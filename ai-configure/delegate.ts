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
 *   - 会话都留在磁盘上：名字可读、ID 可续、随时能翻
 *
 * 模板 = <项目>/.pi/assistants/*.md 或 <agentDir>/assistants/*.md
 *   frontmatter: name / desc / cwd / model
 *   正文 = 该助理的系统提示词
 *
 * 命名规则：
 *   显示名（/resume 里看到的）  <主进程名>-<代理名><序号>   例：修复登录bug-数据库助理1
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
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { buildShadow, ensureCatalog, loadMcpPool, realSessionDir } from "./mcp-pool";

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
/** 模板搜索目录：项目级优先，全局其次 */
function templateDirs(cwd: string): string[] {
	const dirs: string[] = [];
	const project = join(cwd, ".pi", "assistants");
	if (existsSync(project)) dirs.push(project);
	const global = join(getAgentDir(), "assistants");
	if (existsSync(global)) dirs.push(global);
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

	// cwd 可以由 extends 继承，所以「两边都没有」才算无效模板
	if (!meta.cwd && !meta.extends) return null;

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
 *   不继承：base / enabled / agents_md（用自己写的，没写就是默认值）
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

function loadTemplates(cwd: string): Template[] {
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

	// 先把 extends 解开，再过滤掉关闭的 / cwd 解析不出来的
	const byKey = new Map(parsed.map((t) => [t.key, t]));
	const out: Template[] = [];
	for (const t of parsed) {
		const r = resolveTemplate(t, byKey, new Set());
		if (r.enabled === false) continue;
		if (!r.cwd) continue; // 继承完还是没有工作目录
		out.push(r);
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
	/** 真实会话根目录，保证子会话还能 pi --resume 找到 */
	sessionDir: string;
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
		`找回    pi --session-id ${r.names.id}`,
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
		const tpls = loadTemplates(cwd).filter((t) => t.base !== true);
		if (!tpls.length) return "";
		const list = tpls.map((t) => `${t.key}（${t.name}：${oneLine(t.desc, 40)}）`).join("；");
		return ` 可用：${list}`;
	} catch {
		return "";
	}
}

function makeDelegateParams(hint: string) {
	return Type.Object({
		assistant: Type.String({ description: `助理模板名，如 db、backend。${hint}`.trim() }),
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

interface PickItem {
	value: string;
	label: string;
	hint?: string;
	checked: boolean;
}

/** 右补空格到 w 列（按终端可见宽度算，中文算 2 列） */
function padRight(s: string, w: number): string {
	const vw = visibleWidth(s);
	return vw >= w ? truncateToWidth(s, w) : s + " ".repeat(w - vw);
}

/** 多选框（和 /ai 那个同一套写法） */
class MultiSelect implements Focusable {
	focused = false;
	private sel = 0;

	constructor(
		private theme: Theme,
		private title: string,
		private items: PickItem[],
		private done: (values: string[] | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.items.length) this.sel = (this.sel - 1 + this.items.length) % this.items.length;
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.items.length) this.sel = (this.sel + 1) % this.items.length;
			return;
		}
		if (matchesKey(data, "space")) {
			const it = this.items[this.sel];
			if (it) it.checked = !it.checked;
			return;
		}
		if (matchesKey(data, "return")) {
			this.done(this.items.filter((i) => i.checked).map((i) => i.value));
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const w = Math.min(78, width);
		const inner = w - 2;
		const b = (s: string) => t.fg("border", s);
		const out: string[] = [];
		out.push(b(`╭${"─".repeat(inner)}╮`));
		out.push(b("│") + padRight(" " + t.fg("accent", t.bold(this.title)), inner) + b("│"));
		out.push(b(`├${"─".repeat(inner)}┤`));
		if (!this.items.length) {
			out.push(b("│") + padRight(" " + t.fg("dim", "（候选池是空的）"), inner) + b("│"));
		}
		this.items.forEach((it, i) => {
			const isSel = i === this.sel;
			const box = it.checked ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
			const text = isSel ? t.fg("accent", it.label) : t.fg("text", it.label);
			const prefix = isSel ? t.fg("accent", "▶ ") : "  ";
			let line = ` ${prefix}${box} ${text}`;
			if (it.hint) line += `  ${t.fg("dim", it.hint)}`;
			out.push(b("│") + padRight(truncateToWidth(line, inner), inner) + b("│"));
		});
		out.push(b(`├${"─".repeat(inner)}┤`));
		out.push(b("│") + padRight(" " + t.fg("dim", "↑↓ 移动 · 空格 勾选 · 回车 确定 · esc 取消"), inner) + b("│"));
		out.push(b(`╰${"─".repeat(inner)}╯`));
		return out;
	}
}

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
	const have = loadTemplates(cwd).map((t) => t.key).join(", ") || "(一个都没有)";
	ctx.ui.notify(`找不到助理「${what || "(没写)"}」。可用：${have}`, "warning");
}

/** 向用户要一行文本（input 不可用就退化成 editor） */
async function ask(ctx: ExtensionContext, title: string, initial: string): Promise<string | undefined> {
	const ui = ctx.ui as unknown as {
		input?: (t: string, v?: string) => Promise<string | undefined> | string | undefined;
		editor?: (t: string, v: string) => Promise<string | undefined> | string | undefined;
	};
	if (typeof ui.input === "function") return await ui.input(title, initial);
	if (typeof ui.editor === "function") return await ui.editor(title, initial);
	return undefined;
}

/** 写回模板 frontmatter：只改指定的键，保留其它键和正文 */
function writeTemplateFields(file: string, updates: Record<string, string | undefined>): void {
	const raw = readFileSync(file, "utf8");
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	const body = m ? raw.slice(m[0].length) : raw;
	const lines: string[] = [];
	const handled = new Set<string>();
	if (m) {
		for (const line of m[1].split(/\r?\n/)) {
			const i = line.indexOf(":");
			if (i <= 0) {
				if (line.trim()) lines.push(line);
				continue;
			}
			const k = line.slice(0, i).trim().toLowerCase();
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
	writeFileSync(file, `---\n${lines.join("\n")}\n---\n${body}`, "utf8");
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
	const usable = tpls.filter((t) => t.base !== true);
	const bases = tpls.filter((t) => t.base === true);
	const fmt = (t: Template): string =>
		`• ${t.key} — ${t.name}\n` +
		`    ${t.desc}\n` +
		`    cwd: ${t.cwd}　mcp: ${t.mcp.length ? t.mcp.join(", ") : "—"}　timeout: ${t.timeoutMs ? `${Math.round(t.timeoutMs / 60000)}m` : "默认"}` +
		(t.extends ? `\n    extends: ${t.extends}` : "");
	const out = [`可派发的助理（${usable.length}）`, ...usable.map(fmt)];
	if (bases.length) out.push("", `基础模板（${bases.length}，只给 extends 用，不能直接派）`, ...bases.map(fmt));
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
		`状态    ${tpl.base === true ? "基础模板（不能直接派）" : "可派发"}${tpl.enabled === false ? " · 已禁用" : ""}`,
	];
	const body = tpl.body ? `\n────── 提示词正文 ──────\n${tpl.body}` : "";
	ctx.ui.notify(`${lines.join("\n")}${body}`, "info");
}

async function editAssistant(ctx: ExtensionContext, cwd: string, what: string, mcpOnly: boolean): Promise<void> {
	const tpl = findTemplate(cwd, what);
	if (!tpl) return notFound(ctx, cwd, what);
	if (!ctx.hasUI) {
		ctx.ui.notify("这个命令需要交互界面（TUI）。", "warning");
		return;
	}

	const pool = loadMcpPool(tpl.cwd);
	const all = [...new Set([...Object.keys(pool.servers), ...tpl.mcp])].sort();
	const items: PickItem[] = all.map((n) => ({
		value: n,
		label: n,
		hint: pool.servers[n] ? `(${pool.origin[n] ?? ""})` : "(候选池里没有，写了也连不上)",
		checked: tpl.mcp.includes(n),
	}));

	const picked = await ctx.ui.custom<string[] | null>(
		(_tui, theme, _kb, done) => new MultiSelect(theme, `MCP 挂载 · ${tpl.name}`, items, done),
		{ overlay: true },
	);
	if (!picked) {
		ctx.ui.notify("已取消，什么都没改。", "info");
		return;
	}
	if (!picked.length) {
		const ok = await ctx.ui.confirm("一个都不挂？", `「${tpl.name}」将不连接任何 MCP。`);
		if (!ok) return;
	}

	const updates: Record<string, string | undefined> = { mcp: picked.join(", ") };

	if (!mcpOnly) {
		const exp = await ctx.ui.select("MCP 暴露方式", [
			"保持现状",
			"codemode（默认：工具不占上下文，但要写脚本调）",
			"direct（工具直接可见，专职助理更省事）",
			"deferred",
		]);
		if (exp === undefined) return;
		if (exp?.startsWith("codemode")) updates.mcp_exposure = "codemode";
		else if (exp?.startsWith("direct")) updates.mcp_exposure = "direct";
		else if (exp?.startsWith("deferred")) updates.mcp_exposure = "deferred";

		const to = await ask(ctx, "超时（如 10m / 90s；留空 = 默认 5 分钟）", tpl.timeoutMs ? `${Math.round(tpl.timeoutMs / 1000)}s` : "");
		if (to === undefined) return;
		if (to.trim() === "") updates.timeout = undefined;
		else if (parseDuration(to)) updates.timeout = to.trim();
		else ctx.ui.notify(`看不懂的超时「${to}」，这项没改。`, "warning");

		const am = await ctx.ui.confirm(
			"带全局 AGENTS.md 吗？",
			`当前：${tpl.agentsMd === false ? "不带" : "带"}\n带 → 更守你的全局规矩；不带 → 每次省约 1500 token。`,
		);
		updates.agents_md = am ? "true" : "false";
	}

	// 保存到哪（写回模板文件；mcp 快捷模式默认就地改）
	let target = tpl.file;
	if (!mcpOnly) {
		const projDir = join(cwd, ".pi", "assistants");
		const inProject = dirname(tpl.file).toLowerCase().startsWith(join(cwd, ".pi").toLowerCase());
		const opts = inProject
			? ["保存到原文件（项目级）"]
			: [
					"保存到原文件（全局模板 —— 会影响所有用到它的项目）",
					`另存为项目级：${join(projDir, `${tpl.key}.md`)}`,
				];
		const where = await ctx.ui.select("保存到哪？", opts);
		if (where === undefined) return;
		if (where.startsWith("另存为")) {
			target = join(projDir, `${tpl.key}.md`);
			mkdirSync(projDir, { recursive: true });
			try {
				writeFileSync(target, readFileSync(tpl.file, "utf8"), "utf8");
			} catch {
				/* 后面 writeTemplateFields 会建 */
			}
		}
	}

	try {
		writeTemplateFields(target, updates);
		ctx.ui.notify(`已写入\n${target}\n\n改模板不用 /reload，下次派发立即生效。`, "info");
	} catch (e) {
		ctx.ui.notify(`写入失败：${(e as Error).message}`, "error");
	}
}

async function newAssistant(ctx: ExtensionContext, cwd: string, key: string): Promise<void> {
	if (!key) {
		ctx.ui.notify("用法：/assistants new <文件名>\n例：/assistants new personal-backend", "warning");
		return;
	}
	const dir = join(getAgentDir(), "assistants");
	const file = join(dir, `${key}.md`);
	if (existsSync(file)) {
		ctx.ui.notify(`已存在：${file}\n想改就 /assistants edit ${key}`, "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("这个命令需要交互界面（TUI）。", "warning");
		return;
	}

	const name = await ask(ctx, "显示名（中文也行）", key);
	if (name === undefined) return;
	const desc = await ask(ctx, "一句话描述（主会话靠它决定派谁）", "");
	if (desc === undefined) return;
	const cwdIn = await ask(ctx, "工作目录", cwd);
	if (cwdIn === undefined) return;
	const model = await ask(ctx, "模型（留空 = 继承默认）", "");
	if (model === undefined) return;

	mkdirSync(dir, { recursive: true });
	writeFileSync(
		file,
		`---\nname: ${name || key}\ndesc: ${desc}\ncwd: ${cwdIn || cwd}${model ? `\nmodel: ${model}` : ""}\n---\n你是……（这里写它的职责和规矩）\n`,
		"utf8",
	);
	ctx.ui.notify(`已创建\n${file}\n\n接着配 MCP：/assistants edit ${key}`, "info");
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
			"助理不能互相派活；每次都会回报会话名和会话 ID，可用 pi --resume 翻看。",
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
				const have = templates.length ? templates.map((t) => `${t.key}(${t.name})`).join(", ") : "(一个都没有)";
				return {
					content: [{ type: "text" as const, text: `找不到助理「${params.assistant}」。可用：${have}` }],
					details: { ok: false, reason: "template_not_found" },
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
			if (ctx.hasUI && shadow.missing.length) {
				ctx.ui.notify(
					`助理「${tpl.name}」要的 MCP 在候选池里找不到：${shadow.missing.join(", ")}` +
						`（池子：${Object.keys(pool.servers).join(", ") || "空"}）`,
					"warning",
				);
			}

			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `📤 ${tpl.name} ${running}干活中…`));
			}

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
							sessionDir: realSessionDir(),
						});
					}),
				);
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
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
			if (sub === "edit") return editAssistant(ctx, cwd, rest, false);
			if (sub === "mcp") return editAssistant(ctx, cwd, rest, true);
			if (sub === "new") return newAssistant(ctx, cwd, rest);
			if (sub === "open") return openAssistant(ctx, cwd, rest);
			return listAssistants(ctx, cwd);
		},
	});
}
