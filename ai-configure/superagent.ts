/**
 * superagent.ts —— Super Agent 模式（Router / Worker 双层，参考 DeepSeek Harness 的设计）。
 *
 * 这一层现在负责什么
 * ----------------
 * ① 三层开关（全局 / 本项目 / 本会话）
 * ② **Router 工具档位**：模式开着时摘掉主会话的执行类工具。**默认「只派活」**（只剩
 *    delegate / progress / git_read），另有只读档 / 不限制档。摘工具只是表面功夫，
 *    真正的边界是 `installRouterGuard()` 那个 `tool_call` 钩子（晚注册的 MCP 工具、
 *    codemode 借道、别的扩展重新激活工具，都得过它）。
 * ③ **Worker 回执契约**：给 Worker 的提示词尾部拼一段 `<result>` 格式要求 + 解析它交回来的块
 * ④ 状态栏提示（开着时 footer 显示 `⚡ Super Agent · 项目 · 只读`）
 *
 * 不做什么：不替 Router 决策、不改 Worker 的执行逻辑（那些在 delegate.ts 里）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerSettings, settingsCtx, type SettingDef } from "./settings";
import { cfgParseError, patchExtCfg, readExtCfg } from "./shared";
import { readUiConfig, UI_DEFAULTS, type UiMode } from "./herdr";
import { logEvent } from "./log";

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
	/** Router 能力档位（默认盲派：主会话只做决策，不自己执行） */
	router: "blind" as RouterMode,
};

export type ReportMode = "strict" | "loose" | "off";
export type RouterMode = "readonly" | "blind" | "off";

const REPORT_OPTIONS = ["严格", "宽松", "关"];
const REPORT_VALUES: ReportMode[] = ["strict", "loose", "off"];
const ROUTER_OPTIONS = [
	"只派活（推荐：主会话只做决策，不能自己执行）",
	"只读（可以自己 read/grep，不能写/跑命令）",
	"不限制（就是普通 pi）",
];
const ROUTER_VALUES: RouterMode[] = ["blind", "readonly", "off"]; // 顺序必须对应

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
		const raw = JSON.parse(stripBom(readFileSync(file, "utf8"))) as unknown;
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
				const raw = JSON.parse(stripBom(readFileSync(file, "utf8"))) as unknown;
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
		// ⚠️ 配置读坏了 → **fail-open**：不按默认值（blind = 最严档）收窄。
		//
		// 真机踩过：Windows 记事本 / PowerShell 5.1 保存会让 ai-extensions.json 多一个 BOM，
		// JSON.parse 直接报错 → 整份配置读不到 → router 回落默认 blind →
		// **用户只是改了个设置，插件反而把自己锁成“只能派活”**，而且一句提示都没有。
		// 读不到就别装懂事：不干预（等同 off），让用户至少保有全部工具。
		router: cfgParseError() && !routerSession ? ("off" as RouterMode) : (routerSession ?? readCfgKey("router")),
	};
}

/** 并发上限默认值（同时最多跑几个子助理） */
export const MAX_CONCURRENT_DEFAULT = 8;
/** 并发上限的硬上限：再大就不是「并发」而是把机器/额度打爆 */
export const MAX_CONCURRENT_LIMIT = 16;

/**
 * 同时最多跑几个子助理（`ai-extensions.json` → `superagent.maxConcurrent`）。
 * 默认 8，夹取 1~16；读不到 / 坏值 → 默认值。
 *
 * delegate.ts 的并发信号量就吃这个值（超过就排队）：
 * 每个 tab 最多 4 格，满了自动开下一个 tab，**到本上限才排队**。
 */
export function readMaxConcurrent(): number {
	const raw = readExtCfg().superagent;
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const n = Number(obj.maxConcurrent);
	if (!Number.isFinite(n)) return MAX_CONCURRENT_DEFAULT;
	return Math.min(MAX_CONCURRENT_LIMIT, Math.max(1, Math.round(n)));
}

// ---------------------- 最大轮数（v2.6.0）----------------------

/** 一个 worker 最多跑几轮（= 会话里 assistant 消息条数）。默认 60 */
export const MAX_TURNS_DEFAULT = 60;
export const MAX_TURNS_MIN = 5;
export const MAX_TURNS_MAX = 500;
/**
 * 夹取最大轮数：范围内四舍五入；坏值 / 没写 → 默认 60。
 *
 * 为什么下限是 5：再小就等于「刚开工就被叫停」，任何多步任务都做不完；
 * 上限 500：再大基本等于不设上限，只会把额度烧光。
 */
export function clampMaxTurns(v: unknown): number {
	const n = Number(v);
	if (!Number.isFinite(n)) return MAX_TURNS_DEFAULT;
	return Math.min(MAX_TURNS_MAX, Math.max(MAX_TURNS_MIN, Math.round(n)));
}

/**
 * 生效的最大轮数：**模板 > 全局配置 > 默认 60**（模板 frontmatter `maxTurns` 覆盖全局）。
 *
 * 纯函数（单测直接用），不吃配置。
 */
export function resolveMaxTurns(templateMax?: number, globalMax?: number): number {
	const t = Number(templateMax);
	if (Number.isFinite(t) && t > 0) return clampMaxTurns(t);
	const g = Number(globalMax);
	if (Number.isFinite(g) && g > 0) return clampMaxTurns(g);
	return MAX_TURNS_DEFAULT;
}

/**
 * 全局最大轮数（`ai-extensions.json` → `superagent.maxTurns`）。
 *
 * 优先级：**模板 frontmatter `maxTurns` > 这里 > 默认 60**（`resolveMaxTurns` 里合并）。
 * pi 自己**没有** `--max-turns` / `--max-steps` 之类的参数（`pi --help` 里没有，
 * docs/*.md 也搜不到），所以轮数是本扩展自己数的：worker 的 session jsonl 里
 * `role:"assistant"` 的消息条数。
 */
export function readMaxTurns(): number {
	const raw = readExtCfg().superagent;
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return clampMaxTurns(obj.maxTurns);
}

/** 软着陆比例：轮数用到 80% 就催一次收尾（60 → 48） */
export const TURN_WARN_RATIO = 0.8;

/** 软着陆轮数：`ceil(80% × maxTurns)` —— 60 → 48（纯函数） */
export function turnWarnAt(maxTurns: unknown): number {
	return Math.max(1, Math.ceil(clampMaxTurns(maxTurns) * TURN_WARN_RATIO));
}

/** `turnAction()` 的结论：继续 / 催一次收尾 / 停 */
export type TurnAction = "none" | "warn" | "stop";

/**
 * 这个轮数该做什么（纯函数，单测直接用）。
 *
 * - `"stop"`：到 100% → 停 worker。已产出的正文照样归档，卡片标 `partial`
 * - `"warn"`：首次越过 80% → 发一句「停止探索、立刻交回执」
 *   ⚠️ **只发一次**：调用方必须把 `warned` 记在本次运行里。
 *   每轮都发等于每轮都在打断它，活干不完还白烧 token。
 * - `"none"`：继续跑
 *
 * 为什么到顶是「停」而不是再催一次：连 80% 的提醒都没让它收手，后面每多一轮都是纯浪费。
 */
export function turnAction(turns: unknown, maxTurns: unknown, warned: boolean): TurnAction {
	const max = clampMaxTurns(maxTurns);
	const n = Number(turns);
	const used = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
	if (used >= max) return "stop";
	if (!warned && used >= turnWarnAt(max)) return "warn";
	return "none";
}

// ---------------------- worker 压缩窗口（v2.6.0）----------------------

/** worker 在上下文用到多少百分比时压缩。默认 60（比 pi 的默认更早收） */
export const WORKER_COMPACT_DEFAULT = 60;
export const WORKER_COMPACT_MIN = 30;
export const WORKER_COMPACT_MAX = 95;
/**
 * 夹取压缩百分比。**0 = 不设（用 pi 默认）**，其余夹到 30~95。
 *
 * 为什么 0 是合法值：有些人就是想让 worker 用 pi 的默认阈值（16k 预留）。
 * 为什么下限 30：再早就一直在压缩，等于把上下文全丢掉，活干不完。
 */
export function clampWorkerCompactPercent(v: unknown): number {
	const n = Number(v);
	if (!Number.isFinite(n)) return WORKER_COMPACT_DEFAULT;
	const r = Math.round(n);
	if (r <= 0) return 0; // 显式 0（或负数）= 不设
	return Math.min(WORKER_COMPACT_MAX, Math.max(WORKER_COMPACT_MIN, r));
}

/** 全局压缩百分比（`ai-extensions.json` → `superagent.workerCompactPercent`） */
export function readWorkerCompactPercent(): number {
	const raw = readExtCfg().superagent;
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	if (obj.workerCompactPercent === undefined) return WORKER_COMPACT_DEFAULT;
	return clampWorkerCompactPercent(obj.workerCompactPercent);
}

/** 模式开了没 —— 别的模块统一从这里读 */
export function superagentEnabled(): boolean {
	return readSuperAgent().enabled;
}

/**
 * 批量实时进度（默认**关**）：一次 delegate(tasks) 里，每完成一件就回投一条极短进度卡。
 *
 * 为什么不放进 `UiConfig`：这跟「怎么显示」无关，它决定的是**回投几条消息**
 * （关 = 只等全部完成出 1 张汇总卡）。所以直接读 `superagent.batchLive`。
 */
export function batchLiveEnabled(): boolean {
	const raw = readExtCfg().superagent;
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return obj.batchLive === true;
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

/**
 * 回执约束的文案行（纯函数，便于单测 / 单点维护）。
 *
 * 为什么要有长度约束：回投只带「状态 + 摘要 + 路径」，正文归档不进主会话上下文，
 * 所以 Worker 的 `<result>` 是主会话**唯一**能看到的实质内容 —— 它必须精炼且能直接行动。
 */
export function reportRuleLines(): string[] {
	return [
		"【回执要求】",
		"做完之后，**最后**输出一个回执块，格式严格如下（单独一段，不要放进正文中间）：",
		'<result>{"ok":true,"verdict":"pass","changed":["src/a.ts"],"ran":["npm test → 12 passed"],"blocked":[],"notes":"一句话说明"}</result>',
		"- verdict：pass / partial / fail。**没做完不许写 pass**；有被权限或依赖挡住的事就写进 blocked。",
		"- changed：你改过的文件（相对路径）；一个没改就写 []。",
		"- ran：你真跑过的命令 + 关键输出片段（别编；没跑就 []）。",
		"- notes：一句话说清你做了什么。",
		"- 结论：**最多 3 行**，必须能直接行动（做了什么/结果如何/要不要跟进）。",
		"- 证据：**最多 5 行**，每条一行（命令输出关键行 / 文件:行号 / 数字）。",
		"- **禁止**把大段代码、完整文件内容、长日志贴进回执（那些放进正文，会自动归档）。",
		"- 需要我细看时，在证据里写「详见正文」而不是复制过来。",
	];
}

/** 给 Worker 提示词尾部拼的那段（模式关 / 回执关 → 空串，等于什么都没加） */
export function reportRule(): string {
	const st = readSuperAgent();
	if (!st.enabled || st.report === "off") return "";
	return reportRuleLines().join("\n");
}

// ======================= Router 操作协议（system prompt 段） =======================

/**
 * 给 Router（主会话）的**静态规则**：写进 system prompt 的 `<superagent-router>` 段。
 *
 * ⚠️ 和看板的 `<task-board>` 段同理：段内容必须稳定，pi 会把段的变化当 transcript delta
 *    追加进上下文。所以这里只放永远不变的规则，别塞任何随状态变化的东西。
 */
const ROUTER_PROTOCOL = `【你是 Router】
- 你有 delegate；任何『执行』需求（跑命令 / 改文件 / 提交代码 / 查库）都派 Worker 去做。
- **不要**向用户索要权限、不要请用户代劳。
- 例外（必须停下问人）：① 要改插件源码 / 配置文件 / 助理权限本身 ② 不可逆操作（push、删除、发布）③ 需要人做取舍。
- 派活前先看助理的权限摘要（卡片『权限』那行）：不够就换人，或明确说出『缺哪一条权限』。
- 派活前**先按各助理 desc 挑专才**：数据库 → db，服务器 → server，前端 → frontend，后端 → backend。\`general\` 只用于没有专才对口的杂活。
- **不要把数据库/服务器/前端/后端这类明确领域的活派给 general。**
- 派活**默认 \`wait: false\` 异步派**：派完回一句话说明“已派出什么”，结果完成后会自动回投；**不要用同步等待把主会话卡住**（细则见下方【派活一律异步】）。

【先做依赖分析，再声明计划】
- 声明 progress(plan) 之前，先逐个问：这一步的输入是不是依赖上一步的输出？
- 分类：并行 = 互不依赖；串行 = 后一步要用前一步的结果。只有后者才允许串行。
- 计划表里把可并行的步骤标上「[并行]」，同一批并行的步骤写成同一组。
- 禁止伪串行：只因为步骤编号是 2、3 就串行，是错的。

【并行批次一次派完】
- 同一批互不依赖的活，用一次 delegate(tasks=[...]) 全部派出去，不要逐个等。
- 每批最多 4 个（并发上限 4），超出的排下一批。
- 只有依赖链上的步骤才逐个派：前一步结果出来再派下一步。

【派活一律异步，默认 wait:false】
- 派活**默认异步**（wait:false）：派完立刻回一句「已派出什么」就结束本轮，主会话必须保持可交互。
- **不要自己用同步**（wait:true）：同步会把主会话锁住几十秒，用户在这期间没法说话。
- 只有用户**明确要求**「等它跑完再继续」「跑完告诉我结果我再决定」时，才用 wait:true。
- 结果会自动回投（结论 + 证据）；正文已归档，要正文用 read_result <会话ID>（可带 offset/limit）按需取 —— **不要** resume 重跑，也不要同步 wait。
- 回投卡里已经有结论和证据就先照着说；只有需要原文细节（完整报错、长日志）时才 read_result。`;

// ======================= Router 提示词外部化（A1） =======================

/**
 * 提示词文件放**专用子目录** `<root>/pi-extensions/`：
 *   - 项目级 `<cwd>/.pi/pi-extensions/router.md`
 *   - 用户级 `<agentDir>/pi-extensions/router.md`
 * 不放 `.pi/` 根，是因为那儿会被 pi 当上下文文件（AGENTS.md 之类）扫进去。
 */
const ROUTER_SUBDIR = "pi-extensions";
/** 短于这个长度的替换文件当没写（避免半截文件把 Router 变成哑巴） */
const ROUTER_MIN_CHARS = 200;
/** 注入上限：太长的提示词只会烧 token */
const ROUTER_MAX_BYTES = 12288;
const ROUTER_TRUNC_TAG = "\n…（已截断，超过 12KB）";

/** 生成模板时写在最前面的 3 行注释 */
const ROUTER_TPL_HEADER = [
	"<!-- Super Agent Router 提示词（项目级）。改完下一轮生效，不用 reload。 -->",
	"<!-- 删掉本文件 = 回退到内置/用户级。追加内容请写 router.extra.md。 -->",
	"<!-- 当前内容覆盖的是「内置提示词」，不是追加。 -->",
].join("\n");

export interface RouterPromptInfo {
	text: string;
	/** "项目文件" | "用户文件" | "内置" */
	source: string;
	/** 实际用的替换文件路径（用内置时为空） */
	file?: string;
	/** 追加文件路径（没有为空） */
	extraFile?: string;
	/** 字节数（用于面板/doctor 显示） */
	bytes: number;
	/** 非空 = 有需要注意的情况（例如文件太短被忽略），面板/doctor 显示用 */
	warning?: string;
}

/** 提示词文件的四个位置（项目级优先于用户级） */
function routerPromptPaths(root: string): { base: { file: string; source: string }[]; extra: string[] } {
	const agentDir = getAgentDir();
	return {
		base: [
			{ file: join(root, ".pi", ROUTER_SUBDIR, "router.md"), source: "项目文件" },
			{ file: join(agentDir, ROUTER_SUBDIR, "router.md"), source: "用户文件" },
		],
		extra: [join(root, ".pi", ROUTER_SUBDIR, "router.extra.md"), join(agentDir, ROUTER_SUBDIR, "router.extra.md")],
	};
}

/** 读一个提示词文件：不存在 / 读失败 / trim 后为空 → undefined（等于没这个文件） */
function readPromptFile(file: string): string | undefined {
	try {
		if (!existsSync(file)) return undefined;
		const raw = readFileSync(file, "utf8");
		return raw.trim() ? raw : undefined;
	} catch {
		return undefined;
	}
}

/** 清洗：去 BOM、CRLF → LF、3+ 空行压成 2 个、首尾 trim */
function cleanPromptText(text: string): string {
	return text
		.replace(/^\uFEFF+/, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
}

/** 按 UTF-8 字节截断（不切断多字节字符） */
function truncateUtf8(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let end = maxBytes;
	// 退到字符起始字节：落在续字节（10xxxxxx）上就往前退，最多 3 字节
	while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

/**
 * 解析当前生效的 Router 提示词。
 *
 * 优先级：项目级 router.md → 用户级 router.md → 内置 ROUTER_PROTOCOL；
 * 再把 router.extra.md（项目级 → 用户级）追加在后面。
 * `opts.forceEnabled` 只给单测用（不去读用户真实配置）。
 */
export function resolveRouterPrompt(cwd?: string, opts?: { forceEnabled?: boolean }): RouterPromptInfo {
	const enabled = opts?.forceEnabled ?? superagentEnabled();
	if (!enabled) return { text: "", source: "内置", bytes: 0 };

	const root = cwd || cwdNow();
	const paths = routerPromptPaths(root);

	let base: string | undefined;
	let source = "内置";
	let file: string | undefined;
	let warning: string | undefined;
	for (const c of paths.base) {
		const raw = readPromptFile(c.file);
		if (!raw) continue;
		const text = cleanPromptText(raw);
		if (text.length < ROUTER_MIN_CHARS) {
			warning = "文件太短（<200 字符），已忽略并用内置";
			continue;
		}
		base = text;
		source = c.source;
		file = c.file;
		warning = undefined; // 后面这级用上了，前面被忽略的文件就不再吭声
		break;
	}
	if (base === undefined) base = cleanPromptText(ROUTER_PROTOCOL);

	let extra: string | undefined;
	let extraFile: string | undefined;
	for (const f of paths.extra) {
		const raw = readPromptFile(f);
		if (!raw) continue;
		extra = cleanPromptText(raw);
		if (!extra) continue;
		extraFile = f;
		break;
	}

	let text = cleanPromptText(extra ? `${base}\n\n${extra}` : base);
	if (Buffer.byteLength(text, "utf8") > ROUTER_MAX_BYTES) {
		text = truncateUtf8(text, ROUTER_MAX_BYTES) + ROUTER_TRUNC_TAG;
	}
	return { text, source, file, extraFile, bytes: Buffer.byteLength(text, "utf8"), warning };
}

/** 给 Router 的协议段（模式关 → 空串，等于什么都不加） */
export function routerProtocol(): string {
	return resolveRouterPrompt().text;
}

/** 面板那一行显示的摘要：`项目文件 · 1234 字节 + 追加 ⚠ …` */
export function getRouterPromptLabel(info: RouterPromptInfo = resolveRouterPrompt()): string {
	let s = `${info.source} · ${info.bytes} 字节`;
	if (info.extraFile) s += " + 追加";
	if (info.warning) s += ` ⚠ ${info.warning}`;
	return s;
}

/** 写提示词模板（已存在就**不覆盖**） */
export function writeRouterTemplate(target: string, builtin: string): { ok: boolean; existed: boolean; path: string } {
	try {
		if (existsSync(target)) return { ok: false, existed: true, path: target };
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, `${ROUTER_TPL_HEADER}\n\n${builtin}\n`, "utf8");
		return { ok: true, existed: false, path: target };
	} catch {
		return { ok: false, existed: existsSync(target), path: target };
	}
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
/**
 * 盲派档（默认）：Router 只许这四件事 —— 派活、报进度、验收 diff、按需读回投正文。
 *
 * `git_read` 留着的理由：验收 Worker 的改动要能看 diff，而它只读、改不了任何东西。
 * `read_result` 留着的理由：回投卡只带结论 + 证据，正文在归档里 —— 要看全文就按需取，
 * 不能为了看正文去 `resume` 重跑助理（贵、慢、还可能改坏东西），也不能同步 wait 卡住主会话。
 */
const ROUTER_ALLOW: string[] = ["delegate", "progress", "git_read", "read_result"];
/** 保留旧名（导出：别处还在用 / 单测要断言它没跑偏） */
export const KEEP_BLIND = ROUTER_ALLOW;
/** 只读档明确要保留的（其余按黑名单摘）—— git_read 让我们能验收 Worker 的改动 */
const KEEP_READONLY = ["delegate", "progress", "read", "grep", "git_read"];

/** 盲派档的拒绝文案：一次到位，顺便明令别重试（模型很爱换个工具绕） */
export const ROUTER_DENY_TEXT = [
	"⛔ 主会话是 Router，不亲自执行。",
	"现在是「只派活」档：只能用 delegate / progress / git_read / read_result。",
	"要做事请用 delegate 派 Worker（把「要什么 + 验收标准」写清）。",
	"⛔ 不要重试这个工具，也不要找替代工具绕过 —— 都会被拦。",
].join("\n");

/** 只读档的拒绝文案（同样是「别绕过」口径） */
const ROUTER_DENY_TEXT_READONLY = [
	"⛔ 主会话是 Router，现在是「只读」档：不能写文件、不能跑命令。",
	"只读档能用：delegate / progress / read / grep / git_read。",
	"要做事请用 delegate 派 Worker（把「要什么 + 验收标准」写清）。",
	"⛔ 不要重试这个工具，也不要找替代工具绕过 —— 都会被拦。",
].join("\n");

/**
 * 硬 guard 的判定（**纯函数**，不碰 api / 文件 / 环境变量 —— 这样能单测）。
 *
 * - `off`     ：全放行（等于普通 pi）
 * - `blind`   ：只放行 ROUTER_ALLOW；其它一律 deny —— 内建工具、codemode、
 *               任何 `mcp__*`、以及叫不上名字的新工具，全都算「不是派活」。
 * - `readonly`：deny BLOCKED_READONLY + 名字命中 MCP_DANGER 的 `mcp__*`；其它放行。
 */
export function decideRouterToolCall(tool: string, mode: RouterMode): { allow: boolean; reason?: string } {
	if (mode === "off") return { allow: true };
	const name = String(tool ?? "");
	if (mode === "blind") {
		// 白名单是**正向**的：不在表里的（包括还没见过的新工具、mcp__*）全部拒
		return ROUTER_ALLOW.includes(name) ? { allow: true } : { allow: false, reason: ROUTER_DENY_TEXT };
	}
	if (BLOCKED_READONLY.includes(name)) return { allow: false, reason: ROUTER_DENY_TEXT_READONLY };
	if (name.startsWith("mcp__") && MCP_DANGER.test(name)) return { allow: false, reason: ROUTER_DENY_TEXT_READONLY };
	return { allow: true };
}

/** 本会话对档位的覆盖（「临时放开」用；重启复位） */
let routerSession: RouterMode | undefined;
/** 摘工具前的那一刻快照，用于原样还原 */
let toolsSnapshot: string[] | undefined;
/** 上一次实际生效的档位（用来判断「档位变了」→ 提示一次，别静默改能力） */
let lastAppliedRouter: string | undefined;
/** 工具还没注册完时，最多重试几次（session_start 那一刻经常还没就绪） */
const APPLY_RETRY_DELAYS = [300, 1200];
/** 摘工具用的 api 引用。
 *
 * ⚠️ 名字带 router 前缀是故意的：delegate.ts 里也有个模块级 `apiRef`，
 *    两个同名变量被 esbuild 打包进同一个文件时会被重命名成 `apiRef` / `apiRef2`，
 *    单测往 `apiRef` 里塞假 api 就可能塞到另一个模块上（踩过：后台回投测试莫名就不投了）。
 *    名字错开，两边都叫自己的。 */
let routerApiRef: ExtensionAPI | undefined;
/** guard 钩子只注册一次（theme/session 变化时 setup 可能再跑） */
let guardInstalled = false;

/** 往 `guard.log` 记一行（格式与 guard-entry.ts 一致：ISO 时间 + 空格 + 内容） */
function guardLog(line: string): void {
	try {
		appendFileSync(join(getAgentDir(), "guard.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
	} catch {
		/* 记不上就记不上，不因为这个拦活 */
	}
}

/** 我是不是 Worker 进程（Worker 里 guard 必须放行，否则它自己干不了活） */
function isWorkerProc(): boolean {
	return Boolean((process.env.PI_DELEGATE_PPID ?? "").trim());
}

export function setRouterSession(v: RouterMode | undefined): void {
	const before = roleSnapshot();
	routerSession = v;
	applyRouterTools();
	queueRoleNotice(before);
	refreshSuperAgentStatus();
}

/** 按当前配置摘 / 还原 Router 的工具（幂等，可反复调） */
export function applyRouterTools(): void {
	const api = routerApiRef;
	if (!api?.setActiveTools) return;
	const st = readSuperAgent();
	try {
		if (!st.enabled || st.router === "off") {
			if (toolsSnapshot) {
				api.setActiveTools(toolsSnapshot);
				toolsSnapshot = undefined;
			}
			lastAppliedRouter = undefined;
			return;
		}
		// 只在第一次摘的时候记快照，之后都基于快照算（避免越摘越少）
		// 快照取「所有已配置的工具」而不是「当前激活的」：早期调用时内建工具
		// （bash/read/write/edit/codemode）可能还没注册，拿激活列表当快照会把它们全摘光
		if (!toolsSnapshot) {
			// 配置坏了：一定要说出来（静默才最坑），且不参与收窄
			const cfgErr = cfgParseError();
			if (cfgErr) {
				notifyOnce(
					`⚠️ 配置文件解析失败（${cfgErr.file}）：${cfgErr.err}\n` +
						`已停用 Router 收窄（保持全部工具），请修好配置或删掉文件让它重生。`,
				);
				return;
			}
			const all =
				typeof api.getAllTools === "function"
					? api.getAllTools().map((t) => t.name)
					: ((api.getActiveTools?.() ?? []) as string[]);
			if (all.length < 3) {
				// ⚠️ 工具还没注册完（session_start 那一刻很常见）。
				//    以前这里直接 return → 收窄被推迟到**下一轮** before_agent_start 才生效，
				//    用户看到的就是「开头能跑命令，用着用着突然变只读」，还以为是插件抽风。
				//    现在短延时重试两次，尽快把档位定下来。
				for (const d of APPLY_RETRY_DELAYS) {
					const timer = setTimeout(() => applyRouterTools(), d);
					(timer as unknown as { unref?: () => void }).unref?.();
				}
				return;
			}
			toolsSnapshot = all;
		}
		const base = toolsSnapshot;
		const keep =
			st.router === "blind"
				? base.filter((n) => ROUTER_ALLOW.includes(n))
				: base.filter((n) => !BLOCKED_READONLY.includes(n) && !(n.startsWith("mcp__") && MCP_DANGER.test(n)));
		api.setActiveTools(keep);

		// 档位变了才提示（同一档位反复应用不刷屏）。以前这是**静默**的，
		// 用户在会话中途突然没权限，根本不知道是谁改的。
		if (lastAppliedRouter !== st.router) {
			const first = lastAppliedRouter === undefined;
			lastAppliedRouter = st.router;
			// 主会话工具面变了 → 记一条（用户报过「跑到一半突然不能执行命令」，靠这条定位）
			logEvent("router.apply", { mode: st.router, before: base.length, after: keep.length, first }, "warn");
			const keepText = st.router === "blind" ? "只剩派活/看板/读 git" : "不能写文件、不能跑命令";
			notifyOnce(
				first
					? `主会话已切到「${routerLabel(st.router)}」档：${keepText}。要自己动手改配置就 /ai-ext 里把 Router 设成 off。`
					: `主会话档位已变：${routerLabel(st.router)} —— ${keepText}。`,
			);
		}

		// ---------- fail-safe 自检 ----------
		// 收窄绝不能把 Router 弄成残废（v2.3 真踩过：快照拿早了，bash/read 全没了）。
		// 只校验「本该保留的」：delegate/progress/git_read 必须还在；只读档额外要求 read。
		//
		// ⚠️ 少了东西**绝不原样还原全部工具**：还原 = 把「不自己干活」这个承诺废掉，
		//    而且只剩一条 notify，静悄悄就变全能了。宁可工具少（少到只剩 delegate 也能派活），
		//    也不能变回全能 —— 真漏网的由 installRouterGuard() 兜底拦。
		const required = st.router === "blind" ? ROUTER_ALLOW : KEEP_READONLY;
		const after = (api.getActiveTools?.() ?? []) as string[];
		const missing = required.filter((n) => base.includes(n) && !after.includes(n));
		if (missing.length) {
			guardLog(`ROUTER_NARROW_PARTIAL router=${st.router} missing=${missing.join(",")}`);
			notifyOnce(
				`⚠️ Super Agent 收窄不完整（少了 ${missing.join(", ")}）—— 已保留收窄结果，被漏掉的工具仍会被 guard 拦截`,
			);
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
		routerApiRef?.ui?.notify?.("本会话已恢复全部工具（重启 pi 后按配置重新生效）", "info");
	} catch {
		/* 通知失败无所谓 */
	}
}

/** 当前档位的中文短名（状态栏用） */
function routerLabel(m: RouterMode): string {
	return m === "blind" ? "只派活" : m === "readonly" ? "只读" : "不限制";
}

// ======================= 硬 guard（主会话只能派活） =======================

/**
 * 要不要拦这次 tool_call —— **只有主会话（Router）才拦**。
 *
 * Worker 进程（环境变量里有 `PI_DELEGATE_PPID`）必须放行：它是干活的，拦了就没法干。
 * 这个判断单独抽出来，就是为了能单测（不依赖真跑一个 Worker）。
 */
export function shouldGuardRouter(): boolean {
	if (isWorkerProc()) return false;
	return superagentEnabled();
}

/**
 * 装硬 guard：`tool_call` 钩子，按当前档位拦工具。
 *
 * 为什么光靠 `applyRouterTools()` 摘工具不够（三个漏口）：
 *   1. MCP server 是**异步**连上的：摘完之后 `mcp__…__ssh_exec` 才注册进来，可能自动激活
 *   2. `codemode` 能调任意工具（嵌套调用也会走 tool_call，所以这里能拦住）
 *   3. 别的扩展也可能重新激活工具 —— 摘表是「当时那一刻」的快照，钩子是**每次调用**都判
 *
 * **fail-open**：钩子自己出错就放行（只记 guard.log）。保险丝不该在自身故障时把主会话锁死。
 */
export function installRouterGuard(api: ExtensionAPI): void {
	if (guardInstalled) return; // 幂等：session_start / reload 反复调也只注册一次
	guardInstalled = true;
	try {
		api.on("tool_call", async (event) => {
			try {
				if (!shouldGuardRouter()) return undefined; // 模式关 / Worker 进程 → 不管
				const d = decideRouterToolCall(String(event?.toolName ?? ""), readSuperAgent().router);
				if (d.allow) return undefined;
				guardLog(`ROUTER_DENY ${event?.toolName ?? "?"}`);
				return { block: true, reason: d.reason ?? ROUTER_DENY_TEXT };
			} catch (e) {
				// fail-open：判定自己炸了就放行，别把主会话锁死
				guardLog(`ROUTER_GUARD_ERROR ${e instanceof Error ? e.message : String(e)}`);
				return undefined;
			}
		});
	} catch {
		guardInstalled = false; // 注册没成功：下次 setup 再试
	}
}

// ======================= 状态栏 =======================

export function refreshSuperAgentStatus(): void {
	const ctx = settingsCtx();
	if (!ctx) return;
	try {
		const st = readSuperAgent();
		const cfgErr = cfgParseError();
		if (cfgErr) {
			// 配置坏了必须**写在状态栏上** —— 用户只要一眼就能知道自己改坏了，而不是惑于「行为怎么变了」
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "⚠ 配置解析失败（已停用 Router）"));
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, st.enabled ? `⚡ Super Agent · ${st.decidedBy} · ${routerLabel(st.router)}` : undefined);
	} catch {
		/* 状态栏画不出来不影响功能 */
	}
}

// ======================= 角色变更告知（v2.10.3）=======================

/**
 * 「模式/档位刚变过」→ 下一轮要把这事**明确告诉模型**。
 *
 * 为什么光改 system prompt 段不够：段被删掉只是「不再嘀喧」，模型上下文里
 * 之前那些「你是 Router，不要自己动手」的指令**还在历史里**，它会继续照旧执行。
 * 用户的感受就是「开关了 Super Agent，主会话还按之前的模式跑」。
 *
 * 所以这里学 Claude Code 的 system-reminder：变更发生后往 system prompt 里
 * 插一段**一次性**的覆盖式声明（「之前那套规则作废，现在你是 ……」），下一轮再撤掉。
 */
let pendingRoleNotice: string | undefined;

function roleSnapshot(): { enabled: boolean; router: RouterMode } {
	try {
		const st = readSuperAgent();
		return { enabled: st.enabled, router: st.router };
	} catch {
		return { enabled: false, router: "off" };
	}
}

/** 对比前后，变过就生成一条覆盖式声明 */
export function buildRoleNotice(
	before: { enabled: boolean; router: RouterMode },
	after: { enabled: boolean; router: RouterMode },
): string | undefined {
	if (before.enabled === after.enabled && before.router === after.router) return undefined;
	if (!after.enabled) {
		return (
			"[Super Agent 已关闭] 角色变更，立即生效。\n" +
			"- 之前所有关于「你是 Router、不要自己执行、只能 delegate / progress / git_read / read_result」的规则**全部作废**。\n" +
			"- 你现在拥有完整工具：需要自己读文件、跑命令、改代码就直接做，不必先派助理。\n" +
			"- 已经派出去的 Worker 仍会回投结果，收到就直接用。\n"
		);
	}
	const modeText =
		after.router === "blind"
			? "「只派活」档：只能用 delegate / progress / git_read / read_result"
			: after.router === "readonly"
				? "「只读」档：不能写文件、不能跑命令"
				: "不限制（工具未收窄）";
	return (
		"[Super Agent 已开启] 角色变更，立即生效。\n" +
		`- 你现在是 **Router**，档位 = ${modeText}。\n` +
		"- 不要再自己执行：按助理 desc 挑人，用 delegate 派活；多件互不依赖的用 tasks 一次并行派。\n" +
		"- 该档位下的工具面已经收窄，模型看不到该档位不允许的工具（别去试）。\n"
	);
}

/** 记下「待告知」的角色变更（写操作后调） */
function queueRoleNotice(before: { enabled: boolean; router: RouterMode }): void {
	const note = buildRoleNotice(before, roleSnapshot());
	if (note) {
		pendingRoleNotice = note;
		logEvent("router.role.change", { toEnabled: roleSnapshot().enabled, toRouter: roleSnapshot().router }, "warn");
	}
}

// ======================= 写 =======================

export function setSuperAgentEnabled(v: boolean): void {
	const before = roleSnapshot();
	patchExtCfg({ superagent: { ...(readExtCfg().superagent as object), enabled: v } });
	applyRouterTools();
	queueRoleNotice(before);
	refreshSuperAgentStatus();
}

export function setSuperAgentProject(v: Layer): void {
	const before = roleSnapshot();
	writeProjectLayer(cwdNow(), v);
	applyRouterTools();
	queueRoleNotice(before);
	refreshSuperAgentStatus();
}

export function setSuperAgentSession(v: Layer): void {
	const before = roleSnapshot();
	sessionLayer = v;
	applyRouterTools();
	queueRoleNotice(before);
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

// ---------- UI 模式（Herdr 分屏）----------
// 值存在 `ai-extensions.json` 的 `superagent` 块下：
//   ui / mainSlots / overflowSlots / splitRatio / paneKeepOnError
const UI_OPTIONS = [
	"panel",
	"split",
	"tab",
	"auto（默认：有 Herdr 就分屏）",
];
const UI_VALUES: UiMode[] = ["panel", "split", "tab", "auto"];

/** 改 superagent 块里的键（合并写回，不动别的） */
function patchSuperAgent(patch: Record<string, unknown>): void {
	const cur = readExtCfg().superagent;
	const blk = cur && typeof cur === "object" ? (cur as Record<string, unknown>) : {};
	patchExtCfg({ superagent: { ...blk, ...patch } });
}

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
				"- **只派活（推荐，默认）**：只留 `delegate` `progress` `git_read` `read_result`（派活、报进度、验收 diff、读回投正文）。" +
				"`read` `grep` `bash` `write` `edit` `apply_patch` `codemode` 以及所有 `mcp__*` 全摘；" +
				"就算有晚注册 / 被重新激活的漏网工具，`tool_call` 钩子也会当场拦下。\n" +
				"  → 主会话只做决策，真正干活必须派 Worker\n" +
				"- **只读**：保留 `delegate` `progress` `read` `grep` `git_read`；摘掉 `bash` `write` `edit` `apply_patch` `codemode`；" +
				"另外名字里带 ssh / exec / write / delete 这类词的 MCP 工具也一起摘（否则 `mcp__…__ssh_exec` 变相等于 bash）。\n" +
				"  → 能自己看文件核对 Worker 的证据，但改不了任何东西\n" +
				"- **不限制**：不摘工具也不拦（等于关闭这套收窄）\n\n" +
				"默认只派活；`/router` 可临时切换（本会话有效）。\n" +
				"⚠️ 摘工具只是表面功夫，真正的边界是 `tool_call` 硬 guard（fail-open：守卫自己出错就放行）。",
			kind: "enum",
			options: ROUTER_OPTIONS,
			values: ROUTER_VALUES,
			def: DEFAULTS.router,
			get: () => routerSession ?? readCfgKey("router"),
			set: (v) => {
				routerSession = undefined; // 面板里改档位 = 回到配置值
				setSuperAgentOption({ router: (ROUTER_VALUES.includes(v as RouterMode) ? v : DEFAULTS.router) as RouterMode });
			},
		},
		{
			key: "superagent.ui",
			group: SUPERAGENT_GROUP,
			label: "UI 模式",
			desc:
				"子助理到底怎么显示出活的过程：\n\n" +
				"- **panel**：只在面板里显示卡片（哪里都能用）\n" +
				"- **split**：Herdr 左主右子分屏 —— 主会话在左，右边竖切两格放子助理\n" +
				"- **tab**：每个子助理一个 Herdr 标签\n" +
				"- **auto**：≤2 个用 split，更多溢出到一个「sa:extra」标签里（2×2 四宫格），非 Herdr 自动降级 panel\n\n" +
				"默认 auto：有 Herdr 就分屏，没有就退回面板卡片。\n" +
				"Super Agent 全局关掉时也会强制回到 panel。\n\n" +
				"全部 pane/tab 都**见名知意**：pane = `<状态> <助理名>#<序号> · <任务摘要>`，tab = `sa:<n> · <助理名列表>`。" +
				"跑成功自动收起，失败保留（用 /pane-close 关闭，或等 10 分钟自动回收）。",
			kind: "enum",
			options: UI_OPTIONS,
			values: UI_VALUES,
			def: UI_DEFAULTS.ui,
			get: () => readUiConfig().ui,
			set: (v) => {
				// 面板里长标签可能被截断/去掉说明（"auto（默认…）" / "auto = …"），先精确匹配再按前缀兑
				const raw = String(v ?? "");
				const head = raw.split(/[ =（(]/)[0].trim();
				const hit = UI_VALUES.find((x) => x === raw) ?? UI_VALUES.find((x) => x === head);
				patchSuperAgent({ ui: hit ?? UI_DEFAULTS.ui });
			},
		},
		{
			key: "superagent.mainSlots",
			group: SUPERAGENT_GROUP,
			label: "主窗口格数（0 = 不占主窗口，推荐）",
			desc:
				"主窗口右侧竖切几格给子助理：\n\n" +
				"- **0（默认，推荐）**：**不占主窗口** —— 子助理全进独立 tab（每个 tab 最多 4 格 2×2，满了自动开下一个）\n" +
				"- **1**：主窗口右侧竖切 1 格，多出来的进 tab（旧行为）\n" +
				"- **2**：主窗口右侧竖切 2 格，多出来的进 tab（旧行为）\n\n" +
				"0 的好处：对话区一点不被挤小；子助理在 tab 里一样能看全过程。",
			kind: "number",
			min: 0,
			max: 2,
			def: UI_DEFAULTS.mainSlots,
			get: () => readUiConfig().mainSlots,
			set: (v) => patchSuperAgent({ mainSlots: Math.max(0, Math.min(2, Math.round(Number(v) || 0))) }),
		},
		{
			key: "superagent.maxConcurrent",
			group: SUPERAGENT_GROUP,
			label: "最大并发",
			desc:
				"同时最多跑几个子助理（默认 8）。每个 tab 最多 4 格（2×2），超过就自动开下一个 tab；" +
				"到达本上限才排队。",
			kind: "number",
			min: 1,
			max: 16,
			def: MAX_CONCURRENT_DEFAULT,
			get: () => readMaxConcurrent(),
			set: (v) =>
				patchSuperAgent({
					maxConcurrent: Math.min(MAX_CONCURRENT_LIMIT, Math.max(1, Math.round(Number(v) || MAX_CONCURRENT_DEFAULT))),
				}),
		},
		{
			key: "superagent.maxTurns",
			group: SUPERAGENT_GROUP,
			label: "最大轮数",
			desc:
				"一个子助理最多跑几轮（= 它会话里 assistant 消息的条数），默认 **60**，范围 5~500。\n\n" +
				"**软着陆**：到 80%（默认 48 轮）给它发一句「停止探索、立刻交回执」；" +
				"到 100% 直接停掉 worker，已产出的正文照样归档，卡片标 `⚠ 达到轮数上限（partial）`。\n\n" +
				"单个助理可以在模板 frontmatter 里写 `maxTurns: 100` 覆盖这里（模板 > 这里 > 默认 60）。\n\n" +
				"为什么需要它：轮数失控的 worker 会一直「再查一点」，把额度烧在探索上却不交结论。",
			kind: "number",
			min: MAX_TURNS_MIN,
			max: MAX_TURNS_MAX,
			def: MAX_TURNS_DEFAULT,
			get: () => readMaxTurns(),
			set: (v) => patchSuperAgent({ maxTurns: clampMaxTurns(v) }),
		},
		{
			key: "superagent.workerCompactPercent",
			group: SUPERAGENT_GROUP,
			label: "Worker 压缩窗口（%）",
			desc:
				"子助理的上下文用到 **多少百分比** 时自动压缩，默认 **60**（比 pi 的默认更早收），范围 30~95；" +
				"**0 = 不设**（用 pi 自己的默认阈值）。\n\n" +
				"落地方式：pi 只支持绝对 token 阈值（`compaction.reserveTokens`），所以派活时按" +
				"「100% − 本值」× 当前模型窗口 换算后写进**影子目录的 settings.json**（worker 用 " +
				"`PI_CODING_AGENT_DIR=<影子>` 跑，只影响子助理，不动你自己的会话）。\n\n" +
				"拿不到模型窗口时不会瞎写：跳过并在影子目录警告里说明。",
			kind: "number",
			min: 0,
			max: WORKER_COMPACT_MAX,
			def: WORKER_COMPACT_DEFAULT,
			get: () => readWorkerCompactPercent(),
			set: (v) => patchSuperAgent({ workerCompactPercent: clampWorkerCompactPercent(v) }),
		},
		{
			key: "superagent.overflowSlots",
			group: SUPERAGENT_GROUP,
			label: "溢出标签格数",
			desc: "`sa:extra` 标签里最多放几个子助理（默认 4 = 2×2 四宫格，上限 4）。满了会自动再开下一个 tab。",
			kind: "number",
			min: 0,
			max: 4,
			def: UI_DEFAULTS.overflowSlots,
			get: () => readUiConfig().overflowSlots,
			set: (v) => patchSuperAgent({ overflowSlots: Math.max(0, Math.min(4, Math.round(Number(v) || 0))) }),
		},
		{
			key: "superagent.splitRatio",
			group: SUPERAGENT_GROUP,
			label: "主会话占比",
			desc:
				"切第一刀时**主会话保留的比例**（默认 0.6 = 主会话留 60%，子助理占右边 40%）。\n" +
				"范围 0.05 ~ 0.95。改完下一次派活生效（已经切好的 pane 不会重排）。",
			kind: "number",
			min: 0.05,
			max: 0.95,
			def: UI_DEFAULTS.splitRatio,
			get: () => readUiConfig().splitRatio,
			set: (v) => {
				const n = Number(v);
				patchSuperAgent({ splitRatio: Number.isFinite(n) ? Math.min(0.95, Math.max(0.05, n)) : UI_DEFAULTS.splitRatio });
			},
		},
		{
			key: "superagent.paneKeepOnError",
			group: SUPERAGENT_GROUP,
			label: "失败保留 pane",
			desc:
				"子助理失败/超时时**不自动关它的 pane**（默认开）。\n\n" +
				"留着你能切过去看它到底卡在哪；关掉就是失败也立刻收起。成功的 pane 无论如何都会自动收起。",
			kind: "bool",
			def: UI_DEFAULTS.paneKeepOnError,
			get: () => readUiConfig().paneKeepOnError,
			set: (v) => patchSuperAgent({ paneKeepOnError: v === true || v === "true" }),
		},
		{
			key: "superagent.batchLive",
			group: SUPERAGENT_GROUP,
			label: "批量实时进度",
			desc:
				"派多个任务时，每完成一件就回投一条极短进度（更实时，但消息更多）。\n" +
				"默认关：只等全部完成出 1 张汇总卡。",
			kind: "bool",
			def: false,
			get: () => batchLiveEnabled(),
			set: (v) => patchSuperAgent({ batchLive: v === true || v === "true" }),
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
		{
			key: "superagent.routerPrompt",
			group: SUPERAGENT_GROUP,
			label: "Router 提示词",
			desc:
				"主会话（Router）那段系统提示词从哪来。**可用文件替换/追加**（优先项目级）：\n\n" +
				"```\n" +
				"<cwd>/.pi/pi-extensions/router.md         ← 替换（项目级）\n" +
				"<agentDir>/pi-extensions/router.md        ← 替换（用户级）\n" +
				"<cwd>/.pi/pi-extensions/router.extra.md   ← 追加（项目级）\n" +
				"<agentDir>/pi-extensions/router.extra.md  ← 追加（用户级）\n" +
				"```\n\n" +
				"都没文件 = 用内置。**改完下一轮生效，不用 reload**。\n" +
				"文件 `<200` 字符会被忽略（避免半截文件把 Router 变哑巴）；\n" +
				"拼起来超过 12KB 会截断。\n\n" +
				"回车 = 打印当前实际在用的文件路径 + 字节数。",
			kind: "action",
			def: "",
			// 值列/行尾是**动态**的：每次面板重建都重算（改了文件再开面板就能看到）
			get hint() {
				return getRouterPromptLabel();
			},
			get: () => getRouterPromptLabel(),
			set: () => {
				const info = resolveRouterPrompt();
				const lines = [
					`Router 提示词：${info.source} · ${info.bytes} 字节`,
					`替换文件：${info.file ?? "（无，用内置）"}`,
					`追加文件：${info.extraFile ?? "（无）"}`,
				];
				if (info.warning) lines.push(`⚠ ${info.warning}`);
				settingsCtx()?.ui?.notify?.(lines.join("\n"), info.warning ? "warning" : "info");
			},
		},
		{
			key: "superagent.routerTplProject",
			group: SUPERAGENT_GROUP,
			label: "生成项目级提示词模板",
			desc:
				"把**当前内置提示词**原文写到：\n\n" +
				"```\n<cwd>/.pi/pi-extensions/router.md\n```\n\n" +
				"写出来就能直接改；删掉这个文件 = 回退到内置/用户级。\n" +
				"想**追加**（不覆盖内置）就写同目录的 `router.extra.md`。\n\n" +
				"文件已存在就**不覆盖**（只会提示路径）。",
			kind: "action",
			def: "",
			get: () => "→ 写到项目 `.pi/pi-extensions/router.md`",
			set: () => {
				const target = join(cwdNow(), ".pi", ROUTER_SUBDIR, "router.md");
				const r = writeRouterTemplate(target, ROUTER_PROTOCOL);
				settingsCtx()?.ui?.notify?.(
					r.ok ? `已生成模板：${r.path}\n改完下一轮生效` : `已存在，未覆盖：${r.path}`,
					r.ok ? "info" : "warning",
				);
			},
		},
		{
			key: "superagent.routerTplUser",
			group: SUPERAGENT_GROUP,
			label: "生成用户级提示词模板",
			desc:
				"把**当前内置提示词**原文写到：\n\n" +
				"```\n<agentDir>/pi-extensions/router.md\n```\n\n" +
				"用户级 = 所有项目都生效（项目级会盖它）。删掉 = 回退到内置。\n" +
				"想**追加**就写同目录的 `router.extra.md`。\n\n" +
				"文件已存在就**不覆盖**（只会提示路径）。",
			kind: "action",
			def: "",
			get: () => "→ 写到用户级 `pi-extensions/router.md`",
			set: () => {
				const target = join(getAgentDir(), ROUTER_SUBDIR, "router.md");
				const r = writeRouterTemplate(target, ROUTER_PROTOCOL);
				settingsCtx()?.ui?.notify?.(
					r.ok ? `已生成模板：${r.path}\n改完下一轮生效` : `已存在，未覆盖：${r.path}`,
					r.ok ? "info" : "warning",
				);
			},
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
	routerApiRef = api;
	registerSuperAgentSettings();
	// 硬 guard：主会话的 tool_call 一律先过这道坎（幂等，装一次就够）
	installRouterGuard(api);
	// 新会话 / reload：会话级覆盖复位，工具按配置重新摘，状态栏同步
	api.on("session_start", async () => {
		sessionLayer = "inherit";
		routerSession = undefined;
		toolsSnapshot = undefined;
		applyRouterTools();
		refreshSuperAgentStatus();
	});
	// ---------- 提示词注入：只有模式开着才写 <superagent-router> 段 ----------
	api.on("before_agent_start", async (event) => {
		// ⚠️ 每次 agent 启动都**重放摘除**：MCP server 是异步连上的，
		//    session_start 那次摘完以后 `mcp__*` 才注册进来并自动激活 —— 摘一次不够。
		//    applyRouterTools() 是幂等的，重放只是把激活列表再按档位压一遍。
		applyRouterTools();
		const rules = routerProtocol();
		if (rules) {
			if (event.systemPromptOptions.sections["superagent-router"] !== rules) {
				event.systemPromptOptions.sections["superagent-router"] = rules;
			}
		} else if (event.systemPromptOptions.sections["superagent-router"]) {
			// 模式在本会话里被关掉：把段摘掉，别留旧规则误导模型
			delete event.systemPromptOptions.sections["superagent-router"];
		}
		// 模式/档位刚变过 → 插一段**一次性**的覆盖式声明。
		// 光把旧段删掉不够：模型历史里那些「你是 Router，不要自己动手」还生效，
		// 不明确说「作废」它会继续照旧执行（用户感受就是「开关了还按旧模式跑」）。
		const secs = event.systemPromptOptions.sections;
		if (pendingRoleNotice) {
			secs["superagent-role-change"] = pendingRoleNotice;
			pendingRoleNotice = undefined;
		} else if (secs["superagent-role-change"]) {
			delete secs["superagent-role-change"]; // 只插一轮，避免长期占 token
		}
	});
	setTimeout(() => {
		refreshSuperAgentStatus();
	}, 0);
}