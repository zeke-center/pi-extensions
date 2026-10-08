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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { type FormResult, type FormField, showForm, type PickItem } from "./form";
import { addJob, beginRun, consume, markEnd, newJob, type EndStatus, type LiveJob } from "./live";
import { autoClosePanel, closeAgentPanel, ensureAgentPanel, openAgentPanel, panelMode, setPreferOverlay, snapshotLines, toggleDetail } from "./panel";
import { assistantSessionRoot, buildShadow, ensureCatalog, loadMcpPool, localCatalogPath, type McpPool } from "./mcp-pool";

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

type Outcome = "done" | "timeout" | "failed" | "empty";

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

function spawnWatched(argv: string[], cwd: string, extraEnv: Record<string, string> = {}): ChildProcess {
	installExitHook();
	const child = spawn(process.execPath, ["-e", WATCHDOG_SRC], {
		cwd,
		env: {
			...process.env,
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
	signal: AbortSignal;
	names: Names;
	resumed: boolean;
	/** 影子 agentDir（只含本助理该有的 mcp.json） */
	shadowDir: string;
	/** 助理专属会话目录（不在 sessions/ 下，/resume 看不见） */
	sessionDir: string;
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

function runAssistant(tpl: Template, task: string, opt: RunOptions): Promise<RunResult> {
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

	const cli = resolveCli();
	if (!cli) {
		sink.stderr = "找不到 pi 的 CLI 入口。请设置环境变量 PI_CLI 指向 pi 的 cli.js。";
		return Promise.resolve(base("failed", null));
	}

	// 实时视图：从 spawn 起，子进程每个 JSON 事件都会同时喂给它（面板据此实时画）
	const job = newJob({ key: tpl.key, name: tpl.name, task, sessionId: opt.names.id, startedAt: started });
	sink.live = job;
	addJob(job);

	// -xt：助理不需要面板工具（影子目录下本来也没有 ai-configure，这里是双保险）
	const args = [cli, "-p", "--mode", "json", "-xt", "delegate,progress"];
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

		const child = spawnWatched(args, tpl.cwd, {
			PI_CODING_AGENT_DIR: opt.shadowDir,
			...tpl.env,
		});

		const finish = (outcome: Outcome, exitCode: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opt.signal.removeEventListener("abort", onAbort);
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
			done(base(outcome, exitCode));
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child); // 到点就杀，绝不留孤儿；要接着做靠 resume 续跑
		}, opt.timeoutMs);

		const onAbort = (): void => {
			timedOut = false;
			killTree(child);
		};
		opt.signal.addEventListener("abort", onAbort);

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
			if (opt.signal.aborted) {
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
	});
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
}): FormField[] {
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
	const out = usable.length ? [`可派发的助理（${usable.length}）`, ...usable.map(fmt)] : ["可派发的助理（0）—— 现在没有能派的"];
	if (bases.length) out.push("", `基础模板（${bases.length}，只给 extends 用，不能直接派）`, ...bases.map(fmt));
	if (demos.length) out.push("", `示例模板（${demos.length}，给你看字段怎么写法的，不能派）`, ...demos.map(fmt));
	out.push("", "细节：/assistants show <key>　配置：/assistants edit <key>　新建：/assistants new <key>");
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
	});
	const r = await showForm(ctx, `${tpl.name} · 配置`, fields, mcpItems(pool, tpl.mcp), focusKey);
	if (!r) {
		ctx.ui.notify("已取消，什么都没改。", "info");
		return;
	}
	await commitForm(ctx, { form: r, cwd, original: tpl });
}

async function newAssistant(ctx: ExtensionContext, cwd: string, key: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("这个命令需要交互界面（TUI）。", "warning");
		return;
	}
	if (key && existsSync(join(globalAssistantDir(), `${key}.md`))) {
		ctx.ui.notify(`已经有个全局模板叫「${key}」了。\n想改它：/assistants edit ${key}`, "warning");
		return;
	}
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
	});
	const r = await showForm(ctx, "助理模板 · 新建", fields, mcpItems(pool, []), "key");
	if (!r) {
		ctx.ui.notify("已取消，什么都没建。", "info");
		return;
	}
	await commitForm(ctx, { form: r, cwd, original: null });
}
function openAssistant(ctx: ExtensionContext, cwd: string, what: string): void {
	const tpl = findTemplate(cwd, what);
	if (!tpl) return notFound(ctx, cwd, what);
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

// ======================= 注册 =======================
export function setupDelegate(api: ExtensionAPI): void {
	ensureCatalog(); // 本地 MCP 目录文件不存在就建个空壳
	// 助理清单在加载时算一次，拼进工具参数描述（零额外开销）
	const params = makeDelegateParams(assistantHint(process.cwd()));

	api.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"把任务派给**临时助理**（另起独立 pi 进程），只把卡片（状态/结论/证据）带回来。" +
			"适合过程很脏、只要结论的活；不适合你想看过程的活。" +
			"多件互不依赖的活用 tasks 并行派；超时/失败过的活用 resume 续跑。" +
			"助理不能互相派活；每次都会回报会话名和会话 ID，要翻看用 /resume-agent。",
		parameters: params,

		async execute(
			_toolCallId: string,
			params: { assistant: string; task?: string; tasks?: string[]; resume?: string; timeoutMs?: number },
			signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
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
			const running = `${list.length > 1 ? `×${list.length} ` : ""}`;

			// 建影子 agentDir：只放进本模板声明的那些 MCP（真正的「按需给」）
			const pool = loadMcpPool(tpl.cwd);
			const shadow = buildShadow(tpl.key, tpl.mcp, pool, {
				agentsMd: tpl.agentsMd !== false,
				exposure: tpl.mcpExposure,
			});
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
			try {
				results = await Promise.all(
					list.map((task, i) => {
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
			if (sub === "new") return newAssistant(ctx, cwd, rest);
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

	// ---------- /agents：子代理实时面板 ----------
	api.registerCommand("agents", {
		description: "子代理实时面板：直接敲=开；off 关；detail 展开思考；text 打印快照；float 改成右侧浮层，widget 改回看板上方",
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

			// 直接敲 /agents = 打开（并解开「用户关过」的封印）；形态沿用上次选的
			openAgentPanel(ctx, { force: true });
			ctx.ui.notify(`子代理面板：${panelMode()}`, "info");
		},
	});
}
