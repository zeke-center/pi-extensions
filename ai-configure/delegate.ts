/**
 * delegate · 派活给临时助理（并行 + 同步停止 + 超时续期）
 *
 * 一个工具：delegate(assistant, task | tasks) —— 起**独立的后台 pi 进程**干活，
 * 干完只把卡片（状态/结论/证据）带回来。中间过程不进主对话，但留在自己的会话文件里，可回看。
 *
 * 设计要点：
 *   - 并行：tasks 数组 → Promise.all，一次派多路，等全部返回
 *   - 同步停止：Esc / 主进程退出 / 主进程被强杀（看门狗），三层都杀，不留孤儿
 *   - 超时：到点就**杀**，返回「半成品 + 调过的工具 + 会话ID」；要接着做就带 resume 续跑
 *   - 助理之间不能互相派活（给子进程加了 -xt delegate）
 *   - 会话都留在磁盘上，但**不在 sessions/ 里**（否则 pi 自带的 /resume 会被助理刷满）：
 *     ~/.pi/agent/assistant-sessions/<助理 slug>/<时间戳>_<会话ID>.jsonl
 *     要单独翻看：/resume-agent（或 pi --session "<文件路径>"）
 *
 * 模板 = <项目>/.pi/assistants/*.md 或 <agentDir>/assistants/*.md
 *   frontmatter: name / desc / cwd / model
 *   正文 = 该助理的系统提示词
 *
 * 命名规则：
 *   显示名（/resume-agent 里看到的）  <主进程名>-<代理名><序号>   例：修复登录bug-数据库助理1
 *   会话 ID（ASCII，机器用）    <slug>-<yyyymmdd>-<hhmmss>-<序号>  例：db-20261003-114801-1
 *
 * 用法:
 *   /assistants                        列出所有助理模板
 *   delegate(assistant="db", task="查一下 X")
 *   delegate(assistant="db", tasks=["查 A", "查 B"])        ← 并行
 *   delegate(assistant="db", task="接着做", resume="db-20261003-114801-1")  ← 续跑
 *
 * 环境变量（可选）:
 *   PI_CLI          手动指定 pi 的 CLI 入口（默认自动找）
 *   PI_PACKAGE_DIR  覆盖 pi 包目录（Nix/Guix 场景）
 */
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { type FormResult, type FormField, showForm, type PickItem } from "./form";
import { addJob, beginRun, consume, markEnd, newJob, type EndStatus, type LiveJob } from "./live";
import { autoClosePanel, closeAgentPanel, ensureAgentPanel, openAgentPanel, panelMode, setPreferOverlay, snapshotLines, toggleDetail } from "./panel";
import { assistantSessionRoot, buildShadow, ensureCatalog, loadMcpPool, localCatalogPath, reapStaleShadowDirs, type McpPool } from "./mcp-pool";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 单次硬上限 30 分钟
const MIN_TIMEOUT_MS = 5 * 1000; // 最少 5 秒
const STATUS_KEY = "delegate";
const PARTIAL_LIMIT = 2000; // 半成品最多保留的字符数
const STDERR_LIMIT = 4000;

// ======================= 类型 =======================
interface Template {
	/** 模板名 = 文件名去掉 .md，比如 db */
	key: string;
	/** 显示名（frontmatter.name），默认用 key */
	name: string;
	/** 何时该叫我（frontmatter.desc）—— 主会话的 AI 靠这句话决定派谁 */
	desc: string;
	/**
	 * 工作目录。「在哪儿干活」= 文件读写 / 相对路径 / 项目 AGENTS.md。
	 * 可以由 extends 从父模板继承；最终必须非空。
	 */
	cwd: string;
	/** 模型（frontmatter.model），空则不指定、继承默认 */
	model?: string;
	/**
	 * 要挂的 MCP 名字（逗号分隔）。**与 cwd 无关** —— 这是 v2 的核心改动。
	 * 空数组 = 一个都不挂。
	 */
	mcp: string[];
	/** 默认超时毫秒（frontmatter.timeout，如 10m / 90s）；调用参数仍可覆盖 */
	timeoutMs?: number;
	/** 继承的父模板 key（frontmatter.extends） */
	extends?: string;
	/** base:true → 只给 extends 用，不直接派发（undefined = 没写） */
	base?: boolean;
	/**
	 * demo:true → 示例模板：能看 / 能 show / 能 extends，但**绝对不能派**。
	 * 和 base 的区别只是「怎么在列表里解释自己」：base 是底座、demo 是样板。
	 */
	demo?: boolean;
	/** enabled:false → 列表里不显示、也不能派（undefined = 没写，视为 true） */
	enabled?: boolean;
	/** 是否带全局 AGENTS.md（frontmatter.agents_md）；undefined = 带。关掉省 ~1500 token/次 */
	agentsMd?: boolean;
	/** 覆盖所挂 MCP 的 exposure：codemode | direct | deferred */
	mcpExposure?: string;
	/** 工具白名单（frontmatter.tools）—— 写了就只给这些工具（精确匹配；MCP 工具名形如 mcp__<server>__<tool>） */
	tools?: string[];
	/** 额外禁用的工具（frontmatter.deny_tools）—— 追加到默认的 delegate/progress 黑名单 */
	denyTools?: string[];
	/** env 隔离（frontmatter.isolate_env）：true = 子进程只拿白名单环境变量（默认 false，继承全部） */
	isolateEnv?: boolean;
	/** env 隔离时额外保留的环境变量名（frontmatter.env_passthrough，逗号分隔） */
	envPassthrough?: string[];
	/** 额外环境变量（frontmatter.env，写成 K=V, K2=V2） */
	env: Record<string, string>;
	/** 系统提示词正文（extends 时 = 父正文 + 子正文） */
	body: string;
	/** 模板文件路径 */
	file: string;
}

interface Names {
	/** 会话显示名 */
	display: string;
	/** 会话 ID（ASCII） */
	id: string;
}

type Outcome = "done" | "timeout" | "failed" | "empty" | "busy";

interface RunResult {
	outcome: Outcome;
	/** done 时的最终文本 */
	text: string;
	/** timeout 时已经产出的部分 */
	partial: string;
	/** 它调用过的工具（按顺序，含重复） */
	tools: string[];
	elapsedMs: number;
	exitCode: number | null;
	stderrTail: string;
	names: Names;
	tpl: Template;
	task: string;
	resumed: boolean;
}

// ======================= 模板加载 =======================
/** 扩展自己的目录（…/ai-configure），以及包根目录（…/）—— 包自带的模板在包根的 assistants/ 下 */
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = dirname(EXT_DIR);

/** 模板搜索目录：项目级优先，全局其次，最后是包自带的（pi install 装进来的） */
function templateDirs(cwd: string): string[] {
	const dirs: string[] = [];
	const project = join(cwd, ".pi", "assistants");
	if (existsSync(project)) dirs.push(project);
	const global = join(getAgentDir(), "assistants");
	if (existsSync(global)) dirs.push(global);
	// 包自带：别人 pi install 装完就有一份能看的样板，同名时前面两个优先
	const bundled = join(PACKAGE_DIR, "assistants");
	if (existsSync(bundled)) dirs.push(bundled);
	return dirs;
}

function expandHome(p: string): string {
	return p.replace(/^~(?=[/\\]|$)/, homedir());
}

// ---------- frontmatter 值的小工具 ----------

/** "a, b ,c" → ["a","b","c"]；也容忍空格分隔 */
function splitList(v: string): string[] {
	return v
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** "K=V, K2=V2" → {K:"V", K2:"V2"} */
function splitEnv(v: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of v.split(",")) {
		const i = part.indexOf("=");
		if (i <= 0) continue;
		out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}

/** "10m" / "90s" / "1.5h" / "500ms" → 毫秒；认不出来返回 undefined */
function parseDuration(v: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(v.trim());
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = (m[2] ?? "s").toLowerCase();
	const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60000 : 3600000;
	return n * mult;
}

function parseBool(v: string, dflt: boolean): boolean {
	const s = v.trim().toLowerCase();
	if (["1", "true", "yes", "on", "y"].includes(s)) return true;
	if (["0", "false", "no", "off", "n"].includes(s)) return false;
	return dflt;
}

/** 极简 frontmatter 解析：--- 之间是 key: value，其余是正文 */
function parseTemplate(file: string, key: string): Template | null {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	const meta: Record<string, string> = {};
	let body = raw;
	if (m) {
		body = raw.slice(m[0].length);
		for (const line of m[1].split(/\r?\n/)) {
			const i = line.indexOf(":");
			if (i <= 0) continue;
			const k = line.slice(0, i).trim().toLowerCase();
			const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
			if (k && v) meta[k] = v;
		}
	}

	// cwd 可以由 extends 继承、也可以省略（省略 = 跟随当前项目），所以只有「什么都没写」才算无效模板
	if (!meta.cwd && !meta.extends && !meta.name && !meta.desc) return null;

	return {
		key,
		name: meta.name || key,
		desc: meta.desc || "(没有描述)",
		cwd: meta.cwd ? expandHome(meta.cwd) : "",
		model: meta.model || undefined,
		mcp: meta.mcp ? splitList(meta.mcp) : [],
		timeoutMs: meta.timeout ? parseDuration(meta.timeout) : undefined,
		extends: meta.extends || undefined,
		base: meta.base ? parseBool(meta.base, false) : undefined,
		demo: meta.demo ? parseBool(meta.demo, false) : undefined,
		enabled: meta.enabled ? parseBool(meta.enabled, true) : undefined,
		agentsMd: meta.agents_md ? parseBool(meta.agents_md, true) : undefined,
		mcpExposure: meta.mcp_exposure || undefined,
		tools: meta.tools ? splitList(meta.tools) : undefined,
		denyTools: meta.deny_tools ? splitList(meta.deny_tools) : undefined,
		isolateEnv: meta.isolate_env ? parseBool(meta.isolate_env, false) : undefined,
		envPassthrough: meta.env_passthrough ? splitList(meta.env_passthrough) : undefined,
		env: meta.env ? splitEnv(meta.env) : {},
		body: body.trim(),
		file,
	};
}

/**
 * 解开 extends 链：子写的覆盖父的，正文是「父 + 子」拼接。
 *
 * 继承规则（写进 README 的那份）：
 *   继承：cwd / model / mcp / timeout / mcp_exposure / env / body
 *   不继承：base / demo / enabled / agents_md（用自己写的，没写就是默认值）
 *   mcp 是「覆盖」不是「合并」—— 避免「以为只挂了 1 个其实带了一堆」
 *
 * 最多 2 层（子 → 父 → 祖父），并检测循环。
 */
function resolveTemplate(t: Template, byKey: Map<string, Template>, seen: Set<string>, depth = 0): Template {
	if (!t.extends) return t;
	if (depth >= 2 || seen.has(t.key)) return { ...t, extends: undefined }; // 太深/成环就到此为止
	const parent = byKey.get(t.extends);
	if (!parent) return t; // 找不到父模板就当没写

	const next = new Set(seen);
	next.add(t.key);
	const p = resolveTemplate(parent, byKey, next, depth + 1);

	return {
		...t,
		cwd: t.cwd || p.cwd,
		model: t.model ?? p.model,
		mcp: t.mcp.length ? t.mcp : p.mcp,
		timeoutMs: t.timeoutMs ?? p.timeoutMs,
		mcpExposure: t.mcpExposure ?? p.mcpExposure,
		tools: t.tools?.length ? t.tools : p.tools,
		denyTools: t.denyTools?.length ? t.denyTools : p.denyTools,
		isolateEnv: t.isolateEnv ?? p.isolateEnv,
		envPassthrough: t.envPassthrough?.length ? t.envPassthrough : p.envPassthrough,
		env: { ...p.env, ...t.env },
		body: [p.body, t.body].filter(Boolean).join("\n\n"),
	};
}

export function loadTemplates(cwd: string): Template[] {
	const seen = new Set<string>();
	const parsed: Template[] = [];
	for (const dir of templateDirs(cwd)) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.endsWith(".md")) continue;
			const key = e.slice(0, -3);
			if (seen.has(key)) continue; // 项目级优先
			const file = join(dir, e);
			try {
				if (!statSync(file).isFile()) continue;
			} catch {
				continue;
			}
			const t = parseTemplate(file, key);
			if (!t) continue;
			seen.add(key);
			parsed.push(t);
		}
	}

	// 先把 extends 解开，再过滤掉关闭的
	const byKey = new Map(parsed.map((t) => [t.key, t]));
	const out: Template[] = [];
	for (const t of parsed) {
		const r = resolveTemplate(t, byKey, new Set());
		if (r.enabled === false) continue;
		// cwd 省略 → 跟随主进程当前所在的项目目录。
		// 这样模板可以跨机器复用（不然里面会写死某台机器的绝对路径）。
		out.push({ ...r, cwd: r.cwd || cwd });
	}
	return out;
}

// ======================= 找 pi 的 CLI =======================
/** 返回可直接 spawn 的入口；找不到返回 null */
function resolveCli(): string | null {
	const candidates: string[] = [];
	const envCli = process.env.PI_CLI;
	if (envCli && existsSync(envCli)) candidates.push(envCli);
	const pkgDir = process.env.PI_PACKAGE_DIR;
	if (pkgDir) {
		const p = join(pkgDir, "dist", "bundle", "cli.js");
		if (existsSync(p)) candidates.push(p);
	}
	// 扩展跑在 pi 进程内，argv[1] 就是 CLI 入口（已实测）
	const argv1 = process.argv[1];
	if (argv1 && /\.(js|cjs|mjs)$/i.test(argv1) && existsSync(argv1)) candidates.push(argv1);
	return candidates[0] ?? null;
}

// ======================= 命名 =======================
/** 会话 ID 只允许 [A-Za-z0-9-_.]，首尾必须是字母数字（pi 的硬性要求） */
function sanitizeSessionId(raw: string): string {
	let s = raw.replace(/[^A-Za-z0-9\-_.]/g, "-").replace(/-{2,}/g, "-");
	s = s.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
	return s.slice(0, 80) || "delegate";
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本地时间戳 yyyymmdd-hhmmss */
function stamp(d = new Date()): string {
	return (
		`${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
		`-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
	);
}

/** 主进程的会话名；没设就兜底 */
function mainName(ctx: ExtensionContext): string {
	try {
		const n = ctx.sessionManager?.getSessionName?.();
		if (n && n.trim()) return n.trim();
	} catch {
		/* ignore */
	}
	return "主进程";
}

/** 同一代理在本会话里第几次被派（累加，所以名字不撞） */
const seqCounters = new Map<string, number>();
function nextSeq(key: string): number {
	const n = (seqCounters.get(key) ?? 0) + 1;
	seqCounters.set(key, n);
	return n;
}

function buildNames(main: string, tpl: Template, seq: number, resumeId?: string): Names {
	const display = `${main}-${tpl.name}${seq}`;
	const id = resumeId ?? sanitizeSessionId(`${tpl.key}-${stamp()}-${seq}`);
	return { display, id };
}

// ======================= 进程管理：登记 + 全杀 =======================
/** 所有在跑的子进程（其实是看门狗包装器） */
const liveJobs = new Set<ChildProcess>();
let exitHookInstalled = false;

/** 杀掉一整棵进程树。Windows 用 taskkill /T，POSIX 杀进程组。 */
function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid == null) return;
	if (process.platform === "win32") {
		try {
			const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			k.on("error", () => {
				/* ignore */
			});
		} catch {
			/* ignore */
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL"); // POSIX：整组杀（子进程是 detached 的组长）
		} catch {
			/* ignore */
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		/* ignore */
	}
}

/** 杀掉所有在跑的子进程 */
function killAll(): void {
	for (const c of [...liveJobs]) killTree(c);
	liveJobs.clear();
}

/** 主进程退出时兜底杀一遍（强杀由看门狗负责） */
function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", killAll);
}

/**
 * 看门狗包装器：不直接起 pi，而是起这个，它再起 pi。
 * 每 2 秒探一次主进程是否还活着；主进程没了就把 pi 杀掉再退出。
 * 这样即使主进程被任务管理器强杀（来不及跑任何清理代码），也不会留下孤儿。
 *
 * 真实 argv 走环境变量传，避开引号转义问题。
 */
const WATCHDOG_SRC = `
const { spawn } = require("node:child_process");
const argv = JSON.parse(process.env.PI_DELEGATE_ARGV || "[]");
const ppid = Number(process.env.PI_DELEGATE_PPID || "0");
if (!argv.length || !ppid) process.exit(2);
const child = spawn(process.execPath, argv, { stdio: "inherit", shell: false });
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  try { child.kill("SIGKILL"); } catch (e) {}
  process.exit(0);
}
const timer = setInterval(function () {
  try { process.kill(ppid, 0); } catch (e) { stop(); }
}, 2000);
child.on("close", function (code) { clearInterval(timer); process.exit(code === null ? 1 : code); });
child.on("error", function () { clearInterval(timer); process.exit(1); });
`;

/** env 隔离开时要保留的变量：系统不能少的那些 */
const ENV_KEEP_EXACT = new Set([
	"PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "TMPDIR",
	"LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "SHELL", "ComSpec", "SystemRoot", "SystemDrive",
	"windir", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
	"OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "USERNAME", "USER",
	"LOGNAME", "PWD", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "NO_COLOR", "FORCE_COLOR",
]);
/** env 隔离开时按前缀保留的变量（pi / node / npm 自己的） */
const ENV_KEEP_PREFIX = ["PI_", "NODE_", "npm_"];

/** 按白名单挑环境变量。注意：模型 key 若只放在环境变量里，需要模板用 env_passthrough 显式保留。 */
function filteredEnv(passthrough: string[]): Record<string, string> {
	const keep = new Set([...ENV_KEEP_EXACT, ...passthrough]);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined) continue;
		if (keep.has(k) || ENV_KEEP_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
	}
	return out;
}

function spawnWatched(
	argv: string[],
	cwd: string,
	extraEnv: Record<string, string> = {},
	envMode: { isolate?: boolean; passthrough?: string[] } = {},
): ChildProcess {
	installExitHook();
	const base = envMode.isolate ? filteredEnv(envMode.passthrough ?? []) : process.env;
	const child = spawn(process.execPath, ["-e", WATCHDOG_SRC], {
		cwd,
		env: {
			...base,
			PI_SKIP_VERSION_CHECK: "1",
			...extraEnv,
			PI_DELEGATE_ARGV: JSON.stringify(argv),
			PI_DELEGATE_PPID: String(process.pid),
		},
		stdio: ["pipe", "pipe", "pipe"],
		shell: false,
		detached: process.platform !== "win32", // POSIX：自成进程组，方便整组杀
		windowsHide: true,
	});
	liveJobs.add(child);
	child.on("close", () => liveJobs.delete(child));
	child.on("error", () => liveJobs.delete(child));
	return child;
}

// ======================= 交卡要求 =======================
function deadlineRule(secs: number, resumed: boolean): string {
	return [
		`【时限】你必须在 ${secs} 秒内给出结论。`,
		"时间不够时**不要硬撑**：立刻停下，交出你**已经确认**的部分，并明确写「未完成」「还差什么」。",
		"半成品也比超时好 —— 超时会被强制掐断，那时你写的东西可能来不及送出去。",
		resumed
			? "本次是**续跑**：先看你上面的对话记录，接着做没做完的部分，不要从头再来。"
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

function cardPrompt(task: string): string {
	return `【任务】
${task}

【交卡要求】
只输出下面三行，不要写别的东西，不要用 markdown 代码块包起来：

状态: 完成 或 卡住 或 需要信息
结论: 一句话说清结果（要数据/结论，不要写过程）
证据: 你怎么确认的，最多 3 行（表名 / 命令 / 关键输出 / 改了哪些文件）

如果你卡住了、或需要别人给你信息才能继续，把「需要什么」写进结论，状态写「需要信息」。
不要猜，不要编。做不到就说做不到。`;
}

// ======================= 解析 --mode json 的流 =======================
interface Sink {
	partial: string;
	tools: string[];
	final: string;
	stderr: string;
	/** 实时视图：每个事件同时喂给它，面板才看得到「它现在在干什么」 */
	live?: LiveJob;
}

function clampTail(s: string, limit: number): string {
	return s.length > limit ? s.slice(-limit) : s;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b) => {
				if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
					return String((b as { text?: unknown }).text ?? "");
				}
				return "";
			})
			.join("")
			.trim();
	}
	return "";
}

/** 单行 JSON → 累积半成品 / 记录工具调用 / 取最终文本 */
function handleLine(line: string, sink: Sink): void {
	if (line.charCodeAt(0) !== 123 /* { */) return;
	let obj: {
		type?: string;
		message?: { role?: string; content?: unknown };
		assistantMessageEvent?: { type?: string; delta?: unknown; toolCall?: { name?: unknown } };
	};
	try {
		obj = JSON.parse(line);
	} catch {
		return; // 不是 JSON（可能是 warning），忽略
	}
	// 实时视图：同一个事件同时喂给面板的状态机（它只认自己关心的字段）
	if (sink.live) consume(sink.live, obj);
	if (obj.type === "message_update") {
		const ev = obj.assistantMessageEvent;
		if (ev?.type === "text_delta" && typeof ev.delta === "string") {
			sink.partial = clampTail(sink.partial + ev.delta, PARTIAL_LIMIT);
		} else if (ev?.type === "toolcall_end" && ev.toolCall?.name) {
			sink.tools.push(String(ev.toolCall.name));
		}
	} else if (obj.type === "message_end" && obj.message?.role === "assistant") {
		const t = extractText(obj.message.content);
		if (t) sink.final = t;
	}
}

function makeLineReader(sink: Sink): (chunk: string) => void {
	let buf = "";
	return (chunk: string) => {
		buf += chunk;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (line) handleLine(line, sink);
		}
		if (buf.length > 1_000_000) buf = ""; // 防超长单行撑爆内存
	};
}

/** name×n → "name×2" */
function summarizeTools(tools: string[]): string {
	const m = new Map<string, number>();
	for (const t of tools) m.set(t, (m.get(t) ?? 0) + 1);
	return [...m].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(" → ");
}

// ======================= 跑一个助理 =======================
interface RunOptions {
	timeoutMs: number;
	/** 可选：后台任务不传（不随本轮 turn 结束被 abort） */
	signal?: AbortSignal;
	names: Names;
	resumed: boolean;
	/** 影子 agentDir（只含本助理该有的 mcp.json） */
	shadowDir: string;
	/** 助理专属会话目录（不在 sessions/ 下，/resume 看不见） */
	sessionDir: string;
	/** 后台任务完成时回调（写状态文件、触发回投）。同步模式不用。 */
	onSettle?: (r: RunResult) => void;
}

/** 给助理准备专属会话目录：不存在就建 */
function ensureAssistantSessionDir(key: string): string {
	const dir = join(assistantSessionRoot(), key);
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		/* ignore */
	}
	return dir;
}

/** 按会话 ID 反查会话文件（文件名以 `_<会话ID>.jsonl` 结尾） */
function sessionFileFor(key: string, id: string): string | undefined {
	const dir = join(assistantSessionRoot(), key);
	try {
		const hit = readdirSync(dir).find((f) => f.endsWith(`_${id}.jsonl`));
		return hit ? join(dir, hit) : undefined;
	} catch {
		return undefined;
	}
}

async function runAssistant(tpl: Template, task: string, opt: RunOptions): Promise<RunResult> {
	const started = Date.now();
	const sink: Sink = { partial: "", tools: [], final: "", stderr: "" };
	const base = (outcome: Outcome, exitCode: number | null): RunResult => ({
		outcome,
		text: sink.final.trim(),
		partial: sink.partial,
		tools: sink.tools,
		elapsedMs: Date.now() - started,
		exitCode,
		stderrTail: clampTail(sink.stderr.trim(), STDERR_LIMIT),
		names: opt.names,
		tpl,
		task,
		resumed: opt.resumed,
	});

	// 同会话互斥：该会话正在别处跑（另一次 resume / 另一个 pi 实例）→ 直接拒绝，绝不起第二个进程。
	// 两个进程写同一份会话文件会交叉覆盖 —— 这是线上实踩到的坑。
	const lock = acquireSessionLock(opt.names.id, opt.names.display);
	if (!lock.ok) {
		const r = base("busy", null);
		r.stderrTail = `会话 ${opt.names.id} 正在运行：${lock.holder}`;
		return Promise.resolve(r);
	}

	const cli = resolveCli();
	if (!cli) {
		releaseSessionLock(opt.names.id);
		sink.stderr = "找不到 pi 的 CLI 入口。请设置环境变量 PI_CLI 指向 pi 的 cli.js。";
		return Promise.resolve(base("failed", null));
	}

	// 并发上限：超出的先排队（防一次派太多打爆机器 / 额度）
	await acquireRunSlot();

	// 实时视图：从 spawn 起，子进程每个 JSON 事件都会同时喂给它（面板据此实时画）
	const job = newJob({ key: tpl.key, name: tpl.name, task, sessionId: opt.names.id, startedAt: started });
	sink.live = job;
	addJob(job);

	// -xt：助理不需要面板工具（影子目录下本来也没有 ai-configure，这里是双保险）
	// 工具控制：
	//   - 默认：黑名单只挡面板工具（助理不需要 delegate/progress）
	//   - 模板写了 tools: → 白名单（-t），只给列出的工具（精确匹配）
	//   - 模板写了 deny_tools: → 追加到黑名单
	// ⚠️ MCP 工具名是 mcp__<server>__<tool>，用 -t 时必须逐个列出，否则 MCP 会不可用。
	const denyTools = ["delegate", "progress", ...(tpl.denyTools ?? [])];
	const args = [cli, "-p", "--mode", "json", "-xt", denyTools.join(",")];
	if (tpl.tools?.length) args.push("-t", tpl.tools.join(","));
	// -na：忽略项目级资源 → 掐掉 {cwd}/.pi/mcp.json。
	//   否则项目的 MCP 会 merge 回影子配置里，「按需给」就白做了。
	//   AGENTS.md 不受项目信任管，所以照常加载。
	args.push("-na");
	args.push("--session-dir", opt.sessionDir);
	if (opt.resumed) {
		args.push("--session-id", opt.names.id); // 续跑：沿用旧会话，不改名字
	} else {
		args.push("--session-id", opt.names.id, "--name", opt.names.display);
	}
	if (tpl.model) args.push("--model", tpl.model);
	const body = [tpl.body, deadlineRule(Math.round(opt.timeoutMs / 1000), opt.resumed)]
		.filter(Boolean)
		.join("\n\n");
	if (body) args.push("--append-system-prompt", body);

	return new Promise<RunResult>((done) => {
		let timedOut = false;
		let settled = false;
		const read = makeLineReader(sink);

		let child: ChildProcess;
		try {
			child = spawnWatched(
				args,
				tpl.cwd,
				{
					PI_CODING_AGENT_DIR: opt.shadowDir,
					...tpl.env,
				},
				{ isolate: tpl.isolateEnv === true, passthrough: tpl.envPassthrough ?? [] },
			);
		} catch (e) {
			sink.stderr = clampTail(
				`${sink.stderr}\n[spawn 失败] ${e instanceof Error ? e.message : String(e)}`,
				STDERR_LIMIT,
			);
			releaseSessionLock(opt.names.id);
			releaseRunSlot();
			done(base("failed", null));
			return;
		}

		const finish = (outcome: Outcome, exitCode: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opt.signal?.removeEventListener("abort", onAbort);
			liveJobs.delete(child);
			// 面板终态：写在这里而不是事件里 —— agent_end 不代表进程结束（可能还会重试/续跑）
			const liveStatus: EndStatus = outcome === "timeout" ? "timeout" : outcome === "failed" ? "failed" : "done";
			markEnd(
				job,
				liveStatus,
				outcome === "timeout"
					? "超时被停止（要接着做用 resume）"
					: outcome === "empty"
						? "跑了但没吐结论"
						: exitCode && exitCode !== 0
							? `子进程退出码 ${exitCode}`
							: undefined,
			);
			const r = base(outcome, exitCode);
			releaseSessionLock(opt.names.id);
			releaseRunSlot();
			opt.onSettle?.(r);
			done(r);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child); // 到点就杀，绝不留孤儿；要接着做靠 resume 续跑
		}, opt.timeoutMs);

		const onAbort = (): void => {
			timedOut = false;
			killTree(child);
		};
		opt.signal?.addEventListener("abort", onAbort);

		child.stdout?.on("data", (d: Buffer) => read(d.toString("utf8")));
		child.stderr?.on("data", (d: Buffer) => {
			sink.stderr = clampTail(sink.stderr + d.toString("utf8"), STDERR_LIMIT);
		});
		child.on("error", (e) => {
			sink.stderr = clampTail(`${sink.stderr}\n[spawn 失败] ${e.message}`, STDERR_LIMIT);
			finish("failed", null);
		});
		child.on("close", (code) => {
			if (settled) return;
			if (opt.signal?.aborted) {
				finish("failed", code);
			} else if (timedOut) {
				finish("timeout", code);
			} else if (code !== 0) {
				finish("failed", code);
			} else if (sink.final.trim()) {
				finish("done", code);
			} else {
				finish("empty", code);
			}
		});

		// 任务正文走 stdin —— 避开命令行转义问题
		try {
			child.stdin?.write(cardPrompt(task), "utf8");
			child.stdin?.end();
		} catch (e) {
			sink.stderr = clampTail(`${sink.stderr}\n[写入任务失败] ${e instanceof Error ? e.message : e}`, STDERR_LIMIT);
			killTree(child);
		}
	});
}

// ======================= 渲染卡片 =======================
function oneLine(s: string, max: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

const HEADS: Record<Outcome, (name: string, secs: number, extra: string) => string> = {
	done: (n, s) => `【${n}】回来了（${s}s）`,
	timeout: (n, s) => `【${n}】超时被停止（${s}s）`,
	failed: (n, s, e) => `【${n}】失败（${s}s${e}）`,
	empty: (n, s) => `【${n}】跑了但没输出（${s}s）`,
	busy: (n, s) => `【${n}】没启动：会话正忙（${s}s）`,
};

function renderCard(r: RunResult): string {
	const secs = Math.round(r.elapsedMs / 1000);
	const name = r.tpl.name;
	const tools = summarizeTools(r.tools);

	let head: string;
	let body: string;

	switch (r.outcome) {
		case "done":
			head = HEADS.done(name, secs);
			body = r.text || "(空)";
			break;
		case "timeout":
			head = HEADS.timeout(name, secs);
			body = [
				"状态: 超时（未完成）",
				"",
				"到点前的产出：",
				r.partial.trim() || "(还没吐出文字 —— 它可能一直在跑工具)",
				"",
				tools ? `它调用过：${tools}` : "它还没来得及动手。",
				"",
				`要接着做就再调一次 delegate，带上 resume: "${r.names.id}" 和补充的时间 —— 它的历史都在，会接着做而不是重做。`,
			].join("\n");
			break;
		case "failed":
			head = HEADS.failed(name, secs, r.exitCode === null ? "" : `，退出码 ${r.exitCode}`);
			body = [
				"状态: 失败",
				"",
				r.stderrTail || "(没有 stderr)",
				"",
				tools ? `它调用过：${tools}` : "",
				`它的会话还在，可以 resume: "${r.names.id}" 接着查。`,
			]
				.filter((x) => x !== "")
				.join("\n");
			break;
		case "busy":
			head = HEADS.busy(name, secs);
			body = [
				"状态: 没启动 —— 这个会话正在运行，已拒绝并发（否则两个进程会交叉写同一份会话/文件）。",
				"",
				r.stderrTail || "",
				`要它接着做：等它跑完再 resume: "${r.names.id}"；或换一个新会话重新派。`,
			]
				.filter((x) => x !== "")
				.join("\n");
			break;
		default:
			head = HEADS.empty(name, secs);
			body = [
				"状态: 空返回",
				"退出码 0，但没拿到任何结论。",
				"",
				r.stderrTail || "(没有 stderr)",
				tools ? `它调用过：${tools}` : "",
				`resume: "${r.names.id}"`,
			]
				.filter((x) => x !== "")
				.join("\n");
			break;
	}

	const file = sessionFileFor(r.tpl.key, r.names.id);

	return [
		head,
		"",
		body,
		"",
		"──── 本次派发 ────",
		`会话名  ${r.resumed ? "(沿用原有名字)" : r.names.display}`,
		`会话ID  ${r.names.id}`,
		`代理    ${name}（${r.tpl.key}${r.tpl.model ? ` · ${r.tpl.model}` : ""}）`,
		`目录    ${r.tpl.cwd}`,
		`连接    ${r.tpl.mcp.length ? r.tpl.mcp.join(", ") : "(不连 MCP)"}`,
		`任务    ${oneLine(r.task, 40)}`,
		`耗时    ${secs}s`,
		`找回    /resume-agent 里挑${file ? `，或 pi --session "${file}"` : ""}`,
	].join("\n");
}

// ======================= 工具参数 =======================
/**
 * 生成「可用助理」提示，拼进 assistant 参数的描述里。
 *
 * 为什么放参数描述、不另发一条消息：
 *   工具 schema 每轮本来就发给模型，放这里等于**零额外开销**；
 *   而 before_agent_start 注入一条消息会多占几十~上百 token/轮。
 * ⚠️ 代价：清单在扩展加载时就定下来了。新增/改名助理后要 /reload 才会刷新
 *   （派发本身不缓存，改模板规则/正文立即生效）。
 */
function assistantHint(cwd: string): string {
	try {
		const tpls = loadTemplates(cwd).filter((t) => t.base !== true && t.demo !== true);
		if (!tpls.length) return "";
		const list = tpls.map((t) => `${t.key}（${t.name}：${oneLine(t.desc, 40)}）`).join("；");
		return ` 可用：${list}`;
	} catch {
		return "";
	}
}

function makeDelegateParams(hint: string) {
	return Type.Object({
		assistant: Type.String({ description: `助理模板名。${hint || "当前**没有**可派发的助理（都是 base / 示例模板），先用 /assistants 看看。"}` }),
		task: Type.Optional(Type.String({ description: "一件事。写清目标 + 验收标准，别写「分析一下」这种模糊指令。" })),
		tasks: Type.Optional(
			Type.Array(Type.String(), {
				description: "多件互不依赖的事，并行跑，总耗时≈最慢那件。有依赖就分开派。给了就不用给 task。",
			}),
		),
		resume: Type.Optional(Type.String({ description: "续跑：填上次卡片里的「会话ID」，它会接着做而不是重做。只能配一个 task。" })),
		timeoutMs: Type.Optional(
			Type.Number({ description: `超时毫秒（模板可用 timeout 字段给默认值；上限 ${MAX_TIMEOUT_MS}）。` }),
		),
		wait: Type.Optional(
			Type.Boolean({ description: "默认 false（异步）：派完立即返回「已派发」，子进程后台跑，完成后自动把结果回投到主会话（不打断，排队到当前轮后面）。true = 同步等结果（阻塞，派多路时等全部回来）才返回。" }),
		),
	});
}

// ======================= 默认同步/异步模式 =======================
/** 模式持久化文件：~/.pi/agent/delegate-mode，内容 sync|async */
function delegateModeFile(): string {
	return join(getAgentDir(), "delegate-mode");
}
function readDelegateMode(): "sync" | "async" {
	try {
		const v = readFileSync(delegateModeFile(), "utf8").trim();
		return v === "sync" ? "sync" : "async";
	} catch {
		return "async"; // 默认异步（派完就走 + 自动回投）
	}
}
function writeDelegateMode(mode: "sync" | "async"): void {
	try {
		writeFileSync(delegateModeFile(), mode, "utf8");
	} catch {
		/* 写不进去就只生效本次 */
	}
}

// ======================= 后台任务（异步派活）=======================
interface BgTaskFile {
	id: string;
	key: string;
	name: string;
	task: string;
	sessionId: string;
	startedAt: number;
	status: "running" | "done" | "timeout" | "failed" | "empty";
	resultText?: string;
	finishedAt?: number;
	delivered?: boolean;
	/** 派发它的「主会话」文件路径 —— 结果只投回这个会话，别的会话扫到也不投（防串台） */
	ownerSessionFile?: string;
	/** 派发它的主会话 ID（file 拿不到时的退路，也方便排查） */
	ownerSessionId?: string;
	/** 投递失败重试次数 */
	attempts?: number;
	/** 上次尝试投递的时间（算退避用） */
	lastAttemptAt?: number;
	/** 第一次投递失败的时间（算“多久还没发出去”用） */
	firstFailAt?: number;
	/** 最后一次投递失败的原因（排查用） */
	lastError?: string;
	/** 自动重试已放弃（超时），等 /agents bg redeliver 手动投 */
	undelivered?: boolean;
}

function bgRoot(): string {
	const d = join(assistantSessionRoot(), ".bg");
	try {
		mkdirSync(d, { recursive: true });
	} catch {
		/* ignore */
	}
	return d;
}
function bgFile(id: string): string {
	return join(bgRoot(), `${id}.json`);
}
function writeBgTask(t: BgTaskFile): void {
	try {
		writeFileSync(bgFile(t.id), JSON.stringify(t, null, 2), "utf8");
	} catch {
		/* ignore */
	}
}
function readBgTask(id: string): BgTaskFile | undefined {
	try {
		return JSON.parse(readFileSync(bgFile(id), "utf8")) as BgTaskFile;
	} catch {
		return undefined;
	}
}
function listBgTasks(): BgTaskFile[] {
	try {
		return readdirSync(bgRoot())
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return JSON.parse(readFileSync(join(bgRoot(), f), "utf8")) as BgTaskFile;
				} catch {
					return undefined;
				}
			})
			.filter((t): t is BgTaskFile => !!t);
	} catch {
		return [];
	}
}
function outcomeToStatus(o: Outcome): BgTaskFile["status"] {
	switch (o) {
		case "done": return "done";
		case "timeout": return "timeout";
		case "empty": return "empty";
		case "busy": return "failed";
		default: return "failed";
	}
}

// ======================= /assistants 的界面 =======================

/** 按 key 或 name 找模板（先精确，再模糊） */
function findTemplate(cwd: string, what: string): Template | undefined {
	const tpls = loadTemplates(cwd);
	const q = what.trim();
	const low = q.toLowerCase();
	return (
		tpls.find((t) => t.key.toLowerCase() === low || t.name.toLowerCase() === low) ??
		tpls.find((t) => t.key.toLowerCase().includes(low) || t.name.includes(q))
	);
}

function notFound(ctx: ExtensionContext, cwd: string, what: string): void {
	const can = loadTemplates(cwd).filter((t) => t.base !== true && t.demo !== true);
	const have = can.length ? `可派的有：${can.map((t) => t.key).join(", ")}` : `现在一个能派的都没有（只有 base 和示例模板）`;
	ctx.ui.notify(`找不到助理「${what || "(没写)"}」。${have}`, "warning");
}

/** 向用户要一行文本（input 不可用就退化成 editor） */
/** 写模板文件：不认识的键原样保留；body 传了才换正文 */
function writeTemplate(file: string, updates: Record<string, string | undefined>, body?: string): void {
	let raw = "";
	if (existsSync(file)) raw = readFileSync(file, "utf8");
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	const oldBody = fm ? raw.slice(fm[0].length) : raw;
	const lines: string[] = [];
	const handled = new Set<string>();
	if (fm) {
		for (const line of fm[1].split(/\r?\n/)) {
			const i = line.indexOf(":");
			if (i <= 0) {
				if (line.trim()) lines.push(line);
				continue;
			}
			const k = line.slice(0, i).trim().toLowerCase();
			// updates 里出现过的键归我们管：有新值就写，空串 / undefined 就把这行删掉
			if (k in updates) {
				handled.add(k);
				const v = updates[k];
				if (v !== undefined && v !== "") lines.push(`${k}: ${v}`);
			} else {
				lines.push(line);
			}
		}
	}
	for (const [k, v] of Object.entries(updates)) {
		if (handled.has(k) || v === undefined || v === "") continue;
		lines.push(`${k}: ${v}`);
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `---\n${lines.join("\n")}\n---\n${(body ?? oldBody).trim()}\n`, "utf8");
}

const SCOPE_GLOBAL = "全局（所有项目都能用）";
const SCOPE_PROJECT = "项目级（只在这个项目里生效）";

function globalAssistantDir(): string {
	return join(getAgentDir(), "assistants");
}

function projectAssistantDir(cwd: string): string {
	return join(cwd, ".pi", "assistants");
}

/** 这个模板文件是不是放在「项目级」目录里 */
function isProjectFile(file: string, cwd: string): boolean {
	const norm = (s: string): string => s.replace(/\\/g, "/").toLowerCase();
	return norm(dirname(file)).startsWith(norm(join(cwd, ".pi")));
}

function humanTimeout(ms: number): string {
	if (ms % 60000 === 0) return `${ms / 60000}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return `${ms}ms`;
}

/** 候选池 → 多选项（池子里的 + 当前挂的，去重排序） */
function mcpItems(pool: McpPool, current: string[]): PickItem[] {
	const all = [...new Set([...Object.keys(pool.servers), ...current])].sort();
	return all.map((n) => ({
		value: n,
		label: n,
		hint: pool.servers[n] ? `(${pool.origin[n] ?? ""})` : "(候选池里没有，写了也连不上)",
		checked: current.includes(n),
	}));
}

/** 面板上的行 —— new 和 edit 共用同一套 */
/** 「基础模板」下拉里的「不选」项 */
const BASE_NONE = "（不用）";

/** 可当「基础模板」的底座：base:true 的模板 */
function availableBases(cwd: string): Template[] {
	try {
		return loadTemplates(cwd).filter((t) => t.base === true);
	} catch {
		return [];
	}
}

/** 「开发助理（底座）」→「开发助理」；只用于下拉里的提示 */
function shortBaseName(name: string): string {
	return name.replace(/[（(]\s*底座\s*[)）]\s*$/, "").replace(/底座\s*$/, "").trim() || name;
}

function buildFields(o: {
	key: string;
	name: string;
	desc: string;
	cwd: string;
	model: string;
	timeout: string;
	agentsMd: boolean;
	dispatchable: boolean;
	dispatchNote?: string;
	scope: string;
	bodyChars: number;
	keyEditable: boolean;
	/** 当前挂的底座 key（"" = 没挂） */
	extendsKey: string;
	/** 能选的底座 */
	bases: { key: string; name: string }[];
}): FormField[] {
	const baseKeys = o.bases.map((b) => b.key);
	// 手写的非底座 extends 也留在选项里，不然一编辑就被悄悄改掉
	const extendsOptions = [
		BASE_NONE,
		...(o.extendsKey && !baseKeys.includes(o.extendsKey) ? [o.extendsKey] : []),
		...baseKeys,
	];
	return [
		{
			key: "key",
			label: "文件名",
			value: o.key,
			kind: "text",
			readonly: !o.keyEditable,
			hint: o.keyEditable ? "(去掉 .md —— 派它时就用这个名字)" : "(改名＝新建一个，用 /assistants new)",
		},
		{ key: "name", label: "显示名", value: o.name, kind: "text", hint: "(中文也行)" },
		{
			key: "desc",
			label: "描述",
			value: o.desc,
			kind: "text",
			hint: "(写「什么时候用我」，主 pi 靠它决定派谁)",
		},
		{
			key: "extends",
			label: "基础模板",
			value: o.extendsKey || BASE_NONE,
			kind: "enum",
			options: extendsOptions,
			hint: o.bases.length
				? `(底座只读；选了就继承它的提示词和默认值) ${o.bases.map((b) => `${b.key}＝${shortBaseName(b.name)}`).join(" · ")}`
				: "(这个包里没有底座，只能从空白开始)",
		},
		{
			key: "cwd",
			label: "工作目录",
			value: o.cwd,
			kind: "text",
			hint: "(在哪儿干活：文件读写 / 项目 AGENTS.md)",
		},
		{ key: "model", label: "模型", value: o.model, kind: "text", hint: "(留空 = 继承默认)" },
		{ key: "timeout", label: "超时", value: o.timeout, kind: "text", hint: "(10m / 90s / 1.5h，留空 = 5 分钟)" },
		{
			key: "agents_md",
			label: "带 AGENTS.md",
			value: o.agentsMd ? "是" : "否",
			kind: "bool",
			hint: "(关掉每次省约 1500 token)",
		},
		{ key: "mcp", label: "MCP", value: "", kind: "mcp", hint: "(回车勾选能连什么 —— 跟工作目录无关)" },
		{
			key: "dispatchable",
			label: "可派发",
			value: o.dispatchable ? "是" : "否",
			kind: "bool",
			readonly: o.dispatchNote !== undefined,
			hint: o.dispatchNote ?? "(关掉 = 写 demo: true：能看能改，但派不了)",
		},
		{
			key: "scope",
			label: "保存到",
			value: o.scope,
			kind: "enum",
			options: [SCOPE_GLOBAL, SCOPE_PROJECT],
			hint: "(全局在 ~/.pi/agent/assistants/)",
		},
		{
			key: "body",
			label: "提示词正文",
			value: `(${o.bodyChars} 字)`,
			kind: "action",
			hint: "回车 = 保存并打开编辑器",
		},
	];
}

/** 面板交回来的值 → 真正写盘 */
async function commitForm(
	ctx: ExtensionContext,
	o: { form: FormResult; cwd: string; original: Template | null },
): Promise<void> {
	const v = o.form.values;
	const key = (v.key ?? "").trim();
	if (!key) {
		ctx.ui.notify("「文件名」不能是空的，什么都没存。", "warning");
		return;
	}
	// 兜底：底座只读（正常路径已被 /assistants edit 拦住，这里防绕过）
	if (o.original?.base === true) {
		ctx.ui.notify(
			`「${o.original.key}」是底座（只读），不能保存。\n定制：/assistants new <你的名字> ${o.original.key}`,
			"warning",
		);
		return;
	}
	const timeout = (v.timeout ?? "").trim();
	if (timeout && !parseDuration(timeout)) {
		ctx.ui.notify(`看不懂的超时「${timeout}」（写成 10m / 90s / 1.5h），什么都没存。`, "warning");
		return;
	}
	const cwdIn = (v.cwd ?? "").trim() || o.cwd;
	if (!existsSync(cwdIn)) {
		ctx.ui.notify(`工作目录不存在：${cwdIn}\n什么都没存。`, "warning");
		return;
	}

	const file =
		(v.scope ?? "") === SCOPE_PROJECT
			? join(projectAssistantDir(o.cwd), `${key}.md`)
			: join(globalAssistantDir(), `${key}.md`);

	// 只有「提示词正文」那行被按了回车，才动正文 —— 平时改 MCP 不该顺手把正文覆盖了
	let body: string | undefined;
	if (o.form.openBody) {
		const edited = await ctx.ui.editor(`「${v.name || key}」的提示词正文`, o.original?.body ?? "");
		if (typeof edited === "string") body = edited;
	}

	const updates: Record<string, string | undefined> = {
		name: (v.name ?? "").trim() || key,
		desc: (v.desc ?? "").trim(),
		cwd: cwdIn,
		model: (v.model ?? "").trim(),
		timeout,
		agents_md: (v.agents_md ?? "是") === "是" ? undefined : "false",
		mcp: (v.mcp ?? "").trim(),
		demo: (v.dispatchable ?? "是") === "是" ? undefined : "true",
		extends: (v.extends ?? "").trim() && (v.extends ?? "").trim() !== BASE_NONE ? (v.extends ?? "").trim() : undefined,
	};

	// MCP 名字在三个来源里都找不到 → 问一声。
	// 不硬拦：你可能就是先把模板写好、回头再补连接。但得让你知道派发时会被拒。
	const wantMcp = (v.mcp ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const poolNow = loadMcpPool(cwdIn);
	const unknownMcp = wantMcp.filter((n) => !poolNow.servers[n]);
	if (unknownMcp.length) {
		const go = await ctx.ui.confirm(
			"这些 MCP 找不到定义",
			`${unknownMcp.join(", ")}\n\n` +
				`候选池里只有：${Object.keys(poolNow.servers).join(", ") || "(空)"}\n\n` +
				`存下去的话，这个助理派发时会被直接拒绝（不会“连不上还假装干活”）。\n仍要保存？`,
		);
		if (!go) {
			ctx.ui.notify(
				`没保存。\n补连接：把定义放进本地目录 ${localCatalogPath()}\n或者 /ai 从配置中心拉（会写到项目级）`,
				"info",
			);
			return;
		}
	}

	try {
		writeTemplate(file, updates, body);
	} catch (e) {
		ctx.ui.notify(`写入失败：${(e as Error).message}`, "error");
		return;
	}

	const notes: string[] = [];
	if (o.original && o.original.file !== file && existsSync(o.original.file)) {
		notes.push(`原来的那份没动：${o.original.file}（本项目里新的这份优先）`);
	}
	if (body === undefined && !o.original) notes.push(`正文还是空的 —— 用 /assistants open ${key} 去写`);
	ctx.ui.notify(`已保存\n${file}\n${notes.join("\n")}\n\n改模板不用 /reload，下次派发立即生效。`, "info");
}
function listAssistants(ctx: ExtensionContext, cwd: string): void {
	const tpls = loadTemplates(cwd);
	const dirs = templateDirs(cwd);
	if (!tpls.length) {
		ctx.ui.notify(
			`没有找到助理模板。\n找过：${dirs.length ? dirs.join("\n") : "(目录都不存在)"}\n` +
				`新建：/assistants new <名字>　或手动放到 ${join(getAgentDir(), "assistants")}`,
			"warning",
		);
		return;
	}
	const usable = tpls.filter((t) => t.base !== true && t.demo !== true);
	const bases = tpls.filter((t) => t.base === true);
	const demos = tpls.filter((t) => t.demo === true);
	const fmt = (t: Template): string =>
		`• ${t.key} — ${t.name}\n` +
		`    ${t.desc}\n` +
		`    cwd: ${t.cwd}　mcp: ${t.mcp.length ? t.mcp.join(", ") : "—"}　timeout: ${t.timeoutMs ? `${Math.round(t.timeoutMs / 60000)}m` : "默认"}` +
		(t.extends ? `\n    extends: ${t.extends}` : "");
	const fmtBase = (t: Template): string =>
		fmt(t) +
		`\n    → 基于它建：/assistants new <你的名字> ${t.key}　看原文：/assistants show ${t.key}`;
	const out = usable.length ? [`可派发的助理（${usable.length}）`, ...usable.map(fmt)] : ["可派发的助理（0）—— 现在没有能派的"];
	if (bases.length) out.push("", `基础模板 / 底座（${bases.length}，只读 + 只能 extends，不能直接派）`, ...bases.map(fmtBase));
	if (demos.length) out.push("", `示例模板（${demos.length}，给你看字段怎么写法的，不能派）`, ...demos.map(fmt));
	out.push(
		"",
		"细节：/assistants show <key>　配置：/assistants edit <key>　新建：/assistants new <key>　" +
			"从底座建：/assistants new <key> <底座key>",
	);
	ctx.ui.notify(out.join("\n"), "info");
}

function showAssistant(ctx: ExtensionContext, cwd: string, what: string): void {
	const tpl = findTemplate(cwd, what);
	if (!tpl) return notFound(ctx, cwd, what);
	const lines = [
		`${tpl.name}　(${tpl.key})`,
		`文件    ${tpl.file}`,
		`描述    ${tpl.desc}`,
		`目录    ${tpl.cwd}`,
		`MCP     ${tpl.mcp.length ? tpl.mcp.join(", ") : "(不连)"}${tpl.mcpExposure ? `　exposure: ${tpl.mcpExposure}` : ""}`,
		`模型    ${tpl.model ?? "(继承默认)"}`,
		`超时    ${tpl.timeoutMs ? `${tpl.timeoutMs} ms` : "(默认 5 分钟)"}`,
		`AGENTS  ${tpl.agentsMd === false ? "不带全局 AGENTS.md" : "带"}`,
		`继承    ${tpl.extends ?? "(无)"}`,
		`状态    ${tpl.demo === true ? "示例模板（不能派）" : tpl.base === true ? "基础模板（不能直接派）" : "可派发"}${tpl.enabled === false ? " · 已禁用" : ""}`,
	];
	const body = tpl.body ? `\n────── 提示词正文 ──────\n${tpl.body}` : "";
	ctx.ui.notify(`${lines.join("\n")}${body}`, "info");
}

async function editAssistant(ctx: ExtensionContext, cwd: string, what: string, focusKey?: string): Promise<void> {
	const tpl = findTemplate(cwd, what);
	if (!tpl) return notFound(ctx, cwd, what);
	// 底座是「公共父类」：被多个助理 extends，改坏 = 一起坏，而且很难发现。所以只读。
	if (tpl.base === true) {
		ctx.ui.notify(
			`「${tpl.key}」是底座（只读），不能改。\n\n` +
				`它由扩展提供，升级/重装会被还原 —— 改了也白改。\n` +
				`想定制：/assistants new <你的名字> ${tpl.key}   ← 会自动 extends 它\n` +
				`只想看它写了什么：/assistants show ${tpl.key}`,
			"warning",
		);
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("这个命令需要交互界面（TUI）。", "warning");
		return;
	}

	const pool = loadMcpPool(tpl.cwd);
	const fields = buildFields({
		key: tpl.key,
		name: tpl.name,
		desc: tpl.desc,
		cwd: tpl.cwd,
		model: tpl.model ?? "",
		timeout: tpl.timeoutMs ? humanTimeout(tpl.timeoutMs) : "",
		agentsMd: tpl.agentsMd !== false,
		dispatchable: tpl.demo !== true,
		dispatchNote: tpl.base === true ? "(base：底座，不能在这儿改)" : undefined,
		scope: isProjectFile(tpl.file, cwd) ? SCOPE_PROJECT : SCOPE_GLOBAL,
		bodyChars: tpl.body.length,
		keyEditable: false,
		extendsKey: tpl.extends ?? "",
		bases: availableBases(cwd).map((b) => ({ key: b.key, name: b.name })),
	});
	const r = await showForm(ctx, `${tpl.name} · 配置`, fields, mcpItems(pool, tpl.mcp), focusKey);
	if (!r) {
		ctx.ui.notify("已取消，什么都没改。", "info");
		return;
	}
	await commitForm(ctx, { form: r, cwd, original: tpl });
}

async function newAssistant(ctx: ExtensionContext, cwd: string, key: string, baseKey?: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("这个命令需要交互界面（TUI）。", "warning");
		return;
	}
	if (key && existsSync(join(globalAssistantDir(), `${key}.md`))) {
		ctx.ui.notify(`已经有个全局模板叫「${key}」了。\n想改它：/assistants edit ${key}`, "warning");
		return;
	}
	const bases = availableBases(cwd);
	// 底座只认存在的；写错了就当没写（表单里也能看到有哪些）
	const wantBase = (baseKey ?? "").trim();
	const extendsKey = wantBase && bases.some((b) => b.key === wantBase) ? wantBase : "";
	const baseTpl = extendsKey ? bases.find((b) => b.key === extendsKey) : undefined;
	const pool = loadMcpPool(cwd);
	const fields = buildFields({
		key,
		name: key,
		desc: "",
		cwd,
		model: "",
		timeout: "",
		agentsMd: true,
		dispatchable: true,
		scope: SCOPE_GLOBAL,
		bodyChars: 0,
		keyEditable: true,
		extendsKey,
		bases: bases.map((b) => ({ key: b.key, name: b.name })),
	});
	const r = await showForm(
		ctx,
		extendsKey ? `助理模板 · 新建（基于 ${extendsKey}）` : "助理模板 · 新建",
		fields,
		mcpItems(pool, baseTpl?.mcp ?? []),
		"key",
	);
	if (!r) {
		ctx.ui.notify("已取消，什么都没建。", "info");
		return;
	}
	await commitForm(ctx, { form: r, cwd, original: null });
}
function openAssistant(ctx: ExtensionContext, cwd: string, what: string): void {
	const tpl = findTemplate(cwd, what);
	if (!tpl) return notFound(ctx, cwd, what);
	// 底座放行（有时你就想看看原文），但先说清楚它是只读的
	if (tpl.base === true) {
		ctx.ui.notify(
			`「${tpl.key}」是底座（只读）：当参考看就行，改了下次同步会被还原。\n` +
				`要定制请：/assistants new <你的名字> ${tpl.key}`,
			"info",
		);
	}
	try {
		const opt = { detached: true, stdio: "ignore" as const, windowsHide: true };
		if (process.platform === "win32") spawn("cmd", ["/c", "start", "", tpl.file], opt).unref();
		else if (process.platform === "darwin") spawn("open", [tpl.file], opt).unref();
		else spawn("xdg-open", [tpl.file], opt).unref();
		ctx.ui.notify(`已用默认程序打开：\n${tpl.file}`, "info");
	} catch (e) {
		ctx.ui.notify(`打不开：${(e as Error).message}\n手动改：${tpl.file}`, "error");
	}
}

// ======================= /resume-agent：翻助理的会话 =======================
/** 列表一次最多列这么多条 */
const SESSION_LIST_LIMIT = 30;

interface AgentSession {
	file: string;
	key: string;
	ts: number;
	name: string;
	first: string;
	kb: number;
}

/** 只读到“会话名 + 首条任务”就停（文件再大也只扫一遍行） */
function readSessionHead(file: string): { name: string; first: string } {
	let name = "";
	let first = "";
	let text = "";
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return { name, first };
	}
	for (const line of text.split("\n")) {
		if (!name && line.includes('"session_info"')) {
			try {
				const d = JSON.parse(line) as { type?: string; name?: string };
				if (d.type === "session_info" && d.name) name = d.name;
			} catch {
				/* ignore */
			}
		}
		if (!first && line.includes('"role":"user"')) {
			try {
				const d = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
				if (d.type === "message" && d.message?.role === "user") {
					const c = d.message.content;
					first =
						typeof c === "string"
							? c
							: Array.isArray(c)
								? c.map((x) => (x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : "")).join(" ")
								: "";
				}
			} catch {
				/* ignore */
			}
		}
		if (name && first) break;
	}
	return { name: name.trim(), first: first.replace(/\s+/g, " ").trim() };
}

/** 扫 ~/.pi/agent/assistant-sessions/<助理>/，按时间倒序 */
function scanAssistantSessions(onlyKey?: string): AgentSession[] {
	const root = assistantSessionRoot();
	let keys: string[] = [];
	try {
		keys = readdirSync(root).filter((k) => {
			try {
				return statSync(join(root, k)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}

	const rows: AgentSession[] = [];
	for (const key of keys) {
		if (onlyKey && key !== onlyKey) continue;
		const dir = join(root, key);
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const file = join(dir, f);
			try {
				const st = statSync(file);
				const head = readSessionHead(file);
				rows.push({ file, key, ts: st.mtimeMs, name: head.name, first: head.first, kb: Math.round(st.size / 1024) });
			} catch {
				continue;
			}
		}
	}
	rows.sort((a, b) => b.ts - a.ts);
	return rows;
}

function fmtClock(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 记录「主会话」路径，供 /agent-resume-back 切回来。
 *  为什么存文件而不是内存变量：切会话时扩展模块会重载，内存变量会丢。 */
function returnPathFile(): string {
	return join(getAgentDir(), ".return-to-main");
}
function saveReturnPath(file: string): void {
	try {
		writeFileSync(returnPathFile(), file, "utf8");
	} catch {
		// 写不进去就算了，/agent-resume-back 会提示找不到
	}
}
function loadReturnPath(): string | undefined {
	try {
		const p = readFileSync(returnPathFile(), "utf8").trim();
		return p || undefined;
	} catch {
		return undefined;
	}
}

async function resumeAgent(ctx: ExtensionCommandContext, arg: string): Promise<void> {
	const only = (arg ?? "").trim().split(/\s+/).filter(Boolean)[0];
	const rows = scanAssistantSessions(only);
	if (!rows.length) {
		ctx.ui.notify(
			only
				? `没找到助理「${only}」的会话。\n助理会话目录：${assistantSessionRoot()}`
				: `还没有助理会话。\n派活之后它们会出现在：${assistantSessionRoot()}`,
			"info",
		);
		return;
	}

	const shown = rows.slice(0, SESSION_LIST_LIMIT);
	const labels = shown.map(
		(r, i) =>
			`${String(i + 1).padStart(2, "0")}  ${fmtClock(r.ts)} · ${r.key} · ${r.name || "(无名)"} · ${r.kb}KB · ${r.first.slice(0, 36) || "(无任务)"}`,
	);
	const picked = await ctx.ui.select(`助理会话（${shown.length}/${rows.length} 条，选中后切过去看，Esc 取消）`, labels);
	if (!picked) return;
	const row = shown[labels.indexOf(picked)];
	if (!row) return;

	// 切走前记下主会话路径，/agent-resume-back 才能一键回来（/resume 在助理会话里看不到主会话）
	const prev = ctx.sessionManager.getSessionFile();
	if (prev) saveReturnPath(prev);

	const back = "想回来：/agent-resume-back（一键返回主会话）。";
	if (!ctx.hasUI) {
		ctx.ui.notify(`${row.key} · ${row.name}\n${row.file}\n\n查看：pi --session "${row.file}"\n回来：/agent-resume-back`, "info");
		return;
	}
	await ctx.switchSession(row.file, {
		withSession: async (next) => {
			next.ui.notify(`已切到助理会话：${row.key} · ${row.name || "(无名)"}\n${back}`, "info");
		},
	});
}

/** /agent-resume-back：从助理会话切回主会话 */
async function backToMain(ctx: ExtensionCommandContext): Promise<void> {
	const target = loadReturnPath();
	if (!target || !existsSync(target)) {
		ctx.ui.notify(
			"没找到可返回的主会话路径。\n你大概本来就已在主会话里，或还没用 /resume-agent 切进过助理会话。",
			"info",
		);
		return;
	}
	if (ctx.sessionManager.getSessionFile() === target) {
		ctx.ui.notify("已经在主会话里了。", "info");
		return;
	}
	await ctx.switchSession(target, {
		withSession: async (next) => {
			next.ui.notify("已返回主会话。", "info");
		},
	});
}

// ======================= 后台轮询 + 自动回投 =======================
let apiRef: ExtensionAPI | undefined;
let bgTimer: ReturnType<typeof setInterval> | undefined;

/** 本实例当前所在的主会话身份（session_start 与每次派活时刷新）。
 *  后台结果只投给「派发它的那个会话」，所以要能认出「我是谁」。 */
let currentSessionFile: string | undefined;
let currentSessionId: string | undefined;

/** 刷新当前主会话身份。切会话（/resume、/new）也会触发 session_start，所以两头都刷。 */
function rememberCurrentSession(ctx: ExtensionContext): void {
	try {
		currentSessionFile = ctx.sessionManager?.getSessionFile?.() ?? currentSessionFile;
		currentSessionId = ctx.sessionManager?.getSessionId?.() ?? currentSessionId;
	} catch {
		/* 拿不到就算了 */
	}
}

/** 这条后台结果是不是本会话派发的？
 *  老记录（升级前留下的、没有 owner 字段）→ 按老行为投给当前会话，避免结果永远收不到。 */
function isOwnBgTask(t: BgTaskFile): boolean {
	if (!t.ownerSessionFile && !t.ownerSessionId) return true;
	if (t.ownerSessionFile && currentSessionFile) return t.ownerSessionFile === currentSessionFile;
	if (t.ownerSessionId && currentSessionId) return t.ownerSessionId === currentSessionId;
	return false; // 有 owner 但本会话身份还没认出来 → 先不投，等认出来再投
}

/** 退避上限：每次失败后隔多久再试（2^n 秒，封顶 30s） */
const DELIVER_BACKOFF_MAX_MS = 30 * 1000;
/** 超过这个时长还是发不出去 → 标 undelivered（不静默丢，但也不无限刷） */
const DELIVER_GIVEUP_MS = 10 * 60 * 1000;

function deliverBackoffMs(attempts: number): number {
	return Math.min(DELIVER_BACKOFF_MAX_MS, 1000 * 2 ** Math.min(attempts, 5));
}

/** 要投给主会话的文本 */
function bgDeliveryText(t: BgTaskFile): string {
	return (
		`子Agent「${t.name}」回来了（后台任务）\n${t.resultText || "（没有结果文本）"}\n\n` +
		`会话ID：${t.sessionId}（要翻看：/resume-agent）`
	);
}

/**
 * 把一条已完成的后台任务投给主会话。
 *
 * ⚠️ 必须 await：sendUserMessage 返回 Promise，它 reject 时不会被同步 try/catch 接住
 *    （之前就是这么“假成功”的：异常没接住，却照旧写了 delivered:true → 结果永久丢）。
 */
async function deliverBgTask(t: BgTaskFile): Promise<void> {
	if (!apiRef) throw new Error("apiRef 未就绪");
	// 主会话空闲时：prompt() 会直接起一轮（唤醒）；正在跑：排队（followUp，本轮结束接着跑）
	await apiRef.sendUserMessage(bgDeliveryText(t), { deliverAs: "followUp" });
}

/** 每秒扫一遍后台任务：终态、没回投过、且**属于本会话**的 → 回投 */
async function pollBgTasks(): Promise<void> {
	if (!apiRef) return;
	const now = Date.now();
	for (const t of listBgTasks()) {
		if (t.status === "running" || t.delivered) continue;
		// 归属校验：只投给派发它的那个主会话；别的会话/实例扫到也不投，避免串台
		if (!isOwnBgTask(t)) continue;
		if (t.undelivered) continue; // 自动重试已放弃，等手动
		const attempts = t.attempts ?? 0;
		// 退避：别每秒硬撞
		if (t.lastAttemptAt && now - t.lastAttemptAt < deliverBackoffMs(attempts)) continue;
		// 原子认领：同一会话开在多个实例上时，也只有一个能投（wx 创建失败=别人在投）
		const claim = bgFile(t.id) + ".claim";
		try {
			writeFileSync(claim, String(process.pid), { flag: "wx" });
		} catch {
			continue; // 别人正在投
		}
		try {
			await deliverBgTask(t);
			// 只有真发出去才标 delivered
			writeBgTask({ ...t, delivered: true, attempts: attempts + 1, lastAttemptAt: now, lastError: undefined });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const firstFailAt = t.firstFailAt ?? now;
			const giveUp = now - firstFailAt > DELIVER_GIVEUP_MS;
			writeBgTask({
				...t,
				delivered: false,
				attempts: attempts + 1,
				lastAttemptAt: now,
				firstFailAt,
				lastError: msg,
				undelivered: giveUp, // 超时→不再自动重试，但也不静默丢（面板 + /agents bg 能看到）
			});
		} finally {
			try {
				rmSync(claim, { force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

/** 未投递出去的条数（面板提示用） */
export function undeliveredBgCount(): number {
	try {
		return listBgTasks().filter((t) => t.status !== "running" && !t.delivered).length;
	} catch {
		return 0;
	}
}

/** 孤儿任务清理：running 但超过 10 分钟（正常 timeout 最多 5 分钟）→ 标 failed */
function reapStaleBgTasks(): void {
	const now = Date.now();
	for (const t of listBgTasks()) {
		if (t.status === "running" && now - t.startedAt > 10 * 60 * 1000) {
			writeBgTask({
				...t,
				status: "failed",
				resultText: "（孤儿任务：子进程已消失，标记为失败）",
				finishedAt: now,
				delivered: false,
			});
		}
	}
}

// ======================= 会话运行锁（防同会话并发运行）=======================
// 为什么用文件锁：并发可能来自**不同进程**（另一次 resume、另一个 pi 实例），内存变量管不着。
// 锁 = assistant-sessions/.locks/<会话ID>.lock，用 wx 原子创建抢；pid 死了或太旧算死锁，可接管。
function lockRoot(): string {
	const d = join(assistantSessionRoot(), ".locks");
	try {
		mkdirSync(d, { recursive: true });
	} catch {
		/* ignore */
	}
	return d;
}
function lockFile(sessionId: string): string {
	return join(lockRoot(), `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
}
/** 超过这个时长一律视为死锁（正常 timeout 最多 5 分钟，给足余量） */
const STALE_LOCK_MS = 15 * 60 * 1000;

interface LockInfo {
	pid: number;
	sessionId: string;
	label: string;
	startedAt: number;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function lockIsStale(info: Partial<LockInfo>): boolean {
	return (
		typeof info.pid !== "number" ||
		!pidAlive(info.pid) ||
		!info.startedAt ||
		Date.now() - info.startedAt > STALE_LOCK_MS
	);
}

/** 抢会话锁。ok=true 才能起进程；ok=false 说明该会话正被别处运行。 */
function acquireSessionLock(sessionId: string, label: string): { ok: true } | { ok: false; holder: string } {
	const f = lockFile(sessionId);
	const payload = JSON.stringify({ pid: process.pid, sessionId, label, startedAt: Date.now() });
	try {
		writeFileSync(f, payload, { flag: "wx" }); // 原子：已存在就抛
		return { ok: true };
	} catch {
		/* 已存在 → 看是不是死锁 */
	}
	try {
		const info = JSON.parse(readFileSync(f, "utf8")) as Partial<LockInfo>;
		if (lockIsStale(info)) {
			writeFileSync(f, payload, "utf8"); // 接管死锁
			return { ok: true };
		}
		const since = info.startedAt ? fmtClock(info.startedAt) : "?";
		return { ok: false, holder: `${info.label || "另一个运行"}（pid ${info.pid}，${since} 起）` };
	} catch {
		/* 锁文件坏了 → 覆盖 */
		try {
			writeFileSync(f, payload, "utf8");
			return { ok: true };
		} catch {
			return { ok: false, holder: "未知（锁文件不可读写）" };
		}
	}
}

function releaseSessionLock(sessionId: string): void {
	try {
		rmSync(lockFile(sessionId), { force: true });
	} catch {
		/* ignore */
	}
}

/** 回收死锁（session_start 时跑一遍）：pid 已死或超时的锁文件删掉 */
function reapStaleLocks(): void {
	const root = lockRoot();
	let files: string[] = [];
	try {
		files = readdirSync(root).filter((f) => f.endsWith(".lock"));
	} catch {
		return;
	}
	for (const f of files) {
		const p = join(root, f);
		try {
			const info = JSON.parse(readFileSync(p, "utf8")) as Partial<LockInfo>;
			if (lockIsStale(info)) rmSync(p, { force: true });
		} catch {
			try {
				rmSync(p, { force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

// ======================= 并发上限（信号量）=======================
/** 同时最多跑几个助理（超出的排队）。防一次 tasks 派太多把机器/额度打爆。 */
const MAX_CONCURRENT_RUNS = 4;
let activeRuns = 0;
const runSlotWaiters: Array<() => void> = [];

/** 排队拿一个运行名额。拿到后必须调 releaseRunSlot()。 */
async function acquireRunSlot(): Promise<void> {
	if (activeRuns < MAX_CONCURRENT_RUNS) {
		activeRuns++;
		return;
	}
	await new Promise<void>((resolve) => {
		runSlotWaiters.push(() => {
			activeRuns++;
			resolve();
		});
	});
}

function releaseRunSlot(): void {
	activeRuns = Math.max(0, activeRuns - 1);
	const next = runSlotWaiters.shift();
	if (next) next();
}

// ======================= 注册 =======================
export function setupDelegate(api: ExtensionAPI): void {
	ensureCatalog(); // 本地 MCP 目录文件不存在就建个空壳
	apiRef = api; // 供后台轮询回投用

	// 后台任务轮询：session_start 挂 timer，session_shutdown 清理（与 panel.ts 同一套模式）
	api.on("session_start", async (_event, ctx) => {
		rememberCurrentSession(ctx); // 记下「我是哪个会话」，后台结果靠它认领
		reapStaleBgTasks(); // 先清理上个会话留下的孤儿任务
		reapStaleLocks(); // 再回收 pid 已死/超时的会话运行锁
		reapStaleShadowDirs(); // 再回收过期的影子目录（每次派发一个，超 24h 的删）
		if (bgTimer) clearInterval(bgTimer);
		bgTimer = setInterval(() => {
			// 注意：pollBgTasks 是 async，rejection 只能这样接
			void pollBgTasks().catch(() => {
				/* 单轮出错别把进程干挂 */
			});
		}, 1000);
	});
	api.on("session_shutdown", async () => {
		if (bgTimer) clearInterval(bgTimer);
		bgTimer = undefined;
	});
	// 兑底：agent 一变空闲就查一次。
	// 为什么需要：1 秒定时器是 session_start 挂的，如果 /reload 之后 session_start 没触发，
	// 定时器就不在 —— 光靠它会出现“助理回来了但没人去投”。agent_settled 每个 turn 结束都会来。
	api.on("agent_settled", async () => {
		// 稍微延后：避开 settle 事件自身的重入窗口（这一刻直接 prompt 可能被拒）
		setTimeout(() => {
			void pollBgTasks().catch(() => {
				/* ignore */
			});
		}, 300);
	});
	// 助理清单在加载时算一次，拼进工具参数描述（零额外开销）
	const params = makeDelegateParams(assistantHint(process.cwd()));

	api.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"把任务派给**临时助理**（另起独立 pi 进程），只把卡片（状态/结论/证据）带回来。\n" +
			"【自己做，别派】1~2 次工具调用就能完事 / 要跟用户来回确认 / 要用当前对话的上下文 / 要改**当前仓库**（改完你还得复核）。这类派出去只会更慢更贵。\n" +
			"【该派】过程长而脏（大量探查、批量扫描、跑测试、翻几十个文件）而你**只要结论** / 几件互不依赖的活并行(tasks) / 要在**另一个项目目录**干活。\n" +
			"【成本】每个助理 = 一个独立进程 + 一次完整模型上下文。派之前先自问：这件事我自己两步能做完吗？能，就自己做。\n" +
			"多件互不依赖用 tasks 并行派；超时/失败过的用 resume 续跑；助理不能互相派活；会话名/ID 会回报，要翻看用 /resume-agent。",
		parameters: params,

		async execute(
			_toolCallId: string,
			params: { assistant: string; task?: string; tasks?: string[]; resume?: string; timeoutMs?: number; wait?: boolean },
			signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			// wait 参数优先；没传才用 /delegate-mode 的默认（默认异步）
			const wait = params.wait ?? (readDelegateMode() === "sync");
			const cwd = ctx.cwd ?? process.cwd();
			const templates = loadTemplates(cwd);
			const tpl = templates.find((t) => t.key === params.assistant || t.name === params.assistant);

			if (!tpl) {
				const can = templates.filter((t) => t.base !== true && t.demo !== true);
				const have = can.length
					? `可派的有：${can.map((t) => `${t.key}(${t.name})`).join(", ")}`
					: `可是现在**一个能派的都没有**（只有 base 和示例模板，用 /assistants 看）`;
				return {
					content: [{ type: "text" as const, text: `找不到助理「${params.assistant}」。${have}` }],
					details: { ok: false, reason: "template_not_found" },
				};
			}

			// demo:true 是「示例模板」—— 只是拿来示范字段写法的，能看不能派
			if (tpl.demo === true) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`「${tpl.name}」是示例模板（demo: true），不能派。` +
								`它只是给你看字段怎么写法的 —— 想去掉限制就把它 frontmatter 里的 demo 那行删了。`,
						},
					],
					details: { ok: false, reason: "template_is_demo" },
				};
			}

			// base:true 是「基础模板」，只给 extends 用，不能直接派
			if (tpl.base === true) {
				const kids = templates.filter((t) => t.extends === tpl.key).map((t) => t.key);
				return {
					content: [
						{
							type: "text" as const,
							text:
								`「${tpl.name}」是基础模板（base: true），不能直接派。` +
								(kids.length ? `请派继承了它的：${kids.join(", ")}` : `目前没有模板继承它，要去改它的子模板。`),
						},
					],
					details: { ok: false, reason: "template_is_base" },
				};
			}

			if (!existsSync(tpl.cwd)) {
				return {
					content: [{ type: "text" as const, text: `助理「${tpl.name}」的工作目录不存在：${tpl.cwd}` }],
					details: { ok: false, reason: "cwd_not_found" },
				};
			}

			// 白名单 + 挂了 MCP，但没列 mcp__ 工具 → 直接拒绝（否则 MCP 会静默不可用）
			if (tpl.tools?.length && tpl.mcp.length > 0) {
				const hasMcpTool = tpl.tools.some((t) => t.startsWith("mcp__"));
				const hasCodemode = tpl.tools.includes("codemode");
				if (!hasMcpTool && !hasCodemode) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`「${tpl.name}」用了工具白名单（tools:），又挂了 MCP（${tpl.mcp.join(", ")}），` +
									`但白名单里没有任何 mcp__ 工具 —— 这样 MCP 工具会静默不可用：\n\n` +
									`  tools: ${tpl.tools.join(", ")}\n\n` +
									`修法二选一：\n` +
									`  ① 把要用的 MCP 工具名（mcp__<server>__<tool>）也写进 tools；\n` +
									`  ② 或者把 codemode 写进 tools（MCP 以 codemode 暴露时）。\n` +
									`看某台 MCP 有哪些工具：pi 里敲 /mcp 选那个 server。`,
							},
						],
						details: { ok: false, reason: "tools_allowlist_blocks_mcp" },
					};
				}
			}

			const resumeId = params.resume?.trim() || undefined;
			let list = (params.tasks ?? (params.task ? [params.task] : []))
				.map((s) => String(s).trim())
				.filter((s) => s.length > 0);
			if (resumeId) list = list.slice(0, 1); // 续跑只能配一件
			if (!list.length) {
				return {
					content: [{ type: "text" as const, text: "没给任务。用 task（一件）或 tasks（多件并行）。" }],
					details: { ok: false, reason: "no_task" },
				};
			}

			const raw =
				params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : (tpl.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const total = Math.min(Math.max(raw, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
			const main = mainName(ctx);
			rememberCurrentSession(ctx); // 刷新本会话身份（异步回投靠它认领）
			const running = `${list.length > 1 ? `×${list.length} ` : ""}`;

			// 建影子 agentDir：只放进本模板声明的那些 MCP（真正的「按需给」）
			const pool = loadMcpPool(tpl.cwd);
			const shadow = buildShadow(tpl.key, tpl.mcp, pool, {
				agentsMd: tpl.agentsMd !== false,
				exposure: tpl.mcpExposure,
				// 每次派发一个独立影子目录：同一个助理并发派发不再互相覆盖 mcp.json
				runSuffix: Math.random().toString(36).slice(2, 8),
			});
			// 关键配置没写成功 → 直接拒绝启动（否则可能挂着错的 MCP 还假装在干活）
			if (shadow.errors.length) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`「${tpl.name}」的隔离配置没建成功，已拒绝启动：\n  ${shadow.errors.join("\n  ")}\n\n` +
								`影子目录：${shadow.dir}\n` +
								`检查那个目录能不能写（磁盘满 / 权限 / 杀软占用）。`,
						},
					],
					details: { ok: false, reason: "shadow_build_failed", errors: shadow.errors },
				};
			}
			// 要的 MCP 一个都找不到 → 直接拒绝。
			// 为什么不只 warn：一个连不上库的「数据库助理」会假装在干活、给你编结果，
			// 这比直接失败更吓人。此处还没进 Promise.all(runAssistant)，子进程一个都不会起。
			if (shadow.missing.length) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`「${tpl.name}」要的 MCP 找不到定义：${shadow.missing.join(", ")}\n` +
								` 实际挂上：${shadow.names.join(", ") || "(一个都没有)"}\n` +
								` 候选池里只有：${Object.keys(pool.servers).join(", ") || "(空)"}\n\n` +
								`三个来源（同名后者覆盖）：\n` +
								`  本地目录  ${localCatalogPath()}\n` +
								`  用户级    ${join(getAgentDir(), "mcp.json")}\n` +
								`  项目级    ${join(tpl.cwd, ".pi", "mcp.json")}\n\n` +
								`补法：把定义写进本地目录（它不会被主会话自动加载，只当助理候选），` +
								`或者 /assistants edit ${tpl.key} 改挂一个池子里已有的。`,
						},
					],
					details: { ok: false, reason: "mcp_not_found", missing: shadow.missing },
				};
			}

			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `📤 ${tpl.name} ${running}干活中…`));
			}
			// 清掉上一轮的旧账，面板上只留这一批
			beginRun();
			ensureAgentPanel(ctx);

			let results: RunResult[];
			if (wait) {
				try {
					results = await Promise.all(
						list.map((task) => {
							const seq = resumeId ? 0 : nextSeq(tpl.key);
							const names = buildNames(main, tpl, seq, resumeId);
							return runAssistant(tpl, task, {
								timeoutMs: total,
								signal,
								names,
								resumed: Boolean(resumeId),
								shadowDir: shadow.dir,
								sessionDir: ensureAssistantSessionDir(tpl.key),
							});
						}),
					);
				} finally {
					if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
					// 跑完了不马上收面板：留一会儿让你看完，再自动收起（其间又派活会取消）
					autoClosePanel(ctx);
				}
			} else {
				// 异步：派完就走，登记后台任务；子进程后台跑，完成由轮询回投（见 pollBgTasks）
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
				const ids: string[] = [];
				for (const task of list) {
					const seq = resumeId ? 0 : nextSeq(tpl.key);
					const names = buildNames(main, tpl, seq, resumeId);
					// bg 文件名加随机后缀：中文 key 会被 sanitize 掉，两个助理同一秒派发会撞 id、互相覆盖 .bg 文件
					const bgId = `${names.id}-${Math.random().toString(36).slice(2, 8)}`;
					ids.push(names.id);
					writeBgTask({
						id: bgId, key: tpl.key, name: tpl.name, task, sessionId: names.id,
						startedAt: Date.now(), status: "running",
						ownerSessionFile: currentSessionFile,
						ownerSessionId: currentSessionId,
					});
					void runAssistant(tpl, task, {
						timeoutMs: total,
						// 不传 signal：不随本轮 turn 结束被 abort
						names,
						resumed: Boolean(resumeId),
						shadowDir: shadow.dir,
						sessionDir: ensureAssistantSessionDir(tpl.key),
						onSettle: (r) => {
							const prev = readBgTask(bgId) ?? {
								id: bgId, key: tpl.key, name: tpl.name, task, sessionId: names.id,
								startedAt: Date.now(), status: "running" as const,
								ownerSessionFile: currentSessionFile,
								ownerSessionId: currentSessionId,
							};
							writeBgTask({
								...prev,
								status: outcomeToStatus(r.outcome),
								resultText: renderCard(r),
								finishedAt: Date.now(),
								delivered: false,
							});
						},
					}).catch(() => { /* runAssistant 自身不 reject，兜底 */ });
				}
				return {
					content: [
						{
							type: "text" as const,
							text:
								`已派发 ${list.length} 个任务给「${tpl.name}」（后台跑，完成后自动回投主会话）：\n` +
								ids.map((id) => `  · 会话ID ${id}`).join("\n") +
								`\n\n中途想切同步/异步：/delegate-mode async | sync`,
						},
					],
					details: { ok: true, async: true, sessions: ids },
				};
			}

			const sep = `\n\n${"─".repeat(48)}\n\n`;
			const text = results.map(renderCard).join(sep);
			const ok = results.every((r) => r.outcome === "done");

			return {
				content: [{ type: "text" as const, text }],
				details: {
					ok,
					elapsedMs: Math.max(...results.map((r) => r.elapsedMs)),
					outcomes: results.map((r) => r.outcome),
					sessions: results.map((r) => r.names.id),
				},
			};
		},
	});

	api.registerCommand("assistants", {
		description: "助理模板：直接敲列出；show / edit / mcp / new / open <名字>",
		handler: async (args: string, ctx: ExtensionContext) => {
			const cwd = ctx.cwd ?? process.cwd();
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();
			const rest = parts.slice(1).join(" ");

			if (sub === "show") return showAssistant(ctx, cwd, rest);
			if (sub === "edit") return editAssistant(ctx, cwd, rest);
			if (sub === "mcp") return editAssistant(ctx, cwd, rest, "mcp");
			if (sub === "new") return newAssistant(ctx, cwd, parts[1] ?? "", parts[2]);
			if (sub === "open") return openAssistant(ctx, cwd, rest);
			return listAssistants(ctx, cwd);
		},
	});

	api.registerCommand("resume-agent", {
		description: "翻看助理的历次会话（它们不在 /resume 里）；可 /resume-agent db 只看某个助理",
		handler: async (args: string, ctx) => resumeAgent(ctx, args ?? ""),
	});

	api.registerCommand("agent-resume-back", {
		description: "从助理会话一键返回主会话（/resume 在助理会话里看不到主会话，用这个）",
		handler: async (_args: string, ctx) => backToMain(ctx),
	});

	api.registerCommand("delegate-mode", {
		description: "切 delegate 默认模式：async=派完就走+自动回投（默认），sync=派完等结果",
		handler: async (args: string, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			const cur = readDelegateMode();
			if (!sub) {
				ctx.ui.notify(`delegate 默认模式：${cur}\n用法：/delegate-mode async | sync`, "info");
				return;
			}
			if (sub === "async" || sub === "sync") {
				writeDelegateMode(sub);
				ctx.ui.notify(`delegate 默认模式已切成：${sub}\n（delegate 工具没传 wait 时按这个来；传了 wait 以 wait 为准）`, "info");
				return;
			}
			ctx.ui.notify(`不认识「${sub}」。用法：/delegate-mode [async|sync]`, "info");
		},
	});

	// ---------- /agents：子代理实时面板 ----------
	api.registerCommand("agents", {
		description:
			"子代理实时面板：直接敲=开；off 关；detail 展开思考；text 打印快照；" +
			"float 改成右侧浮层，widget 改回看板上方；" +
			"bg 看后台任务状态（失败原因），bg redeliver 把没投回主会话的立刻重投",
		handler: async (args: string, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();

			if (sub === "off" || sub === "close") {
				closeAgentPanel({ user: true });
				ctx.ui.notify("子代理面板已关闭（下次派活不再自动弹出；/agents 可手动叫回）", "info");
				return;
			}
			if (sub === "detail") {
				const on = toggleDetail();
				ctx.ui.notify(on ? "思考过程：展开" : "思考过程：折叠", "info");
				return;
			}
			if (sub === "text") {
				const lines = snapshotLines();
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "widget" || sub === "w" || sub === "fixed") {
				setPreferOverlay(false);
				closeAgentPanel({ user: false });
				openAgentPanel(ctx, { force: true });
				ctx.ui.notify(`面板形态：${panelMode()}（看板正上方的整宽面板）`, "info");
				return;
			}
			if (sub === "overlay" || sub === "float") {
				setPreferOverlay(true);
				closeAgentPanel({ user: false });
				openAgentPanel(ctx, { force: true });
				ctx.ui.notify(`面板形态：${panelMode()}（右侧浮层，会盖住一块）`, "info");
				return;
			}

			// --- 后台任务：看状态 / 手动重投（卡住时的救急口）---
			if (sub === "bg" || sub.startsWith("bg ")) {
				const action = sub.slice(2).trim();
				const all = listBgTasks().sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
				if (!all.length) {
					ctx.ui.notify("没有后台任务记录。", "info");
					return;
				}
				if (action === "redeliver" || action === "retry") {
					let n = 0;
					for (const t of all) {
						if (t.status === "running" || t.delivered) continue;
						if (!isOwnBgTask(t)) continue;
						// 清掉「已放弃」和退避计时，立即重试
						writeBgTask({ ...t, undelivered: false, firstFailAt: undefined, attempts: 0, lastAttemptAt: undefined });
						n++;
					}
					await pollBgTasks();
					ctx.ui.notify(
						n ? `已重投 ${n} 条 —— 看主对话有没有冒出新消息` : "没有可重投的（都投过了，或不属于本会话）",
						"info",
					);
					return;
				}
				const lines = all.slice(0, 20).map((t) => {
					const mine = isOwnBgTask(t) ? "" : "  ⚠别的会话";
					const st = t.delivered
						? "已投"
						: t.undelivered
							? "未投(已放弃)"
							: t.status === "running"
								? "跑着"
								: "待投";
						const err = t.lastError ? `  失败:${shortText(t.lastError, 36)}` : "";
						return `${fmtClock(t.startedAt)} ${t.key} · ${st} · 试${t.attempts ?? 0}次${mine}${err}`;
				});
				ctx.ui.notify(
					`后台任务 ${all.length} 条（最多列 20）：\n${lines.join("\n")}\n\n重投未投递的：/agents bg redeliver`,
					"info",
				);
				return;
			}

			// 直接敲 /agents = 打开（并解开「用户关过」的封印）；形态沿用上次选的
			openAgentPanel(ctx, { force: true });
			ctx.ui.notify(`子代理面板：${panelMode()}`, "info");
		},
	});
}
