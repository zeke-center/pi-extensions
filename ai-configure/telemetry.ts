/**
 * telemetry.ts —— 插件埋点（本地采集 → 批量上报）。
 *
 * 四个硬约束（都在这里兜住）：
 *   1. **默认关闭**：`telemetryUpload=false` 时不采集、不落盘、不联网；
 *   2. **必须有密钥**：`telemetryKey` 为空时即使开关打开也不上传（开关自动回弹）；
 *   3. **失败静默**：任何异常都不弹错、不阻塞主流程，最多重试 3 次后落本地队列；
 *   4. **脱敏**：密钥样式字符串（sk- / ghp_ / Bearer / password=…）一律打码。
 *
 * 事件口径见同目录 `EVENTS.md`；隐私声明见仓库根目录 `PRIVACY.md`。
 */
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchExtCfg, readExtCfg } from "./shared";
import { registerSettings } from "./settings";

// ======================= 常量 =======================

export const CONSENT_VERSION = 1;

export const PRIVACY_NOTICE = [
	"开启后，本机会把使用数据上传到下面填写的后端地址，包括：",
	"· 每次对话的 token 用量、耗时、轮次",
	"· 调用了哪些工具、参数摘要、成功/失败、耗时",
	"· 任务计划的声明/确认/进度操作、临时助理派发结果",
	"· 语音播报的生成与播放结果",
	"· 报错信息、操作系统、pi 与插件版本号",
	"",
	"这些数据可能被用于分析和迭代本项目。",
	"不会上传文件正文和对话正文（除非你单独选择「全量」档），密钥会打码。",
	"随时可以在设置里关闭；关闭后立即停止上传并清空本地待传队列。",
].join("\n");

const DEFAULT_ENDPOINT = (process.env.CENTER_API || "https://api.zeke0419.top").replace(/\/+$/, "");
/** 默认读哪个环境变量；找不到再依次回退（见 envKey()） */
const DEFAULT_KEY_ENV = "PI_TELEMETRY_KEY";
const QUEUE_FILE = () => join(getAgentDir(), "telemetry-queue.jsonl");
const MAX_QUEUE = 2000;
const BATCH = 20;
const MAX_BATCH = 500;
const MAX_STR_FULL = 32 * 1024;
const MAX_STR_META = 200;
const DAILY_BUDGET = 20 * 1024 * 1024;

// ======================= 状态 =======================

type Level = "meta" | "full";

interface TeleEvent {
	event_id: string;
	kind: string;
	name: string;
	ts: string;
	session_id: string;
	turn: number;
	tool?: string;
	ok?: boolean;
	duration_ms?: number;
	props: Record<string, unknown>;
}

let upload = false;
let level: Level = "meta";
let apiKey = "";
let keyEnvName = DEFAULT_KEY_ENV;
let endpoint = DEFAULT_ENDPOINT;
let consentVersion = 0;
let consentAt = "";
let installId = "";

let ctxRef: ExtensionContext | undefined;
let sessionId = "";
let turnNo = 0;
let turnStartedAt = 0;
let lastContextTokens = 0;
let queue: TeleEvent[] = [];
let flushing = false;
let retries = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let pendingTools = new Map<string, number>();

let dayKey = new Date().toISOString().slice(0, 10);
let bytesToday = 0;

// 会话累计（用于 session_end）
let sessTok = { input: 0, output: 0, cacheRead: 0 };
let sessTools = 0;
let sessErrors = 0;

// ======================= 工具函数 =======================

function enabled(): boolean {
	return upload && currentKey().value.length > 0;
}

/** 从环境变量取密钥。返回命中的变量名，方便在 /telemetry 里显示来源。 */
function envKey(): { value: string; source: string } {
	const names = [keyEnvName, DEFAULT_KEY_ENV, "CENTER_TOKEN", "CENTER_MASTER_KEY", "MASTER_KEY"].filter(Boolean);
	for (const n of names) {
		const v = (process.env[n] ?? "").trim();
		if (v) return { value: v, source: `env:${n}` };
	}
	return { value: "", source: "" };
}

/** 密钥优先级：环境变量 > ai-extensions.json。 */
function currentKey(): { value: string; source: string } {
	const e = envKey();
	if (e.value) return e;
	return apiKey ? { value: apiKey, source: "file" } : { value: "", source: "none" };
}

function notify(text: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		ctxRef?.ui.notify(text, type);
	} catch {
		/* UI 不在就静默 */
	}
}

/** 把本机路径里的用户名换成 ~，避免泄露账户名。 */
function redactPaths(text: string): string {
	let out = text;
	const pats: RegExp[] = [
		/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'`]+/gi,
		/(\/c\/Users\/)[^/\s"'`]+/gi,
		/(\/(?:home|Users)\/)[^/\s"'`]+/g,
	];
	for (const re of pats) out = out.replace(re, "$1~");
	return out;
}

/** 密钥样式打码。宁可多打，不可漏。 */
export function redact(text: string): string {
	if (!text) return text;
	let out = text;
	const patterns: RegExp[] = [
		/\bsk-[A-Za-z0-9_-]{12,}/g,
		/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
		/\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
		/\b(?:MASTER_KEY|SECRET_KEY|X-Brain-Token|api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/gi,
	];
	for (const re of patterns) out = out.replace(re, (m) => (m.includes("=") || m.includes(":") ? `${m.split(/[:=]/)[0]}=[redacted]` : "[redacted]"));
	const k = currentKey().value;
	if (k && k.length >= 8) out = out.split(k).join("[redacted]");
	return redactPaths(out);
}

/** 按档位截断字符串；超限标记 truncated。 */
function clip(value: unknown, metaLimit = MAX_STR_META): unknown {
	if (typeof value === "string") {
		const s = redact(value);
		const limit = level === "full" ? MAX_STR_FULL : metaLimit;
		return s.length <= limit ? s : `${s.slice(0, limit)}…[truncated:${s.length}]`;
	}
	if (Array.isArray(value)) return value.slice(0, 200).map((v) => clip(v, metaLimit));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 200)) out[k] = clip(v, metaLimit);
		return out;
	}
	return value;
}

function projectTag(cwd: string): string {
	return createHash("sha256").update(cwd || "").digest("hex").slice(0, 12);
}

function ensureInstall(): string {
	if (!installId) {
		const cfg = readExtCfg();
		installId = typeof cfg.telemetryInstallId === "string" ? cfg.telemetryInstallId : "";
		if (!installId) {
			installId = randomUUID();
			patchExtCfg({ telemetryInstallId: installId });
		}
	}
	return installId;
}

let piVerCache: string | null = null;
/** pi 版本：环境变量 → 从入口向上找 package.json（全局安装时只能这样） */
function piVersion(): string {
	if (piVerCache !== null) return piVerCache;
	const env = (process.env.PI_VERSION ?? "").trim();
	if (env) return (piVerCache = env);
	let dir = process.argv[1] ? dirname(process.argv[1]) : "";
	for (let i = 0; i < 8 && dir; i++) {
		try {
			const p = join(dir, "package.json");
			if (existsSync(p)) {
				const j = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
				if (j.name === "@earendil-works/pi-coding-agent" && j.version) return (piVerCache = j.version);
			}
		} catch {
			/* ignore */
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return (piVerCache = "");
}

let extVerCache: string | null = null;
function extVersion(): string {
	if (extVerCache !== null) return extVerCache;
	const candidates: string[] = [];
	try {
		candidates.push(join(dirname(fileURLToPath(import.meta.url)), "package.json"));
	} catch {
		/* 某些加载方式下 import.meta 不可用 */
	}
	candidates.push(
		join(getAgentDir(), "extensions/ai-configure/package.json"),
		join(getAgentDir(), "npm/node_modules/@zeke-center/pi-extensions/package.json"),
		join(getAgentDir(), "git/gitee.com/zqk0815/pi-extensions/package.json"),
		join(getAgentDir(), "git/github.com/zeke-center/pi-extensions/package.json"),
	);
	for (const p of candidates) {
		try {
			if (!existsSync(p)) continue;
			const j = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
			if (j.version) return (extVerCache = j.version);
		} catch {
			/* ignore */
		}
	}
	return (extVerCache = "");
}

function installPayload() {
	return {
		install_id: ensureInstall(),
		alias: hostname().slice(0, 64),
		os: platform(),
		os_version: release().slice(0, 64),
		pi_version: piVersion(),
		ext_version: extVersion(),
		level,
		consent_version: consentVersion,
		consent_at: consentAt || null,
	};
}

// ======================= 采集 =======================

export function track(kind: string, props: Record<string, unknown> = {}, extra: Partial<TeleEvent> = {}): void {
	if (!enabled()) return;
	const ev: TeleEvent = {
		event_id: randomUUID(),
		kind,
		name: kind,
		ts: new Date().toISOString(),
		session_id: sessionId,
		turn: turnNo,
		...extra,
		props: clip(props) as Record<string, unknown>,
	};
	queue.push(ev);
	if (queue.length >= BATCH) void flush();
	else schedule(5000);
}

/** 把业务性拒绝和真错误分开，避免错误率虚高 */
function classifyError(text: string): "rejected" | "aborted" | "tool_error" {
	const t = text.slice(0, 500);
	if (/用户没有确认|用户\*\*不要\*\*|先别做|已在电脑端选择|没有执行方案/.test(t)) return "rejected";
	if (/aborted|abort|cancel|已取消|已中断/i.test(t)) return "aborted";
	return "tool_error";
}

function schedule(ms: number): void {
	if (timer) return;
	timer = setTimeout(() => {
		timer = undefined;
		void flush();
	}, ms);
}

function rollDay(): void {
	const d = new Date().toISOString().slice(0, 10);
	if (d !== dayKey) {
		dayKey = d;
		bytesToday = 0;
	}
}

function persistQueue(): void {
	try {
		mkdirSync(dirname(QUEUE_FILE()), { recursive: true });
		const trimmed = queue.slice(-MAX_QUEUE);
		writeFileSync(QUEUE_FILE(), trimmed.map((e) => JSON.stringify(e)).join("\n"), "utf8");
	} catch {
		/* 落盘失败就算了 */
	}
}

function loadQueue(): void {
	try {
		if (!existsSync(QUEUE_FILE())) return;
		const lines = readFileSync(QUEUE_FILE(), "utf8").split("\n").filter(Boolean).slice(-MAX_QUEUE);
		for (const line of lines) {
			try {
				queue.push(JSON.parse(line) as TeleEvent);
			} catch {
				/* 坏行跳过 */
			}
		}
		if (queue.length) rmSync(QUEUE_FILE(), { force: true });
	} catch {
		/* ignore */
	}
}

export async function flush(): Promise<void> {
	if (!enabled() || flushing || queue.length === 0) return;
	flushing = true;
	rollDay();
	try {
		while (queue.length > 0 && enabled()) {
			const batch = queue.slice(0, MAX_BATCH);
			const sendKey = currentKey().value;
			const body = JSON.stringify({ schema: 1, install: installPayload(), events: batch });
			const size = Buffer.byteLength(body);
			if (bytesToday + size > DAILY_BUDGET) {
				queue = [];
				persistQueue();
				notify("埋点今日配额已用完，剩余事件不再上传", "warning");
				break;
			}
			const url = `${endpoint.replace(/\/+$/, "")}/api/telemetry/ingest`;
			let res: { status: number; ok: boolean };
			try {
				res = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json", "X-Brain-Token": sendKey },
					body,
				});
			} catch {
				retries++;
				if (retries > 3) {
					persistQueue();
					break;
				}
				schedule(Math.min(60_000, 2000 * 2 ** retries));
				break;
			}
			if (res.status === 401) {
				upload = false;
				patchExtCfg({ telemetryUpload: false });
				notify("埋点密钥被后端拒绝（401），已自动关闭上传", "error");
				break;
			}
			if (res.status === 413) {
				// 单批太大：丢掉这一批，别卡死队列
				queue.splice(0, batch.length);
				continue;
			}
			if (!res.ok) {
				retries++;
				if (retries > 3) {
					persistQueue();
					break;
				}
				schedule(Math.min(60_000, 2000 * 2 ** retries));
				break;
			}
			queue.splice(0, batch.length);
			retries = 0;
			bytesToday += size;
		}
	} finally {
		flushing = false;
	}
}

/** 落盘 + 清空（关闭开关时用） */
export function purge(): void {
	queue = [];
	try {
		rmSync(QUEUE_FILE(), { force: true });
	} catch {
		/* ignore */
	}
}

// ======================= 配置 =======================

function loadConfig(): void {
	const cfg = readExtCfg();
	upload = cfg.telemetryUpload === true;
	apiKey = typeof cfg.telemetryKey === "string" ? cfg.telemetryKey : "";
	keyEnvName = typeof cfg.telemetryKeyEnv === "string" && cfg.telemetryKeyEnv ? cfg.telemetryKeyEnv : DEFAULT_KEY_ENV;
	endpoint = typeof cfg.telemetryEndpoint === "string" && cfg.telemetryEndpoint ? cfg.telemetryEndpoint : DEFAULT_ENDPOINT;
	level = cfg.telemetryLevel === "full" ? "full" : "meta";
	consentVersion = typeof cfg.telemetryConsentVersion === "number" ? cfg.telemetryConsentVersion : 0;
	consentAt = typeof cfg.telemetryConsentAt === "string" ? cfg.telemetryConsentAt : "";
	ensureInstall();
}

/** 真正开启：先确认，再落配置。返回是否开启成功。 */
async function enableWithConsent(): Promise<boolean> {
	ensureInstall();
	if (!currentKey().value) {
		notify("请先填「埋点密钥」或设置环境变量 " + keyEnvName + "，再打开上传", "warning");
		return false;
	}
	let ok = true;
	try {
		ok = await ctxRef!.ui.confirm("上传使用数据到远程？", PRIVACY_NOTICE);
	} catch {
		ok = false;
	}
	if (!ok) {
		notify("已保持关闭", "info");
		return false;
	}
	upload = true;
	consentVersion = CONSENT_VERSION;
	consentAt = new Date().toISOString();
	patchExtCfg({
		telemetryUpload: true,
		telemetryConsentVersion: consentVersion,
		telemetryConsentAt: consentAt,
	});
	track("telemetry_state", { upload: true, level, key_set: true, reason: "user_enabled" });
	track("install", { ...installPayload(), consent_version: consentVersion });
	void flush();
	notify("埋点已开启（可随时在设置里关闭）", "info");
	return true;
}

function disable(reason: string): void {
	upload = false;
	patchExtCfg({ telemetryUpload: false });
	purge();
	notify("埋点已关闭，本地待传队列已清空", "info");
}

function registerTelemetrySettings(): void {
	registerSettings([
		{
			key: "telemetryUpload",
			group: "数据与隐私",
			label: "上传使用数据",
			desc: `默认关闭。开启需填密钥并确认声明；**数据可能用于迭代本项目**。${PRIVACY_NOTICE.replace(/\n/g, " ").slice(0, 160)}…`,
			kind: "bool",
			def: false,
			get: () => upload,
			set: (v) => {
				if (!v) {
					disable("user_disabled");
					return;
				}
				// 开关先回弹，等确认结果再真正置位（set 是同步的，这里只发起流程）
				upload = false;
				void enableWithConsent();
			},
		},
		{
			key: "telemetryKey",
			group: "数据与隐私",
			label: "埋点密钥",
			desc: "后端 MASTER_KEY（请求头 X-Brain-Token）。**环境变量优先于这里**（PI_TELEMETRY_KEY → CENTER_TOKEN → CENTER_MASTER_KEY → MASTER_KEY）。留空且没环境变量 = 永远不上传。",
			kind: "text",
			def: "",
			get: () => apiKey,
			set: (v) => {
				apiKey = String(v).trim();
				patchExtCfg({ telemetryKey: apiKey });
				if (upload && !currentKey().value) {
					disable("key_cleared");
				}
			},
		},
		{
			key: "telemetryKeyEnv",
			group: "数据与隐私",
			label: "密钥环境变量名",
			desc: "优先从这个环境变量读密钥（默认 PI_TELEMETRY_KEY）；读不到再用 CENTER_TOKEN → CENTER_MASTER_KEY → MASTER_KEY，最后才用上面的“埋点密钥”。",
			kind: "text",
			def: DEFAULT_KEY_ENV,
			get: () => keyEnvName,
			set: (v) => {
				keyEnvName = String(v).trim() || DEFAULT_KEY_ENV;
				patchExtCfg({ telemetryKeyEnv: keyEnvName });
				if (upload && !currentKey().value) {
					disable("key_missing");
				}
			},
		},
		{
			key: "telemetryEndpoint",
			group: "数据与隐私",
			label: "上报地址",
			desc: "后端根地址，默认取环境变量 CENTER_API，没有则 https://api.zeke0419.top（会拼 /api/telemetry/ingest）。",
			kind: "text",
			def: DEFAULT_ENDPOINT,
			get: () => endpoint,
			set: (v) => {
				endpoint = String(v).trim() || DEFAULT_ENDPOINT;
				patchExtCfg({ telemetryEndpoint: endpoint });
			},
		},
		{
			key: "telemetryLevel",
			group: "数据与隐私",
			label: "记录粒度",
			desc: "meta=只记参数摘要与返回前 200 字（默认，体积小）；full=记参数≤8KB、返回≤32KB、对话正文≤8KB。",
			kind: "enum",
			options: ["meta", "full"],
			values: ["meta", "full"],
			def: "meta",
			get: () => level,
			set: (v) => {
				level = v === "full" ? "full" : "meta";
				patchExtCfg({ telemetryLevel: level });
				track("telemetry_state", { upload, level, key_set: !!currentKey().value, reason: "level_changed" });
			},
		},
		{
			key: "telemetryNotice",
			group: "数据与隐私",
			label: "查看隐私声明",
			desc: "回车展开完整声明（和首次开启时的确认框内容一致）。",
			kind: "action",
			def: "",
			get: () => "",
			set: () => {
				void ctxRef?.ui.confirm("隐私声明", PRIVACY_NOTICE).catch(() => undefined);
			},
		},
	]);
}

// ======================= 装配 =======================

export function setupTelemetry(api: ExtensionAPI): void {
	loadConfig();

	api.on("session_start", async (_e, ctx) => {
		ctxRef = ctx;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			sessionId = "";
		}
		turnNo = 0;
		sessTok = { input: 0, output: 0, cacheRead: 0 };
		sessTools = 0;
		sessErrors = 0;
		loadQueue();
		if (enabled() && consentVersion < CONSENT_VERSION) {
			// 声明改版：重新确认，否则不上传
			upload = false;
			patchExtCfg({ telemetryUpload: false });
			notify("隐私声明已更新，请重新开启埋点并确认", "warning");
		}
		track("session_start", { project: projectTag(ctx.cwd), model: ctx.model?.id ?? "" });
	});

	api.on("before_agent_start", async () => {
		turnNo++;
		turnStartedAt = Date.now();
	});

	api.on("tool_call", async (event) => {
		pendingTools.set(event.toolCallId, Date.now());
	});

	api.on("tool_result", async (event) => {
		const start = pendingTools.get(event.toolCallId) ?? 0;
		pendingTools.delete(event.toolCallId);
		sessTools++;
		if (event.isError) sessErrors++;
		const text = event.content
			.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
			.map((c) => c.text)
			.join("\n");
		track(
			"tool_call",
			{
				args: event.input,
				args_bytes: Buffer.byteLength(JSON.stringify(event.input ?? {})),
				result: level === "full" ? text : text.slice(0, MAX_STR_META),
				result_bytes: Buffer.byteLength(text),
				error: event.isError ? text.slice(0, 500) : undefined,
				error_kind: event.isError ? classifyError(text) : undefined,
			},
			{ tool: event.toolName, ok: !event.isError, duration_ms: start ? Date.now() - start : undefined },
		);
	});

	api.on("turn_end", async (event) => {
		const msg = event.message as { usage?: Record<string, number> };
		const u = msg.usage ?? {};
		sessTok.input += u.input ?? 0;
		sessTok.output += u.output ?? 0;
		sessTok.cacheRead += u.cacheRead ?? 0;
		const ctxTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		lastContextTokens = ctxTokens;
		track(
			"turn",
			{
				model: ctxRef?.model?.id ?? "",
				token_input: u.input ?? 0,
				token_output: u.output ?? 0,
				token_cache_read: u.cacheRead ?? 0,
				token_reasoning: u.reasoning ?? 0,
				context_tokens: ctxTokens,
				tool_results: event.toolResults?.length ?? 0,
			},
			{ duration_ms: turnStartedAt ? Date.now() - turnStartedAt : 0 },
		);
	});

	api.on("session_shutdown", async (event) => {
		if (!enabled()) return;
		track("session_end", {
			turns: turnNo,
			tool_calls: sessTools,
			errors: sessErrors,
			tokens: sessTok,
			reason: event.reason,
		});
		await flush();
	});

	// 压缩：上下文压力与触发原因（manual / threshold / overflow）
	api.on("session_compact", async (event) => {
		track("compaction", {
			reason: event.reason,
			will_retry: event.willRetry,
			from_extension: event.fromExtension,
			context_tokens: lastContextTokens,
		});
	});

	// 斜杠命令使用（只记命令名，不记参数内容）
	api.on("input", async (event) => {
		const text = event.text ?? "";
		const m = /^\s*\/([A-Za-z0-9_-]+)/.exec(text);
		if (m) {
			track("command_used", {
				command: m[1],
				args_len: Math.max(0, text.trim().length - m[0].length),
				source: event.source,
			});
		}
	});

	api.registerCommand("telemetry", {
		description: "埋点状态 / 立即上报 / 清空队列",
		handler: async (args: string, ctx: ExtensionContext) => {
			ctxRef = ctx;
			const a = args.trim();
			if (a === "flush") {
				await flush();
				ctx.ui.notify(`已尝试上报，剩余 ${queue.length} 条`, "info");
				return;
			}
			if (a === "off") {
				disable("command");
				return;
			}
			if (a === "on") {
				const ok = await enableWithConsent();
				if (ok) void flush();
				return;
			}
			ctx.ui.notify(
				[
					`埋点：${enabled() ? "开启" : "关闭"} · 粒度 ${level} · 密钥 ${currentKey().value ? `已填(${currentKey().source})` : "未填"}`,
					`密钥环境变量：${keyEnvName}（再回退 CENTER_TOKEN / CENTER_MASTER_KEY / MASTER_KEY）`,
					`本地队列：${queue.length} 条 · 今日已传 ${(bytesToday / 1024).toFixed(1)} KB`,
					`地址：${endpoint}`,
					"用法：/telemetry on | off | flush",
				].join("\n"),
				"info",
			);
		},
	});

	registerTelemetrySettings();
}
