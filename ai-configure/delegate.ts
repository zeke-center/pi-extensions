/**
 * delegate · 派活给临时助理（并行 + 同步停止 + 超时续期）
 *
 * 一个工具：delegate(assistant, task | tasks) —— 起**独立的后台 pi 进程**干活，
 * 干完只把卡片（状态/结论/证据）带回来。中间过程不进主对话，但留在自己的会话文件里，可回看。
 *
 * 设计要点：
 *   - 并行：tasks 数组 → Promise.all，一次派多路，等全部返回
 *   - 同步停止：Esc / 主进程退出 / 主进程被强杀（看门狗），三层都杀，不留孤儿
 *   - 超时：**到点前先叫停，再硬杀兑底**。子进程跑在 `--mode rpc`（双向）上，所以
 *       软档 = T - max(120s, 25%)：steer 一句“开始收尾”
 *       硬档 = T - 45s      ：abort 打断 + 追问一次交卡（上下文还在，能拿到真结论）
 *     这样超时卡片里是「阶段成果 + 工具时间线 + 还差什么」，而不是一句空话；
 *     旧模式（单向 json）没这个通道，只靠 `PI_DELEGATE_RPC=0` 应急回退。
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
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { type FormResult, type FormField, type FormPage, showForm, type PickItem, pickFromList } from "./form";
import {
	batchLiveEnabled,
	parseReport,
	readSuperAgent,
	readMaxConcurrent,
	reportHeadline,
	reportRule,
	setRouterSession,
	superagentEnabled,
	type RouterMode,
	type WorkerReport,
} from "./superagent";
import {
	parsePerms,
	permSummary,
	permDetail,
	permissionRule,
	FS_OPTIONS,
	FS_KEYS,
	EXEC_OPTIONS,
	EXEC_KEYS,
	NET_OPTIONS,
	NET_KEYS,
	toLabel,
	fromLabel,
	type WorkerPermissions,
	PERM_DEFAULTS,
	permsDeclared,
} from "./permissions";
import { guardCtx, readExtCfg } from "./shared";
import {
	mainPaneId,
	herdrLog,
	HERDR_DOWN_PREFIX,
	herdrDownNote,
	herdrStatus,
	markHerdrBroken,
	paneClose,
	paneLabel,
	paneSummary,
	paneList,
	paneReadEx,
	paneRename,
	paneRun,
	paneSendKeys,
	paneSplit,
	planSlot,
	readUiConfig,
	resetHerdrCache,
	resolveUiMode,
	tabBaseIndex,
	tabClose,
	tabCreate,
	tabLabel,
	tabLabelMode,
	tabLabelWithNames,
	tabRename,
	workspaceId,
	type UiConfig,
	type UiMode,
} from "./herdr";
import { registerSettings } from "./settings";
import { addJob, beginRun, consume, getLingerMs, liveJobs as liveJobList, markEnd, newJob, notifyLive, setLingerMs, type EndStatus, type LiveJob } from "./live";
import { RpcChannel, rejectDialog } from "./rpc";
import { autoClosePanel, closeAgentPanel, ensureAgentPanel, openAgentPanel, panelMode, setPreferOverlay, snapshotLines, toggleDetail } from "./panel";
import { isExtDisabled, onGateApply } from "./gate";
import { assistantSessionRoot, buildShadow, ensureCatalog, installGuard, loadMcpPool, localCatalogPath, reapStaleShadowDirs, type McpPool } from "./mcp-pool";
import { AUTO_DELIVER_MAX_ATTEMPTS, autoDeliverSkipReason, bgPruneReason, mergeBgTask, type BgTaskFile, type BgTaskNext } from "./bg-store";
import { archiveResult, listArchivedResults, pruneArchivedResults, readArchivedResult, resultPathLine } from "./results";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 单次硬上限 30 分钟
const MIN_TIMEOUT_MS = 5 * 1000; // 最少 5 秒
const STATUS_KEY = "delegate";
const PARTIAL_LIMIT = 4000; // 半成品最多保留的字符数（超时卡片就靠它，给足）
const STDERR_LIMIT = 4000;
/** 时限低于这个就不值得发收尾提醒了（提醒本身也要占掉一个 turn） */
const MIN_WINDDOWN_MS = 3 * 60 * 1000;
/** 硬收尾的提前量：留出“打断 + 追问交卡”的时间 */
const HARD_WINDDOWN_LEAD_MS = 45 * 1000;
/** 软收尾的提前量：至少这么多秒，或总时限的 25%（取大的） */
const SOFT_WINDDOWN_MIN_LEAD_MS = 120 * 1000;

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
	/** 模型（frontmatter.model）；空 = 继承主会话当前模型 */
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
	/** 能力权限（frontmatter 的 fs/paths/exec/cmds/net/budget） */
	perms: WorkerPermissions;
	/** 子模板自己写过权限吗（没写就继承父模板的） */
	permsDeclared: boolean;
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
/** pane 里等到的结局：多一个 "stalled"（看门狗收掉的）—— 它不对应 RunResult.outcome，而是**转降级 rpc 重跑** */
type PaneOutcome = Outcome | "stalled";

interface RunResult {
	outcome: Outcome;
	/** done 时的最终文本 */
	text: string;
	/** timeout 时已经产出的部分 */
	partial: string;
	/** 它调用过的工具（按顺序，含重复） */
	tools: string[];
	/** 每个工具的耗时（超时卡片里用来看“预算被什么吃了”） */
	toolRuns: { name: string; ms: number }[];
	/** 到点前发过的收尾动作（收尾提醒 / 打断卡住的 run / 追问交卡） */
	windDownLog: string[];
	/** 最终回复被模型的输出上限截断（pi 1.2.0 起 `-p` 会因此在 stderr 报警并以 1 退出） */
	truncated: boolean;
	/** Worker 交回来的结构化回执（没交 / Super Agent 模式关着 = undefined） */
	report?: WorkerReport;
	elapsedMs: number;
	exitCode: number | null;
	stderrTail: string;
	names: Names;
	tpl: Template;
	task: string;
	resumed: boolean;
	/** pane 这条路降级过（派发失败 / 卡死 / 槽位等不到）→ 批次汇总卡里标 ⚠️ */
	degradeNote?: string;
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
		perms: parsePerms(meta),
		permsDeclared: permsDeclared(meta),
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

/** 带毫秒的时间戳 —— 会话 ID 用。秒级粒度下，同一秒并发派发会撞 ID。 */
function stampMs(d = new Date()): string {
	return `${stamp(d)}${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * 助理 key 的稳定 ASCII 指纹（6 位 base36）。
 *
 * ⚠️ 为什么必需：中文 key（如「个人中心服务器助理」）会被 sanitizeSessionId
 * 整段抹成 "-" 再剔掉，结果会话 ID 里**完全不含助理身份**，
 * 于是同一秒并发派两个不同助理 → 两侧 ID 一模一样 → 第二个被锁拒掉。
 * 用 FNV-1a 算个短指纹补上身份，纯 ASCII、稳定、不依赖名字长度。
 */
export function keyFingerprint(key: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36).padStart(6, "0").slice(0, 6);
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

/**
 * 生成一个会话 ID：`<助理指纹>-<带毫秒时间戳>-<序号>`
 *
 * ⚠️ 两个坑，缺一不可：
 *   1. 指纹：中文 key（如「个人中心服务器助理」）会被 sanitizeSessionId 整段抹成 "-" 再剔掉，
 *      ID 里就【没有助理身份】了 → 同一秒派两个不同助理必然撞 ID。
 *   2. 毫秒：秒级粒度下，并发派发同样能撞。
 *
 * 导出是为了单测（scripts/unit.mjs 直接断言「同毫秒两个助理不撞」）。
 */
export function makeSessionId(key: string, seq: number, at: Date = new Date()): string {
	return sanitizeSessionId(`${keyFingerprint(key)}-${stampMs(at)}-${seq}`);
}

function buildNames(main: string, tpl: Template, seq: number, resumeId?: string): Names {
	const display = `${main}-${tpl.name}${seq}`;
	const id = resumeId ?? makeSessionId(tpl.key, seq);
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

/**
 * 主进程退出前：把还在跑的后台任务标成「被中止」。
 *
 * 不写的话，bg 文件会永远停在 `running` —— 要等下次启动 `reapStaleBgTasks()` 才被标成
 * 「孤儿任务：子进程已消失」，那是**误导**（其实是你退了 pi），而且不提「能 resume」
 *
 * ⚠️ 走的是 `process.on("exit")` —— 那里**不能 await**，所以只能用同步写盘。
 * 而且这是退出路径：写不进去就算了，绝不能再抛错。
 */
function markRunningBgTasksAborted(): void {
	try {
		const running = liveJobList().filter((j) => j.status === "running");
		if (!running.length) return;
		const now = Date.now();
		for (const t of listBgTasks()) {
			if (t.status !== "running") continue;
			if (!running.some((j) => j.sessionId === t.sessionId)) continue;
			writeBgTask({
				...t,
				status: "failed",
				resultText:
					"（主会话退出，任务被中止）\n" +
					`要接着做：回到主会话重新派一次，带上 resume: "${t.sessionId}" —— 它的历史都在，会接着做而不是重做。`,
				finishedAt: now,
				delivered: false,
				undelivered: false,
			});
		}
	} catch {
		/* 退出路径：不抛错 */
	}
}

/** 杀掉所有在跑的子进程，并把它们的后台任务标成中止（强杀由看门狗负责） */
function killAll(): void {
	markRunningBgTasksAborted();
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

/**
 * 子进程走不走 RPC 通道？默认走。
 * `PI_DELEGATE_RPC=0` 强制回退到旧的单向 `-p --mode json`（应急开关，代码保留不删）。
 */
function rpcEnabled(): boolean {
	return (process.env.PI_DELEGATE_RPC ?? "") !== "0";
}

/**
 * pi 到底支不支持 `--mode rpc`？
 *
 * 老版本没有 rpc 模式 —— 无脑切过去 = 派活全挂。所以开工前用 `pi --help` 探一次，
 * 结果在**进程内缓存**（只花一次 0.5s）。探不到就老路径，行为跟改造前完全一样。
 */
let rpcProbe: Promise<boolean> | undefined;
function rpcSupported(cli: string): Promise<boolean> {
	if (!rpcEnabled()) return Promise.resolve(false);
	if (rpcProbe) return rpcProbe;
	rpcProbe = new Promise<boolean>((resolve) => {
		let done = false;
		const finish = (v: boolean): void => {
			if (done) return;
			done = true;
			resolve(v);
		};
		try {
			const p = spawn(process.execPath, [cli, "--help"], { stdio: ["ignore", "pipe", "pipe"], shell: false });
			let out = "";
			p.stdout?.on("data", (d: Buffer) => {
				out += d.toString("utf8");
			});
			const t = setTimeout(() => {
				try {
					p.kill();
				} catch {
					/* ignore */
				}
				finish(false);
			}, 20_000);
			p.on("close", () => {
				clearTimeout(t);
				// 帮助里写着 `--mode <mode>  Output mode: text (default), json, or rpc`
				finish(/\brpc\b/i.test(out));
			});
			p.on("error", () => {
				clearTimeout(t);
				finish(false);
			});
		} catch {
			finish(false);
		}
	});
	return rpcProbe;
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

/**
 * 到点前的收尾提醒（走 RPC 的 steer）。
 *
 * 为什么需要：子助理**不知道时间在流逝** —— deadlineRule 只在开头说过一次“你必须在 N 秒内给出结论”，
 * 它跑到第 8 分钟还以为“再查一个文件就好”（真事：一条 `ls` 花了 188.9s，预算直接抽干）。
 * steer 不会打断它当前的工具调用，而是在“当前 turn 的工具跑完”后插一句 —— 正好是让它收手的时机。
 *
 * @param secLeft 还剩多少秒（写进提醒里，给它明确的时间感）
 */
function windDownText(secLeft: number): string {
	return [
		`【时间提醒】只剩约 ${secLeft} 秒。`,
		"请开始收尾：不要再开新方向的大范围排查（大目录递归 ls / 全库 grep 这类）。",
		"把**已经确认**的结论整理出来，按交卡格式输出。",
		"还差什么就写清「未完成：…」，别硬撑到被掐断。",
	].join("\n");
}

/**
 * 硬收尾的「追问」文案。
 *
 * 为什么硬档是 `abort` + 追问，而不是只发一个更硬的 steer：
 *   steer 的送达时机是「当前 turn 的工具调用跑完」—— 卡在一条 `sleep 240`（或那条 190s 的 ls）上时
 *   提醒**永远送不进去**。实测：steer 被 accepted（queued），但到尾还是被硬杀，一个字没交。
 *   而 `abort` 能真的打断正在跑的工具调用（实测 bash 被断成 "Command aborted"），
 *   打断后上下文还在，再追一句就能拿到**像样的结论**，而不是一句 "I'll analyze..."。
 *
 * ⚠️ `abort_bash` 不用往里写了：它只管 RPC 客户端自己发的 `bash` 命令，掐不动模型的 bash 工具调用
 *    （实测：返回 success，但 sleep 240 照样跑到底）。
 */
function wrapUpText(): string {
	return [
		"【时间到点，请立刻交卡】",
		"不要再调用任何工具。把你**目前已经确认**的内容按交卡格式输出。",
		"未完成的部分写「未完成：还差什么」，并说明下一步该做什么。",
	].join("\n");
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

/**
 * 一次运行里 `type:"prompt"` 的**闸门** —— 碎片事故的防回归。
 *
 * 事故现象（真事，见 README 的 Herdr 一节）：worker 会话里出现一长串**碎片** user 消息
 * （`test` / `→` / `12` / reportRule 中段…），每段都被 pi 当成一条独立 prompt 跑掉。
 * 也就是「同一次运行被投递了多次 prompt」，而**谁都不报错**。
 *
 * 所以把「发 prompt」收敛成一个可计数的对象：
 *   - 任务正文：**只准 1 条**；第二次直接拒绝（宁可少发，也不许把半截文本再投一遍）
 *   - 到点追问：只有「硬收尾真的开火了」（allowWrapUp）之后才准发第 2 条，且只准一次
 * 单测直接断言 count / 拒绝行为，不用起子进程。
 */
function makePromptGate(): {
	task(message: string): boolean;
	wrapUp(message: string): boolean;
	allowWrapUp(): void;
	readonly count: number;
	readonly messages: string[];
} {
	const messages: string[] = [];
	let wrapUpAllowed = false;
	return {
		task(message: string): boolean {
			if (messages.length > 0) return false;
			messages.push(message);
			return true;
		},
		wrapUp(message: string): boolean {
			if (!wrapUpAllowed || messages.length !== 1) return false;
			messages.push(message);
			return true;
		},
		allowWrapUp(): void {
			wrapUpAllowed = true;
		},
		get count(): number {
			return messages.length;
		},
		get messages(): string[] {
			return messages;
		},
	};
}

/** 一条工具调用的耗时（卡片用） */
interface ToolRunBrief {
	id: string;
	name: string;
	startedAt: number;
	/** 0 = 还没结束 */
	ms: number;
}

// ======================= 解析 --mode json 的流 =======================
interface Sink {
	partial: string;
	tools: string[];
	final: string;
	stderr: string;
	/** 工具调用时序（两种模式共用；卡片里看“时间花哪了”） */
	toolRuns: ToolRunBrief[];
	/** 实时视图：每个事件同时喂给它，面板才看得到「它现在在干什么」 */
	live?: LiveJob;
}

function clampTail(s: string, limit: number): string {
	return s.length > limit ? s.slice(-limit) : s;
}

/** 派活降级的卡片备注（必须让用户看出「本来想分屏，退回来了」） */
const PANE_DEGRADED_NOTE = "pane 派发失败已降级";
/** 卡死看门狗降级的卡片备注 */
const PANE_STALLED_NOTE = "pane 卡死 90s（无输出）已降级 rpc";
/** 槽位等不到（60s 超时）降级的卡片备注 */
const SLOT_WAIT_NOTE = "pane 槽位等待 60s 超时已降级 rpc";

/**
 * 「分屏不可用」只 notify 一次（每会话）。
 * 为什么：默认 auto 下有 4 个并发助理，逐个 notify 会刷 4 条一样的警告。
 */
let herdrDownNotified = false;
function notifyHerdrDownOnce(ctx: ExtensionContext | undefined, reason: string): void {
	if (herdrDownNotified) return;
	herdrDownNotified = true;
	try {
		ctx?.ui?.notify(`分屏不可用：${reason}\n已自动改用面板卡片（想强制分屏先修 Herdr）`, "warning");
	} catch {
		/* 通知失败不影响派活 */
	}
}
/** 等「任务真的送到 worker」的上限 */
const TASK_DELIVER_TIMEOUT_MS = 20_000;
/**
 * 卡死看门狗阈值：pane 连续这么久**一个字符都没变** → 判定卡死 → 收 pane + 降级 rpc。
 * 实测：8 个并发里有 4 个挂到 12 分钟硬超时才判失败（pane 建好、pi 起来，然后静默卡住）。
 * 90s 是「明显不正常，但又给了慢模型足够余地」的折中。要调就改这一个常量（别写死在多处）。
 */
export const PANE_IDLE_MS = 90_000;

/**
 * pane 分支的**兜底收尾**宽限：`waitPaneDone` 自己会在 timeoutMs 到点时返回，
 * 但它前后任何一段（读 pane 抛错没人接 / finally 里又抛）都可能把 promise 挂住，
 * 一旦挂住 run 就永远不 settle → `.bg` 一直 `running` → 回执永远不投。
 * 所以 pane 分支另起一个「最长 timeoutMs + 这个宽限」的强制收尾定时器。
 */
export const HERDR_FINALIZE_GRACE_MS = 60_000;

/**
 * 回执正文的**稳定窗口**：看到 `状态: 完成` 这类回执之后，还要连续这么久不再变化才算真跑完。
 *
 * 为什么不是「看到就判完」：模型在写回执时是**流式**的 —— `状态: 完成` 往往先出现，
 * `结论 / 证据` 还在往下写。早判 1 秒就会把正文截断（卡片上只剩半截）。
 * 800ms 是「盖住一次续写、又不会让用户白等」的折中（原来 2000ms 偏保守：
 * 用户体感上「活已经跑完了，卡片还在转」）。回执一旦开始续写文字就变 → 窗口照样重置。
 */
export const PANE_RECEIPT_STABLE_MS = 800;

/**
 * 采集 pane 状态的采样间隔（也是抛错后的重试间隔）。
 *
 * 2000ms → 800ms：pane 里的活跑完到卡片变绿之间，原来最多要多等 2 个采样周期；
 * 读 pane 只是 `herdr pane read`，便宜（不是全量 diff），降频收益不大、延迟收益明显。
 */
export const PANE_SAMPLE_MS = 800;

/** 连续读失败到**这么多次**就把采样间隔临时降频（避免疯狂重试拖垮 herdr） */
export const PANE_READ_FAIL_SLOW_AFTER = 3;

/** 降频后的采样间隔（读 pane 一直抛错时用；成功读到一次就回到 `PANE_SAMPLE_MS`） */
export const PANE_SAMPLE_SLOW_MS = 2_000;

/**
 * 这一轮该隔多久采样（纯函数，便于单测）。
 * 连续读失败 >= `PANE_READ_FAIL_SLOW_AFTER` 次 → 降频到 `slowMs`；读到一次成功（readFails 归零）→ 回 `baseMs`。
 */
export function effectiveSampleMs(readFails: number, baseMs: number = PANE_SAMPLE_MS, slowMs: number = PANE_SAMPLE_SLOW_MS): number {
	return Number(readFails) >= PANE_READ_FAIL_SLOW_AFTER ? slowMs : baseMs;
}

/**
 * 采集 pane 状态**连续抛错**多少次才放弃（每次 `PANE_SAMPLE_MS`，≈ 24s）。
 *
 * 以前是 3 次（≈ 6s）：pane 刚被关 / herdr 短暂抽风就判 `failed` ——
 * 实战里把一次**已经跑成功**的活（已 commit、已双推）判成「失败（退出码 1）」，
 * 还把 pane 留着。抛错只说明「读不到 pane」，不等于任务失败，所以放宽到 12 次，
 * 且每次都用会话 jsonl 另找事实（见 `waitPaneDone`）。
 */
export const PANE_READ_FAIL_LIMIT = 12;

/**
 * pane 屏幕上「正在执行」的迹象。
 *
 * 为什么需要它：任务本身可能在跑一个**长时间不出输出**的命令（装包、跑测试、等网络），
 * 屏幕不变 ≠ 进程卡死。**只能在没有执行迹象时才判卡死**。
 * 反过来，只要看到一条迹象就不判 —— 宁可漏杀（慢），也绝不误杀（把好好的活干掉）。
 */
const PANE_BUSY_HINTS: RegExp[] = [
	/[\u2801-\u28ff]/, // ⠋⠙⠹ 这类 spinner 字形（TUI 在画界面）
	/正在执行|执行中|运行中|思考中|等待中/, // 中文状态词
	/\b(running|executing|thinking|waiting|installing)\b/i,
	/esc to interrupt|按\s*esc\s*中断/i,
];

/** pane 屏幕上有没有「正在执行」的迹象（纯函数） */
export function paneShowsActivity(output: string): boolean {
	const t = String(output ?? "");
	if (!t.trim()) return false;
	return PANE_BUSY_HINTS.some((re) => re.test(t));
}

export interface PaneStallCtx {
	/** pane 还在吗（paneList 里能看到）—— 已经消失就不叫「卡死」，走结束路径 */
	alive?: boolean;
	/** 这次 pane read 成功了吗？失败 = 拿不到判断依据 */
	readable?: boolean;
	/** 最新一次读到的屏幕内容 */
	output?: string;
	/** 阈值（默认 PANE_IDLE_MS，单测可注入小值） */
	idleMs?: number;
}

/**
 * 卡死判定的**纯函数**（不读时间、不碰 herdr，只做算术 + 字符串判断 → 可单测）。
 *
 * 判卡死必须**同时**满足：
 *   ① pane 还活着（消失 → 交给「pane 被关」的结束路径）
 *   ② 这次读取成功（读不到 → 没有判断依据 → 只记日志不杀）
 *   ③ 任务已经送到过（没送到 → 交给任务送达校验那套，别抢它的活）
 *   ④ 连续 idleMs 毫秒内容完全没变
 *   ⑤ 屏幕上**看不到**「正在执行」迹象（看得到 → 可能只是在跑长命令，不杀）
 *   ⑥ 屏幕不是空白（空屏啥也说明不了 → 同样算「没有判断依据」，不杀）
 *
 * 任何一条不满足都返回 false —— 默认不杀。
 */
export function isPaneStalled(
	lastChangeAt: number,
	now: number,
	hasDelivered: boolean,
	ctx: PaneStallCtx = {},
): boolean {
	const alive = ctx.alive !== false;
	const readable = ctx.readable !== false;
	const output = String(ctx.output ?? "");
	const idleMs = Number.isFinite(ctx.idleMs) ? Number(ctx.idleMs) : PANE_IDLE_MS;
	if (!alive) return false; // ① 已消失 → 结束路径
	if (!readable) return false; // ② 拿不到输出 → 只记日志
	if (!hasDelivered) return false; // ③ 未送达 → 送达校验负责
	if (!output.trim()) return false; // ⑥ 空屏 → 没有判断依据
	const idle = Number(now) - Number(lastChangeAt);
	if (!(idle >= idleMs)) return false; // ④ 还没到阈值
	if (paneShowsActivity(output)) return false; // ⑤ 有执行迹象 → 不杀
	return true;
}

/** 卡死判定的「为什么不杀」——只用于记日志（拿不到依据时也留证据） */
export function paneStallReason(
	lastChangeAt: number,
	now: number,
	hasDelivered: boolean,
	ctx: PaneStallCtx = {},
): "stalled" | "gone" | "no-read" | "undelivered" | "empty" | "busy" | "idle" {
	if (isPaneStalled(lastChangeAt, now, hasDelivered, ctx)) return "stalled";
	if (ctx.alive === false) return "gone";
	if (ctx.readable === false) return "no-read";
	if (!hasDelivered) return "undelivered";
	if (!String(ctx.output ?? "").trim()) return "empty";
	if (paneShowsActivity(String(ctx.output ?? ""))) return "busy";
	return "idle";
}

/** `finalizeHerdrRun()` 的入参 */
export interface HerdrFinalizeInput {
	/** 运行结果（和 `RunResult.outcome` 同源） */
	outcome: Outcome;
	/** 会话 jsonl 里抓到的最终文本（可能空 / 可能没有 `<result>`） */
	text?: string;
	/** 收尾异常信息 / 不属于任务本身的原因（写 lastError） */
	error?: string;
	/** 兜底计时器到点强制收尾（不是正常收尾） */
	forced?: boolean;
	/** 现在时刻（单测可注入） */
	now?: number;
}

/** `finalizeHerdrRun()` 的产出：**应该写进 `.bg` 的终态字段** */
export interface HerdrFinalizeFields {
	/** 终态（绝不会是 `running`） */
	status: BgTaskFile["status"];
	/** 卡片正文（调用方已有更漂亮的卡片时不要覆盖它） */
	resultText?: string;
	/** 落盘这一刻**一定还没投递**（投递由 pollBgTasks 做，之后单独写 true） */
	delivered: boolean;
	/** 结束时刻 */
	finishedAt: number;
	/** 排查线索（没交回执 / 收尾异常 / 兜底计时器） */
	lastError?: string;
	/** 判定依据，只用于日志/单测 */
	reason: string;
}

/**
 * pane 分支的终态判定（**纯函数**：不读时间、不碰文件、不碰 herdr → 可单测）。
 *
 * 回归背景：pane 模式的收尾曾经只写在 rpc 分支里 —— pane 跑完后
 * 「解析 `<result>` → markEnd → 写 `.bg` 终态 → 投递」整段没跑，
 * `.bg` 永远停在 `running`，回执永远不投（rpc 那 1 个任务正常，正好说明问题在收尾路径）。
 * 现在 pane / rpc 两条路径都过这里，保证判定口径一致。
 */
export function finalizeHerdrRun(input: HerdrFinalizeInput): HerdrFinalizeFields {
	const text = String(input.text ?? "");
	const receipt = parseReport(text);
	const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
	const finishedAt = now;
	const fields = (status: BgTaskFile["status"], reason: string, lastError?: string): HerdrFinalizeFields => ({
		status,
		// 有正文就有卡片（没正文也给一句人话，别让 .bg 只剩 status）
		resultText: text.trim() ? text : lastError ? `（没有正文）${lastError}` : undefined,
		delivered: false, // 写终态这一刻一定还没投；投递成功后会再写一次 true
		finishedAt,
		...(lastError ? { lastError } : {}),
		reason,
	});

	// ① 兜底计时器：pane 收尾没跑完 → 按超时算（任务没结束，不是 done）
	if (input.forced) return fields("timeout", "forced", input.error ?? "兜底计时器到点强制收尾");
	// ② 收尾自己抛了：判 failed（除非本来就是超时/空跑，那是更准确的口径）
	if (input.error) {
		if (input.outcome === "timeout") return fields("timeout", "error", input.error);
		if (input.outcome === "empty") return fields("empty", "error", input.error);
		return fields("failed", "error", input.error);
	}
	switch (input.outcome) {
		case "done":
			// 跑完了但**没交 `<result>`**：以前会被当成 done 混过去（卡片上看起来“成功”），
			// 现在明确标 empty —— 既不是 failed，也绝不留在 running。
			return receipt
				? { ...fields("done", "receipt"), resultText: text }
				: fields("empty", "no-receipt", "pane 跑完了但没交 <result> 回执");
		case "timeout":
			return fields("timeout", "timeout");
		case "empty":
			return fields("empty", "empty");
		case "busy":
		default:
			return fields("failed", "failed");
	}
}

/**
 * 把 `finalizeHerdrRun()` 算出来的终态写进 `.bg`（**合并写**，不覆盖已有卡片，不回退 `delivered`）。
 *
 * 为什么需要它：`opt.onSettle` 是调用方注册的回调，万一它没注册 / 自己抛了，
 * 或者根本没有异步记账（同步模式），`.bg` 就会重新卡回 `running`。这里是死守的一道。
 * 另外：`writeBgTask` 内部自己 try/catch 过，这里再包一层 —— 它必须是最后一根稻草，不能再抛。
 */
export function writeHerdrBgTerminal(bgId: string | undefined, fields: HerdrFinalizeFields): BgTaskFile | undefined {
	if (!bgId) return undefined;
	try {
		const prev = readBgTask(bgId);
		if (!prev) return undefined;
		return writeBgTask({
			...prev,
			status: fields.status,
			delivered: prev.delivered === true, // 单向：已经投过就永远是 true
			resultText: prev.resultText ?? fields.resultText,
			finishedAt: prev.finishedAt ?? fields.finishedAt,
			...(fields.lastError ? { lastError: fields.lastError } : {}),
		});
	} catch {
		return undefined;
	}
}

/**
 * 收尾归档的一句话摘要（纯函数）：优先 Worker 回报的 `notes`，否则正文开头。
 * 正文可能很长（几千行），摘要只取一句 —— 要全文看归档文件。
 */
function archiveSummary(r: RunResult | undefined, body: string): string {
	const notes = String(r?.report?.notes ?? "").replace(/\s+/g, " ").trim();
	if (notes) return oneLine(notes, 120);
	const flat = String(body ?? "").replace(/\s+/g, " ").trim();
	if (flat) return oneLine(flat, 120);
	const err = String(r?.stderrTail ?? "").replace(/\s+/g, " ").trim();
	return err ? oneLine(err, 120) : "（没有正文）";
}

/**
 * 会话 ID → 归档路径（只活在内存）。
 *
 * 为什么需要：批次汇总卡要逐件给「结果：<path>」，但 `BatchItem` 里没有路径；
 * 而批次**不写** per-task 的 `.bg`（写了就每件单独回投一张卡），路径无处可取。
 * 归档就发生在收尾的那条链上，顺手记一份 —— 没记到（跨 `/reload` 了）就写「未归档」。
 */
const archivePathOf = new Map<string, string>();

/**
 * 单任务收尾：**把完整正文归档到文件**，并顺手把路径回写进 `.bg`（`resultPath`）。
 *
 * 为什么要做：回投卡里只有 90 字摘要，正文从来没落盘 —— 想细看只能 `/resume-agent`
 * 重载整个会话上下文。归档后回投只给「状态 + 摘要 + 路径」，看全文用 `/batch <id>`。
 *
 * 底线：**归档失败不影响任务本身** —— 整段自己 try 住，写不进去就返回 undefined。
 */
function archiveTaskRun(a: {
	bgId?: string;
	tpl: Template;
	names: Names;
	task: string;
	r: RunResult;
	text: string;
	status: string;
}): string | undefined {
	try {
		const prev = a.bgId ? readBgTask(a.bgId) : undefined;
		const body = String(a.text ?? "") || String(a.r?.partial ?? "");
		const path = archiveResult({
			id: a.names.id,
			kind: "task",
			name: a.tpl.name,
			status: a.status,
			...(prev?.startedAt ? { startedAt: prev.startedAt } : {}),
			finishedAt: Date.now(),
			summary: archiveSummary(a.r, body),
			body,
			meta: {
				sessionId: a.names.id,
				task: oneLine(a.task ?? "", 160),
				outcome: a.r?.outcome,
				elapsedMs: a.r?.elapsedMs,
				...(a.bgId ? { bgId: a.bgId } : {}),
			},
		});
		if (path && a.bgId) {
			const cur = readBgTask(a.bgId);
			if (cur) writeBgTask({ ...cur, resultPath: path });
		}
		if (path) archivePathOf.set(a.names.id, path); // 批次汇总卡要逐件列出路径
		return path;
	} catch {
		return undefined;
	}
}

/**
 * pane 分支的兜底计时器（**到点必然收尾**，自己绝不抛）。
 *
 * 为什么不直接用 `setTimeout`：收尾逻辑可能把 promise 挂住（读 pane 抛错没人接），
 * 到点回调里如果又抛，就真的什么都没发生。这里把回调包进 try/catch 并 `unref()`。
 */
export function armHerdrFinalizeGuard(ms: number, onFire: () => void): { clear: () => void } {
	const t = setTimeout(() => {
		try {
			onFire();
		} catch {
			/* 兜底回调自己抛了就没别的手段了，但绝不再往外抛 */
		}
	}, Math.max(0, Number.isFinite(ms) ? ms : 0));
	t.unref?.();
	return {
		clear: () => {
			try {
				clearTimeout(t);
			} catch {
				/* ignore */
			}
		},
	};
}

/** 降级过的卡片：把「已降级」标记接在终态备注前面（不让 markEnd 把它抹掉） */
function withDegrade(job: LiveJob, note: string | undefined): string | undefined {
	// 两种降级备注都要保住：派发失败 / 卡死看门狗收掉 / 槽位等不到（都用 rpc 接着跑）
	// Herdr 不可用（掉回面板卡片）也是降级，同样不能被终态备注抹掉。
	const note_ = job.note;
	const degraded =
		note_ === PANE_DEGRADED_NOTE ||
		note_ === PANE_STALLED_NOTE ||
		note_ === SLOT_WAIT_NOTE ||
		(typeof note_ === "string" && note_.startsWith(HERDR_DOWN_PREFIX));
	if (!degraded) return note;
	return note ? `${note_}；${note}` : note_;
}

/** 删掉 launcher 的两个临时文件（脚本 + JSON） */
function dropLauncher(script: string | undefined): void {
	if (!script) return;
	for (const f of [script, launcherJsonPath(script)]) {
		try {
			rmSync(f, { force: true });
		} catch {
			/* ignore */
		}
	}
}

/** 会话 jsonl 里第一条 user 消息的正文（= 派活时塞进去的任务文本；没有就 undefined） */
function firstUserTextIn(file: string | undefined): string | undefined {
	return userTextIn(file, "first");
}

/** 会话 jsonl 里最后一条 user 消息的正文（resume 时新任务追加在末尾） */
function lastUserTextIn(file: string | undefined): string | undefined {
	return userTextIn(file, "last");
}

function userTextIn(file: string | undefined, which: "first" | "last"): string | undefined {
	if (!file) return undefined;
	let lines: string[];
	try {
		lines = readFileSync(file, "utf8").split(/\r?\n/);
	} catch {
		return undefined;
	}
	const forward = which === "first";
	for (let n = 0; n < lines.length; n++) {
		const s = lines[forward ? n : lines.length - 1 - n]!.trim();
		if (!s) continue;
		let o: Record<string, unknown>;
		try {
			o = JSON.parse(s) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (o.type !== "message") continue;
		const m = (o.message ?? {}) as Record<string, unknown>;
		if (m.role !== "user") continue;
		return extractText(m.content);
	}
	return undefined;
}

/**
 * 等 worker 会话里出现「任务文本」。
 *   相等    → 送到了
 *   不相等  → 任务被吃掉（立即 false，不用等满 20s）
 *   文件没出现 / 一直等不到 → 超时 false
 * resume（启动前文件已存在）看**最后一条** user 消息，否则看**第一条**。
 */
async function waitTaskDelivered(
	sessionDir: string,
	sessionId: string,
	task: string,
	resumed: boolean,
	timeoutMs = TASK_DELIVER_TIMEOUT_MS,
): Promise<boolean> {
	const want = String(task ?? "").trim();
	const started = Date.now();
	while (true) {
		const file = findSessionFileIn(sessionDir, sessionId);
		const got = resumed ? lastUserTextIn(file) : firstUserTextIn(file);
		if (got !== undefined) return String(got).trim() === want;
		if (Date.now() - started > timeoutMs) return false;
		// 这里用**不 unref** 的定时器：正在等一个真实 I/O 结果，不能因为“没别的事干”
		// 就把进程提前送走（那会变成「任务送没送到」永远没有结论）。
		await new Promise((r) => setTimeout(r, 500));
	}
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

/** 一条 session 事件（`--mode json` 与 `--mode rpc` 形状一致） */
interface EventRecord {
	type?: string;
	message?: { role?: string; content?: unknown };
	assistantMessageEvent?: { type?: string; delta?: unknown; toolCall?: { name?: unknown } };
	toolCallId?: unknown;
	toolName?: unknown;
	/** RPC 命令回执 / UI 请求也走这个形状 */
	method?: unknown;
	id?: unknown;
}

/**
 * 事件对象 → 累积半成品 / 记录工具调用 / 取最终文本。
 * **两种模式共用**：`--mode json` 从 stdout 逐行解析后进来，RPC 直接透传进来。
 */
function handleEvent(obj: EventRecord, sink: Sink): void {
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
	} else if (obj.type === "tool_execution_start") {
		sink.toolRuns.push({
			id: String(obj.toolCallId ?? ""),
			name: String(obj.toolName ?? "tool"),
			startedAt: Date.now(),
			ms: 0,
		});
		// 别让长任务把内存堆满
		if (sink.toolRuns.length > 60) sink.toolRuns.splice(0, sink.toolRuns.length - 60);
	} else if (obj.type === "tool_execution_end") {
		const id = String(obj.toolCallId ?? "");
		// pi 1.1.0 起事件直接带 durationMs（单调时钟量的 execute() 耗时，两路都有）→
		// 优先用它：比 Date.now() 差值准（不受事件乱序影响），重载会话后也照样准。
		const reported = typeof obj.durationMs === "number" ? obj.durationMs : undefined;
		// 从后往前找第一条没结束的（id 对不上时也不至于记错）
		for (let i = sink.toolRuns.length - 1; i >= 0; i--) {
			const r = sink.toolRuns[i]!;
			if (r.ms !== 0) continue;
			if (id && r.id && r.id !== id) continue;
			r.ms = reported ?? Date.now() - r.startedAt;
			break;
		}
	}
}

/** 单行 JSON → handleEvent（只有旧的 `-p --mode json` 那条路还在用） */
function handleLine(line: string, sink: Sink): void {
	if (line.charCodeAt(0) !== 123 /* { */) return;
	let obj: EventRecord;
	try {
		obj = JSON.parse(line) as EventRecord;
	} catch {
		return; // 不是 JSON（可能是 warning），忽略
	}
	handleEvent(obj, sink);
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

// ======================= Herdr 分屏（split / tab）—— Super Agent 的可见 UI =======================
//
// 布局规则（用户定的）：
//   主窗口：左边主会话不动，右侧竖切两格 → 最多 2 个子助理
//   超过 2 个：另开一个 tab（叫 sa:extra#n）放子助理，2×2 四宫格 → 最多 4 个
//   （显式 ui=tab 是另一条路：每个子助理一个 `sa:tab#n` 标签，不经过这里的规划）
//   再多：溢出 tab 也满了 → 再开一个 `sa:extra#2`、`#3`…（每个 tab 最多 overflowSlots 个 pane）
//   还拿不到格（例如主窗口满 + tab 建不出来 / 全是别人留着没关的失败 pane）→ 等槽位，
//   最多等 HERDR_SLOT_WAIT_MS，超时才降级成 rpc 无头模式
//
// 所有 herdr 调用都走 herdr.ts 的薄封装 —— 它**绝不抛**。
// 任何一步失败（没有 herdr / 切不出来 / pane run 失败）→ 返回 undefined，
// runAssistant 自动退回原来的 rpc 无头模式（原逻辑**一行不改**，留作 fallback）。

interface HerdrSlot {
	/** 全局第几格（1-based，planSlot 用的就是它） */
	index: number;
	paneId: string;
	tabId?: string;
	where: "main" | "overflow";
	/** 这个格子里跑的是哪个助理（显示名）—— 只用来算 tab 标题，账里不参与分配 */
	name?: string;
}

/** 进程内槽位表（split / tab 两种模式共用）：key = 全局第几格（planSlot 的 index） */
const herdrSlots = new Map<number, HerdrSlot>();
/**
 * 失败/超时**保留**的 pane：paneId → 保留时刻。
 * 用途只有两个：① TTL（`paneKeepMinutes`，默认 10 分钟）到期自动关；② 回收时挑「最旧的」先关。
 * 只记内存：进程重启后账就没了，这时候 pane 也确实是孤儿了（由 pruneHerdrSlots 兜）。
 */
const keptPaneAt = new Map<string, number>();
/**
 * 溢出 tab：key = tab 编号 n（1-based，标题是 `sa:<n> · <助理名列表>`），value = herdr 的 tabId。
 * 「tab n 的第 m 格」= tabBaseIndex(n, cfg) + m - 1（和 planSlot 共用同一个公式）。
 */
const herdrExtraTabs = new Map<number, { tabId: string }>();
/** tab 模式（每个子助理一个标签）的序号 */
let herdrTabModeSeq = 0;

/** 拿不到槽位时最多等多久（到点才降级 rpc；期间每 HERDR_SLOT_POLL_MS 轮询一次） */
export const HERDR_SLOT_WAIT_MS = 60_000;
/** 等槽位时的轮询间隔（每次先 prune 掉已关闭 pane 的账，再看有没有空格） */
export const HERDR_SLOT_POLL_MS = 300;
/** 「不是满了、只是切 pane 抖了一下」的重试间隔（沿用旧行为：只补一次） */
const HERDR_SLOT_RETRY_MS = 300;

/** 等槽位时可以注入时间 / 轮询（单测用：不用真等 60s） */
export interface SlotWaitDeps {
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** 总等待上限（默认 HERDR_SLOT_WAIT_MS） */
	waitMs?: number;
}

/**
 * 槽位分配要用的 herdr 操作。
 * 单独抽一层是为了**单测能注入假桩**（真 herdr 没法在 CI 里跑，但它正是并发撞车的地方）。
 */
interface HerdrSlotOps {
	mainPaneId(): string | undefined;
	workspaceId(): string | undefined;
	paneList(): { paneId: string; label?: string; tabId?: string }[];
	paneSplit(target: string, dir: "right" | "down", ratio: number, cwd: string): string | undefined;
	tabCreate(workspace: string, label: string, cwd: string): { tabId: string; paneId: string } | undefined;
	tabClose(tabId: string): boolean;
	/** 可选：改 tab 标题（单测注入用；不传就走真的 tabRename） */
	tabRename?(tabId: string, label: string): boolean;
	/** 可选：归还槽位时关 pane（单测注入用；不传就走真的 paneClose） */
	paneClose?(paneId: string): boolean;
}

const realHerdrSlotOps: HerdrSlotOps = { mainPaneId, workspaceId, paneList, paneSplit, tabCreate, tabClose, tabRename, paneClose };
let herdrSlotOps: HerdrSlotOps = realHerdrSlotOps;

/** 单测用：注入假 herdr 桩 / 传 undefined 复位 */
export function setHerdrSlotOps(ops?: HerdrSlotOps): void {
	herdrSlotOps = ops ?? realHerdrSlotOps;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		t.unref?.();
	});
}

/** 启动脚本对应的数据文件（同名的 .json） */
function launcherJsonPath(script: string): string {
	return script.replace(/\.mjs$/i, ".json");
}

/**
 * 把「跑这个 worker 的完整命令行」写成 **JSON 数据 + 纯 ASCII Node 启动脚本**，再用 pane run 启动脚本。
 *
 * 事故史：
 *   1) 命令行直接拼进 .ps1 —— PowerShell 按 ANSI（GBK）而不是 UTF-8 读脚本，
 *      即使加 BOM 也不保险（`pane run` 那层会把命令串再穿一遍），中文全乱、
 *      位置参数（任务文本）被吃掉，worker 只收到几个碎片后空跑一趟。
 *   2) 改成 .ps1 读 JSON —— 仍是 PowerShell 解析：`--name` 存成 `涓昏繘绋?閫氱敤鍔╃悊2`，
 *      任务文本照样丢。根因是「让 shell 帮忙传字符串」这件事本身。
 *
 * 现在（不经任何 shell 解析）：
 *   sa-pane-<tag>.json —— { node, args, env }，UTF-8 **无 BOM**，中文/换行/引号全由 JSON 保证原样
 *   sa-pane-<tag>.mjs  —— **纯 ASCII**，只做三件事：读 JSON → 合并 env → spawn 子进程
 * pane run 的命令 = `node "<mjs>" "<json>"`：纯 ASCII、无反斜杠、无引号嵌套 → 编码/转义无坑可踩。
 */
type EnvPairs = Array<[string, string]>;

/** launcher 的数据部分（单独一个函数，方便单测直接断言「中文原样」） */
function paneLauncherPayload(
	node: string,
	args: string[],
	env: EnvPairs,
): { node: string; args: string[]; env: Record<string, string> } {
	const envObj: Record<string, string> = {};
	for (const [k, v] of env) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
		envObj[k] = String(v);
	}
	return { node, args: [...args], env: envObj };
}

function writePaneLauncher(tpl: Template, argv: string[], opt: RunOptions, tag: string): string | undefined {
	try {
		const stem = join(tmpdir(), `sa-pane-${tag}`);
		const jsonFile = `${stem}.json`;
		const file = `${stem}.mjs`;
		const envs: EnvPairs = [
			["PI_CODING_AGENT_DIR", opt.shadowDir],
			["PI_SKIP_VERSION_CHECK", "1"],
			...Object.entries(tpl.env ?? {}),
		];
		// argv[0] = pi 的 cli.js；用 node 跑它（和 spawnWatched 里的约定一致）
		const payload = paneLauncherPayload(process.execPath, argv, envs);
		// 数据文件：UTF-8 **无 BOM**（JSON.parse 直接读得对；中文/换行/引号全由 JSON 保证原样）
		writeFileSync(jsonFile, JSON.stringify(payload), "utf8");

		// 脚本本体是常量、一个中文字符都没有（纯 ASCII），两个平台通用。
		// 路径不写进脚本：由 `pane run` 的命令串当参数传（命令里一律正斜杠）。
		writeFileSync(file, launcherSource(), "utf8");
		return file;
	} catch {
		return undefined;
	}
}

/** 启动脚本源码（纯 ASCII：不写路径、不拼命令行，只读 JSON 后 spawn） */
function launcherSource(): string {
	return [
		'import { readFileSync } from "node:fs";',
		'import { spawn } from "node:child_process";',
		"const cfgPath = process.argv[2];",
		'const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));',
		'const child = spawn(cfg.node, cfg.args, { stdio: "inherit", env: { ...process.env, ...cfg.env } });',
		'child.on("exit", (code) => process.exit(code ?? 0));',
		'child.on("error", () => process.exit(1));',
		"",
	].join("\n");
}

/** pane run 的命令：`node "<mjs>" "<json>"`（纯 ASCII、无反斜杠、无引号嵌套、不经 PowerShell） */
function paneLaunchCommand(script: string): string {
	// ⚠️ 实测：`pane run` 的命令串里反斜杠会被吃（C:\Users\x → C:Usersx），所以一律正斜杠。
	const s = script.replace(/\\/g, "/");
	const j = launcherJsonPath(s);
	return `node "${s}" "${j}"`;
}

/**
 * 记一笔槽位。
 *
 * 断言：**同一个 paneId 绝不允许被两个槽位同时引用**。
 * 压测里就是这样撞的车：两个任务都看到「#1 空」，都往同一个 pane 里灌命令，
 * 结果第二个任务失败 → 整条 pane 路径返回 undefined → 降级 rpc。
 * 真撞上了宁可丢掉这一格（调用方降级 / 重试），也不能两个任务共用一个 pane。
 */
function recordHerdrSlot(slot: HerdrSlot): HerdrSlot | undefined {
	for (const s of herdrSlots.values()) {
		if (s.paneId === slot.paneId && s.index !== slot.index) return undefined;
		// 同一格也不许被两笔账先后覆盖（覆盖 = 前一笔的 pane 从此没人回收）
		if (s.index === slot.index && s.paneId !== slot.paneId) return undefined;
	}
	herdrSlots.set(slot.index, slot);
	return slot;
}

/** 某个溢出 tab 里现存的槽位（按全局编号排序 = 切 pane 的先后顺序） */
function slotsInTab(tabId: string): HerdrSlot[] {
	return [...herdrSlots.values()].filter((s) => s.tabId === tabId).sort((a, b) => a.index - b.index);
}

/**
 * 溢出 tab 里一个 pane 都不剩了 → 关掉该 tab（用户切过去不会看到空标签）。
 * 如果这个 tab 是我们记在账上的，账也一起销掉（编号会被下个溢出 tab 复用）。
 */
function closeTabIfEmpty(tabId: string | undefined): void {
	if (!tabId) return;
	if (slotsInTab(tabId).length > 0) return;
	for (const [n, t] of [...herdrExtraTabs]) if (t.tabId === tabId) herdrExtraTabs.delete(n);
	const close = herdrSlotOps.tabClose ?? tabClose;
	close(tabId);
}

/**
 * 溢出 tab 的标题跟着「现有助理」走：`sa:<n> · 数据库助理,通用助理`。
 * 分配 / 回收槽位后调一次（tab 模式 `sa:tab#n` 不在这套命名里，直接跳过）。
 * 改不动标签不影响派活 —— 一律吃掉异常。
 */
function syncTabLabel(tabId: string | undefined): void {
	if (!tabId) return;
	const hit = [...herdrExtraTabs].find(([, t]) => t.tabId === tabId);
	if (!hit) return;
	const names = slotsInTab(tabId)
		.map((s) => String(s.name ?? "").trim())
		.filter(Boolean);
	const rename = herdrSlotOps.tabRename ?? tabRename;
	try {
		rename(tabId, tabLabelWithNames(hit[0], names));
	} catch {
		/* 标签改不动不影响结果 */
	}
}

/** 一次分配的结果：`full` = 「格子真的满了，等会儿可能就空出来」（其它失败都是 herdr 抽风） */
type SlotAttempt = { slot?: HerdrSlot; full: boolean };

/** 挑一个槽位并真把它切出来。拿不到（没 herdr / 切失败 / 撞车 / 满了）→ 给出原因 */
function allocHerdrSlotOnce(cwd: string, cfg: UiConfig, mode: UiMode): SlotAttempt {
	const main = herdrSlotOps.mainPaneId();
	const ws = herdrSlotOps.workspaceId();
	if (!main || !ws) return { full: false };
	pruneHerdrSlots(); // 先把「用户已经关掉的 pane」从账上抹掉

	// tab 模式：每个子助理一个标签（自带一格）
	if (mode === "tab") {
		herdrTabModeSeq += 1;
		const t = herdrSlotOps.tabCreate(ws, tabLabelMode(herdrTabModeSeq), cwd);
		if (!t) return { full: false };
		return { slot: recordHerdrSlot({ index: herdrTabModeSeq, paneId: t.paneId, tabId: t.tabId, where: "overflow" }), full: false };
	}

	const mainSlots = Math.max(0, Math.min(2, Math.round(Number(cfg.mainSlots) || 0)));
	const overflowSlots = Math.max(0, Math.min(4, Math.round(Number(cfg.overflowSlots) || 0)));

	// ---- 1) 主窗口：最小的空格 ----
	for (let i = 1; i <= mainSlots; i++) {
		if (herdrSlots.has(i)) continue;
		const plan = planSlot(i, cfg);
		if (plan.where !== "main" || !plan.split) continue;
		const target = plan.anchor === "root" ? main : herdrSlots.get(Number(plan.anchor))?.paneId;
		if (!target) continue;
		const paneId = herdrSlotOps.paneSplit(target, plan.split, plan.ratio ?? cfg.splitRatio, cwd);
		if (!paneId) {
			markHerdrBroken("切 pane 失败"); // 探测说能用但切不出来 → 本会话回 panel
			return { full: false };
		}
		const slot = recordHerdrSlot({ index: i, paneId, where: "main" });
		return { slot, full: false };
	}

	// 主窗口满了但用户显式关了溢出（overflowSlots=0）→ 这就是「满了」，等用户腾格子
	if (overflowSlots < 1) return { full: true };

	// ---- 2) 溢出：先补已有 tab 里还没用的格子（不重开 tab）----
	for (const n of [...herdrExtraTabs.keys()].sort((a, b) => a - b)) {
		const tab = herdrExtraTabs.get(n);
		if (!tab) continue;
		const panes = slotsInTab(tab.tabId);
		if (panes.length >= overflowSlots) continue; // 这个 tab 满了 → 看下一个 / 新建
		const pos = panes.length + 1;
		const index = tabBaseIndex(n, cfg) + pos - 1;
		if (herdrSlots.has(index)) continue; // 记账有洞，这个 tab 不再补（宁缺不错位）
		const plan = planSlot(index, cfg);
		if (!plan.split) continue;
		const anchor = plan.anchor === "root" || plan.anchor === undefined ? undefined : herdrSlots.get(Number(plan.anchor))?.paneId;
		if (!anchor) {
			// 该 tab 的锚点 pane 已经不在了（用户手动关了一格）→ 这个 tab 不能再切，关掉重开
			for (const [k, t] of [...herdrExtraTabs]) if (t.tabId === tab.tabId) herdrExtraTabs.delete(k);
			closeTabIfEmpty(tab.tabId);
			continue;
		}
		const paneId = herdrSlotOps.paneSplit(anchor, plan.split, plan.ratio ?? 0.5, cwd);
		if (!paneId) {
			markHerdrBroken("溢出 tab 里切 pane 失败");
			return { full: false };
		}
		const slot = recordHerdrSlot({ index, paneId, tabId: tab.tabId, where: "overflow" });
		return { slot, full: false };
	}

	// ---- 3) 现有 tab 都满了 → 新开一个 `sa:<n>`（n 取最小的、格子全空的编号；tab 数不设上限）----
	for (let n = 1; ; n++) {
		if (herdrExtraTabs.has(n)) continue;
		const base = tabBaseIndex(n, cfg);
		let free = true;
		for (let i = base; i < base + overflowSlots; i++) if (herdrSlots.has(i)) free = false;
		if (!free) continue;
		const t = herdrSlotOps.tabCreate(ws, tabLabel(n), cwd);
		if (!t) return { full: true }; // 建不出 tab（herdr 不让再开）→ 等会儿再试
		herdrExtraTabs.set(n, { tabId: t.tabId });
		const slot = recordHerdrSlot({ index: base, paneId: t.paneId, tabId: t.tabId, where: "overflow" });
		if (!slot) {
			closeTabIfEmpty(t.tabId);
			return { full: false };
		}
		return { slot, full: false };
	}
	return { full: true };
}

/**
 * 槽位分配的**进程内互斥**：从「找空槽」到「split + 记账」必须是一个整体。
 * 不互斥时：两个并发任务都看到「#1 空」→ 都去切同一个 pane → 第二个失败 → 降级。
 * 一个 Promise 链就够（不需要引依赖）。
 */
let slotAllocQueue: Promise<unknown> = Promise.resolve();

function serializeSlotAlloc<T>(fn: () => T): Promise<T> {
	// 前一个失败也要继续排（用同一个 fn 当 onRejected）
	const run = slotAllocQueue.then(fn, fn);
	slotAllocQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * 拿一个槽位（**满的时候排队等，不再立刻降级 rpc**）：
 *   1. 先直接试一次；
 *   2. 不是「满了」的失败（切 pane / 建 tab 抖了一下）→ 300ms 后补一次，拿不到就降级；
 *   3. 真的满了 → 每 300ms 轮询（每次先 prune 掉已关 pane 的账），最多等 HERDR_SLOT_WAIT_MS；
 *      中途有人关掉 pane / 有 tab 腾出来 → 立刻拿到；到点还是没有 → 返回 undefined（降级 rpc）。
 */
async function allocHerdrSlot(
	cwd: string,
	cfg: UiConfig,
	mode: UiMode,
	deps: SlotWaitDeps = {},
): Promise<HerdrSlot | undefined> {
	const now = deps.now ?? Date.now;
	const nap = deps.sleep ?? sleep;
	const waitMs = Number.isFinite(deps.waitMs) ? Math.max(0, Number(deps.waitMs)) : HERDR_SLOT_WAIT_MS;

	const first = await serializeSlotAlloc(() => allocHerdrSlotOnce(cwd, cfg, mode));
	if (first.slot) return first.slot;
	if (!first.full) {
		// ⚠️ 这里的等一下**不能 unref**：否则事件环空了进程会先退（单测里就会“卡在未决 await”）
		await new Promise<void>((resolve) => setTimeout(resolve, HERDR_SLOT_RETRY_MS));
		const again = await serializeSlotAlloc(() => allocHerdrSlotOnce(cwd, cfg, mode));
		return again.slot;
	}

	const deadline = now() + waitMs;
	// ⚠️ 排队前先回收一格：保留（⏹/❌）的 pane 会永久占槽，不回收就是「每个新任务干等 60s」。
	// 回收成功 → 立刻重试分配一次；拿不到才真的去排队。
	if (reclaimOneKeptPane()) {
		const afterReclaim = await serializeSlotAlloc(() => allocHerdrSlotOnce(cwd, cfg, mode));
		if (afterReclaim.slot) return afterReclaim.slot;
	}
	while (now() < deadline) {
		await nap(Math.min(HERDR_SLOT_POLL_MS, Math.max(0, deadline - now())));
		const r = await serializeSlotAlloc(() => allocHerdrSlotOnce(cwd, cfg, mode));
		if (r.slot) return r.slot;
		if (!r.full) return undefined; // 结构性失败：别空等 60s
	}
	return undefined;
}

/** 归还槽位（closePane=true 时把 pane 也关了；溢出 tab 里没人了就关 tab） */
function releaseHerdrSlot(slot: HerdrSlot | undefined, closePane: boolean): void {
	if (!slot) return;
	if (!closePane) return; // 失败保留：账**也不销**（槽位留着，下次分配前用 pruneHerdrSlots 回收）
	const close = herdrSlotOps.paneClose ?? paneClose;
	close(slot.paneId);
	herdrSlots.delete(slot.index);
	closeTabIfEmpty(slot.tabId);
	syncTabLabel(slot.tabId); // tab 还在 → 把走了的助理从标题里去掉
}

/**
 * 回收「用户已经把 pane 关了」的槽位。
 * 为什么要这一步：失败保留的 pane（paneKeepOnError）会一直占着槽位，
 * 用户手动关掉后账要对得上 —— 不然槽位永远不释放，以后全降级成无头模式。
 */
function pruneHerdrSlots(): void {
	if (herdrSlots.size === 0) {
		// 账上没槽位但有「建了 tab 却没记上格」的残留 → 清掉（编号会给下个溢出 tab 复用）
		for (const n of [...herdrExtraTabs.keys()].sort((a, b) => b - a)) {
			const t = herdrExtraTabs.get(n);
			if (!t) continue;
			herdrExtraTabs.delete(n);
			const close = herdrSlotOps.tabClose ?? tabClose;
			close(t.tabId);
		}
		return;
	}
	const alive = new Set(herdrSlotOps.paneList().map((p) => p.paneId));
	if (alive.size === 0) return; // herdr 刚挂/刚重启 —— 这轮先不下结论
	const touchedTabs = new Set<string>();
	for (const [idx, s] of [...herdrSlots]) {
		if (alive.has(s.paneId)) continue;
		herdrSlots.delete(idx);
		if (s.tabId) touchedTabs.add(s.tabId);
	}
	// 整 tab 的 pane 都没了 → 关 tab（用户切过去不会看到空标签）
	for (const tabId of touchedTabs) closeTabIfEmpty(tabId);
}

/** 按会话 ID 找会话文件（不依赖 assistant-sessions 目录结构，直接用本次的 sessionDir） */
function findSessionFileIn(dir: string, id: string): string | undefined {
	try {
		const hit = readdirSync(dir).find((f) => f.endsWith(`_${id}.jsonl`));
		return hit ? join(dir, hit) : undefined;
	} catch {
		return undefined;
	}
}

/** 会话文件里**最后一条助手正文**（就是它的交卡） */
function lastAssistantTextIn(file: string | undefined): string {
	if (!file) return "";
	let lines: string[];
	try {
		lines = readFileSync(file, "utf8").split(/\r?\n/);
	} catch {
		return "";
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]!.trim();
		if (!l) continue;
		let o: Record<string, unknown>;
		try {
			o = JSON.parse(l) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (o.type !== "message") continue;
		const m = (o.message ?? {}) as Record<string, unknown>;
		if (m.role !== "assistant") continue;
		const txt = extractText(m.content);
		if (txt && txt.trim()) return txt;
	}
	return "";
}

/**
 * pane 最后一行是不是又回到 shell 提示符了（= 我们丢进去的 pi 已经退出）。
 *
 * ⚠️ **不要拿它当 pane 模式的完成信号**（以前就是，结果误判）。原因：
 * pane 里跑的是**交互式 pi**，它答完**不会退出** —— 停在输入框等下一句，
 * 提示符永远不会回来，所以 `paneAtShell(tail)` 在真实分屏里恒为 false。
 * 保留它只是为了将来「非交互」场景（比如直接 `pi -p '<task>'` 丢进 pane）。
 * pane 模式的完成信号只有两个（见 `waitPaneDone`）：`</result>` 硬信号 + 回执正文稳定信号。
 */
export function paneAtShell(tail: string): boolean {
	const lines = String(tail ?? "")
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter((l) => l.trim());
	const last = lines[lines.length - 1] ?? "";
	if (/^PS\s+[A-Za-z]:.*>\s*$/.test(last)) return true; // Windows PowerShell
	if (/^[^\s]+@[^\s]+:[^\s]*\$\s*$/.test(last)) return true; // bash 常见 PS1
	if (/^[A-Za-z]:\\[^>]*>\s*$/.test(last)) return true; // cmd
	return false;
}

/**
 * 输出里是不是已经有**回执正文**了（纯函数，不碰命令行 / 文件）。
 *
 * 这是 `</result>` 之外的**第二种完成信号**：worker 经常只写人话回执
 * （`状态: 完成` / `结论: ...`）而**忘写** `<result>{...}</result>`。
 * 旧逻辑只认 `</result>` → 一直等到超时 → 把成功的活判成「失败」，还留着 pane。
 *
 * 判据故意收得很紧：
 *   - `状态: 完成` / `状态：卡住` / `状态: 需要信息`（半角 / 全角冒号都认）
 *   - 行首的 `结论:` / `证据:`（多行回执的后半段，说明模型在正经写回执）
 *   - **不认** `状态: 完成中` —— 后面紧跟汉字/字母/数字说明词还没写完，早判就把正文截了
 *
 * 这里只判断「有没有」；「稳定 2s」由 `waitPaneDone` 负责（要拿两次采样比）。
 */
export function paneHasReceiptText(output: string): boolean {
	const t = String(output ?? "");
	if (!t.trim()) return false;
	if (/状态\s*[:：]\s*(完成|卡住|需要信息)(?![\u4e00-\u9fa5A-Za-z0-9_])/.test(t)) return true;
	if (/^[ \t]*(结论|证据)\s*[:：]/m.test(t)) return true;
	return false;
}

/** 两次 ctrl+c 之间的间隔（第一次只清输入框，第二次才是真退出） */
export const PANE_STOP_GAP_MS = 300;

/** `stopKeptPane` 的可注入依赖（单测传假桩：不真发键、不真等） */
export interface StopKeptPaneDeps {
	sendKeys?: (paneId: string, keys: string) => boolean;
	rename?: (paneId: string, label: string) => boolean;
	/** 读 pane 屏幕（用来判断 pi 到底退了没有） */
	read?: (paneId: string) => string;
	/** 等两下按键之间（默认 `sleep`；单测传假的，不真等） */
	sleep?: (ms: number) => Promise<void>;
	/** 记账日志（默认 `herdrLog`） */
	log?: (line: string) => void;
}

/**
 * 「失败 / 超时 / ESC 中止 → 保留 pane」时的收尾：**真把里面的 pi 停掉**，再把标签改成「已停」。
 *
 * 为什么必须停：pane 里是交互式 pi，答完/报错都**不退出**，停在输入框。
 * 保留 pane 却留个活进程，等于白占资源 + 用户切过去看到的是「卡住不动」。
 *
 * 为什么要发**两次** ctrl+c（以前只发一次，「已停」是假的）：
 *   pi 里第一次 ctrl+c 只清空输入框（见 pi 的 keybindings.md），进程一点事没有；
 *   第二次才是退出。所以：ctrl+c → 等 `PANE_STOP_GAP_MS` → ctrl+c。
 *   两下之后读一眼屏幕，**还在 pi 界面**（没回到 shell 提示符）→ 再补 `exit` + `return` 兜底。
 *
 * 每一次发键失败都忽略：停不掉也得继续改标签（日志里留 PANE_STOPPED / 失败痕迹）。
 */
export async function stopKeptPane(
	paneId: string,
	name: string,
	idx: number,
	deps: StopKeptPaneDeps = {},
	/** 任务摘要（可选）：保留的 pane 也带上一句话，用户切过去不用猜它是干什么的 */
	summary?: string,
): Promise<{ label: string; stopped: boolean; keys: string[]; escalated: boolean }> {
	const label = paneLabel("stopped", name, idx, summary);
	const send = deps.sendKeys ?? paneSendKeys;
	const nap = deps.sleep ?? sleep;
	const log = deps.log ?? herdrLog;
	const keys: string[] = [];
	const hit = (k: string): boolean => {
		keys.push(k);
		try {
			return send(paneId, k) === true;
		} catch {
			return false; // 停不掉也得继续
		}
	};

	hit("ctrl+c");
	try {
		await nap(PANE_STOP_GAP_MS);
	} catch {
		/* 等不了就直接来第二下 */
	}
	const stopped = hit("ctrl+c");

	// 第二下之后还在 pi 界面（没回到 shell 提示符）→ 补 exit + return
	let escalated = false;
	try {
		const text = (deps.read ?? paneReadSafe)(paneId);
		if (!paneAtShell(text)) {
			escalated = true;
			hit("exit");
			hit("return");
		}
	} catch {
		/* 读不到屏幕就不猜，反正 ctrl+c 已经发了两下 */
	}

	try {
		(deps.rename ?? paneRename)(paneId, label);
	} catch {
		/* 标签改不动不影响结果 */
	}
	try {
		log(`PANE_STOPPED ${paneId}`);
	} catch {
		/* ignore */
	}
	return { label, stopped, keys, escalated };
}

/** 读屏幕但绝不抛（stopKeptPane 的默认 read） */
function paneReadSafe(paneId: string): string {
	try {
		return paneReadEx(paneId).text ?? "";
	} catch {
		return "";
	}
}

// ======================= 保留 pane 的账 / 回收 / TTL / /panes =======================

/** 保留 pane 的默认 TTL（分钟）：超过就自动关，别永久占槽 */
export const PANE_KEEP_MINUTES_DEFAULT = 10;

/** 读 `paneKeepMinutes`（ai-extensions.json → superagent.paneKeepMinutes；默认 10，0 = 永不自动关） */
export function readPaneKeepMinutes(): number {
	const b = readExtCfg().superagent;
	const raw = b && typeof b === "object" ? (b as Record<string, unknown>).paneKeepMinutes : undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return PANE_KEEP_MINUTES_DEFAULT;
	return Math.min(24 * 60, Math.round(n));
}

/**
 * 这个保留的 pane 到 TTL 了没（纯函数）。
 * `minutes <= 0` = 用户显式关掉自动回收 → 永远不到期。
 */
export function paneKeepExpired(keptAt: number, now: number, minutes: number): boolean {
	if (!Number.isFinite(keptAt)) return false;
	if (!Number.isFinite(minutes) || minutes <= 0) return false;
	return now - keptAt > minutes * 60_000;
}

/** 记一笔「这个 pane 被保留了」 */
function markKept(paneId: string, at: number = Date.now()): void {
	if (!paneId) return;
	keptPaneAt.set(paneId, at);
}

/** pane 的状态记号（label 里那个 emoji）→ 给人看的一句话 */
export function paneStateText(label: string | undefined): string {
	const l = String(label ?? "");
	if (l.includes("⏹")) return "⏹已停";
	if (l.includes("❌")) return "❌失败";
	if (l.includes("✅")) return "✅跑完";
	if (l.includes("▶")) return "🟢跑";
	return "· 未知";
}

/** 这个 pane 是不是「保留着、可以回收」的那种（label 含 ⏹ / ❌）—— 纯函数 */
export function paneIsKept(label: string | undefined): boolean {
	const l = String(label ?? "");
	return l.includes("⏹") || l.includes("❌");
}

/**
 * 这个 pane 标题是不是子助理的。
 * 新命名是 `<状态> <助理名>#<序号> · <摘要>`（没有 `sa:` 前缀了）→ 靠「状态记号 + #编号」认；
 * 旧命名 `sa:…` / tab 模式的 `sa:tab#n` 照样认（/reload 之前留下的 pane 也能列、能关）。
 */
export function isSubagentPaneLabel(label: string | undefined): boolean {
	const l = String(label ?? "");
	if (l.includes("sa:")) return true;
	return /^[▶✅❌⏹]\s/.test(l) && /#\d+/.test(l);
}

/** /panes 里一行 */
export interface PaneRow {
	index: number;
	paneId: string;
	label: string;
}

/**
 * 把「账上的槽位」+「herdr 里真实存在的 pane」拼成 /panes 的行（纯函数）。
 *   - 账上的槽位优先（编号 = planSlot 的全局编号，和 /pane-close 的编号一一对应）；
 *   - 账上没有、但 herdr 里还有 `sa:` 前缀的 pane（/reload 之后账丢了）→ 排到后面，照样能关。
 */
export function buildPaneRows(
	panes: { paneId: string; label?: string }[],
	slots: { index: number; paneId: string }[],
): PaneRow[] {
	const labelOf = new Map<string, string>();
	for (const p of panes) if (p && p.paneId) labelOf.set(p.paneId, String(p.label ?? ""));
	const rows: PaneRow[] = [];
	const used = new Set<string>();
	for (const s of [...slots].sort((a, b) => a.index - b.index)) {
		if (!s || !s.paneId || used.has(s.paneId)) continue;
		used.add(s.paneId);
		rows.push({ index: s.index, paneId: s.paneId, label: labelOf.get(s.paneId) ?? "" });
	}
	let next = rows.reduce((m, r) => Math.max(m, r.index), 0);
	for (const p of panes) {
		if (!p || !p.paneId || used.has(p.paneId)) continue;
		if (!isSubagentPaneLabel(p.label)) continue; // 只管子助理的 pane
		used.add(p.paneId);
		next += 1;
		rows.push({ index: next, paneId: p.paneId, label: String(p.label ?? "") });
	}
	return rows;
}

/** 收集本会话的行（真 herdr 走 herdrSlotOps，单测注入桩） */
function collectPaneRows(): PaneRow[] {
	let panes: { paneId: string; label?: string }[] = [];
	try {
		panes = herdrSlotOps.paneList();
	} catch {
		panes = [];
	}
	return buildPaneRows(panes, [...herdrSlots.values()]);
}

/** /panes 的多行文本（纯函数，方便断言） */
export function formatPaneReport(rows: PaneRow[], selfId?: string, mainId?: string): string[] {
	if (rows.length === 0) return ["当前没有子助理 pane"];
	const out = ["子助理 pane（本会话）："];
	for (const r of rows) {
		// 标题去掉状态记号，剩下的就是 `<助理名>#<序号> · <任务摘要>`（和 pane 标题、面板卡片同一份文案）
		const who = String(r.label ?? "").replace(/^[▶✅❌⏹]\s*/, "");
		const name = who || `（herdr 里没标签）${r.paneId}`;
		out.push(`  #${r.index} ${name}  ${r.paneId}  ${paneStateText(r.label)}`);
	}
	out.push(`  （自己：${selfId ?? "未知"} —— 不会被关）`);
	out.push(`主 pane：${mainId ?? "未知"}（永不动）`);
	return out;
}

/** `/pane-close` 的参数（纯函数解析） */
export type PaneCloseTarget =
	| { mode: "kept" }
	| { mode: "all" }
	| { mode: "index"; index: number }
	| { mode: "bad"; arg: string };

export function parsePaneCloseArg(arg: string): PaneCloseTarget {
	const s = String(arg ?? "").trim().toLowerCase();
	if (!s) return { mode: "kept" };
	if (s === "all" || s === "全部" || s === "所有") return { mode: "all" };
	if (/^#?\d+$/.test(s)) {
		const n = Number(s.replace(/^#/, ""));
		if (Number.isFinite(n) && n >= 1) return { mode: "index", index: Math.round(n) };
	}
	return { mode: "bad", arg: String(arg ?? "").trim() };
}

/**
 * 挑出该关哪些行（纯函数）—— **硬规则都在这儿**：
 *   1. 永远跳过自己（`HERDR_PANE_ID`）—— 跳过自己是踩过的事故（助理把自己关了）；
 *   2. 永远跳过主 pane（mainPaneId()）；
 *   3. `kept` 只关 ⏹/❌，`all` 关全部 sa:，`index` 只关那一格（同样受 1、2 约束）。
 */
export function selectPanesToClose(
	rows: PaneRow[],
	target: PaneCloseTarget,
	selfId?: string,
	mainId?: string,
): { close: PaneRow[]; skippedSelf: number; skippedMain: number } {
	const close: PaneRow[] = [];
	if (target.mode === "bad") return { close, skippedSelf: 0, skippedMain: 0 }; // 参数不对 = 一个都不关
	let skippedSelf = 0;
	let skippedMain = 0;
	for (const r of rows) {
		if (!r || !r.paneId) continue;
		if (target.mode === "kept" && !paneIsKept(r.label)) continue;
		if (target.mode === "index" && r.index !== target.index) continue;
		if (selfId && r.paneId === selfId) {
			skippedSelf += 1;
			continue;
		}
		if (mainId && r.paneId === mainId) {
			skippedMain += 1;
			continue;
		}
		close.push(r);
	}
	return { close, skippedSelf, skippedMain };
}

/** 真关一个 pane：销账 + 关空 tab（复用 releaseHerdrSlot 的那套） */
function closePaneAndSlot(paneId: string): boolean {
	const close = herdrSlotOps.paneClose ?? paneClose;
	let ok = false;
	try {
		ok = close(paneId) === true;
	} catch {
		ok = false;
	}
	if (!ok) return false;
	for (const [idx, s] of [...herdrSlots]) {
		if (s.paneId !== paneId) continue;
		herdrSlots.delete(idx);
		closeTabIfEmpty(s.tabId);
	}
	keptPaneAt.delete(paneId);
	return true;
}

/**
 * 执行一次 `/pane-close`（参数已经解析好）。
 * 返回 { closed, skippedSelf, skippedMain }，命令层只负责贴文案。
 */
export function closePanesByTarget(
	target: PaneCloseTarget,
	selfId: string | undefined = mainPaneId(),
	mainId: string | undefined = mainPaneId(),
): { closed: number; skippedSelf: number; skippedMain: number } {
	const rows = collectPaneRows();
	const sel = selectPanesToClose(rows, target, selfId, mainId);
	let closed = 0;
	for (const r of sel.close) if (closePaneAndSlot(r.paneId)) closed += 1;
	return { closed, skippedSelf: sel.skippedSelf, skippedMain: sel.skippedMain };
}

/**
 * 槽位不够时**先回收一个「已停/失败·保留」的 pane**（最旧的那个）。
 *
 * 为什么：以前保留的 pane 永久占槽 → 每个新任务干等 60s 再降级 rpc。
 * 跳过自己和主 pane 的规则复用 `selectPanesToClose`（同一套，绝不两处各写一遍）。
 * 返回 true = 真关掉了一个（调用方可以立刻重试分配）。
 */
export function reclaimOneKeptPane(): boolean {
	const rows = collectPaneRows();
	const selfId = mainPaneId();
	const sel = selectPanesToClose(rows, { mode: "kept" }, selfId, selfId);
	if (sel.close.length === 0) return false;
	// 最旧的先关：没有保留时刻的（老账 / reload 后）排最前
	const oldest = [...sel.close].sort((a, b) => (keptPaneAt.get(a.paneId) ?? 0) - (keptPaneAt.get(b.paneId) ?? 0))[0];
	if (!oldest) return false;
	if (!closePaneAndSlot(oldest.paneId)) return false;
	try {
		herdrLog(`PANE_RECLAIMED ${oldest.paneId}`);
	} catch {
		/* ignore */
	}
	return true;
}

/**
 * 保留 pane 的 TTL 清理（`armBgTimer` 每秒顺手跑一次，不另开定时器）。
 * `minutes = 0`（用户显式关掉）→ 一个都不关。
 */
export function sweepKeptPaneTtl(now: number = Date.now(), minutes: number = readPaneKeepMinutes()): number {
	if (!Number.isFinite(minutes) || minutes <= 0) return 0;
	let closed = 0;
	for (const [paneId, at] of [...keptPaneAt]) {
		if (!paneKeepExpired(at, now, minutes)) continue;
		keptPaneAt.delete(paneId);
		if (paneId === mainPaneId()) continue; // 自己永不动
		if (!closePaneAndSlot(paneId)) continue;
		closed += 1;
		try {
			herdrLog(`PANE_TTL_CLOSED ${paneId}`);
		} catch {
			/* ignore */
		}
	}
	return closed;
}

/** 收尾计划（纯函数）：成功 → 关；失败/超时/ESC 中止 → 按 `paneKeepOnError` 决定停进程+保留还是直接关 */
export type PaneFinishPlan = "close" | "stop-keep";

export function planPaneFinish(input: { outcome: string; aborted?: boolean; keepOnError: boolean }): PaneFinishPlan {
	if (input.outcome === "done") return "close";
	if (input.outcome === "empty") return "close";
	// ESC 中止（aborted）和超时/失败一样处理：**必须先把里面的 pi 停掉**，否则 pane 里留个活进程
	return input.keepOnError ? "stop-keep" : "close";
}

/**
 * `waitPaneDone` 的现实采集口径（单测可以注入假桩，不用真 herdr）。
 *
 * 为什么要个接口：pane 刚被关时 `paneReadEx` / `paneList` 在真机上会抛错，
 * 以前它直接把 waitPaneDone 的 promise 拒掉 —— run 永不 settle → `.bg` 永远 running。
 */
export interface PaneWaitOps {
	/** 读 pane 屏幕（失败也要返回 `{ok:false}`，不要抛） */
	read(paneId: string): { ok: boolean; text: string };
	/** pane 还在吗 */
	alive(paneId: string): boolean;
	/** 采样 / 抛错重试间隔（默认 `PANE_SAMPLE_MS`；单测注入小值，生产别改） */
	sampleMs?: number;
	/** 回执稳定窗口（默认 `PANE_RECEIPT_STABLE_MS`；单测注入小值，生产别改） */
	receiptStableMs?: number;
	/** 连续读失败后的降频间隔（默认 `PANE_SAMPLE_SLOW_MS`；单测注入小值，生产别改） */
	slowSampleMs?: number;
}

const realPaneWaitOps: PaneWaitOps = {
	read: (paneId) => paneReadEx(paneId),
	alive: (paneId) => paneList().some((p) => p.paneId === paneId),
};

/**
 * 等一个 pane 里的 pi 跑完（pane 没了 / 交了回执 / 到点 / **卡死**）。
 *
 * **完成信号只有两个**（别再拿「回到 shell 提示符」当信号，交互式 pi 答完不退出）：
 *   ① 硬信号：会话正文里出现完整的 `</result>`
 *   ② 软信号：出现**回执正文**（`paneHasReceiptText`）且连续 `PANE_RECEIPT_STABLE_MS` 没变化
 *      —— 用来救「回执写全了、但忘了写 `<result>`」的活（以前这种必然超时 → 误判失败）
 *
 * 卡死看门狗（`outcome: "stalled"`）就是在这个循环里顺带做的：
 * 每轮已经读了一次屏幕，拿它和上一次比，记住「最后一次变化」的时刻；
 * 连续 `PANE_IDLE_MS` 没变化 → 返回 stalled，由调用方收 pane + 降级 rpc 重跑。
 * 判定条件全在 `isPaneStalled()`（纯函数）里，这里只负责采集事实：
 *   pane 还活着吗 / 这次读成没读成 / 屏幕内容 / 任务送达过没有。
 */
export async function waitPaneDone(
	slot: HerdrSlot,
	sessionDir: string,
	sessionId: string,
	timeoutMs: number,
	signal?: AbortSignal,
	delivered = true,
	ops: PaneWaitOps = realPaneWaitOps,
): Promise<{ outcome: PaneOutcome; text: string; tail: string; stallLog: string[]; error?: string }> {
	const started = Date.now();
	const sampleMs = Number.isFinite(ops.sampleMs) ? Number(ops.sampleMs) : PANE_SAMPLE_MS;
	// 降频档：生产固定 2000ms；单测注入小值（否则真睡 2s，把用例拖慢）
	const slowSampleMs = Number.isFinite(ops.slowSampleMs) ? Number(ops.slowSampleMs) : PANE_SAMPLE_SLOW_MS;
	const receiptStableMs = Number.isFinite(ops.receiptStableMs) ? Number(ops.receiptStableMs) : PANE_RECEIPT_STABLE_MS;
	let text = "";
	// ---- 卡死看门狗的账 ----
	let lastSeen = ""; // 上一次看到的「屏幕 + 会话正文」指纹
	let lastChangeAt = started; // 最后一次变化时刻（初始 = 开跑那一刻）
	const stallLog: string[] = [];
	let lastReason = "";
	// ---- 回执正文的稳定窗口账（和看门狗分开算：那只盯整屏，这里只盯「回执这段文字」）----
	let receiptSrc = "";
	let receiptSinceAt = 0;
	// 采集异常计数：读 pane / paneList 对已关闭的 pane 真机上会抛错。
	// 以前它直接把 waitPaneDone 的 promise 拒掉 → run 永不 settle → `.bg` 永远 running。
	// 也不再把「连续 3 次抛错」当失败：抛错只说明**读不到**，不等于活失败。
	// 现在最多连续 `PANE_READ_FAIL_LIMIT` 次（≈ 24s）才放弃，且放弃时按「有没有正文」定终态。
	let readFails = 0;
	while (true) {
		try {
			const file = findSessionFileIn(sessionDir, sessionId);
			const t = lastAssistantTextIn(file);
			if (t) text = t;
			const read = ops.read(slot.paneId);
			const tail = clampTail(read.text, STDERR_LIMIT);
			const alive = ops.alive(slot.paneId);

			// 屏幕或会话正文只要变了 → 刷新「最后一次变化」
			const seen = `${read.ok ? "1" : "0"}\u0000${read.text}\u0000${t}`;
			if (seen !== lastSeen) {
				lastSeen = seen;
				lastChangeAt = Date.now();
				lastReason = "";
			}

			// ---- ① 硬信号：会话正文里有完整的 <result>...</result> ----
			if (/<\/result>/.test(text)) return { outcome: "done", text, tail, stallLog };

			// ---- ② 软信号：回执正文（人话回执、没写 <result>）+ 连续稳定窗口没变化 ----
			// 注意「稳定」看的是**回执这段文字**本身（不是整屏）：模型续写「证据 / 改了哪些文件」
			// 会让文字延长 → 窗口重置 → 不会把正文截掉。
			const receipt = paneHasReceiptText(text) || paneHasReceiptText(read.text);
			if (receipt) {
				const src = paneHasReceiptText(text) ? text : read.text;
				if (src !== receiptSrc) {
					receiptSrc = src;
					receiptSinceAt = Date.now();
				} else if (Date.now() - receiptSinceAt >= receiptStableMs) {
					return { outcome: "done", text: text || tail, tail, stallLog };
				}
			} else {
				receiptSrc = "";
				receiptSinceAt = 0;
			}

			if (!alive) {
				// pane 被关了：有正文就当跑完（可能用户手动关的），没正文算失败
				return { outcome: text ? "done" : "failed", text, tail, stallLog };
			}
			if (signal?.aborted) return { outcome: "failed", text, tail, stallLog };
			if (Date.now() - started > timeoutMs) return { outcome: "timeout", text, tail, stallLog };

			// ---- 卡死看门狗 ----
			// 注意：read.ok === false / 空屏 / 有执行迹象 → isPaneStalled 都不杀，这里只把原因记进日志，
			// 留着排查「为什么看门狗没动手」。（同一个原因只记一条，不刷屏）
			const ctx = { alive, readable: read.ok, output: read.text };
			const stalled = isPaneStalled(lastChangeAt, Date.now(), delivered, ctx);
			if (stalled) {
				stallLog.push(`[看门狗] pane ${slot.paneId} 连续 ${Math.round((Date.now() - lastChangeAt) / 1000)}s 无输出 → 判卡死`);
				return { outcome: "stalled", text, tail, stallLog };
			}
			const reason = paneStallReason(lastChangeAt, Date.now(), delivered, ctx);
			if (reason !== "idle" && reason !== lastReason) {
				lastReason = reason;
				stallLog.push(`[看门狗] 暂不判卡死（${reason}）`);
			}
			readFails = 0; // 本轮采集全成功
		} catch (e) {
			readFails += 1;
			const msg = e instanceof Error ? e.message : String(e);
			stallLog.push(`[收尾] 采集 pane 状态抛错（第 ${readFails} 次）：${msg}`);
			// 连续读不到 → 降频：每 800ms 狂敲 herdr 既没用又费机器（pane 已关时就是一路抛错）。
			// 只记一条（第 3 次那一刻），之后每次抛错不再重复记，免得日志刷屏。
			if (readFails === PANE_READ_FAIL_SLOW_AFTER) {
				stallLog.push(`[采样] 连续读失败 ${readFails} 次，降频到 ${slowSampleMs}ms`);
			}
			// 抛错时**优先用会话 jsonl 当事实来源**：pane 读不到 ≠ 活没跑完。
			// pi 自己写的会话文件是另一条独立渠道，读得到正文就先记下来（放弃时据此判 done）。
			try {
				const file = findSessionFileIn(sessionDir, sessionId);
				const t = lastAssistantTextIn(file);
				if (t) text = t;
			} catch {
				/* 会话文件也读不到 → 只能靠计数兜底 */
			}
			if (readFails >= PANE_READ_FAIL_LIMIT) {
				return {
					outcome: text ? "done" : "failed",
					text,
					tail: "",
					stallLog,
					error: `采集 pane 状态连续抛错 ${readFails} 次：${msg}`,
				};
			}
		}
		if (signal?.aborted) return { outcome: "failed", text, tail: "", stallLog };
		if (Date.now() - started > timeoutMs) return { outcome: "timeout", text, tail: "", stallLog };
		await sleep(effectiveSampleMs(readFails, sampleMs, slowSampleMs));
	}
}

/**
 * 试着用 Herdr 跑一把。
 * 返回 RunResult = 已经跑完了（不管成败）；返回 undefined = 没走成，调用方退回 rpc 无头模式。
 */
async function tryRunInHerdr(
	tpl: Template,
	task: string,
	opt: RunOptions,
	argv: string[],
	job: LiveJob,
	sink: Sink,
	makeResult: (outcome: Outcome, exitCode: number | null) => RunResult,
): Promise<RunResult | undefined> {
	/** pane / tab 标题共用的任务摘要（12 字）—— 先在函数头算好，后面四处重命名都用它 */
	const summary = paneSummary(task);
	let slot: HerdrSlot | undefined;
	let script: string | undefined;
	/** pane 里的活真的开跑了（这之后**必须有终态**，绝不带着 running 离开） */
	let started = false;
	/** 终态只写一次（重复写会把 delivered / 面板小票冲乱） */
	let finalized = false;
	/** 兜底计时器已经强制收尾过（后续收尾就不许再还锁 / 还槽位） */
	let abandoned = false;
	let guard: { clear: () => void } | undefined;
	/** 卡在哪一步（写错误信息用） */
	let stage = "init";
	let result: RunResult | undefined;

	const clearGuard = (): void => {
		if (guard) {
			guard.clear();
			guard = undefined;
		}
	};

	/**
	 * 写终态（`.bg` + 投递登记 + 面板小票），**只写一次，且自己绝不抛**。
	 *
	 * 这就是本次回归的修法核心：以前这段只存在于 rpc 分支的 `finish()` 里，
	 * pane 分支跑完直接 `return makeResult(...)` → `opt.onSettle` 从没被调用 →
	 * `.bg` 永远 `running`、轮询永远不认领 → 回执永远不投。
	 */
	const settle = (outcome: Outcome, text: string, error?: string, forced = false): RunResult => {
		const exitCode = forced ? null : outcome === "done" ? 0 : outcome === "timeout" ? null : 1;
		const r = makeResult(outcome, exitCode);
		r.degradeNote = job.note; // 批次汇总卡要靠它标 ⚠️
		if (finalized) return r;
		finalized = true;
		clearGuard();
		const fields = finalizeHerdrRun({ outcome, text, error, forced });
		// ① 正文归档（pane 这条路的收尾点）：完整正文落盘，路径写进 `.bg` 的 resultPath。
		//    ⚠️ 必须**先于** onSettle：批次汇总卡的「正文归档」段要逐件列路径（archivePathOf）。
		try {
			archiveTaskRun({ bgId: opt.bgId, tpl, names: opt.names, task, r, text, status: fields.status });
		} catch {
			/* 归档失败不影响任务本身 */
		}
		// ② 投递链：onSettle 负责「富卡片 + 交给 pollBgTasks 回投」（rpc 分支走的是同一条链）
		try {
			opt.onSettle?.(r);
		} catch (e) {
			try {
				sink.stderr = clampTail(`${sink.stderr}\n[收尾] onSettle 抛错：${e instanceof Error ? e.message : String(e)}`, STDERR_LIMIT);
			} catch {
				/* ignore */
			}
		}
		// ③ 保险：onSettle 缺失 / 抛错时也把终态写进 `.bg`
		//    （合并写：不覆盖已有卡片，绝不把 delivered:true 冲回 false）
		try {
			writeHerdrBgTerminal(opt.bgId, fields);
		} catch {
			/* 已经是最后一道兜底了 */
		}
		// ④ 面板小票
		try {
			markEnd(
				job,
				outcome === "done" ? "done" : outcome === "timeout" ? "timeout" : "failed",
				withDegrade(
					job,
					error ??
						(outcome === "done"
							? "分屏里跑完了（pane 已收起）"
							: outcome === "timeout"
								? "超时（pane 留着，要看就切过去）"
								: "失败（pane 保留，用 /pane-close 关闭）"),
				),
			);
		} catch {
			/* ignore */
		}
		return r;
	};

	/** 还会话锁 + 并发槽位（只还一次；兜底计时器已经还过就不碰） */
	const releaseAll = (): void => {
		if (abandoned) return;
		abandoned = true;
		try {
			releaseSessionLock(opt.names.id);
		} catch {
			/* ignore */
		}
		try {
			releaseRunSlot();
		} catch {
			/* ignore */
		}
	};

	try {
		const cfg = readUiConfig();
		const status = herdrStatus();
		const mode = resolveUiMode(cfg, activeRuns, status.ok);
		if (mode === "panel") {
			// 用户配了 auto/split/tab 却掉到 panel → 必须说清楚为什么，别静默降级
			const wanted = cfg.ui;
			if ((wanted === "auto" || wanted === "split" || wanted === "tab") && !status.ok) {
				job.note = herdrDownNote(status.reason, wanted); // 卡片上直接写原因（live.ts 渲染 job.note）
				notifyHerdrDownOnce(bgCtx, status.reason); // 每会话只提醒一次
				notifyLive();
			}
			return undefined;
		}
		if (!mainPaneId()) {
			// 探测说能用，但本会话没有 pane 号 → 切不了，本次会话别再试
			markHerdrBroken("拿不到本会话的 pane（HERDR_PANE_ID 未设）");
			return undefined;
		}

		stage = "alloc";
		slot = await allocHerdrSlot(tpl.cwd, cfg, mode);
		if (!slot) {
			// 等满 60s 还是没格 → 降级 rpc（备注要能让用户看出「不是派失败，是没位了」）
			job.note = SLOT_WAIT_NOTE;
			notifyLive();
			return undefined;
		}

		const label = paneLabel("run", tpl.name, slot.index, summary);
		paneRename(slot.paneId, label);
		slot.name = tpl.name; // 记账：tab 标题要用「这个 tab 里有谁」
		syncTabLabel(slot.tabId);
		job.paneId = slot.paneId;
		job.tabId = slot.tabId;
		job.uiMode = mode;
		job.slotIndex = slot.index;
		notifyLive();

		// 交互式参数：去掉 --mode rpc / -p --mode json，其余白名单照旧；末尾加任务文本
		const interactive = stripHeadlessArgs(argv).concat(task);
		// resume 时会话文件已经存在：那时「第一条 user 消息」是上一次的任务，改看最后一条
		const existedBefore = findSessionFileIn(opt.sessionDir, opt.names.id) !== undefined;
		stage = "launch";
		script = writePaneLauncher(tpl, interactive, opt, `${opt.names.id}-${slot.index}`);
		if (!script || !paneRun(slot.paneId, paneLaunchCommand(script))) {
			// pane 已经切出来了但活没跑起来 —— 收干净再降级
			releaseHerdrSlot(slot, true);
			dropLauncher(script);
			job.paneId = undefined;
			job.tabId = undefined;
			job.uiMode = undefined;
			job.slotIndex = undefined;
			// 放宽探测后的兜底锁：本会话别再往 pane 里试了（每次白等 10s 超时）
			markHerdrBroken("pane 里跑不起 pi（pane run 失败）");
			return undefined;
		}

		// ---- 兜底计时器：活进了 pane 就开始计时 ----
		// 即使收尾逻辑再出错（读 pane 抛错 / finally 里又抛 / promise 永远不 resolve），
		// 到点也必须写一次终态 —— 这是「.bg 永远 running」的最后一道堤。
		const guardMs = opt.timeoutMs + HERDR_FINALIZE_GRACE_MS;
		guard = armHerdrFinalizeGuard(guardMs, () => {
			const msg = `兜底计时器到点（pane 收尾没在 ${Math.round(guardMs / 1000)}s 内跑完）`;
			try {
				sink.stderr = clampTail(`${sink.stderr}\n[收尾] ${msg}`, STDERR_LIMIT);
			} catch {
				/* ignore */
			}
			try {
				settle("timeout", sink.final, msg, true);
			} catch {
				/* 连 settle 都炸就真没撤了 */
			}
			// 收干净：pane / 槽位 / 会话锁都不许留
			abandoned = true;
			try {
				if (slot) releaseHerdrSlot(slot, true);
			} catch {
				/* ignore */
			}
			try {
				releaseSessionLock(opt.names.id);
			} catch {
				/* ignore */
			}
			try {
				releaseRunSlot();
			} catch {
				/* ignore */
			}
			started = false; // 已经收尾过，finally 别再写一遍
		});

		// ---- 关键断言：任务文本到底送到了没有 ----
		// 编码事故过的链「不报错、只空跑」，所以必须拿会话文件反查第一条 user 消息。
		// 不相等 / 超时 / 文件没出现 → **立刻关 pane + 降级 rpc 重跑**（宁可没见过过程，也不许 worker 收到空任务）。
		stage = "deliver";
		const delivered = await waitTaskDelivered(opt.sessionDir, opt.names.id, task, existedBefore);
		if (!delivered) {
			releaseHerdrSlot(slot, true);
			dropLauncher(script);
			job.paneId = undefined;
			job.tabId = undefined;
			job.uiMode = undefined;
			job.slotIndex = undefined;
			job.note = PANE_DEGRADED_NOTE;
			notifyLive();
			return undefined; // 调用方接着走 rpc 无头模式（会话锁 / 槽位都还在，不释放）
		}
		// 从这一刻起：活真的在 pane 里跑了，怎么结束都必须有终态
		started = true;

		stage = "wait";
		let res: Awaited<ReturnType<typeof waitPaneDone>>;
		try {
			res = await waitPaneDone(slot, opt.sessionDir, opt.names.id, opt.timeoutMs, opt.signal, delivered);
		} catch (e) {
			// waitPaneDone 内部已经接住了大部分异常，这里是最后一道：
			// 绝不让它的 reject 把 run 悬空（以前就是这么静默 reject → 永不 settle）。
			res = {
				outcome: "failed",
				text: "",
				tail: "",
				stallLog: [`[收尾] waitPaneDone 抛错：${e instanceof Error ? e.message : String(e)}`],
				error: `waitPaneDone 抛错：${e instanceof Error ? e.message : String(e)}`,
			};
		}

		// ---- 卡死看门狗扣下的活：收 pane + 释放槽位 + 降级 rpc 重跑同一个任务 ----
		// 为什么可以安全的重跑：pane 里的活一个字都没吐（90s 屏幕没变），会话文件里也没有可用的正文，
		// 所以不存在「跑了两次、结果冲突」；而且这里是**回收后再降级**，不会两个进程同时写会话。
		if (res.outcome === "stalled") {
			paneRename(slot.paneId, paneLabel("stalled", tpl.name, slot.index, summary));
			releaseHerdrSlot(slot, true); // closePane=true：关 pane + 销槽位（溢出 tab 没人了就关 tab）
			dropLauncher(script);
			job.paneId = undefined;
			job.tabId = undefined;
			job.uiMode = undefined;
			job.slotIndex = undefined;
			job.note = PANE_STALLED_NOTE;
			job.lastEventAt = Date.now();
			notifyLive();
			sink.stderr = clampTail(`${sink.stderr}\n${res.stallLog.join("\n")}`.trim(), STDERR_LIMIT);
			// 返回 undefined → 调用方接着走 rpc 无头模式（终态由 rpc 分支写；这里写会把重跑的结果提前锁成失败）
			started = false;
			return undefined;
		}

		if (res.stallLog.length) {
			sink.stderr = clampTail(`${sink.stderr}\n${res.stallLog.join("\n")}`.trim(), STDERR_LIMIT);
		}
		sink.final = res.text;
		sink.stderr = clampTail(`${sink.stderr}\n${res.tail}`.trim(), STDERR_LIMIT);

		// ---- 与 rpc 分支对等的收尾：终态先写，pane 修饰后做 ----
		// 顺序很重要：以前是先改标签 / 关 pane / markEnd，任何一步抛错就丢了终态。
		stage = "settle";
		releaseAll();
		result = settle(res.outcome, res.text, res.error);

		// 收尾：成功 → 改 ✅ → 2s → 关；失败/超时/**ESC 中止** → 先停掉里面的 pi，再按 `paneKeepOnError` 决定保留还是关
		try {
			const aborted = opt.signal?.aborted === true;
			const plan = planPaneFinish({ outcome: res.outcome, aborted, keepOnError: cfg.paneKeepOnError });
			if (plan === "close") {
				if (res.outcome === "done") {
					paneRename(slot.paneId, paneLabel("ok", tpl.name, slot.index, summary));
					setTimeout(() => releaseHerdrSlot(slot, true), 2000).unref?.();
				} else {
					releaseHerdrSlot(slot, true);
				}
			} else {
				// 保留 pane（内容还在，用户能看），但**必须先把里面的 pi 停掉**：
				// 交互式 pi 答完/报错都不退出，留着就是活进程白占 pane（切过去像「卡住」）。
				// 这里对**超时 / 失败 / ESC 中止**一视同仁 —— ESC 以前只让 waitPaneDone 返回 failed，
				// 却把活着的 pi 留在 pane 里，用户看到的是「停了但没停」。
				await stopKeptPane(slot.paneId, tpl.name, slot.index, {}, summary);
				markKept(slot.paneId); // TTL / 回收靠这笔账
				releaseHerdrSlot(slot, false);
			}
			dropLauncher(script);
		} catch (e) {
			// pane 修饰失败不影响结果（终态已经落了）
			sink.stderr = clampTail(
				`${sink.stderr}\n[收尾] pane 修饰失败：${e instanceof Error ? e.message : String(e)}`,
				STDERR_LIMIT,
			);
		}
		return result;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		try {
			sink.stderr = clampTail(`${sink.stderr}\n[收尾] pane 收尾异常（${stage}）：${msg}`, STDERR_LIMIT);
		} catch {
			/* ignore */
		}
		try {
			if (slot) releaseHerdrSlot(slot, true);
		} catch {
			/* ignore */
		}
		try {
			if (script) dropLauncher(script);
		} catch {
			/* ignore */
		}
		releaseAll();
		// 活还没开跑（分配 / 起跑阶段就炸了）→ 交给 rpc 重试
		if (!started) return undefined;
		return settle("failed", sink.final, `pane 收尾异常（${stage}）：${msg}`);
	} finally {
		clearGuard();
		// 最后一道闸：只要活真的开跑过，就绝不带着 `running` 离开这个函数
		if (started && !finalized) {
			try {
				result = settle("failed", sink.final, "pane 收尾没走到终态（finally 兜底）");
			} catch {
				/* ignore */
			}
		}
	}
}

/** 把无头模式的参数改成交互式：去掉 `--mode rpc` / `-p --mode json` */
function stripHeadlessArgs(argv: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--mode" && (argv[i + 1] === "rpc" || argv[i + 1] === "json")) {
			i++; // 连值一起跳过
			continue;
		}
		if (a === "-p" || a === "--print") continue;
		out.push(a);
	}
	return out;
}

// ======================= 跑一个助理 =======================
interface RunOptions {
	timeoutMs: number;
	/** 可选：后台任务不传（不随本轮 turn 结束被 abort） */
	signal?: AbortSignal;
	names: Names;
	resumed: boolean;
	/** 主会话当前模型（`provider/id`）。模板没写 `model` 时用它 —— 「默认继承主会话」 */
	mainModel?: string;
	/** 影子 agentDir（只含本助理该有的 mcp.json） */
	shadowDir: string;
	/** 助理专属会话目录（不在 sessions/ 下，/resume 看不见） */
	sessionDir: string;
	/** 后台任务完成时回调（写状态文件、触发回投）。同步模式不用。 */
	onSettle?: (r: RunResult) => void;
	/** 后台任务的记账 id（异步派活才有）：pane 分支的收尾靠它兜底写 `.bg` 终态 */
	bgId?: string;
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
	const sink: Sink = { partial: "", tools: [], final: "", stderr: "", toolRuns: [] };
	/** 到点前发过的收尾动作（要在 base() 里带上，所以提到这层） */
	const windDownLog: string[] = [];
	const base = (outcome: Outcome, exitCode: number | null): RunResult => ({
		outcome,
		text: sink.final.trim(),
		partial: sink.partial,
		tools: sink.tools,
		toolRuns: sink.toolRuns.map((t) => ({ name: t.name, ms: t.ms })),
		windDownLog: [...windDownLog],
		// pi 1.2.0：`-p` 模式下最终回复撞到输出上限时，会打印已产出的文本、
		// stderr 写 "Response was truncated: the model reached its output token limit."、并以退出码 1 结束。
		truncated: /output token limit/i.test(sink.stderr),
		// 回执只从「最终回复」里解析（partial 是半截，不能当证据）
		report: parseReport(sink.final),
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

	// 实时视图：**先建小票，再拿槽位**。
	// 旧顺序是先 await 槽位再建小票 —— 排队的任务在面板上完全看不见，用户以为派出去的活丢了。
	// 现在排队期间小票就挂在面板上（status=queued → 渲染成「⏳ 排队中」）。
	// 注意：槽位已满的判断只是「预判」（用于决定小票初始状态），真正的计量在 acquireRunSlot() 里。
	const limit = readMaxConcurrent() || MAX_CONCURRENT_RUNS;
	const willQueue = activeRuns >= limit;
	const job = newJob({
		key: tpl.key,
		name: tpl.name,
		task,
		sessionId: opt.names.id,
		startedAt: started,
		status: willQueue ? "queued" : "running",
	});
	sink.live = job;
	addJob(job);

	// 并发上限：超出的先排队（防一次派太多打爆机器 / 额度）
	await acquireRunSlot();
	if (job.status !== "running") {
		// 拿到槽位 → 正式起跑（面板从「⏳ 排队中」变成「● 在跑」）
		job.status = "running";
		job.lastEventAt = Date.now();
		notifyLive();
	}
	// 排队期间可能已被中止（用户停掉 / 主会话退出）：拿到槽位也别再起进程 ——
	// 但小票要收尾（否则面板上永远是「在跑」），槽位也要立即归还。
	if (opt.signal?.aborted) {
		markEnd(job, "failed", "排队期间被中止，未启动");
		releaseSessionLock(opt.names.id);
		releaseRunSlot();
		return base("failed", null);
	}

	// -xt：助理不需要面板工具（影子目录下本来也没有 ai-configure，这里是双保险）
	// 工具控制：
	//   - 默认：黑名单只挡面板工具（助理不需要 delegate/progress）
	//   - 模板写了 tools: → 白名单（-t），只给列出的工具
	//   - 模板写了 deny_tools: → 追加到黑名单
	// ⚠️ pi 1.0.4 起 `-t/--tools` 的语义：**MCP 工具默认保留**，只有白名单里出现
	//    `mcp__` 开头的条目时才按它过滤 MCP。所以「列了 tools 就必须逐个列出 MCP 工具」
	//    已经是旧说法（老版本会把 MCP 一起挡掉）。
	const denyTools = ["delegate", "progress", "git_read", ...(tpl.denyTools ?? [])];
	// RPC 模式：stdin 保持打开，才能在到点前发 steering 催它收尾（这是本次改造的全部理由）。
	// 旧模式 `-p --mode json` 是单向的，写完 prompt 就只能等它自己跑完或被杀。
	const useRpc = await rpcSupported(cli);
	const args = useRpc
		? [cli, "--mode", "rpc", "-xt", denyTools.join(",")]
		: [cli, "-p", "--mode", "json", "-xt", denyTools.join(",")];
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
	// 模型：模板写了就用模板的；没写 → 继承主会话当前模型（provider/id）。
	// 不继承的话 pi 会走自己的默认解析（settings.defaultModel → 内置默认 → models.json 第一个），未必是你在用的。
	const modelArg = tpl.model || opt.mainModel;
	if (modelArg) args.push("--model", modelArg);
	const body = [
		tpl.body,
		deadlineRule(Math.round(opt.timeoutMs / 1000), opt.resumed),
		reportRule(), // Super Agent 开着时要求结构化回执（关着就是空串，等于没加）
		superagentEnabled() ? permissionRule(tpl.perms, tpl.cwd) : "", // L2：先告诉它边界，别让它靠试
	]
		.filter(Boolean)
		.join("\n\n");
	if (body) args.push("--append-system-prompt", body);

	// ---------- Herdr 分屏模式（split / tab）----------
	// 走成了 → 直接返回结果（pane 里跑，用户能看见全貌）；
	// 没走成（非 Herdr / 任何 herdr 调用失败）→ 返回 undefined，下面原封不动走 rpc 无头模式。
	{
		const viaPane = await tryRunInHerdr(tpl, task, opt, args, job, sink, base);
		if (viaPane) return viaPane;
	}

	return new Promise<RunResult>((done) => {
		let timedOut = false;
		let settled = false;

		// ---------- 槽位释放：单次兜底 ----------
		// 为什么要提前到「子进程退出的那一刻」：回执解析 / 落盘 / 面板收尾都占时间，
		// 以前这些干完才 release，实测每个任务之间白空 ~3.7s（4 个槽位等于只跑 3 个）。
		// ⚠️ released 必须是单次的：异常 / 超时 / 手动中断三条路径都可能重复走到释放，
		//    重复 release 会把 activeRuns 减亏，以后就永远只剩 3 个槽。
		let released = false;
		const releaseSlot = (): void => {
			if (released) return;
			released = true;
			releaseRunSlot();
		};
		/** kill 发出后等不到 close 的兜底（宁可信错，也绝不泄漏槽位） */
		let escapeTimer: ReturnType<typeof setTimeout> | undefined;

		// ---------- 到点前优雅收尾（RPC 专属状态）----------
		let softTimer: ReturnType<typeof setTimeout> | undefined;
		let hardTimer: ReturnType<typeof setTimeout> | undefined;
		let wrapUpTimer: ReturnType<typeof setTimeout> | undefined;
		/** 硬收尾已发起 abort，等 agent_settled 到了要追问一次（而不是就此收工） */
		let expectWrapUp = false;
		let wrapUpSent = false;
		/** 硬档已经开火了 → 这次运行算「超时被叫停」，而不是 done */
		let hardWindDownFired = false;
		/** 追问交卡的实现（在收尾块里赋值，因为要等 rpc 就绪） */
		let wrapUpHook: (() => void) | undefined;

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
			// 起不来的话小票也必须收尾 —— 否则面板上永远挂着一个假的「在跑/排队中」
			markEnd(job, "failed", "子进程启动失败");
			releaseSessionLock(opt.names.id);
			releaseSlot();
			done(base("failed", null));
			return;
		}

		// ---------- 传输层：RPC（双向）或 旧 JSON（单向）----------
		// RpcChannel 自己订阅 stdout；旧路径才需要 jsonRead 逐行喂。
		let rpc: RpcChannel | undefined;
		/** prompt 的唯一出口（正常 1 条；硬收尾追问再 1 条，见 makePromptGate） */
		const prompts = makePromptGate();
		let jsonRead: ((chunk: string) => void) | undefined;
		if (useRpc) {
			rpc = new RpcChannel(child);
			rpc.onEvent((rec) => {
				handleEvent(rec, sink);
				if (rec.type === "agent_settled") {
					// 硬收尾阶段：这一条 settled 是 `abort` 把它打断产生的 → **不是**收工，而是追问交卡。
					// 追问那一次跑完后再 settled，才真正收工。
					//
					// pi 1.1.0 起 agent_settled 带 `aborted`（RPC / JSON 都透传：{type,aborted}）。
					// 有它就按它判，不再靠 expectWrapUp 猜 —— 否则「abort 发出去时对方刚好自己跑完了」
					// 会被当成被我们打断，白多发一轮追问。aborted === undefined 才是旧版 pi，退回猜。
					const aborted = (rec as { aborted?: boolean }).aborted;
					const wantWrapUp = expectWrapUp && !wrapUpSent && aborted !== false;
					if (wantWrapUp) {
						expectWrapUp = false;
						if (wrapUpTimer) {
							clearTimeout(wrapUpTimer);
							wrapUpTimer = undefined;
						}
						wrapUpHook?.();
					} else {
						expectWrapUp = false;
						// 正常情况下：这一轮不会再自动续跑/重试 → 有序关闭 stdin，让 pi 收工退出。
						// 迟迟不来的，由下面的 timer killTree 兜底。
						rpc?.closeStdin();
					}
				}
			});
			// dialog 类请求（select/confirm/input/editor）**必须应答**：
			// 不应答 pi 会一直 blocking 等 response → 子助理永久挂住。
			// 语义对齐「非交互 = 拒绝」。notify/setStatus 这类不需要应答，rejectDialog 会自己跳过。
			rpc.onUi((rec) => rejectDialog(rpc!, rec));
		} else {
			jsonRead = makeLineReader(sink);
		}

		const finish = (outcome: Outcome, exitCode: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (softTimer) clearTimeout(softTimer);
			if (hardTimer) clearTimeout(hardTimer);
			if (wrapUpTimer) clearTimeout(wrapUpTimer);
			if (escapeTimer) clearTimeout(escapeTimer);
			opt.signal?.removeEventListener("abort", onAbort);
			liveJobs.delete(child);
			// 面板终态：写在这里而不是事件里 —— agent_end 不代表进程结束（可能还会重试/续跑）
			const liveStatus: EndStatus = outcome === "timeout" ? "timeout" : outcome === "failed" ? "failed" : "done";
			markEnd(
				job,
				liveStatus,
				withDegrade(
					job,
					outcome === "timeout"
						? "超时被停止（要接着做用 resume）"
						: outcome === "empty"
							? "跑了但没吐结论"
							: exitCode && exitCode !== 0
								? `子进程退出码 ${exitCode}`
								: undefined,
				),
			);
			const r = base(outcome, exitCode);
			r.degradeNote = job.note; // 批次汇总卡要靠它标 ⚠️
			releaseSessionLock(opt.names.id);
			releaseSlot(); // 兜底：正常路径在 close/exit 里已经释放过，这里保证「无论如何都释放」
			// 正文归档（rpc 这条路的收尾点，与 pane 的 settle 对齐）：
			// ⚠️ 必须**先于** onSettle：批次汇总卡的「正文归档」段要逐件列路径（archivePathOf）。
			try {
				archiveTaskRun({
					bgId: opt.bgId,
					tpl,
					names: opt.names,
					task,
					r,
					text: r.text || r.partial,
					status: outcomeToStatus(outcome),
				});
			} catch {
				/* 归档失败不影响任务本身 */
			}
			opt.onSettle?.(r);
			done(r);
		};

		/**
		 * kill 之后的逃生门：正常情况 close/exit 会先把槽位还回来；
		 * 万一 kill 了却等不到 close（子进程卡死 / 平台差异），8 秒后自己收尾。
		 * **宁可写一张失败卡，也绝不泄漏槽位**（漏一个 = 以后永远只剩 3 个并发）。
		 */
		const armEscape = (outcome: Outcome): void => {
			if (escapeTimer || settled) return;
			escapeTimer = setTimeout(() => {
				escapeTimer = undefined;
				finish(outcome, null);
			}, ESCAPE_RELEASE_MS);
			// 纯兜底定时器，不该拖着进程不让退
			escapeTimer.unref?.();
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child); // 到点就杀，绝不留孤儿；要接着做靠 resume 续跑
			armEscape("timeout");
		}, opt.timeoutMs);

		const onAbort = (): void => {
			timedOut = false;
			killTree(child);
			armEscape("failed");
		};
		opt.signal?.addEventListener("abort", onAbort);

		// ---------- 到点前优雅收尾（两档）----------
		// 只能靠 RPC：旧模式是单向的，一个字节都发不进去，只能到点硬杀。
		//   软档 = T - max(120s, 25%·T)：steer 一句“开始收尾，把已确认的结论整理出来”。
		//          不打断它，只在两个 tool call 之间插话 —— 便宜（几十 tok）。
		//   硬档 = T - 45s：它要还没交卡，就 `abort` 打断 + 追问一次交卡（见 wrapUpText）。
		//          实测：软档对“卡在长命令里”的情况无效（steer 送不进去），硬档才是真保险。
		if (rpc && opt.timeoutMs >= MIN_WINDDOWN_MS) {
			const softLead = Math.max(SOFT_WINDDOWN_MIN_LEAD_MS, Math.floor(opt.timeoutMs * 0.25));
			wrapUpHook = () => {
				if (wrapUpSent || settled) return;
				const text = wrapUpText();
				if (!prompts.wrapUp(text)) return; // 闸门：任务 prompt 之外，只有硬收尾能补发这一条
				wrapUpSent = true;
				windDownLog.push("追问交卡");
				rpc?.send({ type: "prompt", message: text });
			};
			softTimer = setTimeout(() => {
				if (settled) return;
				windDownLog.push("收尾提醒");
				rpc?.send({ type: "steer", message: windDownText(Math.round(softLead / 1000)) });
			}, opt.timeoutMs - softLead);
			hardTimer = setTimeout(() => {
				if (settled) return;
				windDownLog.push("打断卡住的 run");
				hardWindDownFired = true;
				expectWrapUp = true;
				prompts.allowWrapUp();
				rpc?.send({ type: "abort" });
				// 兜底：万一 abort 根本没产生 agent_settled（比如它当时本来就闲着、没有可打断的 run），
				// 2 秒后直接追问。正常情况在上面的 settled 里按 aborted 就接住了，这个定时器不会开火。
				wrapUpTimer = setTimeout(() => {
					if (settled || wrapUpSent) return;
					expectWrapUp = false;
					wrapUpHook?.();
				}, 2_000);
			}, opt.timeoutMs - HARD_WINDDOWN_LEAD_MS);
		}

		// RPC 路径由 RpcChannel 内部订阅（这里 jsonRead 是 undefined，等于不挂）
		child.stdout?.on("data", (d: Buffer) => jsonRead?.(d.toString("utf8")));
		child.stderr?.on("data", (d: Buffer) => {
			sink.stderr = clampTail(sink.stderr + d.toString("utf8"), STDERR_LIMIT);
		});
		child.on("error", (e) => {
			sink.stderr = clampTail(`${sink.stderr}\n[spawn 失败] ${e.message}`, STDERR_LIMIT);
			finish("failed", null);
		});
		// 子进程一退出就还槽位（不等回执解析 / 落盘 / 面板收尾那一段）
		// close 与 exit 谁先到就谁还；releaseSlot 是单次的，重复调无害
		child.on("exit", releaseSlot);
		child.on("close", (code) => {
			releaseSlot();
			if (settled) return;
			if (opt.signal?.aborted) {
				finish("failed", code);
			} else if (timedOut) {
				finish("timeout", code);
			} else if (hardWindDownFired) {
				// 到点前被我们主动掐停（abort + 追问）：虽然是退出码 0、也有结论，
				// 但**任务本身没跑完** —— 报成 timeout，让主会话拿着阶段成果自己决定要不要重启。
				finish("timeout", code);
			} else if (code !== 0) {
				// ⚠️ pi 1.2.0 改了 `-p` 的退出码：最终回复被输出上限截断时，它照样把已产出的
				//    文本写进 stdout（结论是有的，只是可能不全），但退出码变成 1。
				//    所以「有结论 + 非零退出」不能再当失败 —— 否则会把已经拿到的成果丢掉。
				if (sink.final.trim()) {
					finish("done", code);
				} else {
					finish("failed", code);
				}
			} else if (sink.final.trim()) {
				finish("done", code);
			} else {
				finish("empty", code);
			}
		});

		// 任务正文走 stdin —— 避开命令行转义问题
		try {
			if (rpc) {
				// ⚠️ 发完**不能** closeStdin()：关了 stdin 就再也发不出 steering，
				//    而且等于立刻让 pi 收工。收工时机由 agent_settled / 超时定时器决定。
				// 任务正文只发这一条（走闸门：同一次运行绝不许有第二条任务 prompt）。
				const text = cardPrompt(task);
				if (prompts.task(text)) rpc.send({ id: "prompt-1", type: "prompt", message: text });
			} else {
				child.stdin?.write(cardPrompt(task), "utf8");
				child.stdin?.end();
			}
		} catch (e) {
			sink.stderr = clampTail(`${sink.stderr}\n[写入任务失败] ${e instanceof Error ? e.message : e}`, STDERR_LIMIT);
			killTree(child);
			armEscape("failed");
		}
	});
}

// ======================= 渲染卡片 =======================
function oneLine(s: string, max: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 取第一个**非空**行（压成一行），截到 120 字。回投只用它当摘要，正文不进口袋。 */
function firstLine(s: string | undefined): string {
	const line = String(s ?? "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find(Boolean) ?? "";
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/** trim 之后再判空。`x || "占位"` 的洞：`"\n\n  "` 是真值 → 会把一堆空白当正文投出去 */
function trimOrPlaceholder(s: string | undefined, placeholder: string): string {
	const t = String(s ?? "").trim();
	return t || placeholder;
}

/**
 * 回投文本硬上限（字符数）：超了保留头部 + 尾部（路径/会话ID 这类找回信息），
 * 中间塞一行「已截断」。上下文是稀缺资源 —— 正文一律进归档文件，不进对话。
 */
function clampDelivery(text: string, max: number): string {
	const s = String(text ?? "").trim();
	if (s.length <= max) return s;
	const marker = "…（已截断，完整内容见归档）";
	const room = max - marker.length - 2; // 两个换行
	if (room <= 0) return marker.slice(0, Math.max(0, max));
	// 尾部最多留两行非空（`结果：<path>` / `会话ID：…`）
	const lines = s.split("\n");
	const tailLines: string[] = [];
	for (let i = lines.length - 1; i >= 0 && tailLines.length < 2; i--) {
		const l = lines[i].trim();
		if (l) tailLines.unshift(l);
	}
	let tail = tailLines.join("\n");
	if (tail.length > Math.floor(room / 2)) tail = tail.slice(0, Math.floor(room / 2)); // 尾行本身超预算 → 砍尾行
	const head = s.slice(0, room - tail.length);
	return `${head}\n${marker}\n${tail}`;
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
		case "done": {
			head = HEADS.done(name, secs);
			body = r.text || "(空)";
			// Super Agent：把回执变成卡片头部的一眼可见结论
			const sa = readSuperAgent();
			if (sa.enabled && sa.report !== "off") {
				if (r.report) {
					head = `【${name}】${reportHeadline(r.report, sa.report === "strict" ? "strict" : "loose")}（${secs}s）`;
					const ev: string[] = [];
					if (r.report.changed.length)
						ev.push(`改了：${r.report.changed.slice(0, 5).join(", ")}${r.report.changed.length > 5 ? ` …(+${r.report.changed.length - 5})` : ""}`);
					if (r.report.ran.length) ev.push(`跑过：${r.report.ran.slice(0, 3).join(" ｜ ")}`);
					if (r.report.blocked.length) ev.push(`被挡：${r.report.blocked.slice(0, 3).join(", ")}`);
					if (r.report.notes) ev.push(`说明：${r.report.notes}`);
					if (ev.length) body = `${ev.join("\n")}\n────────────\n${body}`;
				} else if (sa.report === "strict") {
					head = `【${name}】⚠️ 无回执（${secs}s）`;
					body = `（它没按格式交 <result> 回执 —— 下面内容仅供参考，别当"已完成"用）\n────────────\n${body}`;
				}
			}
			if (r.truncated) {
				body +=
					"\n\n⚠️ 它的最终回复撞到了模型的输出上限，被**截断**了（pi 1.2.0 起 `-p` 会因此以退出码 1 结束，" +
					"结论已按上面的原文保留）。要完整结果：再调一次 delegate，带 resume: \"" + r.names.id +
					"\" 让它接着写，或者让它分成几段输出。";
			}
			break;
		}
		case "timeout": {
			head = HEADS.timeout(name, secs);
			// 到点前已经叫停过（abort + 追问）的那次，结论在 r.text 里；只有硬杀才是空的 r.partial。
			// 两者都可能为空 —— 那就是预算全耗在工具上了，会说清楚，而不是留一句
			// “I'll analyze the directory structure...” 让人干瞪眼。
			const gave = r.text.trim() || r.partial.trim();
			const slow = r.toolRuns
				.filter((t) => t.ms >= 5_000)
				.sort((a, b) => b.ms - a.ms)
				.slice(0, 3)
				.map((t) => `${t.name} ${(t.ms / 1000).toFixed(1)}s`);
			const parts: string[] = [
				"状态: 超时（到点前已叫停，下面是它交回的阶段成果）",
				"",
				gave || "(它连文字都没来得及吐 —— 预算大概全耗在工具上了)",
			];
			if (tools) parts.push(`它调用过：${tools}`);
			if (slow.length) parts.push(`最慢的几步：${slow.join(" · ")}`);
			if (r.windDownLog.length) parts.push(`收尾动作：${r.windDownLog.join(" → ")}`);
			parts.push(
				"",
				`要接着做就再调一次 delegate，带上 resume: "${r.names.id}" 和补充的时间 —— 它的历史都在，会接着做而不是重做。`,
			);
			body = parts.join("\n");
			break;
		}
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
		`权限    ${permSummary(r.tpl.perms)}`,
		`任务    ${oneLine(r.task, 40)}`,
		`耗时    ${secs}s`,
		`找回    /resume-agent 里挑${file ? `，或 pi --session "${file}"` : ""}`,
	].join("\n");
}

// ======================= 批次汇总卡（同一次 delegate(tasks) 只投一张）=======================
//
// 踩过的体验：一次派 8 个，全部 10s 内跑完，但卡片**一张一张吐了 8 轮对话**（异步回投每个 turn 只投一条）。
// 现在：同一次调用的所有子任务共用一个 `batchId`，全部 settle 之后**只写一条 `.bg`、只投一次**，
// 内容是一张汇总卡（每条一行）。单任务（非 tasks 数组）的投递行为一字不改。

/** 汇总卡里一条结论最多多长（超过就截断，保证一条任务一行） */
export const BATCH_CONCLUSION_MAX = 90;

/** 汇总卡里的一条（纯数据，方便单测） */
export interface BatchItem {
	/** 助理名（不带 #n） */
	name: string;
	outcome: Outcome;
	/** 耗时（ms） */
	elapsedMs: number;
	/** 该任务的回执正文（取「结论:」那一行） */
	text?: string;
	/** 失败原因（failed / busy） */
	error?: string;
	/** 降级备注（有它 = 这条算「降级」，标 ⚠️） */
	note?: string;
	/** 会话 ID（卡尾保留找回方式） */
	sessionId?: string;
	/** 正文归档路径（`results.ts` 写的那份；没归档就不给，卡里写「未归档」） */
	resultPath?: string;
}

/** 从一段回执正文里取「结论:」那一行（没有就取第一行），压成一行并截断到 90 字 */
function batchConclusion(text: string | undefined): string {
	const lines = String(text ?? "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const hit = [...lines].reverse().find((l) => /^结论\s*[:：]/.test(l));
	const src = (hit ?? lines[0] ?? "").replace(/^结论\s*[:：]\s*/, "");
	const one = src.replace(/\s+/g, " ").trim() || "（没有结论）";
	return one.length > BATCH_CONCLUSION_MAX ? `${one.slice(0, BATCH_CONCLUSION_MAX)}…` : one;
}

/** 批次汇总卡的硬上限（比单任务宽松，但也不能无限） */
export const BATCH_CARD_MAX = 1600;

/**
 * 批次汇总卡（纯函数，不读盘 / 不看时钟 / 不改入参）：
 *
 *   【批次 8 个】6 成功 · 1 降级 · 1 失败（合计 23s）
 *   ✅ general#1  一句话结论（12s）
 *   ⚠️ general#7  pane 槽位等待 60s 超时已降级 rpc
 *   ❌ general#8  失败原因（3s）
 *   ──── 正文归档 ────
 *   #1 通用助理  a6tffv-xxx  结果：<path>
 *   看完整正文：/batch <id>
 *
 * 「合计」= 这批的墙钟耗时（取最慢那条）；空列表也能渲染（不崩）。
 * 卡里只给摘要 + 路径：正文不在上下文里。
 */
export function buildBatchCard(items: BatchItem[], batchId?: string): string {
	const list = Array.isArray(items) ? items : [];
	const doneOk = list.filter((i) => i.outcome === "done" && !i.note).length;
	const degraded = list.filter((i) => Boolean(i.note)).length;
	const failed = list.filter((i) => !i.note && (i.outcome === "failed" || i.outcome === "busy" || i.outcome === "empty")).length;
	const timedOut = list.filter((i) => !i.note && i.outcome === "timeout").length;
	const totalMs = list.reduce((m, i) => Math.max(m, Number(i.elapsedMs) || 0), 0);
	const segs: string[] = [];
	if (doneOk) segs.push(`${doneOk} 成功`);
	if (degraded) segs.push(`${degraded} 降级`);
	if (failed) segs.push(`${failed} 失败`);
	if (timedOut) segs.push(`${timedOut} 超时`);
	const head = `【批次 ${list.length} 个】${segs.length ? segs.join(" · ") : "没有任务"}（合计 ${Math.round(totalMs / 1000)}s）`;

	const rows = list.map((it, i) => {
		const who = `${it.name || "worker"}#${i + 1}`;
		const secs = Math.round((Number(it.elapsedMs) || 0) / 1000);
		if (it.note) return `⚠️ ${who}  ${oneLine(it.note, BATCH_CONCLUSION_MAX)}`;
		if (it.outcome === "done") return `✅ ${who}  ${batchConclusion(it.text)}（${secs}s）`;
		if (it.outcome === "timeout") return `⏱ ${who}  超时（${secs}s）`;
		if (it.outcome === "empty") return `❌ ${who}  跑完没输出（${secs}s）`;
		const why = it.error ? oneLine(it.error, BATCH_CONCLUSION_MAX) : it.outcome === "busy" ? "会话正忙，没启动" : "失败";
		return `❌ ${who}  ${why}（${secs}s）`;
	});

	const ids = list.map((i) => (i.sessionId ? `${i.name || "worker"}=${i.sessionId}` : "")).filter(Boolean);
	const tail = ids.length
		? `\n\n──── 找回方式 ────\n${ids.join(" · ")}\n（要它接着做：delegate 带 resume: "<会话ID>"；要看过程：/resume-agent）`
		: "";
	// 正文归档段：每件一行「谁 · 会话ID · 路径」。正文不进上下文，要看就开文件 / `/batch <id>`
	const arch = [
		"──── 正文归档 ────",
		...list.map((it, i) => {
			const who = it.name || "worker";
			const sid = it.sessionId || "（无会话ID）";
			return `#${i + 1} ${who}  ${sid}  ${it.resultPath ? resultPathLine(it.resultPath) : "结果：（未归档）"}`;
		}),
		`看完整正文：/batch${batchId ? ` ${batchId}` : ""}`,
	].join("\n");
	return clampDelivery([head, ...rows].join("\n") + tail + `\n\n${arch}`, BATCH_CARD_MAX);
}

/** 一批的记账状态（只活在内存：整批 settle 后才落一条 `.bg`） */
interface BatchState {
	/** 写进 `BgTaskFile.id`（也是唯一那条 `.bg` 的文件名） */
	id: string;
	expected: number;
	startedAt: number;
	key: string;
	task: string;
	ownerSessionFile?: string;
	ownerSessionId?: string;
	deadlineAt: number;
	/** 按任务序号存：pane 收尾 / 兜底 / catch 都可能来记同一条，序号去重 */
	items: Map<number, BatchItem>;
	/** 已经写过几条「实时短卡」（防刷屏上限，见 `BATCH_LIVE_MAX`） */
	liveWritten: number;
}

/** 进程内的批（key = batchId）；还没 settle 完的都在这里 */
const pendingBatches = new Map<string, BatchState>();

/** 开一批：同一次 delegate(tasks) 的所有子任务共用这一个 batchId */
function openBatch(
	expected: number,
	meta: { key: string; task: string; ownerSessionFile?: string; ownerSessionId?: string; deadlineAt: number },
): BatchState {
	const id = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const b: BatchState = {
		id,
		expected: Math.max(1, Math.round(Number(expected) || 0)),
		startedAt: Date.now(),
		key: meta.key,
		task: meta.task,
		ownerSessionFile: meta.ownerSessionFile,
		ownerSessionId: meta.ownerSessionId,
		deadlineAt: meta.deadlineAt,
		items: new Map(),
		liveWritten: 0,
	};
	pendingBatches.set(id, b);
	return b;
}

/** `RunResult` → 汇总卡的一条 */
function batchItemOf(r: RunResult): BatchItem {
	return {
		name: r.tpl.name,
		outcome: r.outcome,
		elapsedMs: r.elapsedMs,
		text: r.text || r.partial,
		error: r.stderrTail || (typeof r.exitCode === "number" ? `退出码 ${r.exitCode}` : ""),
		note: r.degradeNote,
		sessionId: r.names.id,
	};
}

/**
 * 批量「实时短卡」的条数上限。
 *
 * 为什么是 4：同一批的**并发上限就是 4**（再多也只能排队），等一批真跑完时
 * 前 4 条已经能把「大概完工到哪了」说清楚；再接下去投（排队补跑 / 自动重派）
 * 就只是刷屏 —— 用户要的是体感实时，不是 8 条消息。
 */
export const BATCH_LIVE_MAX = 4;

/** 单条实时短卡的硬上限（字符数；一条消息一屏看得完） */
export const BATCH_LIVE_MAX_CHARS = 60;

/** 短卡里那半句「干了什么」：成功取回执的「结论:」行，失败取原因 */
function batchLiveHeadline(item: BatchItem): string {
	if (item.note) return oneLine(item.note, BATCH_LIVE_MAX_CHARS);
	if (item.outcome === "done") return batchConclusion(item.text);
	if (item.outcome === "timeout") return "超时";
	if (item.outcome === "empty") return "跑完没输出";
	if (item.outcome === "busy") return "会话正忙，没启动";
	return oneLine(item.error || "失败", BATCH_LIVE_MAX_CHARS);
}

/**
 * 一条实时短卡的正文（纯函数：不读盘 / 不看时钟）：
 *
 *   ✅ #3 通用助理 7s · 改完了 README 版式
 *
 * 总长硬压在 `BATCH_LIVE_MAX_CHARS` 内 —— 超长**只截后半句**（前缀的
 * 「序号 / 助理名 / 耗时」永不丢，那才是用户扫一眼要的信息）。
 * 失败用 ❌（降级也当没成功算，理由写在后半句）。
 *
 * 序号**统一 1 基**（和汇总卡的 `worker#1` / `worker#2` 对齐）：`seq` 内部仍是 0 基，显示时 +1。
 */
export function batchLiveLiveText(seq: number, item: BatchItem): string {
	const ok = item.outcome === "done" && !item.note;
	const secs = Math.round((Number(item.elapsedMs) || 0) / 1000);
	const head = `${ok ? "✅" : "❌"} #${seq + 1} ${item.name || "worker"} ${secs}s`;
	const budget = BATCH_LIVE_MAX_CHARS - head.length - 3; // 3 = " · "
	if (budget < 1) return head.slice(0, BATCH_LIVE_MAX_CHARS);
	// 注意：这里不能用 delegate 的 oneLine（它按**字符数**截、且会多吐 1 个 `…`），
	// 总长要硬压到 MAX，所以自己算：超长 → `budget-1` 字 + `…`。
	const flat = batchLiveHeadline(item).replace(/\s+/g, " ").trim();
	if (!flat) return head.slice(0, BATCH_LIVE_MAX_CHARS);
	const tail = flat.length > budget ? (budget <= 1 ? "" : `${flat.slice(0, budget - 1)}…`) : flat;
	const out = tail ? `${head} · ${tail}` : head;
	return out.length > BATCH_LIVE_MAX_CHARS ? out.slice(0, BATCH_LIVE_MAX_CHARS) : out;
}

/**
 * 落一条**批量实时短卡**（`.bg/<batch.id>:item:<seq>`，由 pollBgTasks 投一次）。
 *
 * 和汇总卡的关系：汇总卡的 id 就是 `batch.id`（不带 `:item:`），两者是**不同文件**，
 * 互不覆盖；短卡数量有 `BATCH_LIVE_MAX` 上限，刷屏风险有底。
 * `batch: true` → 投递时直出 resultText（不再套「子Agent 回来了」的壳）。
 */
function writeBatchLiveItem(batch: BatchState, seq: number, item: BatchItem): void {
	if (batch.liveWritten >= BATCH_LIVE_MAX) return; // 只写前 4 条（并发上限 4）
	batch.liveWritten += 1;
	const elapsedMs = Number(item.elapsedMs) || 0;
	writeBgTask({
		id: `${batch.id}:item:${seq}`,
		key: batch.key,
		name: `${item.name || "worker"}#${seq}`,
		task: batch.task,
		sessionId: item.sessionId ?? "",
		startedAt: Math.max(batch.startedAt, Date.now() - elapsedMs),
		status: item.outcome === "done" && !item.note ? "done" : "failed",
		resultText: batchLiveLiveText(seq, item),
		finishedAt: Date.now(),
		delivered: false,
		batch: true,
		ownerSessionFile: batch.ownerSessionFile,
		ownerSessionId: batch.ownerSessionId,
		deadlineAt: batch.deadlineAt,
	});
}

/**
 * 记一条；整批 settle 后把汇总卡写成**唯一**一条 `.bg`（由 pollBgTasks 只投一次）。
 * 同一序号重复来（pane 收尾 + 兜底计时器）→ 只认第一次。
 */
function noteBatchItem(batch: BatchState, seq: number, item: BatchItem): void {
	if (batch.items.has(seq)) return;
	batch.items.set(seq, item);
	// 🟢 实时进度：每完成一件立刻回投一条极短卡（默认关，见 superagent.batchLive）
	if (batchLiveEnabled()) writeBatchLiveItem(batch, seq, item);
	if (batch.items.size < batch.expected) return;
	pendingBatches.delete(batch.id);

	const items = [...batch.items.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, v]) => v)
		// 逐件补归档路径（正文归档段要每件一行；没归到的写「未归档」）
		.map((v) => ({
			...v,
			resultPath: v.resultPath ?? (v.sessionId ? archivePathOf.get(v.sessionId) : undefined),
		}));
	const anyFail = items.some((i) => i.outcome === "failed" || i.outcome === "busy" || i.outcome === "empty");
	const allTimeout = items.length > 0 && items.every((i) => i.outcome === "timeout");
	const card = buildBatchCard(items, batch.id);
	const status: BgTaskFile["status"] = allTimeout ? "timeout" : anyFail ? "failed" : "done";
	const finishedAt = Date.now();
	// 批次汇总卡原文也归档一份（`kind:"batch"`）。
	// 注意：这里**只归档汇总卡** —— 每个任务的完整正文已经在单任务收尾
	// （archiveTaskRun）里各自归过档了，再逐件归档等于同一份正文存两遍。
	let resultPath: string | undefined;
	try {
		resultPath = archiveResult({
			id: batch.id,
			kind: "batch",
			name: `批次 ${items.length} 个`,
			status,
			startedAt: batch.startedAt,
			finishedAt,
			summary: archiveSummary(undefined, card),
			body: card,
			meta: {
				expected: batch.expected,
				sessionIds: items.map((i) => i.sessionId ?? "").filter(Boolean),
				outcomes: items.map((i) => i.outcome),
			},
		});
	} catch {
		/* 归档失败不影响回投 */
	}
	writeBgTask({
		id: batch.id,
		key: batch.key,
		name: `批次 ${items.length} 个`,
		task: batch.task,
		sessionId: items.map((i) => i.sessionId ?? "").filter(Boolean).join(", "),
		startedAt: batch.startedAt,
		status,
		resultText: card,
		finishedAt,
		delivered: false,
		batch: true,
		ownerSessionFile: batch.ownerSessionFile,
		ownerSessionId: batch.ownerSessionId,
		deadlineAt: batch.deadlineAt,
		...(resultPath ? { resultPath } : {}),
	});
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
		assistant: Type.Optional(
			Type.String({
				description: `助理模板名。${hint || "当前**没有**可派发的助理（都是 base / 示例模板），先用 /assistants 看看。"} tasks 的每一项也可以自带 assistant 覆盖这里。`,
			}),
		),
		task: Type.Optional(Type.String({ description: "一件事。写清目标 + 验收标准，别写「分析一下」这种模糊指令。" })),
		tasks: Type.Optional(
			Type.Array(
				Type.Union([
					Type.String(),
					Type.Object({ assistant: Type.Optional(Type.String()), task: Type.String() }),
				]),
				{
					description:
						"多件互不依赖的事，并行跑，总耗时≈最慢那件。有依赖就分开派。给了就不用给 task。元素可以是字符串（用外层 assistant），也可以是 { assistant, task } —— 跨领域并行（如改代码 + 查库）时每件自带助理。长时间任务请用 wait:false 异步派，避免主会话被阻塞。",
				},
			),
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

/**
 * 本进程已投递过的任务 id。
 *
 * 为什么磁盘上已经有 `delivered:true` 还要内存去重：重试循环 / 投递途中 `/reload`
 * 的竞态下，磁盘标记可能还没落盘就又开始新一轮扫描 —— 同一个 id 只认内存这一次。
 */
const deliveredThisRun = new Set<string>();

/**
 * 用户**手动** `/agents bg redeliver` 点名要投的 id。
 *
 * 自动投递有「只投最近 10 分钟」闸门（防 `/reload` 反复投老卡），
 * 但手动重投就是用户自己拍板要补：「太老」对它们无效，否则点了没反应。
 * 投一次就划掉（手动意图只免一次，失败后仍回到自动闸门口径）。
 */
const forcedDeliver = new Set<string>();

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
	// id 里可能带 `:`（批量实时短卡 = `<batchId>:item:<seq>`），而 Windows 文件名不允许 `:`
	// → 写盘会 EINVAL 被丢掉。这里统一换成 `_`（只在文件名上换，JSON 里的 id 保持原样）。
	// 注意：文件路径**只能**从这里拼，读写两边用同一个函数才保证对得上。
	return join(bgRoot(), `${id.replace(/[:*?"<>|]/g, "_")}.json`);
}
/**
 * 写一条后台任务记账。
 *
 * ⚠️ 必须「读旧值 → 合并 → 写」，**不能整对象覆盖**：
 *    同一条任务会被任务结束 / 投递成功 / 看门狗 / 退出钩子先后写，
 *    后写的一方手里往往是**旧快照**，覆盖就会把 `delivered:true` 冲回 false
 *    → `/reload` 再投一遍（用户收到重复卡片）。合并规则见 `mergeBgTask()`。
 */
function writeBgTask(t: BgTaskNext): BgTaskFile | undefined {
	try {
		const merged = mergeBgTask(readBgTask(t.id), t);
		writeFileSync(bgFile(t.id), JSON.stringify(merged, null, 2), "utf8");
		return merged;
	} catch {
		return undefined;
	}
}
function readBgTask(id: string): BgTaskFile | undefined {
	try {
		return JSON.parse(readFileSync(bgFile(id), "utf8")) as BgTaskFile;
	} catch {
		return undefined;
	}
}
function listBgTasks(dir: string = bgRoot()): BgTaskFile[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return JSON.parse(readFileSync(join(dir, f), "utf8")) as BgTaskFile;
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
export function isProjectFile(file: string, cwd: string): boolean {
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

/** 模型下拉里代表「跟主会话用同一个」的那一项 */
export const MODEL_INHERIT = "（继承主会话）";

/** 从当前会话能用的模型里拼出下拉选项：provider/id（和 --model 的写法一致） */
export function modelChoices(ctx: ExtensionContext): string[] {
	const out: string[] = [];
	const push = (m: { provider?: string; id?: string } | undefined) => {
		if (!m?.id) return;
		const id = m.provider ? `${m.provider}/${m.id}` : m.id;
		if (!out.includes(id)) out.push(id);
	};
	push(ctx.model as { provider?: string; id?: string } | undefined);
	try {
		const scoped = (ctx.scopedModels ?? []).map((x) => x.model as { provider?: string; id?: string });
		if (scoped.length) scoped.forEach(push);
		else ((ctx.modelRegistry?.getAvailable?.() ?? []) as { provider?: string; id?: string }[]).forEach(push);
	} catch {
		/* 拿不到就退化成一个空列表 → 模型行回到手输 */
	}
	return out;
}

/** 模型行：能枚举出可用模型就给下拉，否则（拿不到）退回手输，别把功能弄坏 */
function modelField(value: string, options: string[]): FormField {
	if (!options.length) {
		return { key: "model", label: "模型", value, kind: "text", hint: "(留空 = 继承主会话；也可以填 provider/model)" };
	}
	// 手写的怪值（比如只写了 modelId）也留在选项里，不然一编辑就被悄悄改掉
	const opts = [MODEL_INHERIT, ...(value && !options.includes(value) ? [value] : []), ...options];
	return {
		key: "model",
		label: "模型",
		value: value || MODEL_INHERIT,
		kind: "enum",
		options: opts,
		hint: `(回车展开 —— 就是 /model 里能选的那些；选「${MODEL_INHERIT}」= 跟主会话用同一个)`,
	};
}

/** 下拉里的「继承主会话」= 不写 model 字段（继承主会话当前模型） */
function normModel(raw: string | undefined): string {
	const v = (raw ?? "").trim();
	return v === MODEL_INHERIT ? "" : v;
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
	/** 能力权限（面板里 6 行） */
	perms: WorkerPermissions;
	/** 提示词正文原文（面板里长文本编辑，值列显示摘要） */
	body: string;
	keyEditable: boolean;
	/** 当前挂的底座 key（"" = 没挂） */
	extendsKey: string;
	/** 能选的底座 */
	bases: { key: string; name: string }[];
	/** 可选模型（provider/id）。非空 → 「模型」变成下拉，留空仍是继承主会话 */
	modelOptions?: string[];
}): FormField[] {
	const P = o.perms ?? PERM_DEFAULTS;
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
			kind: "long",
			hint: "(写「什么时候用我」，主 pi 靠它决定派谁 · 回车在面板内编辑)",
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
		modelField(o.model, o.modelOptions ?? []),
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
			key: "fs",
			label: "文件权限",
			value: toLabel(FS_KEYS, FS_OPTIONS, P.fs),
			kind: "enum",
			options: FS_OPTIONS,
			hint: "(默认只读；要改代码就选「可写」)",
		},
		{
			key: "paths",
			label: "可写目录",
			value: P.paths.join(", "),
			kind: "text",
			hint: "(逗号分隔；`${cwd}` = 工作目录。留空 = 不限，谨慎)",
		},
		{
			key: "exec",
			label: "命令档",
			value: toLabel(EXEC_KEYS, EXEC_OPTIONS, P.exec),
			kind: "enum",
			options: EXEC_OPTIONS,
			hint: "(默认禁止；「白名单」= 只允许下面那行里的命令)",
		},
		{
			key: "cmds",
			label: "命令白名单",
			value: P.cmds.join(", "),
			kind: "text",
			hint: "(逗号分隔，末尾 * 表示前缀匹配：`npm test*`)",
		},
		{
			key: "net",
			label: "网络",
			value: toLabel(NET_KEYS, NET_OPTIONS, P.net),
			kind: "enum",
			options: NET_OPTIONS,
			hint: "(装依赖 / 调外部接口才需要打开)",
		},
		{
			key: "budget",
			label: "预算",
			value: P.budget ?? "",
			kind: "text",
			hint: "(如 `120k/10m`；留空 = 不限制，只做声明)",
		},
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
			value: o.body,
			kind: "long",
			hint: "(回车在面板内看全文并编辑 · ctrl+s 保存)",
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

	// 正文是面板里的长文本行（kind="long"）：改没改都照原样写回
	// （不改时值就是原文，写回去等长 —— 顺便把首尾空白规整掉）
	const body = typeof v.body === "string" ? v.body : undefined;

	const updates: Record<string, string | undefined> = {
		name: (v.name ?? "").trim() || key,
		desc: (v.desc ?? "").trim(),
		cwd: cwdIn,
		model: normModel(v.model),
		timeout,
		agents_md: (v.agents_md ?? "是") === "是" ? undefined : "false",
		mcp: (v.mcp ?? "").trim(),
		demo: (v.dispatchable ?? "是") === "是" ? undefined : "true",
		extends: (v.extends ?? "").trim() && (v.extends ?? "").trim() !== BASE_NONE ? (v.extends ?? "").trim() : undefined,
		// 权限六项：面板里显示的是中文标签，落盘要转回真实值
		fs: fromLabel(FS_KEYS, FS_OPTIONS, v.fs ?? "") || undefined,
		paths: (v.paths ?? "").trim() || undefined,
		exec: fromLabel(EXEC_KEYS, EXEC_OPTIONS, v.exec ?? "") || undefined,
		cmds: (v.cmds ?? "").trim() || undefined,
		net: fromLabel(NET_KEYS, NET_OPTIONS, v.net ?? "") || undefined,
		budget: (v.budget ?? "").trim() || undefined,
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
				`没保存。\n补连接：把定义放进候选池 ${localCatalogPath()}\n或者 /ai 从配置中心拉（会写到项目级）`,
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
		`模型    ${tpl.model ?? "(继承主会话)"}`,
		`超时    ${tpl.timeoutMs ? `${tpl.timeoutMs} ms` : "(默认 5 分钟)"}`,
		`AGENTS  ${tpl.agentsMd === false ? "不带全局 AGENTS.md" : "带"}`,
		`继承    ${tpl.extends ?? "(无)"}`,
		`状态    ${tpl.demo === true ? "示例模板（不能派）" : tpl.base === true ? "基础模板（不能直接派）" : "可派发"}${tpl.enabled === false ? " · 已禁用" : ""}`,
	];
	const body = tpl.body ? `\n────── 提示词正文 ──────\n${tpl.body}` : "";
	ctx.ui.notify(`${lines.join("\n")}${body}`, "info");
}

/**
 * 助理编辑页每个字段的说明（右栏那一段）。
 * 写的是「这个字段影响什么」——面板里只看到一行值，光看值猜不出来。
 */
const ASSISTANT_FIELD_DOC: Record<string, string> = {
	key: "文件名 = 派活时用的 key（`delegate(assistant=db)` 里的 db）。\n改名字等于新建一个助理，原来的还留着。",
	name: "显示名：面板和会话标题里显示的名字。中文也行，留空就用文件名。",
	desc:
		"**什么时候该派它** —— 这句话会写进主会话的 delegate 工具描述，模型靠它决定派谁。\n写清「什么活找它、什么活别找它」，含糊了模型就会乱派。\n\n回车在同一面板里切到编辑视图：能看全文、能分多段写；ctrl+s 保存、esc 取消。",
	extends: "底座：继承它的正文、工作目录等默认值，再叠上你自己写的部分。\n底座只读（改它会连累所有继承它的助理），要定制就派生一个。",
	cwd: "工作目录：文件读写、相对路径、项目 AGENTS.md 都按它算。\n留空则继承底座；都没有就用当前项目目录。",
	model:
		"模型：派它的时候用哪个模型（回车展开，列表就是 `/model` 里能选的那些）。\n\n选「（继承主会话）」= 跟主 pi 用同一个，主会话切模型它也跟着切；\n选具体某个 = 钉死，省钱的活就派给便宜模型。\n\n拿不到模型列表时这一行会退回手输（填 `provider/model`）。",
	timeout: "超时：这个助理最长跑多久（`10m` / `90s` / `1.5h`，留空 = 5 分钟）。\n超时会被中止，结果标成 timeout。",
	agents_md: "带 AGENTS.md：开 = 把全局/项目 AGENTS.md 塞进它的上下文（约 +1500 token/次）。\n关掉能省钱，但它就不知道项目规矩了。",
	mcp: "MCP：这个助理能连哪些服务（回车勾选）。**跟工作目录无关**，是按需给的。\n不勾 = 一个都不连，只能用本地文件工具。",
	fs: "**文件权限**：只读 = 一个文件都改不了（查数据、看服务器这类就用它）；可写 = 能改，但只限下面「可写目录」里。",
	paths:
		"**可写目录**：逗号分隔，相对工作目录（`${cwd}` = 工作目录本身）。留空 = 哪都能写，谨慎。\n" +
		"插件源码、`~/.pi/agent`、`.git` 永久只读，写在这儿会被拒。",
	exec:
		"**命令档**：禁止 = 不给 bash（最安全）；白名单 = 只能跑下面列的命令；不限 = 等于给 shell。\n" +
		"日常改代码选「白名单」，把 `npm test*` `npx tsc*` `git status*` 加进去就够。",
	cmds:
		"**命令白名单**：逗号分隔，末尾 `*` 表示前缀匹配（`npm test*` 能匹配 `npm test -- --run`）。\n" +
		"白名单为空 = 等于不能执行。",
	net: "**网络**：装依赖、调外部接口才需要开。关着时联网工具不会给它，MCP 也不会挂网络类服务。",
	budget:
		"**预算**：`120k/10m` = 12 万 token / 10 分钟。只做声明（写在提示词里让它自己控节奏），暂不强制中断；留空 = 不限制。",
	dispatchable: "可派发：关掉 = 只当样板看，不能真的派活。\n底座自动是「否」；示例模板也建议关。",
	scope: "存哪儿：全局 = `~/.pi/agent/assistants/`（所有项目都能用）；\n项目 = 当前项目的 `.pi/assistants/`（只在这个项目里出现）。",
	body:
		"提示词正文：这个助理的角色设定（几百上千字都写这儿）。\n继承底座时，这里是「在底座基础上追加」的部分。\n\n回车在同一面板里切到编辑视图：能看原文、能翻能改；ctrl+s 保存、esc 放弃（原值不动）。",
};

/**
 * 助理编辑用的字段 + MCP 候选池。
 * 抽出来是为了让 `/aihelp` 的面板能**在同一个框里翻到这一页**（不再弹新面板）。
 */
export function assistantFormParts(
	ctx: ExtensionContext,
	cwd: string,
	tpl: Template,
	modelOptions: string[] = [],
): { fields: FormField[]; mcp: PickItem[]; commit: (r: FormResult) => Promise<void> } {
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
		body: tpl.body,
		keyEditable: false,
		extendsKey: tpl.extends ?? "",
		bases: availableBases(cwd).map((b) => ({ key: b.key, name: b.name })),
		perms: tpl.perms,
		modelOptions,
	});
	return {
		fields,
		mcp: mcpItems(pool, tpl.mcp),
		commit: (r) => commitForm(ctx, { form: r, cwd, original: tpl }),
	};
}

/**
 * 面板里「助理」那一行回车 → 这一页（同一个框内翻页）。
 * 底座只读：页里所有字段 readonly，右栏直接说明为什么不能改。
 */
/**
 * 把全局助理「另存为本项目副本」：写到 `<cwd>/.pi/assistants/<key>.md`，cwd 改成项目根。
 *
 * 为什么需要：助理分全局/项目两级（项目级同名会覆盖全局）。改了全局的 general，
 * **所有项目一起变** —— 而多数时候你只想改当前项目（尤其工作目录不一样）。
 * 有了这个动作就能"就地派生一份"，全局那份原样不动。
 */
function copyToProject(ctx: ExtensionContext, cwd: string, tpl: Template): void {
	const dest = join(cwd, ".pi", "assistants", `${tpl.key}.md`);
	if (existsSync(dest)) {
		ctx.ui.notify(
			`本项目已经有「${tpl.key}」了：${dest}\n\n想改它：在面板里把「保存到」选成「项目级」再改。`,
			"info",
		);
		return;
	}
	try {
		writeTemplate(
			dest,
			{
				name: tpl.name,
				desc: tpl.desc,
				cwd,
				model: tpl.model ?? "",
				timeout: tpl.timeoutMs ? `${Math.round(tpl.timeoutMs / 60000)}m` : "",
				mcp: tpl.mcp.length ? tpl.mcp.join(", ") : "",
				extends: tpl.extends ?? "",
				agents_md: tpl.agentsMd === false ? "false" : "",
				demo: tpl.demo === true ? "true" : "",
				// 权限一起带过来（不然副本会退回"只读 + 不执行"的默认值）
				fs: tpl.perms.fs,
				// 原项目写死的绝对路径 → 改成 ${cwd}，副本才会跟着当前项目走
				paths: tpl.perms.paths.map((p) => (p === tpl.cwd ? "${cwd}" : p)).join(", "),
				exec: tpl.perms.exec,
				cmds: tpl.perms.cmds.join(", "),
				net: tpl.perms.net,
				budget: tpl.perms.budget ?? "",
			},
			tpl.body,
		);
		ctx.ui.notify(
			`✓ 已复制到本项目：${dest}\n\n全局那份没动。重新打开面板就能看到「本项目」的它（项目级会覆盖同名的全局）。`,
			"info",
		);
	} catch (e) {
		ctx.ui.notify(`✗ 复制失败：${e instanceof Error ? e.message : String(e)}`, "error");
	}
}

export function assistantFormPage(ctx: ExtensionContext, cwd: string, key: string): FormPage | undefined {
	const tpl = findTemplate(cwd, key);
	if (!tpl) return undefined;
	const parts = assistantFormParts(ctx, cwd, tpl, modelChoices(ctx));
	const readonly = tpl.base === true;
	const isGlobal = !isProjectFile(tpl.file, cwd);
	const fields: FormField[] = [
		{ key: "nav.back", label: "← 返回助理列表", value: "", kind: "text", readonly: true, drill: true },
		...parts.fields.map((f) => ({ ...f, readonly: readonly || f.readonly })),
		// 全局助理才给这个动作：想只改本项目就派生一份（全局那份不动）
		...(isGlobal && !readonly
			? [{ key: "dup.project", label: "另存为本项目副本", value: "→ 复制一份到 .pi/assistants/", kind: "action" as const }]
			: []),
	];
	return {
		title: tpl.name,
		fields,
		mcp: parts.mcp,
		footer: readonly ? "这是底座（只读）· esc 返回上一层" : "回车 改 · ctrl+s 保存（退回列表）· esc 返回上一层",
		detail: (f) => {
			if (f.key === "nav.back") return "回到助理列表（也可以直接按 esc）。\n\n本页所有改动都要按 ctrl+s 才落盘。";
			if (f.key === "dup.project")
				return (
					"把**当前这个全局助理**复制一份到本项目的 `.pi/assistants/`，并把工作目录改成当前项目。\n\n" +
					"为什么：助理分全局/项目两级，**项目级同名覆盖全局**。直接改全局那份 → 所有项目一起变；"+L+
					"派生一份本项目副本之后，改它只影响这个项目，全局那份原样不动。"+L+L+
					"复制完重新打开面板就能看到（列表里标「项目」）。"
				);

			const doc = ASSISTANT_FIELD_DOC[f.key] ?? `${f.label}：${f.value}`;
			// 长文本（描述 / 正文）：右栏直接给出前几行，不开编辑器也能看个大概
			if (f.kind === "long") {
				const lines = f.value.split("\n");
				const head = lines.slice(0, 8).join("\n").trim();
				const more = lines.length > 6 ? `\n……（还有 ${lines.length - 6} 行，回车看全文）` : "";
				const chars = [...f.value].length;
				return `${doc}\n\n──────────\n当前内容（${chars} 字 · ${lines.length} 行）：\n${head || "（空）"}${more}`;
			}
			return doc;
		},
		enter: (f) => (f.key === "nav.back" ? null : undefined),
		runAction: (f) => {
			if (f.key !== "dup.project") return;
			copyToProject(ctx, cwd, tpl);
		},
		save: (values) => {
			if (readonly) {
				ctx.ui.notify(`「${tpl.key}」是底座（只读）：要定制请用「＋ 新建助理」派生一个。`, "warning");
				return true;
			}
			const merged: FormResult = { values: { ...values }, openBody: false };
			void parts.commit(merged).catch((e: unknown) => {
				ctx.ui.notify(`✗ 保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
			});
			return false; // 存完退回列表
		},
	};
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

	const parts = assistantFormParts(ctx, cwd, tpl, modelChoices(ctx));
	if (!parts) return;
	const r = await showForm(ctx, `${tpl.name} · 配置`, parts.fields, parts.mcp, focusKey);
	if (!r) {
		ctx.ui.notify("已取消，什么都没改。", "info");
		return;
	}
	await commitForm(ctx, { form: r, cwd, original: tpl });
}

/**
 * 「＋ 新建助理」在**同一个面板里**翻一页（和线上 /assistants new 共用 buildFields）。
 * 为什么要有：动作行如果去跑命令，命令里的 showForm 会再开一个面板 —— 就成两个窗口了。
 */
export function assistantNewPage(ctx: ExtensionContext, cwd: string, baseKey?: string): FormPage {
	const bases = availableBases(cwd);
	const wantBase = (baseKey ?? "").trim();
	const extendsKey = wantBase && bases.some((b) => b.key === wantBase) ? wantBase : "";
	const baseTpl = extendsKey ? bases.find((b) => b.key === extendsKey) : undefined;
	const pool = loadMcpPool(cwd);
	const parts = buildFields({
		key: "",
		name: "",
		desc: "",
		cwd,
		model: "",
		timeout: "",
		agentsMd: true,
		dispatchable: true,
		scope: SCOPE_GLOBAL,
		body: "",
		keyEditable: true,
		extendsKey,
		bases: bases.map((b) => ({ key: b.key, name: b.name })),
		perms: baseTpl?.perms ?? PERM_DEFAULTS,
		modelOptions: modelChoices(ctx),
	});
	const fields: FormField[] = [
		{ key: "nav.back", label: "← 返回助理列表", value: "", kind: "text", readonly: true, drill: true },
		...parts,
	];
	return {
		title: extendsKey ? `新建（基于 ${extendsKey}）` : "新建助理",
		fields,
		mcp: mcpItems(pool, baseTpl?.mcp ?? []),
		footer: "回车 改 · ctrl+s 创建并回到列表 · esc 返回上一层",
		detail: (f) => {
			if (f.key === "nav.back") return "回到助理列表（也可以直接按 esc）。";
			return ASSISTANT_FIELD_DOC[f.key] ?? `${f.label}：${f.value}`;
		},
		enter: (f) => (f.key === "nav.back" ? null : undefined),
		save: (values) => {
			const v = values;
			const key = (v.key ?? "").trim();
			if (!key) {
				ctx.ui.notify("文件名（key）不能为空 —— 派活时用它。", "warning");
				return true; // 留在本页，别关
			}
			if (existsSync(join(globalAssistantDir(), `${key}.md`))) {
				ctx.ui.notify(`已经有个全局模板叫「${key}」了。
想改它：/assistants edit ${key}`, "warning");
				return true;
			}
			void commitForm(ctx, { form: { values, openBody: false }, cwd, original: null }).catch((e: unknown) => {
				ctx.ui.notify(`✗ 创建失败：${e instanceof Error ? e.message : String(e)}`, "error");
			});
			return false; // 建完退回列表
		},
	};
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
		body: "",
		keyEditable: true,
		extendsKey,
		bases: bases.map((b) => ({ key: b.key, name: b.name })),
		perms: baseTpl?.perms ?? PERM_DEFAULTS,
		modelOptions: modelChoices(ctx),
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
	// 弹窗版单选（ctx.ui.select 会掉到输入框下面去，跟面板不是一套观感）
	const picked = await pickFromList(ctx, `助理会话（${shown.length}/${rows.length} 条，选中后切过去看，Esc 取消）`, labels);
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
/** 最近一次拿到的上下文：回投前用它判「主会话空闲没」 */
let bgCtx: ExtensionContext | undefined;
let bgTimer: ReturnType<typeof setInterval> | undefined;

/** 挂后台回投轮询（幂等）。
 *  为什么 load 时就先挂一次：`/reload` 之后 session_start 不一定触发，只靠它会出现
 *  「助理回来了但没人去投」；agent_settled 兑底也只在「又跑了一轮」时才来。 */
function armBgTimer(): void {
	// 停用态一律不挂（/ai-ext on 时会重新调本函数）
	if (isExtDisabled()) return;
	if (bgTimer) clearInterval(bgTimer);
	bgTimer = setInterval(() => {
		// 保留 pane 的 TTL（paneKeepMinutes，默认 10 分钟）顺手清一下：不另开定时器，不折腾事件环
		try {
			sweepKeptPaneTtl();
		} catch {
			/* 清不掉下秒再试 */
		}
		// 注意：pollBgTasks 是 async，rejection 只能这样接
		void pollBgTasks().catch(() => {
			/* 单轮出错别把进程干挂 */
		});
	}, 1000);
}

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

/** 认领文件是不是残留锁：pid 死了 / 读不出 / 太旧（投递就几十毫秒，超 60s 肯定是没清掉） */
const STALE_CLAIM_MS = 60 * 1000;
function claimIsStale(f: string): boolean {
	try {
		const pid = Number(readFileSync(f, "utf8").trim());
		const age = Date.now() - statSync(f).mtimeMs;
		return !Number.isFinite(pid) || !pidAlive(pid) || age > STALE_CLAIM_MS;
	} catch {
		return true; // 读不到 / 坏了 → 当残留处理
	}
}

/** 单次回投的字符硬上限：正文一律进归档，不进上下文 */
export const DELIVERY_MAX = 800;
/** 正文短于这个就直给全文（小任务不值得再让人去开文件） */
export const DELIVERY_SHORT_BODY = 300;
/** 投完多久看 isIdle 自证（pi 的 sendUserMessage 是异步起轮的） */
export const DELIVER_PROOF_MS = 300;
/** 退避上限：每次失败后隔多久再试（2^n 秒，封顶 60s） */
const DELIVER_BACKOFF_MAX_MS = 60 * 1000;
/** 超过这个时长还是发不出去 → 标 undelivered（不静默丢，但也不无限刷） */
const DELIVER_GIVEUP_MS = 10 * 60 * 1000;
/** 「发了却没起一轮」这类失败单独给配额（默认 3 次、’14s 就用完，一次竞态就永久丢） */
export const DELIVER_RETRY_MAX = 6;
/** 「发了却没生效」的报错特征（deliverBgTask 自证失败时抛的那句） */
export const DELIVER_NOT_EFFECTIVE = "投递未生效";

function deliverBackoffMs(attempts: number): number {
	return Math.min(DELIVER_BACKOFF_MAX_MS, 1000 * 2 ** Math.min(Math.max(0, Number(attempts) || 0), 6));
}

/** 这条报错算不算「投了但没生效」（只有这种才放宽重试次数） */
export function isDeliveryNotEffective(msg: string | undefined): boolean {
	return String(msg ?? "").includes(DELIVER_NOT_EFFECTIVE);
}

/** 这类失败最多自动试几次 */
function deliverRetryCap(msg: string | undefined): number {
	return isDeliveryNotEffective(msg) ? DELIVER_RETRY_MAX : AUTO_DELIVER_MAX_ATTEMPTS;
}

/**
 * 该不该自动投？（`bg-store` 的 `autoDeliverSkipReason` 只认 3 次上限）
 *
 * 这里在 delegate 侧开一张小覆盖表：只有「投递未生效」这种**发了没起轮**的错才放宽到
 * `DELIVER_RETRY_MAX`（bg-store 的常量不动 —— 别的模块/单测依赖它）。
 */
export function deliverSkipReason(t: BgTaskFile, now: number = Date.now()): "old" | "attempts" | undefined {
	const why = autoDeliverSkipReason(t, now);
	if (why !== "attempts") return why;
	if (isDeliveryNotEffective(t.lastError) && (t.attempts ?? 0) < DELIVER_RETRY_MAX) return undefined;
	return why;
}

/**
 * 投递失败后怎么记账（纯函数，便于单测）：次数 / 退不退 / 写什么错误。
 *
 * 「投递未生效」到第 6 次（`DELIVER_RETRY_MAX`）才放弃，且放弃时把话说清楚。
 */
export function planDeliverFailure(a: {
	attempts: number;
	msg: string;
	now: number;
	firstFailAt: number;
}): { attempts: number; undelivered: boolean; lastError: string; retryCap: number } {
	const attempts = Math.max(0, Math.floor(Number(a.attempts) || 0));
	const msg = String(a.msg ?? "");
	const cap = deliverRetryCap(msg);
	const next = attempts + 1;
	const exhausted = isDeliveryNotEffective(msg) && next >= cap;
	const byTime = Number(a.now) - Number(a.firstFailAt) > DELIVER_GIVEUP_MS;
	return {
		attempts: next,
		undelivered: exhausted || byTime,
		lastError: exhausted ? `投递 ${cap} 次未生效，用 /batch 看归档` : msg,
		retryCap: cap,
	};
}

/**
 * 要投给主会话的文本：**状态 + 摘要 + 路径**，正文不进上下文。
 *
 * - 批次汇总卡：本身已经是摘要（每件一行 + 归档路径）→ 原样投
 * - 小任务（正文 ≤ 300 字）：直接给全文
 * - 大任务：只给首行摘要 + 归档路径（正文写进 `.md`，要看就 `/batch <id>`）
 */
function bgDeliveryText(t: BgTaskFile): string {
	// 批次汇总卡：卡里已经带了每个任务的一行结论 + 找回/归档方式 → 原样投（不套壳）
	if (t.batch) return clampDelivery(trimOrPlaceholder(t.resultText, "（批次没有结果文本）"), DELIVERY_MAX);
	const head = `子Agent「${t.name}」回来了（${t.status}）`;
	const body = String(t.resultText ?? "").trim();
	const path = String(t.resultPath ?? "").trim();
	// 纯空白正文（"\n\n  "）不能靠 `||` 当空判 —— trim 后才是真相
	if (!body) {
		return clampDelivery(
			[head, "（没有正文）", "", path ? resultPathLine(path) : "（归档失败，可 /resume-agent 续跑查看）", `会话ID：${t.sessionId}`].join("\n"),
			DELIVERY_MAX,
		);
	}
	if (body.length <= DELIVERY_SHORT_BODY) {
		const text = [head, body, "", `会话ID：${t.sessionId}`, path ? resultPathLine(path) : ""].join("\n").trim();
		return clampDelivery(text, DELIVERY_MAX);
	}
	return clampDelivery(
		[
			head,
			firstLine(body) || "（没有正文）",
			"",
			`正文 ${body.length} 字已归档，不在上下文里`,
			path ? resultPathLine(path) : "（归档失败，可 /resume-agent 续跑查看）",
			`会话ID：${t.sessionId}（/batch 可看归档）`,
		].join("\n"),
		DELIVERY_MAX,
	);
}

/** 投完等一小会儿再看 self-proof。
 *  ⚠️ 不能用文件里的 `sleep()`：它的计时器 `unref()` 了 —— 进程没别的事时
 *  会直接退出（unsettled top-level await），自证就永远轮不到。 */
function sleepRef(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, Math.max(0, Number(ms) || 0));
	});
}

/**
 * 把一条已完成的后台任务投给主会话。
 *
 * ⚠️ pi 1.5.2 的 `sendUserMessage()` 运行时**根本不返回 Promise**（d.ts 谎报）且异常会被内部吞掉：
 *    `await` 不会 reject —— 之前就是这么「假成功」的：发了没生效，却照旧写 `delivered:true` → 结果永久丢。
 *    所以这里投完必须**自证**：空闲时投递必然起一轮 → 投后 `isIdle()` 应变 false；否则算失败进重试。
 */
async function deliverBgTask(t: BgTaskFile): Promise<void> {
	if (!apiRef) throw new Error("apiRef 未就绪");
	if (isExtDisabled()) throw new Error("扩展已停用，不投递");
	// ⚠️ 只在主会话**空闲**时投：streaming 时 sendUserMessage 只是「入队」
	//    （用户在 interactive 里按 Esc 中止时 pi 会 clearQueue() 把队列交还给编辑器）
	if (bgCtx && !bgCtx.isIdle()) {
		throw new Error("主会话正在跑，等它空闲再投（不排队，避免被 clearQueue 吞掉）");
	}
	const text = bgDeliveryText(t);
	// 同步抛（assertActive / 旧版不认 deliverAs 的 TypeError）算失败；异步吞掉的靠下面自证
	let sent: unknown;
	try {
		sent = apiRef.sendUserMessage(text, { deliverAs: "followUp" });
	} catch (e) {
		if (!(e instanceof TypeError)) throw e;
		// 旧版 pi 的参数校验更严 → 不带 options 再试一次
		sent = apiRef.sendUserMessage(text);
	}
	// pi 1.5.2 运行时**返回 undefined**（d.ts 谎报 Promise，异常也被内部吞掉）→ 没 thenable 就别等；
	// 但桩/旧版本真返回 Promise 时得接住（否则 rejection 会变成 unhandled，
	// 而且我们会把「发失败」当成功记 delivered:true）。
	if (sent && typeof (sent as Promise<unknown>).then === "function") await (sent as Promise<unknown>);
	await sleepRef(DELIVER_PROOF_MS);
	const started = bgCtx ? !bgCtx.isIdle() : true; // 拿不到 ctx 时无法自证，按成功处理
	if (!started) throw new Error(`${DELIVER_NOT_EFFECTIVE}（agent 仍空闲）——可能是流式竞态，稍后重试`);
}

/** 每秒扫一遍后台任务：终态、没回投过、且**属于本会话**的 → 回投 */
async function pollBgTasks(): Promise<void> {
	if (!apiRef) return;
	// 停用态：一条也不投（小票保留，/ai-ext on 后 armBgTimer 会接着投）
	if (isExtDisabled()) return;
	// 主会话在跑就先不认领，等它空闲（agent_settled / 下一秒轮询会再来）
	// ⚠️ bgCtx 是缓存的主会话 ctx：会话一替换（new/switch/fork/reload）它就连 isIdle() 都不让读，
	//    这里每秒轮询会一直失败 → 统一走 guardCtx，命中 stale 就清掉等新的 session_start。
	if (bgCtx) {
		const g = guardCtx(bgCtx, (c) => c.isIdle() === true);
		if (g.stale) bgCtx = undefined;
		else if (g.ok && g.value === false) return;
	}
	const now = Date.now();
	for (const t of listBgTasks()) {
		if (t.status === "running" || t.delivered) continue;
		// 归属校验：只投给派发它的那个主会话；别的会话/实例扫到也不投，避免串台
		if (!isOwnBgTask(t)) continue;
		if (deliveredThisRun.has(t.id)) continue; // 本进程已投过（防重试/reload 竞态重复投递）
		if (t.undelivered) continue; // 自动重试已放弃，等手动
		// ⚠️ 只有「刚结束 + 还没投够次数」的才自动投。
		//    /reload 会重新 load 扩展 → armBgTimer 又挂一轮 1 秒轮询；没有这两条，
		//    任何一条没落成 delivered:true 的老卡都会**每次 reload 再投一遍**（还顺带唤起主会话跑一轮）。
		//    跳过的记录**不删**：面板 / `/agents bg` 仍能看到「未投递」，手动 redeliver 可补。
		if (deliverSkipReason(t, now) && !forcedDeliver.has(t.id)) continue;
		const attempts = t.attempts ?? 0;
		// 退避：别每秒硬撞
		if (t.lastAttemptAt && now - t.lastAttemptAt < deliverBackoffMs(attempts)) continue;
		// 原子认领：同一会话开在多个实例上时，也只有一个能投（wx 创建失败=别人在投）
		const claim = bgFile(t.id) + ".claim";
		try {
			writeFileSync(claim, String(process.pid), { flag: "wx" });
		} catch {
			// 已有认领文件：持有者还活着就让它投；否则是残留锁（投递途中被关窗口/强杀/`/reload`
			// 时机不巧），**必须能接管** —— 不然这条结果会被永远跳过，既不投也不标
			// undelivered（面板上看不出任何问题，只能人工 redeliver）。
			if (!claimIsStale(claim)) continue; // 别人正在投
			writeFileSync(claim, String(process.pid), "utf8"); // 接管残留锁
		}
		try {
			await deliverBgTask(t);
			deliveredThisRun.add(t.id); // 先记账再落盘：落盘失败也不会在同一进程里再投一次
			// 只有真发出去才标 delivered，而且**紧接着就落盘**：
			// 中间不 await 任何东西，别让后面的 markEnd / 看门狗拿着旧快照把 delivered 冲回 false。
			writeBgTask({ ...t, delivered: true, attempts: attempts + 1, lastAttemptAt: now, lastError: undefined });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// 首次失败就钉住 firstFailAt（之后取最早，不再改）—— 缺了它「多久没发出去」永远算不出来
			const firstFailAt = t.firstFailAt ?? now;
			// 「投递未生效」这类错放宽到 DELIVER_RETRY_MAX 次（否则 14s 就用完配额 → 一次流式竞态就永久丢）
			const plan = planDeliverFailure({ attempts, msg, now, firstFailAt });
			writeBgTask({
				...t,
				delivered: false,
				attempts: plan.attempts,
				lastAttemptAt: now,
				firstFailAt,
				lastError: plan.lastError,
				// 超时 / 次数用完 → 不再自动重试，但也不静默丢（面板 + /agents bg 能看到 /batch 归档）
				undelivered: plan.undelivered,
			});
		} finally {
			forcedDeliver.delete(t.id); // 手动重投只免一次闸门
			try {
				rmSync(claim, { force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

/** 未投递出去的条数（面板提示用）。
 *
 * ⚠️ 只算**本对话**的：别的会话遗留的小票不该在你这儿刷警告 ——
 * 而且 /agents bg redeliver 本来就只投自己会话的，口径必须一致，
 * 否则会出现「提示有 1 条没回投，点了却说没有可重投的」。
 */
export function undeliveredBgCount(): number {
	try {
		return listBgTasks().filter((t) => t.status !== "running" && !t.delivered && isOwnBgTask(t)).length;
	} catch {
		return 0;
	}
}

/**
 * 当前还在跑的后台任务条数。
 *
 * 面板靠它说「退出 pi 会中止」—— 看门狗会在主进程退出时 SIGKILL 掉子进程
 * （这是「不留孤儿」的代价），不提醒的话用户很可能不知情地关掉窗口。
 */
export function runningBgCount(): number {
	try {
		return liveJobList().filter((j) => j.status === "running").length;
	} catch {
		return 0;
	}
}

/** 孤儿任务清理：`running` 但已经过了自己的 deadline → 标 failed。
 *
 * deadlineAt 由派发时写（= startedAt + timeoutMs + 2min 余量）。
 * 为什么不能写死 10 分钟：MAX_TIMEOUT_MS 是 30 分钟 —— 一个设了 20 分钟的助理
 * 会在第 10 分钟被误判成“孤儿、子进程已消失”，投一张**假失败卡**，
 * 等它 20 分钟真跑完又投一张真结果卡。老文件没 deadlineAt → 回退 10 分钟兑底。
 */
function reapStaleBgTasks(): void {
	const now = Date.now();
	for (const t of listBgTasks()) {
		if (t.status !== "running") continue;
		const deadline = t.deadlineAt ?? t.startedAt + 10 * 60 * 1000;
		if (now <= deadline) continue;
		writeBgTask({
			...t,
			status: "failed",
			resultText:
				"（超期未回报，已标为失败）\n" +
				`上一次有记录是在 ${new Date(t.startedAt).toLocaleString()}，过了预期时限（${Math.round((deadline - t.startedAt) / 60000)} 分钟）还是没有结果。\n` +
				`要接着做：重新派一次并带上 resume: "${t.sessionId}" —— 它的历史都在。`,
			finishedAt: now,
			delivered: false,
		});
	}
}

/**
 * 回收过期的记账小票。
 *
 * 两条规则（判定在 `bgPruneReason()` 里，纯函数可单测）：
 *   1. 已投递成功 + 完成超过 24h —— 卡片已经在主对话里了，小票没用；
 *   2. 任何记录超过 7 天 —— 兜底，别让 `.bg/` 堆成几百个文件。
 *
 * ⚠️ `status === "running"` 的**绝不删**（任务还在跑，删了就没法回投）。
 * ⚠️ 没投成功、也没满 7 天的一律不碰 —— 你还能 `/agents bg redeliver`。
 * ⚠️ 只删 `.bg/<id>.json`（投递记账），**绝不碰 `assistant-sessions/<助理>/*.jsonl`（助理会话）**
 *    —— 那是完整历史，/resume-agent 和 resume 续跑都靠它。所以这里只用 `bgFile()` 拼路径。
 *
 * @param now 方便单测注入时钟
 * @param dir 方便单测指向临时目录；默认 `.bg/`
 * @returns 删掉几个
 */
export function reapDeliveredBgTasks(now: number = Date.now(), dir: string = bgRoot()): number {
	let n = 0;
	for (const t of listBgTasks(dir)) {
		if (!bgPruneReason(t, now)) continue;
		const file = join(dir, `${t.id}.json`);
		try {
			rmSync(file, { force: true });
			rmSync(`${file}.claim`, { force: true }); // 顺手清可能残留的「认领」锁
			n++;
		} catch {
			/* 删不掉就算了，下次启动再试 */
		}
	}
	return n;
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
/**
 * 并发上限的**默认/兜底值**（以前是硬编码上限，现在真正的上限读配置）。
 * 真上限 = `readMaxConcurrent()`（`ai-extensions.json` → `superagent.maxConcurrent`，默认 8，夹取 1~16）。
 * 常量保留：算默认值 / 单测断言用，请勿当唯一真相。
 */
const MAX_CONCURRENT_RUNS = 8;
/** kill 发出后等不到 close 的兕底时长：宁可报失败，也绝不泄漏槽位 */
const ESCAPE_RELEASE_MS = 8_000;
let activeRuns = 0;
const runSlotWaiters: Array<() => void> = [];

/** 排队拿一个运行名额。拿到后必须调 releaseRunSlot()。 */
async function acquireRunSlot(): Promise<void> {
	const limit = readMaxConcurrent() || MAX_CONCURRENT_RUNS;
	if (activeRuns < limit) {
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
/** 面板保鲜期配置文件：`~/.pi/agent/ai-extensions.json`（只有这一个键，将来可以考虑加更多） */
function extensionsConfigFile(): string {
	return join(getAgentDir(), "ai-extensions.json");
}

function readExtensionsConfig(): Record<string, unknown> {
	try {
		const raw = JSON.parse(readFileSync(extensionsConfigFile(), "utf8")) as Record<string, unknown>;
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {}; // 没这个文件 / 坏了 —— 用默认值，不要因为一个配置项把插件搞挂
	}
}

/** 启动时把配置灌进 live.ts（读不到就用默认 45s） */
function applyExtensionsConfig(): void {
	const v = Number(readExtensionsConfig().assistantLingerMs);
	if (Number.isFinite(v) && v >= 0) setLingerMs(v);
}

/** 写回保鲜期（保留文件里其它键） */
function writeLingerMs(ms: number): void {
	const cfg = readExtensionsConfig();
	cfg.assistantLingerMs = ms;
	try {
		mkdirSync(dirname(extensionsConfigFile()), { recursive: true });
		writeFileSync(extensionsConfigFile(), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	} catch {
		/* 写不进去就只改内存值，本次会话照常生效 */
	}
	setLingerMs(ms);
}

/** 注册到 /aihelp 配置面板：后台助理的「保鲜期」 */
function registerDelegateSettings(): void {
	registerSettings([
		{
			key: "assistantLingerMs",
			group: "委派",
			label: "助理保鲜期",
			desc: "后台助理（子代理）跑完之后，它那张小票在面板上还留多久。\n\n留一会儿你回来能看见它干了啥；`0` = 跑完立刻撤掉。\n等价 `/agents linger <秒>`。",
			kind: "number",
			min: 0,
			max: 600000,
			unit: "ms",
			def: 45000,
			get: () => getLingerMs(),
			set: (v) => writeLingerMs(Math.max(0, Math.min(600000, Math.round(Number(v) || 0)))),
		},
	]);
}

export function setupDelegate(api: ExtensionAPI): void {
	ensureCatalog(); // 本地 MCP 目录文件不存在就建个空壳
	registerDelegateSettings(); // 注册到 /aihelp 配置面板
	applyExtensionsConfig(); // 面板保鲜期等偏好
	apiRef = api; // 供后台轮询回投用
	armBgTimer(); // 先挂上（幂等）：/reload 后 session_start 不一定触发，见 armBgTimer 说明
	// 启动就清一次过期小票（不依赖 session_start：/reload 时它不一定触发）
	reapDeliveredBgTasks();

	// 后台任务轮询：session_start 挂 timer，session_shutdown 清理（与 panel.ts 同一套模式）
	api.on("session_start", async (_event, ctx) => {
		// 每个会话重新探测一次：别把上个会话的失败结论 / 坏锁带过来（坏锁现在只是 30s 冷却，但结论也得清）
		resetHerdrCache();
		rememberCurrentSession(ctx); // 记下「我是哪个会话」，后台结果靠它认领
		bgCtx = ctx; // 回投前用它判主会话空闲没
		reapStaleBgTasks(); // 先清理上个会话留下的孤儿任务
		reapDeliveredBgTasks(); // 再回收「已投递成功且超 24h」的记账小票（不碰会话文件）
		reapStaleLocks(); // 再回收 pid 已死/超时的会话运行锁
		reapStaleShadowDirs(); // 再回收过期的影子目录（每次派发一个，超 24h 的删）
		// 归档目录保留 `superagent.resultsKeepDays` 天（默认 30，0 = 不清理）
		try {
			pruneArchivedResults();
		} catch {
			/* 清理失败不影响启动 */
		}
		armBgTimer(); // 幂等再挂一次
	});
	api.on("session_shutdown", async () => {
		if (bgTimer) clearInterval(bgTimer);
		bgTimer = undefined;
	});
	// 兑底：agent 一变空闲就查一次。
	// 为什么需要：1 秒定时器是 session_start 挂的，如果 /reload 之后 session_start 没触发，
	// 定时器就不在 —— 光靠它会出现“助理回来了但没人去投”。agent_settled 每个 turn 结束都会来。
	api.on("agent_settled", async (_event, ctx) => {
		bgCtx = ctx;
		// 稍微延后：避开 settle 事件自身的重入窗口（这一刻直接 prompt 可能被拒）
		setTimeout(() => {
			void pollBgTasks().catch(() => {
				/* ignore */
			});
		}, 300);
	});
	// 助理清单在加载时算一次，拼进工具参数描述（零额外开销）
	const params = makeDelegateParams(assistantHint(process.cwd()));

	// ⚠️ 注册成常量：停用时要按 exposure:"hidden" **重新注册**才能从模型工具表里撤下（pi 不支持反注册）
	const DELEGATE_TOOL = {
		name: "delegate",
		label: "Delegate",
		description:
			"把任务派给**临时助理**（另起独立 pi 进程），只把卡片（状态/结论/证据）带回来。\n" +
			"【自己做，别派】1~2 次工具调用就能完事 / 要跟用户来回确认 / 要用当前对话的上下文 / 要改**当前仓库**（改完你还得复核）。这类派出去只会更慢更贵。\n" +
			"【该派】过程长而脏（大量探查、批量扫描、跑测试、翻几十个文件）而你**只要结论** / 几件互不依赖的活并行(tasks) / 要在**另一个项目目录**干活。\n" +
			"【成本】每个助理 = 一个独立进程 + 一次完整模型上下文。派之前先自问：这件事我自己两步能做完吗？能，就自己做。\n" +
			"多件互不依赖用 tasks 并行派；超时/失败过的用 resume 续跑；助理不能互相派活；会话名/ID 会回报，要翻看用 /resume-agent。",
		promptSnippet: "派活给临时助理（真子进程，可并行/续跑）——过程不进主对话，只回卡片",
		promptGuidelines: [
			"自己 1~2 步能做完的活别派（派出去更慢更贵）；要跟用户来回确认的也别派。",
			"派出去之后就**别再自己搜同一件事**：重复搜索是浪费轮次、撑爆上下文的第一大坑。",
			"委托时写清「目标 + 验收标准 + 不碰什么」；只写「分析一下」这类模糊指令等于白派。",
			"多件互不依赖的活用 tasks 一次并行派完，别串行一个个派；超时/失败过的用 resume 续跑，别重开。",
		],
		parameters: params,

		async execute(
			_toolCallId: string,
			params: {
				assistant?: string;
				task?: string;
				tasks?: (string | { assistant?: string; task: string })[];
				resume?: string;
				timeoutMs?: number;
				wait?: boolean;
			},
			signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			// 停用态：工具理论已被撤下，这里再兜一道（防「撤下前已在飞」的调用）
			if (isExtDisabled()) {
				return {
					content: [{ type: "text" as const, text: "扩展已停用（/ai-ext on 恢复）—— 本次没有派发任何助理。" }],
					details: { ok: false, reason: "ext_off" },
				};
			}
			// wait 参数优先；没传才用 /delegate-mode 的默认（默认异步）
			const wait = params.wait ?? (readDelegateMode() === "sync");
			const cwd = ctx.cwd ?? process.cwd();
			const templates = loadTemplates(cwd);
			const resumeId = params.resume?.trim() || undefined;

			// 任务列表：每项解析成 { assistant, task }
			//   · 字符串        → 用外层 assistant
			//   · {assistant,task} → 用自带的（没写才回落到外层）
			const outer = params.assistant?.trim() || "";
			const rawTasks = params.tasks ?? (params.task ? [params.task] : []);
			let wants: { assistant: string; task: string }[] = rawTasks
				.map((t) =>
					t && typeof t === "object"
						? { assistant: String(t.assistant ?? "").trim() || outer, task: String(t.task ?? "").trim() }
						: { assistant: outer, task: String(t).trim() },
				)
				.filter((w) => w.task.length > 0);
			if (resumeId) wants = wants.slice(0, 1); // 续跑只能配一件
			if (!wants.length) {
				return {
					content: [{ type: "text" as const, text: "没给任务。用 task（一件）或 tasks（多件并行）。" }],
					details: { ok: false, reason: "no_task" },
				};
			}
			if (wants.some((w) => !w.assistant)) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"没给助理。用 assistant（模板名）指定，或者在 tasks 的每一项里写 assistant。\n" +
								"例：delegate(tasks=[{assistant:\"db\", task:\"查库\"}, {assistant:\"backend\", task:\"改接口\"}])",
						},
					],
					details: { ok: false, reason: "no_assistant" },
				};
			}

			// 每个助理一份模板 + 一份影子目录（同一助理派多件共用；跨助理各走各的 MCP 隔离）
			const ready = new Map<string, { tpl: Template; shadow: ShadowResult }>();
			for (const name of [...new Set(wants.map((w) => w.assistant))]) {
				const tpl = templates.find((t) => t.key === name || t.name === name);

				if (!tpl) {
					const can = templates.filter((t) => t.base !== true && t.demo !== true);
					const have = can.length
						? `可派的有：${can.map((t) => `${t.key}(${t.name})`).join(", ")}`
						: `可是现在**一个能派的都没有**（只有 base 和示例模板，用 /assistants 看）`;
					return {
						content: [{ type: "text" as const, text: `找不到助理「${name}」。${have}` }],
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

				// （旧代码在这里「白名单没列 mcp__ 工具 → 直接拒绝」，已删除：
				//  pi 1.0.4 起 `-t/--tools` 默认**保留 MCP 工具**，只有白名单里出现 mcp__ 开头的
				//  条目时才按它过滤 MCP —— 所以不列 mcp__ 工具不再会让 MCP 静默不可用，
				//  那条拦截成了误报，会把正常模板挡在门外。）

				// 建影子 agentDir：只放进本模板声明的那些 MCP（真正的「按需给」）
				const pool = loadMcpPool(tpl.cwd);
				const shadow = buildShadow(tpl.key, tpl.mcp, pool, {
					agentsMd: tpl.agentsMd !== false,
					exposure: tpl.mcpExposure,
					// 每次派发一个独立影子目录：同一个助理并发派发不再互相覆盖 mcp.json
					runSuffix: Math.random().toString(36).slice(2, 8),
				});
				// L3 兜底：把守卫放进影子目录（**只在 Super Agent 模式开着时**；关着 = 保持老的全权限行为）。
				// 装失败也不拦派活（fail-open）：没装成 = 退回老行为，比把活卡死好。
				if (superagentEnabled()) {
					installGuard(shadow.dir, { perms: tpl.perms, cwd: tpl.cwd, pluginDir: EXT_DIR });
				}
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
									`  候选池    ${localCatalogPath()}\n` +
									`  用户级    ${join(getAgentDir(), "mcp.json")}\n` +
									`  项目级    ${join(tpl.cwd, ".pi", "mcp.json")}\n\n` +
									`补法：把定义写进候选池（它不会被主会话自动加载，只当助理候选），` +
									`或者 /assistants edit ${tpl.key} 改挂一个池子里已有的。`,
							},
						],
						details: { ok: false, reason: "mcp_not_found", missing: shadow.missing },
					};
				}

				// 影子目录 bin 没接上 → 每个子助理启动都要联网下载 fd/rg（慢 + 报警）。
				// 不拦派活（顶多慢几秒），但要让用户看见。
				if (shadow.warnings.length) {
					ctx.ui.notify(`「${tpl.name}」影子目录 bin 没接好：${shadow.warnings.join("；")}`, "warning");
				}
				ready.set(name, { tpl, shadow });
			}
			const plan = wants.map((w) => ({ ...w, ...ready.get(w.assistant)! }));

			// 超时/默认值沿用第一个任务的模板（单助理派发时和以前完全一致）
			const raw =
				params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : (plan[0].tpl.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const total = Math.min(Math.max(raw, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
			const main = mainName(ctx);
			rememberCurrentSession(ctx); // 刷新本会话身份（异步回投靠它认领）
			bgCtx = ctx; // 降级通知（分屏不可用）要用的 ctx：tryRunInHerdr 里拿不到 ctx
			const running = `${plan.length > 1 ? `×${plan.length} ` : ""}`;
			// 一个助理就显示它的名字；跨助理并列显示，别只报第一个（不然会误以为只派了一个）
			const label = [...new Set(plan.map((p) => p.tpl.name))].join(" + ");

			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `📤 ${label} ${running}干活中…`));
			}
			// 清掉上一轮的旧账，面板上只留这一批
			beginRun();
			ensureAgentPanel(ctx);
			// 主会话当前模型：给助理做「默认继承」（模板里的 model 仍优先）
			const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

			let results: RunResult[];
			if (wait) {
				try {
					results = await Promise.all(
						plan.map(({ tpl: one, shadow: shadowOf, task }) => {
							const seq = resumeId ? 0 : nextSeq(one.key);
							const names = buildNames(main, one, seq, resumeId);
							return runAssistant(one, task, {
								timeoutMs: total,
								signal,
								names,
								resumed: Boolean(resumeId),
								mainModel,
								shadowDir: shadowOf.dir,
								sessionDir: ensureAssistantSessionDir(one.key),
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
				const deadlineAt = Date.now() + total + 2 * 60 * 1000;
				// 同一次 delegate(tasks) → 一个 batchId：整批 settle 后**只写一条** `.bg`、只投一张汇总卡。
				// 单任务（tasks 里就一个）不走批次，投递行为与以前完全一致。
				const batch =
					plan.length > 1
						? openBatch(plan.length, {
								key: "batch",
								task: plan.map((p) => p.task).join(" ｜ "),
								ownerSessionFile: currentSessionFile,
								ownerSessionId: currentSessionId,
								deadlineAt,
							})
						: undefined;
				for (const [seqIdx, { tpl: one, shadow: shadowOf, task }] of plan.entries()) {
					const seq = resumeId ? 0 : nextSeq(one.key);
					const names = buildNames(main, one, seq, resumeId);
					// bg 文件名加随机后缀：中文 key 会被 sanitize 掉，两个助理同一秒派发会撞 id、互相覆盖 .bg 文件
					const bgId = `${names.id}-${Math.random().toString(36).slice(2, 8)}`;
					ids.push(names.id);
					// 批次里**不写** per-task 的 `.bg`（否则每张卡都会单独回投一次 → 8 轮对话）
					if (!batch) {
						writeBgTask({
							id: bgId, key: one.key, name: one.name, task, sessionId: names.id,
							startedAt: Date.now(), status: "running",
							ownerSessionFile: currentSessionFile,
							ownerSessionId: currentSessionId,
							// 2 分钟余量：收尾/追问/写盘都要时间，别卡在边界上误判
							deadlineAt,
						});
					}
					void (batch
						? runAssistant(one, task, {
								// 批次：onSettle 不一定被调到（会话锁忙 / 排队中被中止 / 找不到 CLI 都是早退），
								// 所以再挂一层 .then —— 保证这批一定能凑齐、汇总卡一定发得出去。
								// （noteBatchItem 按序号去重，onSettle 已经记过的不会重复）
								timeoutMs: total,
								names,
								resumed: Boolean(resumeId),
								mainModel,
								shadowDir: shadowOf.dir,
								sessionDir: ensureAssistantSessionDir(one.key),
								onSettle: (r) => noteBatchItem(batch, seqIdx, batchItemOf(r)),
							})
								.then((r) => {
									if (r) noteBatchItem(batch, seqIdx, batchItemOf(r));
								})
								.catch((e) => {
									// runAssistant 正常不 reject；真拒了也得记一条，否则这批永远等不齐
									const msg = e instanceof Error ? e.message : String(e);
									noteBatchItem(batch, seqIdx, {
										name: one.name,
										outcome: "failed",
										elapsedMs: Date.now() - batch.startedAt,
										error: `runAssistant 异常：${msg}`,
										sessionId: names.id,
									});
								})
						: runAssistant(one, task, {
								timeoutMs: total,
								// 不传 signal：不随本轮 turn 结束被 abort
								names,
								resumed: Boolean(resumeId),
								mainModel,
								shadowDir: shadowOf.dir,
								sessionDir: ensureAssistantSessionDir(one.key),
								// pane 分支的收尾靠它兜底写终态（onSettle 抛错 / 根本没调到也得有终态）
								bgId,
								onSettle: (r) => {
									const prev = readBgTask(bgId) ?? {
										id: bgId, key: one.key, name: one.name, task, sessionId: names.id,
										startedAt: Date.now(), status: "running" as const,
										ownerSessionFile: currentSessionFile,
										ownerSessionId: currentSessionId,
										deadlineAt,
									};
									writeBgTask({
										...prev,
										status: outcomeToStatus(r.outcome),
										resultText: renderCard(r),
										finishedAt: Date.now(),
										delivered: false,
									});
								},
							}).catch((e) => {
								// runAssistant 正常不 reject；真拒了也绝不让这条留在 running（回执永远不投的根因）
								try {
									const prev = readBgTask(bgId);
									if (prev && prev.status === "running") {
										const msg = e instanceof Error ? e.message : String(e);
										const fields = finalizeHerdrRun({ outcome: "failed", error: `runAssistant 异常：${msg}` });
										writeHerdrBgTerminal(bgId, fields);
									}
								} catch {
									/* ignore */
								}
							}));
				}
				return {
					content: [
						{
							type: "text" as const,
							text:
								`已派发 ${plan.length} 个任务给「${label}」（后台跑，完成后自动回投主会话${batch ? "，整批合成一张汇总卡" : ""}）：\n` +
								ids.map((id) => `  · 会话ID ${id}`).join("\n") +
								`\n\n中途想切同步/异步：/delegate-mode async | sync`,
						},
					],
					details: { ok: true, async: true, sessions: ids, batchId: batch?.id },
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
	};
	api.registerTool(DELEGATE_TOOL);

	// ---------- 停用闸门：delegate 工具撤下 + 后台回投暂停 ----------
	function applyDelegateGate(off: boolean): void {
		try {
			apiRef?.registerTool({ ...DELEGATE_TOOL, exposure: off ? "hidden" : "direct" });
		} catch (e) {
			console.error("[ai-configure] delegate: 切换 delegate 工具失败：", e);
		}
		if (off) {
			// 停轮询：小票一律不删、不投；/ai-ext on 后 armBgTimer() 会自动补投
			if (bgTimer) {
				clearInterval(bgTimer);
				bgTimer = undefined;
			}
		} else {
			armBgTimer();
		}
	}

	// ---------- /panes + /pane-close：看得见、关得掉子助理 pane ----------
	api.registerCommand("panes", {
		description: "列出本会话的子助理 pane（哪个在跑 / 哪个已停），编号给 /pane-close 用",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const rows = collectPaneRows();
			const self = mainPaneId();
			ctx.ui.notify(formatPaneReport(rows, self, self).join("\n"), "info");
		},
	});

	api.registerCommand("pane-close", {
		description: "关掉卡住的子助理 pane：直接敲=关已停/失败的；all=全关；<编号>=关第 N 个（/panes 的编号）",
		handler: async (args: string, ctx: ExtensionContext) => {
			const target = parsePaneCloseArg(args ?? "");
			if (target.mode === "bad") {
				ctx.ui.notify(`不认识「${target.arg}」。用法：/pane-close | /pane-close all | /pane-close <编号>`, "info");
				return;
			}
			if (target.mode === "index") {
				const exists = collectPaneRows().some((r) => r.index === target.index);
				if (!exists) {
					ctx.ui.notify(
						`没有 #${target.index} 这一格。先敲 /panes 看编号。\n${formatPaneReport(collectPaneRows(), mainPaneId(), mainPaneId()).join("\n")}`,
						"info",
					);
					return;
				}
			}
			const r = closePanesByTarget(target);
			const what = target.mode === "all" ? "全部子助理 pane" : target.mode === "index" ? `#${target.index}` : "已停/失败保留的 pane";
			ctx.ui.notify(
				`已关闭 ${r.closed} 个（${what}；跳过 自己 ${r.skippedSelf} / 主 pane ${r.skippedMain}）`,
				"info",
			);
			notifyLive();
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

	// ---------- /router：Router 档位（默认只派活） ----------
	api.registerCommand("router", {
		description:
			"Router 档位：直接敲看当前档位；blind=只派活（默认）/ readonly=只读 / off=不限制（本会话有效）",
		handler: async (args: string, ctx) => {
			const label = (m: string): string => (m === "blind" ? "只派活" : m === "readonly" ? "只读" : "不限制");
			const st = readSuperAgent();
			const offHint = st.enabled ? "" : "\n（注意：Super Agent 当前是关的，档位暂不生效）";
			const sub = (args ?? "").trim().toLowerCase();
			if (!sub) {
				ctx.ui.notify(
					`当前 Router 档位：${label(st.router)}（${st.router}）· 生效原因：${st.decidedBy}${offHint}\n` +
						"用法：/router blind | readonly | off（本会话有效，重启复位）",
					"info",
				);
				return;
			}
			// 中英文都认：blind/只派活、readonly/只读、off/不限制
			const alias: Record<string, RouterMode> = {
				blind: "blind",
				readonly: "readonly",
				off: "off",
				只派活: "blind",
				只读: "readonly",
				不限制: "off",
			};
			const hit = alias[sub];
			if (!hit) {
				ctx.ui.notify(`不认识「${sub}」。可用：blind（只派活）/ readonly（只读）/ off（不限制）`, "info");
				return;
			}
			setRouterSession(hit);
			ctx.ui.notify(`本会话已切到「${label(hit)}」（${hit}）—— 重启 pi 复位成配置值${offHint}`, "info");
		},
	});

	// ---------- /batch：看归档的子助理结果（只读）----------
	api.registerCommand("batch", {
		description: "看归档的子助理结果：直接敲=最近 7 天列表（最多 20 条）；/batch <id>=看全文；/batch <id> --raw=只看正文",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const raw = parts.some((p) => p.toLowerCase() === "--raw");
			const id = parts.filter((p) => !p.startsWith("--"))[0] ?? "";
			const fmtTime = (ms?: number): string => {
				if (!Number.isFinite(ms)) return "?";
				const d = new Date(Number(ms));
				const p = (n: number): string => String(n).padStart(2, "0");
				return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
			};

			// 没给 id：列最近 7 天
			if (!id) {
				const all = listArchivedResults(7);
				if (!all.length) {
					ctx.ui.notify("最近 7 天没有归档。（派活完成后会自动归档到 <agentDir>/results/）", "info");
					return;
				}
				const rows = all.slice(0, 20).map((r) => {
					const sum = (r.summary || "").replace(/\s+/g, " ").slice(0, 40);
					return `${fmtTime(r.finishedAt ?? r.startedAt)} · ${r.status} · ${r.name || "?"} · ${sum} · ${r.id}`;
				});
				const more = all.length > rows.length ? `\n（还有 ${all.length - rows.length} 条没列，用 /batch <id> 直看正文）` : "";
				ctx.ui.notify([`【归档】最近 7 天 ${all.length} 条`, ...rows].join("\n") + more, "info");
				return;
			}

			// 给了 id：打印正文
			const hit = readArchivedResult(id);
			if (!hit) {
				ctx.ui.notify(`没找到归档：${id}（用 /batch 看列表）`, "info");
				return;
			}
			if (raw) {
				ctx.ui.notify(hit.body || "（这份归档没有正文）", "info");
				return;
			}
			const head = [
				`# ${hit.name || "?"} · ${hit.id}`,
				`- 状态: ${hit.status}`,
				`- 开始: ${fmtTime(hit.startedAt)}`,
				`- 结束: ${fmtTime(hit.finishedAt)}`,
				`- 摘要: ${hit.summary}`,
			];
			ctx.ui.notify(`${head.join("\n")}\n\n──── 正文 ────\n${hit.body || "（没有正文）"}`, "info");
		},
	});

	// ---------- /agents：子代理实时面板 ----------
	api.registerCommand("agents", {
		description:
			"子代理实时面板：直接敲=开；off 关；detail 展开思考；text 打印快照；" +
			"float 改成右侧浮层，widget 改回看板上方；" +
			"bg 看后台任务状态（只列本对话，加 all 看全部），bg redeliver 把没投回主会话的立刻重投；" +
			"linger <时长> 改跑完的子代理在面板上呆多久（默认 45s，0=立刻消失）",
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
			if (sub === "linger" || sub.startsWith("linger ")) {
				const arg = (args ?? "").trim().split(/\s+/).slice(1).join(" ").trim();
				const cur = getLingerMs();
				const show = `面板保鲜期：${cur === 0 ? "0（跑完立刻消失）" : humanTimeout(cur)}\n配置文件：${extensionsConfigFile()}`;
				if (!arg) {
					ctx.ui.notify(`${show}\n\n用法：/agents linger <时长>　（例 45s / 2m / 0=立刻消失）`, "info");
					return;
				}
				const ms = arg === "off" ? 0 : parseDuration(arg);
				if (ms === undefined) {
					ctx.ui.notify(`看不懂「${arg}」。用法：/agents linger 45s | 2m | 0\n\n${show}`, "info");
					return;
				}
				writeLingerMs(ms);
				ctx.ui.notify(
					`面板保鲜期已改成：${ms === 0 ? "0（跑完立刻消失）" : humanTimeout(ms)}\n` +
						`（跑完的子代理会在面板上呆这么久再自动摘掉；以前是下次派活才清）`,
					"info",
				);
				return;
			}
			if (sub === "bg" || sub.startsWith("bg ")) {
				const action = sub.slice(2).trim();
				const every = listBgTasks().sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
				const mine = every.filter((t) => isOwnBgTask(t));
				// 默认只列**本对话**的：别的会话的历史小票跟你没关系，不该在这里刷存在感。
				// /agents bg all 才看全部（那些仍标「⚠别的会话」）。
				const showAll = action === "all";
				const all = showAll ? every : mine;
				if (!all.length) {
					ctx.ui.notify(
						!showAll && every.length > 0
							? `本对话没有后台任务记录。（别处还有 ${every.length} 条历史记录，要看就 /agents bg all）`
							: "本对话没有后台任务记录。",
						"info",
					);
					return;
				}
				if (action === "redeliver" || action === "retry") {
					let n = 0;
					for (const t of all) {
						if (t.status === "running" || t.delivered) continue;
						if (!isOwnBgTask(t)) continue;
						// 清掉「已放弃」和退避计时，立即重试
						writeBgTask({
							...t,
							undelivered: false,
							// 显式清零：只有用户主动要求重投才允许把重试计数/失败时间倒回去
							reset: ["attempts", "firstFailAt", "lastAttemptAt", "lastError", "undelivered"],
						});
						deliveredThisRun.delete(t.id); // 手动重投：把内存去重也放开
						forcedDeliver.add(t.id); // 也绕过「太老不自动投」的闸门（用户亲自要补）
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
					`后台任务 ${all.length} 条${showAll ? "（全部，含别的会话）" : "（本对话）"}（最多列 20）：\n${lines.join("\n")}\n\n` +
						(showAll ? "只看本对话：/agents bg" : "看全部： /agents bg all") +
						"　重投未投递的：/agents bg redeliver",
					"info",
				);
				return;
			}

			// 直接敲 /agents = 打开（并解开「用户关过」的封印）；形态沿用上次选的
			openAgentPanel(ctx, { force: true });
			ctx.ui.notify(`子代理面板：${panelMode()}`, "info");
		},
	});

	// 停用闸门：最后登记（工具定义 / 轮询都在这一层）
	onGateApply("delegate", applyDelegateGate);
}
