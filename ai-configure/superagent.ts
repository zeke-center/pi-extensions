/**
 * superagent.ts —— Super Agent 模式（Router / Worker 双层，参考 DeepSeek Harness 的设计）。
 *
 * 这一层现在负责什么
 * ----------------
 * ① 三层开关（全局 / 本项目 / 本会话）
 * ② **Router 工具档位**：模式开着时摘掉主会话的执行类工具（只读档保留 read/grep）
 * ③ **Worker 回执契约**：给 Worker 的提示词尾部拼一段 `<result>` 格式要求 + 解析它交回来的块
 * ④ 状态栏提示（开着时 footer 显示 `⚡ Super Agent · 项目 · 只读`）
 *
 * 不做什么：不替 Router 决策、不改 Worker 的执行逻辑（那些在 delegate.ts 里）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerSettings, settingsCtx, type SettingDef } from "./settings";
import { patchExtCfg, readExtCfg } from "./shared";

/** 面板里的组名（和文章里的写法一致，带空格） */
export const SUPERAGENT_GROUP = "Super Agent";

/** 状态栏用的 key（一个 key 只占一格，关掉就清） */
const STATUS_KEY = "superagent";

// ======================= 三层开关 =======================

/** 三档：跟随上级 / 强制开 / 强制关 */
type Layer = "inherit" | true | false;

const OPTIONS = ["跟随上级", "强制开启", "强制关闭"];
const VALUES: Layer[] = ["inherit", true, false];

interface LayerConfig {
	global: boolean;
	project: Layer;
	session: Layer;
}

let sessionLayer: Layer = "inherit";

const DEFAULTS = {
	global: false,
	project: "inherit" as Layer,
	session: "inherit" as Layer,
	/** 回执：严格 = 要求格式且缺了标黄；宽松 = 有就解析、没有就当没事；关 = 不要求 */
	report: "strict" as ReportMode,
	/** 失败自动重派次数（0 = 不自动） */
	retry: 0,
	/** Router 能力档位 */
	router: "readonly" as RouterMode,
};

export type ReportMode = "strict" | "loose" | "off";
export type RouterMode = "readonly" | "blind" | "off";

const REPORT_OPTIONS = ["严格", "宽松", "关"];
const REPORT_VALUES: ReportMode[] = ["strict", "loose", "off"];
const ROUTER_OPTIONS = ["只读（推荐）", "全禁（只剩 delegate/progress）", "不限制"];
const ROUTER_VALUES: RouterMode[] = ["readonly", "blind", "off"];

function readGlobalLayer(): boolean {
	const raw = readExtCfg().superagent;
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return typeof obj.enabled === "boolean" ? obj.enabled : DEFAULTS.global;
}

function projectFile(cwd: string): string {
	return join(cwd, ".pi", "ai-extensions.json");
}

function readProjectLayer(cwd: string): Layer {
	try {
		const file = projectFile(cwd);
		if (!existsSync(file)) return "inherit";
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const blk = obj.superagent;
		const b = blk && typeof blk === "object" ? (blk as Record<string, unknown>) : {};
		return typeof b.enabled === "boolean" ? (b.enabled as boolean) : "inherit";
	} catch {
		return "inherit";
	}
}

function writeProjectLayer(cwd: string, v: Layer): void {
	try {
		const file = projectFile(cwd);
		let all: Record<string, unknown> = {};
		if (existsSync(file)) {
			try {
				const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
				if (raw && typeof raw === "object") all = raw as Record<string, unknown>;
			} catch {
				all = {};
			}
		}
		const blk = all.superagent && typeof all.superagent === "object" ? (all.superagent as Record<string, unknown>) : {};
		all.superagent = { ...blk, enabled: v };
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, "utf8");
	} catch {
		/* 写不进去只影响这一项 */
	}
}

function cwdNow(): string {
	return settingsCtx()?.cwd ?? process.cwd();
}

/** 全局块里的某个键（类型不对就用默认） */
function readCfgKey<K extends "report" | "retry" | "router">(k: K): (typeof DEFAULTS)[K] {
	const raw = readExtCfg().superagent;
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const v = obj[k];
	if (k === "retry") return (typeof v === "number" && v >= 0 ? Math.min(2, v) : DEFAULTS.retry) as (typeof DEFAULTS)[K];
	if (k === "report") return (REPORT_VALUES.includes(v as ReportMode) ? v : DEFAULTS.report) as (typeof DEFAULTS)[K];
	return (ROUTER_VALUES.includes(v as RouterMode) ? v : DEFAULTS.router) as (typeof DEFAULTS)[K];
}

export interface SuperAgentState extends LayerConfig {
	enabled: boolean;
	decidedBy: "会话" | "项目" | "全局" | "默认（关）";
	report: ReportMode;
	retry: number;
	router: RouterMode;
}

export function readSuperAgent(): SuperAgentState {
	const global = readGlobalLayer();
	const project = readProjectLayer(cwdNow());
	let enabled = global;
	let decidedBy: SuperAgentState["decidedBy"] = global ? "全局" : "默认（关）";
	if (project !== "inherit") {
		enabled = project === true;
		decidedBy = "项目";
	}
	if (sessionLayer !== "inherit") {
		enabled = sessionLayer === true;
		decidedBy = "会话";
	}
	return {
		global,
		project,
		session: sessionLayer,
		enabled,
		decidedBy,
		report: readCfgKey("report"),
		retry: readCfgKey("retry"),
		router: routerSession ?? readCfgKey("router"),
	};
}

/** 模式开了没 —— 别的模块统一从这里读 */
export function superagentEnabled(): boolean {
	return readSuperAgent().enabled;
}

// ======================= Worker 回执契约 =======================

export interface WorkerReport {
	ok: boolean;
	verdict: "pass" | "partial" | "fail";
	changed: string[];
	ran: string[];
	blocked: string[];
	notes: string;
}

/** 给 Worker 提示词尾部拼的那段（模式关 / 回执关 → 空串，等于什么都没加） */
export function reportRule(): string {
	const st = readSuperAgent();
	if (!st.enabled || st.report === "off") return "";
	return [
		"【回执要求】",
		"做完之后，**最后**输出一个回执块，格式严格如下（单独一段，不要放进正文中间）：",
		'<result>{"ok":true,"verdict":"pass","changed":["src/a.ts"],"ran":["npm test → 12 passed"],"blocked":[],"notes":"一句话说明"}</result>',
		"- verdict：pass / partial / fail。**没做完不许写 pass**；有被权限或依赖挡住的事就写进 blocked。",
		"- changed：你改过的文件（相对路径）；一个没改就写 []。",
		"- ran：你真跑过的命令 + 关键输出片段（别编；没跑就 []）。",
		"- notes：一句话说清你做了什么。",
	].join("\n");
}

/** 从 Worker 的最终回复里抓回执（容忍 ``` 包裹、前后废话、坏 JSON） */
export function parseReport(text: string): WorkerReport | undefined {
	if (!text) return undefined;
	const blocks = [...text.matchAll(/<result>([\s\S]*?)<\/result>/gi)];
	if (!blocks.length) return undefined;
	const raw = (blocks[blocks.length - 1]?.[1] ?? "").replace(/^```(?:json)?|```$/g, "").trim();
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		// 尾逗号 / 单引号这类小毛病：宽松修一下再试一次
		try {
			// 宽松修复：尾逗号 + 单引号 + 没引号的键名（模型常见的三种手滑）
			const fixed = raw
				.replace(/,\s*([}\]])/g, "$1")
				.replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
				.replace(/'/g, '"');
			obj = JSON.parse(fixed) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	const arr = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : [];
	const verdictRaw = String(obj.verdict ?? "").toLowerCase();
	const verdict = verdictRaw === "pass" || verdictRaw === "partial" || verdictRaw === "fail" ? verdictRaw : obj.ok === true ? "pass" : "fail";
	return {
		ok: obj.ok === true,
		verdict,
		changed: arr(obj.changed),
		ran: arr(obj.ran),
		blocked: arr(obj.blocked),
		notes: typeof obj.notes === "string" ? obj.notes.trim() : "",
	};
}

/** 卡片头部那行摘要（没回执 = undefined，交给调用方决定怎么标） */
export function reportHeadline(r: WorkerReport, status: "strict" | "loose"): string {
	const badge = r.verdict === "pass" ? "✅ pass" : r.verdict === "partial" ? "🔸 partial" : "❌ fail";
	const bits: string[] = [];
	if (r.changed.length) bits.push(`改 ${r.changed.length} 个文件`);
	if (r.ran.length) bits.push(`跑过 ${r.ran.length} 条命令`);
	if (r.blocked.length) bits.push(`被挡 ${r.blocked.length} 项`);
	const noEvidence = r.verdict === "pass" && !r.ran.length;
	const tail = noEvidence && status === "strict" ? " ⚠️ 无命令证据" : "";
	return `${badge}${tail}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}

// ======================= Router 工具档位 =======================

/** 只读档要摘掉的工具（能写、能执行、能借道执行的） */
const BLOCKED_READONLY = ["bash", "write", "edit", "apply_patch", "multiedit", "codemode"];
/**
 * 只读档还要摘掉「长得就像能执行/能写」的 MCP 工具。
 *
 * 为什么：只按名字摘内建工具不够 —— 比如 `mcp__nas-ubuntu24__ssh_exec` 能跑任意命令，
 * 留着它等于没摘 bash。这里用名字猜，宁可多摘（真需要就在面板里选「不限制」）。
 */
const MCP_DANGER = /(ssh|exec|shell|bash|run_?cmd|write|delete|drop|update|insert|create|patch|apply)/i;
/** 全禁档：除这两个，其它全摘 */
const KEEP_BLIND = ["delegate", "progress"];
/** 只读档明确要保留的（其余按黑名单摘）—— git_read 让我们能验收 Worker 的改动 */
const KEEP_READONLY = ["delegate", "progress", "read", "grep", "git_read"];

/** 本会话对档位的覆盖（「临时放开」用；重启复位） */
let routerSession: RouterMode | undefined;
/** 摘工具前的那一刻快照，用于原样还原 */
let toolsSnapshot: string[] | undefined;
let apiRef: ExtensionAPI | undefined;

export function setRouterSession(v: RouterMode | undefined): void {
	routerSession = v;
	applyRouterTools();
	refreshSuperAgentStatus();
}

/** 按当前配置摘 / 还原 Router 的工具（幂等，可反复调） */
export function applyRouterTools(): void {
	const api = apiRef;
	if (!api?.setActiveTools) return;
	const st = readSuperAgent();
	try {
		if (!st.enabled || st.router === "off") {
			if (toolsSnapshot) {
				api.setActiveTools(toolsSnapshot);
				toolsSnapshot = undefined;
			}
			return;
		}
		// 只在第一次摘的时候记快照，之后都基于快照算（避免越摘越少）
		// 快照取「所有已配置的工具」而不是「当前激活的」：早期调用时内建工具
		// （bash/read/write/edit/codemode）可能还没注册，拿激活列表当快照会把它们全摘光
		if (!toolsSnapshot) {
			const all =
				typeof api.getAllTools === "function"
					? api.getAllTools().map((t) => t.name)
					: ((api.getActiveTools?.() ?? []) as string[]);
			if (all.length < 3) return; // 工具还没注册完，此时别动手
			toolsSnapshot = all;
		}
		const base = toolsSnapshot;
		const keep =
			st.router === "blind"
				? base.filter((n) => KEEP_BLIND.includes(n))
				: base.filter((n) => !BLOCKED_READONLY.includes(n) && !(n.startsWith("mcp__") && MCP_DANGER.test(n)));
		api.setActiveTools(keep);

		// ---------- fail-safe 自检 ----------
		// 收窄绝不能把 Router 弄成残废（v2.3 真踩过：快照拿早了，bash/read 全没了）。
		// 只校验「本该保留的」：delegate/progress 必须还在；只读档额外要求 read。
		const required = st.router === "blind" ? KEEP_BLIND : KEEP_READONLY;
		const after = (api.getActiveTools?.() ?? []) as string[];
		const missing = required.filter((n) => base.includes(n) && !after.includes(n));
		if (missing.length) {
			api.setActiveTools(toolsSnapshot);
			toolsSnapshot = undefined;
			notifyOnce(`⚠️ Super Agent 收窄失败（少了 ${missing.join(", ")}），已还原全部工具`);
		}
	} catch {
		/* 工具列表改不动就别硬改，主会话照常可用 */
	}
}

/** 同一个告警只弹一次，别每次 session_start 都刷屏 */
let lastWarn = "";
function notifyOnce(msg: string): void {
	if (msg === lastWarn) return;
	lastWarn = msg;
	try {
		settingsCtx()?.ui?.notify?.(msg, "warning");
	} catch {
		/* 通知失败不影响功能 */
	}
}

/** 面板里的「临时放开全部工具」：本会话恢复原样 */
export function releaseRouterTools(): void {
	setRouterSession("off");
	try {
		apiRef?.ui?.notify?.("本会话已恢复全部工具（重启 pi 后按配置重新生效）", "info");
	} catch {
		/* 通知失败无所谓 */
	}
}

/** 当前档位的中文短名（状态栏用） */
function routerLabel(m: RouterMode): string {
	return m === "readonly" ? "只读" : m === "blind" ? "全禁" : "不限制";
}

// ======================= 状态栏 =======================

export function refreshSuperAgentStatus(): void {
	const ctx = settingsCtx();
	if (!ctx) return;
	try {
		const st = readSuperAgent();
		ctx.ui.setStatus(STATUS_KEY, st.enabled ? `⚡ Super Agent · ${st.decidedBy} · ${routerLabel(st.router)}` : undefined);
	} catch {
		/* 状态栏画不出来不影响功能 */
	}
}

// ======================= 写 =======================

export function setSuperAgentEnabled(v: boolean): void {
	patchExtCfg({ superagent: { ...(readExtCfg().superagent as object), enabled: v } });
	applyRouterTools();
	refreshSuperAgentStatus();
}

export function setSuperAgentProject(v: Layer): void {
	writeProjectLayer(cwdNow(), v);
	applyRouterTools();
	refreshSuperAgentStatus();
}

export function setSuperAgentSession(v: Layer): void {
	sessionLayer = v;
	applyRouterTools();
	refreshSuperAgentStatus();
}

/** 改全局块里的 report / retry / router */
export function setSuperAgentOption(patch: Partial<{ report: ReportMode; retry: number; router: RouterMode }>): void {
	const cur = readExtCfg().superagent;
	const blk = cur && typeof cur === "object" ? (cur as Record<string, unknown>) : {};
	patchExtCfg({ superagent: { ...blk, ...patch } });
	applyRouterTools();
	refreshSuperAgentStatus();
}

/**
 * 未来的子选项插槽。
 *
 * 加一条的样子（示例，现在是空的）：
 *   EXTRA_DEFS.push({ key: "superagent.xxx", group: SUPERAGENT_GROUP, label: "…", desc: "…",
 *     kind: "bool", def: false, get: () => …, set: (v) => … });
 */
const EXTRA_DEFS: SettingDef[] = [];

function registerSuperAgentSettings(): void {
	const defs: SettingDef[] = [
		{
			key: "superagent.enabled",
			group: SUPERAGENT_GROUP,
			label: "全局开关",
			desc:
				"Super Agent 模式的**全局**默认值（默认关）。\n\n" +
				"分工：**主会话 = Router**（跟你对话、决定派谁、验收结果，不亲自干活）；" +
				"**助理 = Worker**（各自独立上下文，只做被派的那一件，干完交证据）。\n\n" +
				"优先级：本会话 > 本项目 > 这里。\n" +
				"开着时主会话的工具会被「Router 能力」那一行收窄。",
			kind: "bool",
			def: DEFAULTS.global,
			get: () => readGlobalLayer(),
			set: (v) => setSuperAgentEnabled(v === true || v === "true" || v === "是" || v === "开"),
		},
		{
			key: "superagent.project",
			group: SUPERAGENT_GROUP,
			label: "本项目",
			desc:
				"只对**当前项目**生效的覆盖值。存在 `<项目>/.pi/ai-extensions.json`，跟着仓库走\n" +
				"（记得加进 `.gitignore`，别把个人偏好提交上去）。\n\n" +
				"典型用法：全局关着、只在某个项目里开；或者全局开着、某个项目强制关掉。",
			kind: "enum",
			options: OPTIONS,
			values: VALUES,
			def: DEFAULTS.project,
			get: () => readProjectLayer(cwdNow()),
			set: (v) => setSuperAgentProject((VALUES.includes(v as Layer) ? v : "inherit") as Layer),
		},
		{
			key: "superagent.session",
			group: SUPERAGENT_GROUP,
			label: "本会话",
			desc:
				"只对**当前这次 pi 会话**生效，**不落盘**：重启或开新会话自动复位成「跟随上级」。\n\n" +
				"临时试一下模式、又不想动任何配置文件时用它。",
			kind: "enum",
			options: OPTIONS,
			values: VALUES,
			def: DEFAULTS.session,
			get: () => sessionLayer,
			set: (v) => setSuperAgentSession((VALUES.includes(v as Layer) ? v : "inherit") as Layer),
		},
		{
			key: "superagent.report",
			group: SUPERAGENT_GROUP,
			label: "强制回执",
			desc:
				"要求 Worker 交一个结构化回执块（`<result>{...}</result>`），主会话据此判断到底做成没。\n\n" +
				"- **严格**：要求回执；`verdict=pass` 但没跑过任何命令 → 卡片标 ⚠️ 证据不足\n" +
				"- **宽松**：有回执就解析，没有也不提示\n" +
				"- **关**：不注入回执要求（省 ~200 token/次）\n\n" +
				"回执字段：`verdict`（pass/partial/fail）、`changed`（改的文件）、`ran`（跑过的命令+输出）、`blocked`、`notes`。",
			kind: "enum",
			options: REPORT_OPTIONS,
			values: REPORT_VALUES,
			def: DEFAULTS.report,
			get: () => readCfgKey("report"),
			set: (v) => setSuperAgentOption({ report: (REPORT_VALUES.includes(v as ReportMode) ? v : "strict") as ReportMode }),
		},
		{
			key: "superagent.retry",
			group: SUPERAGENT_GROUP,
			label: "失败重派",
			desc:
				"Worker 回执写 `verdict=fail` 时，主会话自动用 `resume` 再跑一次的次数。\n\n" +
				"默认 **0 = 不自动重派**（避免悄悄烧钱）；调成 1 后失败会带上次的原因重试一次，仍失败就上报给你。",
			kind: "number",
			min: 0,
			max: 2,
			def: DEFAULTS.retry,
			get: () => readCfgKey("retry"),
			set: (v) => setSuperAgentOption({ retry: Math.max(0, Math.min(2, Math.round(Number(v) || 0))) }),
		},
		{
			key: "superagent.router",
			group: SUPERAGENT_GROUP,
			label: "Router 能力",
			desc:
				"**主会话（Router）能用哪些工具** —— 模式开着时生效：\n\n" +
				"- **只读（推荐）**：保留 `delegate` `progress` `read` `grep` `git_read`（只读 git，能验收 diff）；摘掉 `bash` `write` `edit` `apply_patch` `codemode`；" +
				"另外名字里带 ssh / exec / write / delete 这类词的 MCP 工具也一起摘（否则 `mcp__…__ssh_exec` 变相等于 bash）。\n" +
				"  → 能自己看文件核对 Worker 的证据，但改不了任何东西\n" +
				"- **全禁**：只留 `delegate` `progress`（纯调度，验收只能信 Worker 自述）\n" +
				"- **不限制**：不摘工具（等于关闭这套收窄）\n\n" +
				"⚠️ 这**不是安全边界**：它只是让 Router 专心调度。真正拦住越权的是 Worker 侧的权限校验（后续接）。\n" +
				"⚠️ 工具改动只在本会话内存里，pi 重启自动回默认；想立刻恢复用下面那行「临时放开全部工具」。",
			kind: "enum",
			options: ROUTER_OPTIONS,
			values: ROUTER_VALUES,
			def: DEFAULTS.router,
			get: () => routerSession ?? readCfgKey("router"),
			set: (v) => {
				routerSession = undefined; // 面板里改档位 = 回到配置值
				setSuperAgentOption({ router: (ROUTER_VALUES.includes(v as RouterMode) ? v : "readonly") as RouterMode });
			},
		},
		{
			key: "superagent.release",
			group: SUPERAGENT_GROUP,
			label: "临时放开全部工具",
			desc:
				"本会话立刻恢复被摘掉的工具（`bash` `write` `edit` … 全回来），状态栏变成 `不限制`。\n\n" +
				"**只在本会话有效**，重启 pi 后按配置重新生效。\n" +
				"用途：模式开着但你要临时自己跑个命令 / 改个文件，不用去关整个模式。",
			kind: "action",
			def: "",
			get: () => "→ 回车执行",
			set: () => releaseRouterTools(),
		},
		...EXTRA_DEFS,
	];
	try {
		registerSettings(defs);
	} catch {
		/* 注册失败不影响插件其余部分 */
	}
}

export function setupSuperAgent(api: ExtensionAPI): void {
	apiRef = api;
	registerSuperAgentSettings();
	// 新会话 / reload：会话级覆盖复位，工具按配置重新摘，状态栏同步
	api.on("session_start", async () => {
		sessionLayer = "inherit";
		routerSession = undefined;
		toolsSnapshot = undefined;
		applyRouterTools();
		refreshSuperAgentStatus();
	});
	setTimeout(() => {
		refreshSuperAgentStatus();
	}, 0);
}
