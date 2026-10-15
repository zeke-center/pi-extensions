/**
 * 任务进度看板 + 会话信息栏 (Task Board / Session Panel)
 *
 * 一个 pi 扩展：在编辑器上方常驻一个"左大右小"的双栏面板。
 *   左栏：任务进度（AI 通过 progress 工具打点；自动跟踪当前动作）
 *   中栏：运行状态（现在 / 本轮 / 会话；够宽才出现）
 *   右区：MCP / 插件 / 助理 **各自一栏**（窄屏自动叠回一栏）
 *
 * 命令:
 *   /board                 显示/隐藏整个面板
 *   /board on|off          显式开关
 *   /board clear           清空任务
 *   /board above|below     面板位置（输入框上方 / 下方）
 *   /board right           显示/隐藏右区（MCP / 插件 / 助理）
 *
 * 注意: pi 的 widget 只支持 above/below 两个位置，"左右分栏"是本组件自己画出来的。
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { loadTemplates, runningBgCount, undeliveredBgCount } from "./delegate";
import { onGateApply } from "./gate";
import { cardNotify } from "./notify";
import { registerSettings } from "./settings";
import { closePlanAsk, getPlanCfg, isBackgroundTurn, openPlanAsk } from "./shared";

const WIDGET_KEY = "task-board";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_VISIBLE_STEPS = 8;
const RIGHT_WIDTH = 26; // 右区（MCP/插件/助理）每栏宽度上限
const RIGHT_MIN = 9; // 右区每栏宽度下限（再窄就没法看了）
const LEFT_MIN = 28; // 左栏（任务进度）保底宽度
const MID_WIDTH = 30;
const MID_MIN_COLS = 116; // 面板总宽 ≥ 此值才显示中栏（运行状态）
const NARROW_COLS = 88; // 总宽 < 此值：右区三栏退回「三段叠一栏」
const MAX_LISTED = 6;

/**
 * 看板给模型的**静态规则**：写进 system prompt 的 `<task-board>` 段（只吃一次上下文）。
 * 动态状态（当前面板是什么）走 before_agent_start 返回的消息，见下面 handler。
 *
 * ⚠️ 改这里 = 改 system prompt 的段，pi 会作为 transcript delta 追加；
 *    所以只准放「永远不变」的规则，别放任何随状态变化的内容。
 */
const BOARD_RULES = `用户有一个常驻在输入框上方的进度看板（左栏任务进度，右侧几栏会话信息）。

【给计划：必须两步走，不能只弹窗】
1. **先在对话里给详细计划表**（Markdown 表格：# / 步骤 / 具体做什么 / 改哪个文件）。
   「具体做什么」要写到能看出你要动什么（改哪个函数、加哪个接口、换哪个配置），
   不是把步骤名换个说法重复一遍。后面补上「为什么这么做」「用户会看到什么变化」「哪里要拍板」。
2. **然后再调 progress(action="plan")**，只放 <=20 字的简短步骤（面板很窄）。
   弹窗确认用的就是这些短句。详细内容不要塞这里。

【执行过程】
- ⚠️ 每一步都要真的调 progress(action="step")：开始 status="doing"，完成 status="done"。
  不调的话面板会一直停在第一步，用户就看不到进度了。
- 每开始一步 / 遇到卡点，都要**同时在对话里说一句现在干什么**，别只改面板不说话。
- 卡点：progress(action="block", text="...") + 对话里解释。
- 全部完成：progress(action="clear")。

【❌ 不要执行过时计划（很重要）】
- 每轮消息里「当前面板」那一行是**真实状态**，以它为准。不要凭对话历史里的旧计划行事。
- 面板上的计划如果和用户最新的话对不上、或用户说了“算了/先不管/换个事” → **先调 progress(action="clear")**，再按用户最新要求来。
- **面板为空时，不要去“补做”以前讨论过但没确认的任务。**
- 用户否掉方案（“我要改”/“先别做”）时，面板会自动还原到声明前的状态；不要把它当成“计划还在进行中”。`;

type StepStatus = "pending" | "doing" | "done" | "blocked";
type Placement = "aboveEditor" | "belowEditor";

interface Step {
	text: string;
	status: StepStatus;
}

type McpLevel = "session" | "project" | "global";

export interface McpEntry {
	name: string;
	connected: boolean;
	/** session=扩展注册（/ai 拉进来的） · project=项目 .pi/mcp.json · global=用户级 mcp.json */
	level: McpLevel;
}

// ======================= 状态 =======================
let pi: ExtensionAPI;

let title = "";
let steps: Step[] = [];
let blocker: string | undefined;
let activity: string | undefined;

// 过时计划检测：记录“最近一次 progress() 调用发生在第几轮”
let turnNo = 0;
let lastProgressTurn = 0;

// 中栏「运行」统计 —— ⚠️ 一轮 = 一问一答（agent_start → agent_settled），
// 不是模型请求（turn）。实测 pi 的 turn_start 是「每次模型请求」。
let running = false; // 我是否正在跑（决定「现在」行显示什么、计时走不走）
let runStart = 0; // 本轮起点（agent_start）
let runFrozenMs = 0; // 本轮已定格时长（跑完后不再增长）
let pausedTotal = 0; // 本轮累计「等你点弹窗」的时长（要扣掉）
let pauseStart = 0; // 当前暂停起点（0 = 未暂停）
let activeTotalMs = 0; // 会话累计活跃时长（只算真正在跑的）
let runCount = 0; // 会话轮数（一问一答次数）
let runTokIn = 0; // 本轮输入 token 累计
let runTokOut = 0; // 本轮输出 token 累计
let runTokCache = 0; // 本轮缓存命中 token 累计
let activityStart = 0; // 当前动作开始时间
let sessionStart = 0; // 本 pi 会话开始时间（挂钟）

// LLM 生成速度（TPS）
let genStart = 0; // 本次生成起点（0 = 未在生成）
let genChars = 0; // 本次生成累计收到的字符数
let lastTps = 0; // 最近一次测得的 TPS（生成结束后定格）
let charsPerToken = 2.0; // 字符→token 比值（中文约 2；首次响应后自动校准）

// 会话累计 token（与 pi footer 同源：遍历 session entries，缓存避免每 300ms 重算）
let sessTok = { input: 0, output: 0, cacheRead: 0 };

// 子代理用量 —— delegate 的返回值【不含用量】，子代理的消耗记在它自己的会话文件里，
// 主会话 footer / getSessionStats 都看不到。想算全局账只能自己扫 assistant-sessions/。
interface TokAgg {
	sessions: number;
	input: number;
	output: number;
	cacheRead: number;
}
let subTok: TokAgg = { sessions: 0, input: 0, output: 0, cacheRead: 0 };
let subDetail: Array<TokAgg & { name: string }> = [];

let showWidget = true;
let showRight = true;
let showMid = true;
let placement: Placement = "aboveEditor";

let spinnerIdx = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let tickCount = 0;

let lastCtx: ExtensionContext | undefined;
let widgetTui: { requestRender(): void } | undefined;
let mounted = false;
/** 停用态（由 gate 的 applyBoardGate 设置）。
 *  用模块内局部变量而不是每次都问 gate：一是本模块有十几处判定，二是单测能直接驱动它（可回归）。 */
let boardOff = false;/** 供 gate（和单测）设置停用态 */
export function setBoardOff(off: boolean): void {
	boardOff = off;
}
/** 停用态是否已经「真的撤过一次」 widget（避免每次事件都重复 setWidget） */
let gateCleared = false;

/**
 * 「自上次 progress() 以来跑了几次工具调用」——用来治一个真坑：
 * 一个多步任务常常在**同一次用户输入**里就跑完了（一整轮 = 一个 turn），
 * 而原来的过时判定只数 turn（`turnNo - lastProgressTurn`）→ 轮内永远不报警，
 * 于是模型从头做到底一次也不更新看板，面板一直停在 0/N（实测踩过）。
 * 所以再加一个**轮内**计数：工具调用数。
 */
let toolCallsSinceProgress = 0;
/** 上次 progress() 更新的挂钟时刻（轮内也能看出“太久没动了”） */
let lastProgressAt = Date.now();
/** 每这么多次工具调用提醒一次（不是每次都呼） */
const NAG_EVERY_CALLS = 8;

function resetProgressWatch(): void {
	toolCallsSinceProgress = 0;
	lastProgressAt = Date.now();
}

/** 给模型的一句提醒（很短，能看懂就行） */
function progressNag(): string {
	const doneN = steps.filter((s) => s.status === "done").length;
	const doingIdx = steps.findIndex((s) => s.status === "doing");
	const where =
		steps.length === 0
			? "当前没有计划"
			: `计划「${title || "(无标题)"}」${doneN}/${steps.length} 步` +
				(doingIdx >= 0 ? `，卡在第 ${doingIdx + 1} 步「${steps[doingIdx]!.text}」` : "");
	const mins = Math.floor((Date.now() - lastProgressAt) / 60000);
	return (
		`\n\n⚠ 看板提醒：这轮已经 ${toolCallsSinceProgress} 次工具调用没调 progress()` +
		(mins >= 2 ? `（距上次更新 ${mins} 分钟）` : "") +
		` —— ${where}。` +
		`\n做完一步就 progress(action="step", index=N, status="done")，再开下一步 status="doing"；` +
		`全部完成就 progress(action="clear")。别等到最后批量补。`
	);
}

let cachedMcp: McpEntry[] = [];
let cachedPlugins: string[] = [];
/** 「助理」栏：能派的名字 + 不能派的个数 */
let cachedAssistants: { usable: string[]; blocked: number } = { usable: [], blocked: 0 };

// ======================= 小工具 =======================
/** 时长格式化：8s / 3m05s / 1h23m */
function fmtDur(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** token 数量格式化：1234 → 1.2k，8000 → 8k（最多 4 字符，保证中栏不溢出） */
function fmtTok(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	const trim = (s: string) => s.replace(/\.0$/, "");
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k < 10 ? trim(k.toFixed(1)) : Math.round(k)}k`;
	}
	if (n < 1_000_000_000) {
		const m = n / 1_000_000;
		return `${m < 10 ? trim(m.toFixed(1)) : Math.round(m)}M`;
	}
	const g = n / 1_000_000_000;
	return `${g < 10 ? trim(g.toFixed(1)) : Math.round(g)}G`;
}

/** 从一条 assistant 消息里量出「已生成的文本长度」（用于实时估 TPS） */
function assistantTextLen(msg: unknown): number {
	const content = (msg as { content?: unknown })?.content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const part of content) {
		const p = part as { type?: string; text?: string; thinking?: string };
		if (p?.type === "text" && typeof p.text === "string") n += p.text.length;
		else if (p?.type === "thinking" && typeof p.thinking === "string") n += p.thinking.length;
	}
	return n;
}

/** 本轮是否已入账（防止 agent_end 与 agent_settled 重复累加活跃时长） */
let runAccounted = false;

/** 停表 + 定格 + 入账（幂等，重复调用不会重复累加） */
function settleRun(): void {
	if (running) {
		running = false;
		runFrozenMs = Date.now() - runStart - pausedTotal;
	}
	if (!runAccounted && runFrozenMs > 0) {
		activeTotalMs += runFrozenMs;
		runAccounted = true;
	}
}

/** 本轮耗时：跑完就拿冻结值，不再增长 */
function turnMs(): number {
	return running ? Date.now() - runStart - pausedTotal : runFrozenMs;
}

/** 会话活跃时长（含正在跑的那一段） */
function sessionActiveMs(): number {
	return activeTotalMs + (running ? Date.now() - runStart - pausedTotal : 0);
}

/** 把一份 usage 累加进汇总（字段可能缺失） */
function addUsageInto(
	into: { input: number; output: number; cacheRead: number },
	usage: { input?: number; output?: number; cacheRead?: number } | undefined,
): void {
	if (!usage) return;
	into.input += usage.input ?? 0;
	into.output += usage.output ?? 0;
	into.cacheRead += usage.cacheRead ?? 0;
}

/** 会话累计 token —— 与 pi footer 用同一套口径（含压缩/工具摘要用量） */
function recomputeSessTok(ctx: ExtensionContext): void {
	const totals = { input: 0, output: 0, cacheRead: 0 };
	try {
		const entries = ctx.sessionManager.getEntries() as Array<{
			type?: string;
			usage?: { input?: number; output?: number; cacheRead?: number };
			message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } };
		}>;
		for (const e of entries) {
			if (e.type === "usage") addUsageInto(totals, e.usage);
			else if (e.type === "message" && e.message?.role === "assistant") addUsageInto(totals, e.message.usage);
			else if (e.type === "message" && e.message?.role === "toolResult") addUsageInto(totals, e.message.usage);
			else if (e.type === "branch_summary" || e.type === "compaction") addUsageInto(totals, e.usage);
		}
	} catch {
		/* 读不到就保留旧值 */
	}
	sessTok = totals;
}

/** 每个子会话文件的上次结果（按 mtime+size 缓存：未改动的文件不重读） */
const subFileCache = new Map<string, TokAgg & { mtimeMs: number; size: number }>();
const USAGE_RE = /"usage":\s*\{"input":(\d+),\s*"output":(\d+),\s*"cacheRead":(\d+)/g;

/** 扫描 ~/.pi/agent/assistant-sessions/<助理>/*.jsonl 里的 usage，汇总到 subTok / subDetail */
function recomputeSubTok(): void {
	const root = join(getAgentDir(), "assistant-sessions");
	const detail: Array<TokAgg & { name: string }> = [];
	const total: TokAgg = { sessions: 0, input: 0, output: 0, cacheRead: 0 };

	try {
		if (!existsSync(root)) {
			subTok = total;
			subDetail = detail;
			return;
		}
		for (const dir of readdirSync(root, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const dpath = join(root, dir.name);
			const agg: TokAgg & { name: string } = { name: dir.name, sessions: 0, input: 0, output: 0, cacheRead: 0 };
			let files: string[] = [];
			try {
				files = readdirSync(dpath);
			} catch {
				continue;
			}
			for (const f of files) {
				if (!f.endsWith(".jsonl")) continue;
				const fp = join(dpath, f);
				let mtimeMs = 0;
				let size = 0;
				try {
					const st = statSync(fp);
					mtimeMs = st.mtimeMs;
					size = st.size;
				} catch {
					continue;
				}
				agg.sessions++;
				let hit = subFileCache.get(fp);
				if (!hit || hit.mtimeMs !== mtimeMs || hit.size !== size) {
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					try {
						const text = readFileSync(fp, "utf8");
						USAGE_RE.lastIndex = 0;
						let m: RegExpExecArray | null;
						while ((m = USAGE_RE.exec(text)) !== null) {
							input += Number(m[1]);
							output += Number(m[2]);
							cacheRead += Number(m[3]);
						}
					} catch {
						/* 读不了当 0 */
					}
					hit = { mtimeMs, size, sessions: 0, input, output, cacheRead };
					subFileCache.set(fp, hit);
				}
				agg.input += hit.input;
				agg.output += hit.output;
				agg.cacheRead += hit.cacheRead;
			}
			if (agg.sessions > 0) {
				detail.push(agg);
				total.sessions += agg.sessions;
				total.input += agg.input;
				total.output += agg.output;
				total.cacheRead += agg.cacheRead;
			}
		}
	} catch {
		/* 整块失败就保留旧值 */
	}

	detail.sort((a, b) => b.input + b.output - (a.input + a.output));
	subTok = total;
	subDetail = detail;
}

/** 中栏：运行状态（动态过程）—— 底部状态栏已经有的东西这里不放 */
function midLines(theme: Theme): string[] {
	const t = theme;
	const out: string[] = [];

	// 标题行：⚙ 运行 · N 轮（轮 = 一问一答）
	out.push(` ${t.fg("accent", t.bold("⚙ 运行"))}${runCount ? t.fg("muted", ` · ${runCount} 轮`) : ""}`);

	// ── 现在 ──
	let now: string;
	let tone: "text" | "dim" | "accent" = "dim";
	if (activity) {
		now = `${activity} · ${fmtDur(Date.now() - activityStart)}`;
		tone = "text";
	} else if (genStart) {
		const sec = (Date.now() - genStart) / 1000;
		const tps = sec > 0.4 && genChars > 0 ? Math.max(1, Math.round(genChars / charsPerToken / sec)) : lastTps;
		now = `生成中 · ${tps}t/s`;
		tone = "accent";
	} else if (running) {
		now = "思考中…";
		tone = "text";
	} else {
		now = "待命";
	}
	out.push(` ${t.fg("muted", "现在")} ${t.fg(tone, shortText(now, MID_WIDTH - 6))}`);

	// ── 本轮（跑完定格；token 按 输入/输出/缓存 三类上色）──
	const hasRun = running || runFrozenMs > 0 || runTokIn > 0 || runTokOut > 0 || runTokCache > 0;
	if (!hasRun) {
		out.push(` ${t.fg("muted", "本轮")} ${t.fg("dim", "—")}`);
	} else {
		out.push(
			` ${t.fg("muted", "本轮")} ${t.fg("text", fmtDur(turnMs()))}` +
				t.fg("text", ` ↑${fmtTok(runTokIn)}`) +
				t.fg("accent", ` ↓${fmtTok(runTokOut)}`) +
				t.fg("dim", ` R${fmtTok(runTokCache)}`),
		);
	}

	// ── 会话（活跃时长 + 三类累计）──
	out.push(
		` ${t.fg("muted", "会话")} ${t.fg("text", fmtDur(sessionActiveMs()))}` +
			t.fg("text", ` ↑${fmtTok(sessTok.input)}`) +
			t.fg("accent", ` ↓${fmtTok(sessTok.output)}`) +
			t.fg("dim", ` R${fmtTok(sessTok.cacheRead)}`),
	);

	// ── 子代理（delegate 的账，主会话看不到，得自己扫）──
	if (subTok.sessions > 0) {
		out.push(
			` ${t.fg("muted", "子代理")}` +
				t.fg("text", ` ↑${fmtTok(subTok.input)}`) +
				t.fg("accent", ` ↓${fmtTok(subTok.output)}`) +
				t.fg("dim", ` R${fmtTok(subTok.cacheRead)}`),
		);
	}

	return out;
}

function padTo(s: string, w: number): string {
	const p = w - visibleWidth(s);
	return p > 0 ? s + " ".repeat(p) : s;
}

function fit(s: string, w: number): string {
	if (w <= 0) return "";
	return padTo(truncateToWidth(s, w), w);
}

function shortText(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ======================= 左栏：任务进度 =======================
function leftLines(theme: Theme): string[] {
	const t = theme;
	const out: string[] = [];

	const hasTask = steps.length > 0 || !!blocker;
	const doneCount = steps.filter((s) => s.status === "done").length;

	if (hasTask) {
		const head = t.fg("accent", t.bold("▛ 任务"));
		const meta = title ? ` ${t.fg("muted", title)} · ${doneCount}/${steps.length}` : ` ${t.fg("muted", `${doneCount}/${steps.length}`)}`;
		out.push(head + meta);
	} else {
		out.push(t.fg("accent", t.bold("▛ 会话")) + t.fg("dim", "  待命中"));
	}

	const visible = steps.slice(0, MAX_VISIBLE_STEPS);
	let activityShown = false;
	visible.forEach((s, i) => {
		const icon =
			s.status === "done"
				? t.fg("success", "✓")
				: s.status === "doing"
					? t.fg("accent", SPINNER[spinnerIdx % SPINNER.length]!)
					: s.status === "blocked"
						? t.fg("error", "⚠")
						: t.fg("dim", "○");
		const label =
			s.status === "done"
				? t.fg("dim", t.strikethrough(s.text))
				: s.status === "doing"
					? t.fg("text", t.bold(s.text))
					: s.status === "blocked"
						? t.fg("warning", s.text)
						: t.fg("muted", s.text);
		out.push(`  ${icon} ${t.fg("dim", `${i + 1}`)} ${label}`);
		if (s.status === "doing" && activity) {
			out.push(`     ${t.fg("dim", `▸ ${activity}`)}`);
			activityShown = true;
		}
	});

	if (steps.length > MAX_VISIBLE_STEPS) out.push(`  ${t.fg("dim", `… 还有 ${steps.length - MAX_VISIBLE_STEPS} 步`)}`);

	if (blocker) out.push(`  ${t.fg("error", "⚠ 卡点")} ${t.fg("warning", blocker)}`);

	// 当前动作：常驻显示（即使没有步骤标成“进行中”，也要看得到在干活）
	if (activity && !activityShown) out.push(`  ${t.fg("dim", `▸ ${activity}`)}`);

	return out;
}

// ======================= 右区三栏：MCP / 插件 / 助理 =======================
// 以前这三段是叠在**同一个 26 宽的栏**里（最高能到 20 行，很挤）。
// 现在拆成三个独立栏，渲染时并排 —— 高度降下来，代价是任务栏变窄。

/** MCP 服务（区分 会话 / 项目 / 全局 三级）。w = 本栏实际宽度（用于截断名字） */
/**
 * MCP 栏表头：` MCP 7`；没全部连上时补一段 ` ●2`（= 7 个里 2 个已连上）。
 *
 * 为什么要显示个数：只写 `MCP 7` 会让人以为 7 个都连上了。MCP 是后台连的，
 * 刚开始就是会有一批没连上 —— 把「几个连上了」摆出来才不会误读。
 * 返回两段是为了分开上色（第二段用灰）。
 */
function mcpHeaderParts(total: number, verified: number): [string, string] {
	return [` MCP ${total}`, total > verified ? ` ●${verified}` : ""];
}

/**
 * 单个 MCP 的连接标记。
 * ● = 见过它的工具（真连上了）｜ ◌ = 还没见到工具（**未知**，可能还在连，不是挂了）
 */
function mcpMark(connected: boolean): string {
	return connected ? "●" : "◌";
}

function mcpLines(theme: Theme, w: number = RIGHT_WIDTH): string[] {
	const t = theme;
	const out: string[] = [];
	const verified = cachedMcp.filter((s) => s.connected).length;
	const [headMain, headExtra] = mcpHeaderParts(cachedMcp.length, verified);
	out.push(t.fg("accent", t.bold(headMain)) + (headExtra ? t.fg("dim", headExtra) : ""));
	if (cachedMcp.length === 0) {
		out.push(` ${t.fg("dim", "（无）")}`);
	} else {
		for (const s of cachedMcp.slice(0, MAX_LISTED)) {
			out.push(
				` ${t.fg(s.connected ? "success" : "dim", mcpMark(s.connected))} ${t.fg("dim", LEVEL_TAG[s.level])} ${t.fg(s.connected ? "muted" : "dim", shortText(s.name, Math.max(6, w - 8)))}`,
			);
		}
		if (cachedMcp.length > MAX_LISTED) out.push(` ${t.fg("dim", `+${cachedMcp.length - MAX_LISTED}`)}`);
	}
	return out;
}

/** 已加载的 pi 插件 */
function pluginLines(theme: Theme, w: number = RIGHT_WIDTH): string[] {
	const t = theme;
	const out: string[] = [];
	out.push(t.fg("accent", t.bold(` 插件 ${cachedPlugins.length}`)));
	if (cachedPlugins.length === 0) {
		out.push(` ${t.fg("dim", "（无）")}`);
	} else {
		for (const n of cachedPlugins.slice(0, MAX_LISTED)) {
			out.push(` ${t.fg("success", "●")} ${t.fg("muted", shortText(n, Math.max(4, w - 4)))}`);
		}
		if (cachedPlugins.length > MAX_LISTED) out.push(` ${t.fg("dim", `+${cachedPlugins.length - MAX_LISTED}`)}`);
	}
	return out;
}

/** 助理（delegate 现在能派谁）：只列可派的，base/demo 只数个数 */
function assistantLines(theme: Theme, w: number = RIGHT_WIDTH): string[] {
	const t = theme;
	const out: string[] = [];
	out.push(t.fg("accent", t.bold(` 助理 ${cachedAssistants.usable.length}`)));
	if (cachedAssistants.usable.length === 0) {
		out.push(` ${t.fg("dim", "（无）")}`);
	} else {
		for (const n of cachedAssistants.usable.slice(0, MAX_LISTED)) {
			out.push(` ${t.fg("success", "●")} ${t.fg("muted", shortText(n, Math.max(4, w - 4)))}`);
		}
		if (cachedAssistants.usable.length > MAX_LISTED) {
			out.push(` ${t.fg("dim", `+${cachedAssistants.usable.length - MAX_LISTED}`)}`);
		}
	}
	if (cachedAssistants.blocked > 0) {
		out.push(` ${t.fg("dim", `○ ${cachedAssistants.blocked} 个不可派`)}`);
	}
	// 有后台助理在跑 → 必须提醒「退出会中止」。看门狗会在主进程退出时 SIGKILL 掉子进程
	// （这是「不留孤儿」的代价），不说的话你会不知情地关掉窗口、活就白跑了。
	const running = runningBgCount();
	if (running > 0) {
		out.push(` ${t.fg("warning", `⚠ ${running} 个助理在跑`)}`);
		out.push(` ${t.fg("dim", "  退出 pi 会中止它们")}`);
	}
	// 有助理已经跑完、结果却没投回主会话 → 必须看得见（否则你只能干等）
	const undelivered = undeliveredBgCount();
	if (undelivered > 0) {
		out.push(` ${t.fg("warning", `⚠ ${undelivered} 条没回投`)}`);
	}
	return out;
}

// ======================= 数据采集 =======================
const LEVEL_RANK: Record<McpLevel, number> = { global: 0, project: 1, session: 2 };
const LEVEL_TAG: Record<McpLevel, string> = { session: "会话", project: "项目", global: "全局" };

function readMcpNames(file: string): string[] {
	try {
		if (!existsSync(file)) return [];
		const j = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
		return Object.keys(j.mcpServers ?? {});
	} catch {
		return [];
	}
}

export function computeMcp(cwd: string, trusted: boolean): McpEntry[] {
	const levels = new Map<string, McpLevel>();
	const note = (name: string, lv: McpLevel) => {
		const cur = levels.get(name);
		if (!cur || LEVEL_RANK[lv] > LEVEL_RANK[cur]) levels.set(name, lv);
	};

	// 1. 用户级 mcp.json → 全局
	for (const n of readMcpNames(join(getAgentDir(), "mcp.json"))) note(n, "global");
	// 2. 项目级 .pi/mcp.json → 项目（需项目信任）
	if (trusted) for (const n of readMcpNames(join(cwd, ".pi", "mcp.json"))) note(n, "project");
	// 3. 扩展注册的 → 会话级（/ai 拉进来的在这里）
	try {
		for (const s of pi.getMcpServers()) note(s.name, "session");
	} catch {
		/* 忽略 */
	}

	// 4. 从工具名反推“已连接”：mcp__<server>__<tool>
	const connected = new Set<string>();
	try {
		for (const tool of pi.getAllTools()) {
			if (!tool.name.startsWith("mcp__")) continue;
			const rest = tool.name.slice(5);
			const idx = rest.indexOf("__");
			if (idx < 0) continue;
			const derived = rest.slice(0, idx);
			// 工具名把非字母数字下划线都换成了 _，需要跟配置名对上。
			// 别 break：`my-db` 和 `my.db` 都会归一化成 `my_db`，只认第一个会张冠李戴。
			// 撞车时两个都标上 —— 确实分不出这个工具属于谁，但至少不会指错人。
			let hit = false;
			for (const n of levels.keys()) {
				if (n.replace(/[^A-Za-z0-9_]/g, "_") === derived) {
					hit = true;
					connected.add(n);
				}
			}
			if (!hit) {
				// 配置里没这个 server（比如运行时才注册的），按会话级补一条
				if (!levels.has(derived)) levels.set(derived, "session");
				connected.add(derived);
			}
		}
	} catch {
		/* 忽略 */
	}

	return [...levels.entries()]
		.map(([name, level]) => ({ name, level, connected: connected.has(name) }))
		.sort(
			(a, b) =>
				Number(b.connected) - Number(a.connected) ||
				LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
				a.name.localeCompare(b.name),
		);
}

function computePlugins(): string[] {
	const byPath = new Map<string, string>();
	const add = (p: string | undefined) => {
		if (!p || p.startsWith("builtin:")) return;
		const label = basename(p).replace(/\.(ts|js|mjs|cjs)$/, "");
		byPath.set(p, label);
	};

	try {
		for (const c of pi.getCommands()) {
			if (c.source !== "extension") continue;
			add(c.sourceInfo?.path);
		}
	} catch {
		/* 忽略 */
	}
	try {
		for (const tool of pi.getAllTools()) {
			const si = tool.sourceInfo;
			if (!si || si.source !== "extension") continue;
			add(si.path);
		}
	} catch {
		/* 忽略 */
	}

	return [...byPath.values()].sort();
}

/**
 * 只重算 MCP 那一栏（读 2 个 mcp.json + 扫一遍工具名，很便宜）。
 *
 * 为什么要单独拆出来：MCP 是**后台连**的 —— 实测从会话开始到工具出现要 ~10 秒
 * （工具数 12 → 19）。以前只在本空闲时全量刷，一旦面板上有步骤在 `doing`（busy），
 * 刷新就被跳过 → 面板永远冻在 ○。busy 时只跑这个便宜的就行。
 */
function refreshMcp(ctx: ExtensionContext): void {
	lastCtx = ctx;
	try {
		cachedMcp = computeMcp(ctx.cwd, ctx.isProjectTrusted());
	} catch {
		cachedMcp = [];
	}
}

function refreshData(ctx: ExtensionContext): void {
	lastCtx = ctx;
	refreshMcp(ctx);
	recomputeSessTok(ctx);
	recomputeSubTok();
	try {
		cachedPlugins = computePlugins();
	} catch {
		cachedPlugins = [];
	}
	try {
		const all = loadTemplates(ctx.cwd);
		const usable = all.filter((x) => x.base !== true && x.demo !== true).map((x) => x.key);
		cachedAssistants = { usable, blocked: all.length - usable.length };
	} catch {
		cachedAssistants = { usable: [], blocked: 0 };
	}
}

// ======================= 组件 =======================
class BoardComponent implements Focusable {
	focused = false;

	constructor(
		private theme: Theme,
		private getLeft: () => string[],
		private getMid: () => string[],
		private getMcp: (w: number) => string[],
		private getPlugins: (w: number) => string[],
		private getAssistants: (w: number) => string[],
	) {}

	render(width: number): string[] {
		const t = this.theme;
		const sep = t.fg("borderMuted", "│");

		// 中栏（运行状态）：只在够宽时出现
		const mw = showMid && width >= MID_MIN_COLS ? MID_WIDTH : 0;
		const mid = mw ? this.getMid() : [];

		// 右区：先定栏数（每栏宽度要拿去截名字），再取内容
		// 太窄就退回「三段叠一栏」
		const nRight = showRight ? (width < NARROW_COLS ? 1 : 3) : 0;
		const nCols = 1 + (mw ? 1 : 0) + nRight;
		const seps = Math.max(0, nCols - 1);
		// 列宽：左栏保底 LEFT_MIN，右区各栏平分剩下的（上限 RIGHT_WIDTH、下限 RIGHT_MIN）
		const spaceForRight = width - seps - mw - LEFT_MIN;
		let rw = 0;
		if (nRight) {
			rw = Math.min(RIGHT_WIDTH, Math.max(RIGHT_MIN, Math.floor(spaceForRight / nRight)));
		}
		const lw = Math.max(8, width - seps - mw - nRight * rw);

		let rcols: string[][] = [];
		if (nRight === 1) {
			rcols = [[...this.getMcp(rw), ...this.getPlugins(rw), ...this.getAssistants(rw)]];
		} else if (nRight === 3) {
			rcols = [this.getMcp(rw), this.getPlugins(rw), this.getAssistants(rw)];
		}

		const left = this.getLeft();

		const n = Math.max(left.length, mid.length, ...rcols.map((c) => c.length));
		const out: string[] = [];
		for (let i = 0; i < n; i++) {
			let line = fit(left[i] ?? "", lw);
			if (mw) line += sep + fit(mid[i] ?? "", mw);
			for (const col of rcols) line += sep + fit(col[i] ?? "", rw);
			out.push(line);
		}
		return out;
	}

	handleInput(): void {}

	invalidate(): void {}

	dispose(): void {}
}

// ======================= 挂载 / 刷新 =======================
function renderWidget(force = false): void {
	const ctx = lastCtx;
	if (!ctx?.hasUI) return;

	// ⚠️ 停用闸门**必须在这里**（不能只在 refresh 里）：board 有十几处 handler 直接调
	//    renderWidget()，少一处就会把刚撤掉的面板又挂回来（实测踩过）。
	if (boardOff) return;

	if (!showWidget) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		widgetTui = undefined;
		mounted = false;
		return;
	}

	if (mounted && widgetTui && !force) {
		widgetTui.requestRender();
		return;
	}

	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			widgetTui = tui;
			mounted = true;
			return new BoardComponent(
				theme,
				() => leftLines(theme),
				() => midLines(theme),
				(w) => mcpLines(theme, w),
				(w) => pluginLines(theme, w),
				(w) => assistantLines(theme, w),			);
		},
		{ placement },
	);
}

function refreshStatus(): void {
	const ctx = lastCtx;
	if (!ctx?.hasUI) return;
	const bits: string[] = [];
	if (steps.length) {
		const done = steps.filter((s) => s.status === "done").length;
		bits.push(`📋 ${done}/${steps.length}`);
	}
	// 后台助理在跑 → 状态栏也提一句（面板那栏可能被滚走 / 切到别的视图）
	const running = runningBgCount();
	if (running > 0) bits.push(`⏳ ${running} 个助理在跑`);
	ctx.ui.setStatus(WIDGET_KEY, bits.length ? ctx.ui.theme.fg("accent", bits.join("  ")) : undefined);
}

function refresh(force = false): void {
	// ⚠️ 停用闸门：整个看板（widget + 状态栏那一行）在这里总收口。
	//    用 mounted 判断而不是一次性 flag —— 一旦有别的路径把 widget 挂回来，下次 refresh 还会撤。
	if (boardOff) {
		if (mounted || widgetTui || !gateCleared) {
			gateCleared = true;
			const ctx = lastCtx;
			if (ctx?.hasUI) {
				try {
					ctx.ui.setWidget(WIDGET_KEY, undefined);
					ctx.ui.setStatus(WIDGET_KEY, undefined);
				} catch {
					/* 撤不掉也不影响停用语义 */
				}
			}
			widgetTui = undefined;
			mounted = false;
		}
		return;
	}
	gateCleared = false;
	renderWidget(force);
	refreshStatus();
}

function startTimer(): void {
	if (timer) return;
	timer = setInterval(() => {
		tickCount++;
		const busy = running || steps.some((s) => s.status === "doing");
		if (busy) {
			spinnerIdx++;
			// 以前这里直接 return（只重画不刷新）—— 只要有个步骤卡在 doing，
			// MCP 那栏就冻在会话开始那一刻（那时它还没连上）。所以 busy 时也刷，
			// 只是走便宜的 refreshMcp（~1.5s 一次）。
			if (tickCount % 5 === 0 && lastCtx) refreshMcp(lastCtx);
			renderWidget();
			return;
		}
		// 空闲时低频刷新（更新 token 用量 / MCP 连接状态）
		if (tickCount % 8 === 0) {
			if (lastCtx) refreshData(lastCtx);
			renderWidget();
		}
	}, 300);
}

function stopTimer(): void {
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
}

function persist(): void {
	try {
		pi.appendEntry("task-board", { title, steps, blocker });
	} catch {
		/* ignore */
	}
}

/** 工具 → 一行短描述（只讲“在干什么”，不打印参数明细） */
const TOOL_LABEL: Record<string, string> = {
	read: "读取文件",
	write: "写文件",
	edit: "修改文件",
	bash: "执行命令",
	grep: "搜索内容",
	find: "查找文件",
	ls: "浏览目录",
	progress: "更新进度",
};

function summarizeTool(name: string): string {
	if (TOOL_LABEL[name]) return TOOL_LABEL[name]!;
	if (name.startsWith("mcp__")) {
		const rest = name.slice(5);
		const i = rest.indexOf("__");
		return `调用 ${i < 0 ? rest : rest.slice(0, i)}`;
	}
	return name;
}

// ======================= 工具参数 =======================
const ProgressParams = Type.Object({
	action: Type.Union(
		[Type.Literal("plan"), Type.Literal("step"), Type.Literal("block"), Type.Literal("clear")],
		{ description: "要执行的动作" },
	),
	title: Type.Optional(Type.String({ description: "任务标题，如：加一个页面" })),
	steps: Type.Optional(Type.Array(Type.String(), { description: "步骤列表（action=plan），每条一句话" })),
	index: Type.Optional(Type.Number({ description: "步骤序号，从 1 开始（action=step）" })),
	status: Type.Optional(
		Type.Union(
			[Type.Literal("pending"), Type.Literal("doing"), Type.Literal("done"), Type.Literal("blocked")],
			{ description: "该步骤的状态（action=step）" },
		),
	),
	text: Type.Optional(Type.String({ description: "卡点/说明（action=block）" })),
	skipConfirm: Type.Optional(Type.Boolean({ description: "action=plan 时跳过用户确认（默认 false）" })),
});

// ======================= 扩展入口 =======================
/** doctor 用：看板只读快照 */
export function boardSnapshot(): {
	title: string;
	steps: { text: string; status: StepStatus }[];
	blocker?: string;
	activity?: string;
} {
	return { title, steps: steps.map((s) => ({ ...s })), blocker, activity };
}

/** 注册到 /aihelp 配置面板（会话级项：重启 pi 就复位） */
function registerBoardSettings(): void {
	registerSettings([
		{
			key: "boardOff",
			group: "会话级（重启复位）",
			label: "任务面板",
			desc: "会话级临时关掉看板（不落盘，重启 pi 自动恢复）。想永久不用就别启用这个扩展。",
			kind: "bool",
			def: false,
			session: true,
			get: () => boardOff,
			set: (v) => setBoardOff(!!v),
		},
	]);
}

export function setupBoard(api: ExtensionAPI): void {
	pi = api;
	registerBoardSettings(); // 配置面板用

	// ---------- 工具：模型用来汇报进度 ----------
	// ⚠️ 注册成常量而不是直接 api.registerTool({...})：停用时要按 exposure:"hidden" **重新注册**
	//    才能从模型工具表里撤下（pi 不支持反注册，官方给的路子就是重注册成 hidden）。
	const PROGRESS_TOOL = {
		name: "progress",
		label: "Progress",
		description:
			"更新用户的常驻任务进度看板。多步骤任务（>=3 步）开始时必须先用 action=plan 声明步骤，用户会看到并确认；" +
			"每开始一步用 action=step status=doing，完成用 done；遇到卡点用 action=block；全部完成用 action=clear。" +
			"步骤文案要简短（<=20 字），描述『做什么』而不是『怎么做』。",
		promptSnippet: "更新任务看板（>=3 步先 plan 声明，再逐步 doing/done）",
		promptGuidelines: [
			"多步骤任务（>=3 步）开头先用 action=plan 声明步骤，等用户确认后再动手。",
			"每开始一步就 action=step status=doing，完成立刻 status=done；别等到最后批量标。",
			"遇到卡点用 action=block 说明；全部完成后 action=clear。",
		],
		parameters: ProgressParams,

		async execute(
			_toolCallId: string,
			params: {
				action: string;
				title?: string;
				steps?: string[];
				index?: number;
				status?: StepStatus;
				text?: string;
				skipConfirm?: boolean;
			},
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			lastCtx = ctx;
			resetProgressWatch(); // 任何 progress() 调用都算“有更新”

			// 停用态：工具理论已被撤下，这里再兜一道（防「撤下前已在飞」的调用）
			if (boardOff) {
				return { content: [{ type: "text" as const, text: "扩展已停用（/ai-ext on 恢复）" }], details: {} };
			}

			if (params.action === "clear") {
				title = "";
				steps = [];
				blocker = undefined;
				activity = undefined;
				lastProgressTurn = turnNo;
				refresh();
				persist();
				return { content: [{ type: "text" as const, text: "看板已清空" }], details: { steps: [] } };
			}

			if (params.action === "plan") {
				// ⚠️ 先不要动面板！确认通过之前一切只存在局部变量里。
				// （以前是「先写面板 + 落盘，再弹窗确认」，导致用户拒绝后面板一直卡着废弃计划。）
				const pending = (params.steps ?? []).map((s) => ({ text: s, status: "pending" as StepStatus }));
				const pendingTitle = params.title ?? title;

				if (pending.length === 0) {
					return {
						content: [{ type: "text" as const, text: "steps 为空，请重新提交" }],
						details: { error: "empty steps" },
						isError: true,
					};
				}

				// 拒绝/取消时恢复到声明前的快照（而不是无脑清空）
				const snapshot = { title, steps: steps.map((s) => ({ ...s })), blocker };
				const restore = () => {
					title = snapshot.title;
					steps = snapshot.steps;
					blocker = snapshot.blocker;
					activity = undefined;
					refresh();
					persist();
				};

				// 计划确认：分两种情况
				//   · **剪贴板投递来的计划**（你在后台用输入法/复制文本）→ 默认直接执行，不打扰你
				//   · 你在终端亲手派的计划 → 照旧弹终端确认（要改就先改）
				// 另外「粘贴一句话」和「超时兜底」两条通道仍然管用（谁先答算谁）
				const stepTexts = pending.map((x) => x.text);
				const bgTurn = isBackgroundTurn();
				const pcfg = getPlanCfg();
				const needAsk = params.skipConfirm !== true && !bgTurn && ctx?.hasUI;
				let choice: string | undefined = "✅ 按这个执行";
				if (needAsk) {
					const tuiAsk = ctx.ui.select(
						`开始执行这个方案？${pendingTitle ? `（${pendingTitle}）` : ""} · 共 ${pending.length} 步`,
						["✅ 按这个执行", "✏️ 我要改（输入意见）", "⛔ 先别做"],
					);
					const pasteAsk = new Promise<string | undefined>((res) => {
						openPlanAsk(pendingTitle, stepTexts, (a, note) => {
							if (a === "yes") res("✅ 按这个执行");
							else if (a === "no") res("⛔ 先别做");
							else if (a === "edit") res(`✏️ 我要改（输入意见）${note ? `|${note}` : ""}`);
							else res(undefined);
						});
					});
					const timeoutAsk =
						pcfg.timeoutSec > 0
							? new Promise<string | undefined>((res) => {
									const t = setTimeout(() => res(pcfg.timeoutRun ? "✅ 按这个执行" : "⛔ 先别做"), pcfg.timeoutSec * 1000);
									t.unref?.();
								})
							: undefined;
					choice = await Promise.race(timeoutAsk ? [tuiAsk, pasteAsk, timeoutAsk] : [tuiAsk, pasteAsk]);
					closePlanAsk(); // 谁先答都要把挂起状态清掉（否则下一轮计划会被误应答）
				} else if (bgTurn) {
					ctx.ui.notify(`📋 剪贴板投递的计划（${pending.length} 步）→ 默认开始执行：${pendingTitle || ""}`, "info");
				}					if (choice && choice.startsWith("✏️") && choice.includes("|")) {
						// 粘贴通道带来的修改意见：直接当"我要改"处理（不用再弹输入框）
						const note = choice.split("|").slice(1).join("|").trim();
						restore();
						return {
							content: [
								{
									type: "text" as const,
									text: note
										? `用户**不要**这个方案，改完再重新声明。\n用户原话：\n"${note}"\n\n请根据这个意见调整，先在对话里重新给详细计划，再重新 progress(action="plan") 声明步骤。`
										: "用户在修改输入里取消了，没有执行方案。请等用户进一步指示。",
								},
							],
							details: { revised: true, note: note || null },
							isError: true,
						};
					}
					if (choice?.startsWith("✏️")) {
						const note = (await ctx.ui.editor("想怎么改？（Esc 取消）", ""))?.trim();
						restore();
						return {
							content: [
								{
									type: "text" as const,
									text: note
										? `用户**不要**这个方案，改完再重新声明。\n用户原话：\n"${note}"\n\n请根据这个意见调整，先在对话里重新给详细计划，再重新 progress(action="plan") 声明步骤。`
										: "用户在修改输入里取消了，没有执行方案。请等用户进一步指示。",
								},
							],
							details: { revised: true, note: note || null },
							isError: true,
						};
					}

					if (!choice || choice.startsWith("⛔")) {
						restore();
						return {
							content: [
								{
									type: "text" as const,
									text: "用户没有确认该方案。请先询问用户想怎么调整，不要继续执行。",
								},
							],
							details: { confirmed: false },
							isError: true,
						};
					}

				// 计划开跑 → 弹一张**常驻**的「执行弹窗」：把要干的事完整列出来（点 X 才关）
				{
					const lines = pending.map((x, i) => `  ${i + 1}. ${x.text}`).join("\n");
					const tail = bgTurn ? "（剪贴板投递 → 默认执行；点 X 关掉这张）" : "（点 X 关掉这张）";
					cardNotify(`pi · 已按这个计划开工（${pending.length} 步）`, `${pendingTitle ? pendingTitle + "\n" : ""}${lines}\n${tail}`, 0);
				}
				// ✅ 到这里才算确认通过 —— 现在才提交到面板和磁盘
				title = pendingTitle;
				steps = pending;
				// 声明完就开始第一步，不然面板会一直停在 0/N
				steps[0]!.status = "doing";
				blocker = undefined;
				lastProgressTurn = turnNo;
				refresh();
				persist();
				return {
					content: [{ type: "text" as const, text: `方案已确认，共 ${steps.length} 步。请逐步执行并更新状态。` }],
					details: { steps },
				};
			}

			if (params.action === "block") {
				blocker = params.text ?? "遇到问题";
				lastProgressTurn = turnNo;
				refresh();
				persist();
				return { content: [{ type: "text" as const, text: `已记录卡点：${blocker}` }], details: { blocker } };
			}

			if (params.action === "step") {
				const idx = (params.index ?? 0) - 1;
				if (idx < 0 || idx >= steps.length) {
					return {
						content: [{ type: "text" as const, text: `步骤序号无效：${params.index}` }],
						details: { error: "bad index" },
						isError: true,
					};
				}
				const st = params.status ?? "doing";
				steps[idx]!.status = st;
				if (st === "done" && blocker) blocker = undefined;
				lastProgressTurn = turnNo;
				refresh();
				persist();
				return { content: [{ type: "text" as const, text: `步骤 ${params.index} → ${st}` }], details: { steps } };
			}

			return { content: [{ type: "text" as const, text: `未知 action: ${params.action}` }], details: {} };
		},

		// 工具行里补一个耗时（pi 1.1.0 起渲染上下文带 durationMs）：默认渲染只给结果文本，
		// 看不出这次打点花了多久。outputPad 只有 renderShell:"self" 的渲染器要自己应用，这里不用管。
		renderResult(result, _options, theme, context) {
			const first = result.content?.find((c) => c.type === "text");
			const body = first && first.type === "text" ? first.text : "";
			const ms = context?.durationMs;
			const dur =
				typeof ms === "number"
					? theme.fg("dim", ` · ${ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}`)
					: "";
			return new Text(theme.fg("muted", body) + dur, 0, 0);
		},
	};
	api.registerTool(PROGRESS_TOOL);

	// ---------- 停用闸门：progress 工具撤下 / 恢复 ----------
	function applyBoardGate(off: boolean): void {
		setBoardOff(off);
		try {
			pi?.registerTool({ ...PROGRESS_TOOL, exposure: off ? "hidden" : "direct" });
		} catch (e) {
			console.error("[ai-configure] board: 切换 progress 工具失败：", e);
		}
		gateCleared = false; // 让 refresh() 重走一遍：停用 → 撤 widget；恢复 → 重画
		refresh(true);
	}

	// ---------- 事件 ----------
	api.on("tool_call", async (event, ctx) => {
		lastCtx = ctx;
		if (event.toolName === "progress") return;
		activity = summarizeTool(event.toolName);
		activityStart = Date.now();
		renderWidget();
	});

	/**
	 * 轮内提醒（治“一到到底、看板不动”）：
	 * 同一次用户输入里模型可能跑几十次工具调用 —— 中途它看不到新的提示词，
	 * 所以把提醒**附在工具结果后面**（pi 允许 tool_result 处理器改写内容）。
	 * 只数顶层调用（nested 的 codemode 调用不数，免得虚高），每 NAG_EVERY_CALLS 次提醒一次。
	 */
	api.on("tool_result", async (event) => {
		if (boardOff || steps.length === 0) return;
		if (event.toolName === "progress") {
			resetProgressWatch();
			return;
		}
		if (event.parentToolCallId) return; // nested 调用不数
		toolCallsSinceProgress++;
		if (toolCallsSinceProgress < NAG_EVERY_CALLS) return;
		const nag = progressNag();
		toolCallsSinceProgress = 0;
		return { content: [...event.content, { type: "text" as const, text: nag }] };
	});

	// ⚠️ 一轮 = 一问一答：agent_start → agent_settled
	//    pi 的 turn_start / turn_end 是「每次模型请求」，不是「一轮」，不拿它计时/计轮数。

	/** 🟢 一轮开始：你发消息 → 我开始跑 */
	api.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		running = true;
		runAccounted = false;
		runStart = Date.now();
		runFrozenMs = 0;
		pausedTotal = 0;
		pauseStart = 0;
		runTokIn = 0;
		runTokOut = 0;
		runTokCache = 0;
		runCount++;
		genStart = 0;
		genChars = 0;
		activity = undefined;
		renderWidget();
	});

	/** 一条 assistant 消息开始生成 → 进入「生成中」 */
	api.on("message_start", async (event, ctx) => {
		lastCtx = ctx;
		if ((event as { message?: { role?: string } }).message?.role !== "assistant") return;
		activity = undefined;
		genStart = Date.now();
		genChars = 0;
		renderWidget();
	});

	/** 流式增量 → 累计字符数，实时估 TPS */
	api.on("message_update", async (event, ctx) => {
		lastCtx = ctx;
		const ev = event as {
			message?: { role?: string };
			assistantMessageEvent?: { delta?: unknown; text?: unknown };
		};
		if (ev.message?.role !== "assistant") return;
		if (!genStart) {
			genStart = Date.now();
			genChars = 0;
		}
		// 双路兜底：优先用增量 delta，退化用「累积消息的文本长度」
		const ame = ev.assistantMessageEvent;
		const delta = typeof ame?.delta === "string" ? ame.delta : typeof ame?.text === "string" ? ame.text : "";
		if (delta) genChars += delta.length;
		const acc = assistantTextLen(ev.message);
		if (acc > genChars) genChars = acc;
		renderWidget();
	});

	/** 一条消息结束 → 累加本轮 token + 用真实 output 校准字符/token 比值 */
	api.on("message_end", async (event, ctx) => {
		lastCtx = ctx;
		const msg = (
			event as {
				message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } };
			}
		).message;
		if (msg?.role !== "assistant") return;
		const u = msg.usage;
		if (u) {
			runTokIn += u.input ?? 0;
			runTokOut += u.output ?? 0;
			runTokCache += u.cacheRead ?? 0;
			// 自动校准：本次流的字符数 ÷ 真实 output token → 越用越准
			const out = u.output ?? 0;
			if (genChars > 200 && out > 0) {
				const ratio = genChars / out;
				if (ratio > 0.8 && ratio < 8) charsPerToken = ratio;
			}
		}
		if (genStart) {
			const sec = (Date.now() - genStart) / 1000;
			if (sec > 0.3 && genChars > 0) lastTps = Math.max(1, Math.round(genChars / charsPerToken / sec));
			genStart = 0;
			genChars = 0;
		}
		refreshData(ctx);
		renderWidget();
	});

	/** ⚠️ 这只是一个模型请求结束，不是「一轮」 */
	api.on("turn_start", async (_event, ctx) => {
		lastCtx = ctx;
		// 每个模型请求开头也重算一次 MCP：保证会话开始后至少刷一次
		refreshMcp(ctx);
		renderWidget();
	});

	api.on("turn_end", async (_event, ctx) => {
		lastCtx = ctx;
		activity = undefined;
		refreshData(ctx);
		refresh();
	});

	/** 🟡 agent loop 结束（后面可能还有自动重试 / 压缩 / 续跑） */
	api.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		activity = undefined;
		genStart = 0;
		settleRun();
		refreshData(ctx);
		refresh();
	});

	/** 🟢 本轮彻底结束：定格 + 入账 */
	api.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		activity = undefined;
		genStart = 0;
		settleRun();
		refreshData(ctx);
		refresh();
	});

	/** ⏸ 弹窗等你点（✅/✏️/⛔）—— 这段不该算进我的工作时长 */
	api.on("ui_prompt_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (running && !pauseStart) pauseStart = Date.now();
	});

	api.on("ui_prompt_end", async (_event, ctx) => {
		lastCtx = ctx;
		if (pauseStart) {
			pausedTotal += Date.now() - pauseStart;
			pauseStart = 0;
		}
	});

	api.on("model_select", async (_event, ctx) => {
		lastCtx = ctx;
		renderWidget();
	});

	api.on("mcp_servers_change", async (_event, ctx) => {
		lastCtx = ctx;
		refreshData(ctx);
		renderWidget();
	});

	// 工具跑完就刷 —— 刚跑完一个 mcp__ 工具 = 「这个 server 确实连上了」的最强证据
	api.on("tool_execution_end", async (event, ctx) => {
		lastCtx = ctx;
		if (!String(event.toolName ?? "").startsWith("mcp__")) return;
		refreshMcp(ctx);
		renderWidget();
	});

	// ---------- 提示词注入 ----------
	api.on("before_agent_start", async (event) => {
		// ⚠️ pi 1.2.0 起：本事件也会为 `pi.sendMessage(..., { triggerTurn: true })` 起的 run 触发
		//    （event.messageType === "custom"）。那种 run 不是「用户提问」，既不该算一轮，
		//    也不该注入看板提示 —— 否则 turnNo 虚涨会把「计划已 N 轮没更新」误判成作废。
		if (event.messageType === "custom") return;
		// 停用态：不注入任何看板内容（连 system prompt 的段都不碰）
		if (boardOff) return;
		turnNo++;

		// 静态规则走 **system prompt 段**，不再每轮当消息注入：
		//   pi 1.2.0 起段是稳定的（修好了 triggerTurn run 首轮工具调用后把段删掉的 bug），
		//   pi 会把段的变化作为 transcript delta 追加 —— 同样的内容只吃一次上下文，
		//   也不像每轮注入消息那样反复破坏 prompt cache。动态状态仍走下面的 message。
		if (event.systemPromptOptions.sections["task-board"] !== BOARD_RULES) {
			event.systemPromptOptions.sections["task-board"] = BOARD_RULES;
		}

		const doneN = steps.filter((s) => s.status === "done").length;
		const doingIdx = steps.findIndex((s) => s.status === "doing");
		const staleTurns = steps.length > 0 ? turnNo - lastProgressTurn : 0;
		// 轮内也算：同一个 turn 里跑了很多工具却没更新看板（多步任务常常都发生在同一轮里）
		const staleCalls = steps.length > 0 ? toolCallsSinceProgress : 0;

		// 把面板的【真实状态】告诉模型，而不是只给一套静态规则
		let planLine: string;
		if (steps.length === 0) {
			planLine = "当前面板：**空**（没有进行中的计划）";
		} else {
			planLine =
				`当前面板：计划「${title || "(无标题)"}」 ${doneN}/${steps.length} 步` +
				(doingIdx >= 0 ? `，正在做第 ${doingIdx + 1} 步「${steps[doingIdx]!.text}」` : "") +
				(blocker ? `，卡点：${blocker}` : "");
			if (staleTurns >= 2 || staleCalls >= NAG_EVERY_CALLS) {
				planLine +=
					`\n⚠️ 这个计划` +
					(staleTurns >= 2 ? `已经 ${staleTurns} 轮没有任何 progress() 更新` : "") +
					(staleCalls >= NAG_EVERY_CALLS ? `${staleTurns >= 2 ? "，" : "已经"}本轮 ${staleCalls} 次工具调用没更新` : "") +
					`，**很可能已作废或忘了同步**。` +
					`做完一步就 progress(action="step", index=N, status="done")；全部完成就 clear；` +
					`对不上用户最新要求就先 progress(action="clear")。`;
			}
		}

		// 只注入**动态**状态（完整规则在 system prompt 的 <task-board> 段里，不重复）
		return {
			message: {
				customType: "task-board-hint",
				content: `[任务进度看板] ${planLine}`,
				display: false,
			},
		};
	});

	// ---------- 命令 ----------
	api.registerCommand("usage", {
		description: "用量：主会话 + 子代理的全局 token 账",
		handler: async (_args: string, ctx: ExtensionContext) => {
			lastCtx = ctx;
			if (boardOff) {
				ctx.ui.notify("扩展已停用（/ai-ext on 恢复）", "info");
				return;
			}
			recomputeSessTok(ctx);
			recomputeSubTok();
			const f = fmtTok;
			const lines: string[] = [];
			lines.push(`⚙ 用量 · ${runCount} 轮 · 活跃 ${fmtDur(sessionActiveMs())}`);
			lines.push("");
			lines.push(`  主会话   ↑${f(sessTok.input)}  ↓${f(sessTok.output)}  R${f(sessTok.cacheRead)}`);
			lines.push(`  子代理   ↑${f(subTok.input)}  ↓${f(subTok.output)}  R${f(subTok.cacheRead)}`);
			lines.push("  " + "─".repeat(34));
			lines.push(
				`  合计     ↑${f(sessTok.input + subTok.input)}  ↓${f(sessTok.output + subTok.output)}  R${f(sessTok.cacheRead + subTok.cacheRead)}`,
			);
			lines.push("");
			lines.push(`子代理明细（共 ${subTok.sessions} 个会话）`);
			if (subDetail.length === 0) lines.push("  （还没有子代理会话）");
			for (const d of subDetail) {
				lines.push(`  ${d.name}  ${d.sessions}个  ↑${f(d.input)} ↓${f(d.output)} R${f(d.cacheRead)}`);
			}
			lines.push("");
			lines.push("↑输入  ↓输出  R缓存读（缓存命中率看底部状态栏 CH）");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	api.registerCommand("board", {
		description: "任务/会话面板：/board [on|off|clear|above|below|right|mid]",
		handler: async (args: string, ctx: ExtensionContext) => {
			lastCtx = ctx;
			if (boardOff) {
				ctx.ui.notify("扩展已停用（/ai-ext on 恢复）", "info");
				return;
			}
			const a = (args ?? "").trim().toLowerCase();

			if (a === "clear") {
				title = "";
				steps = [];
				blocker = undefined;
				activity = undefined;
				refresh();
				persist();
				ctx.ui.notify("任务已清空", "info");
				return;
			}

			if (a === "above" || a === "below") {
				placement = a === "below" ? "belowEditor" : "aboveEditor";
				refresh(true);
				ctx.ui.notify(`面板位置：${a === "below" ? "输入框下方" : "输入框上方"}`, "info");
				return;
			}

			if (a === "right") {
				showRight = !showRight;
				refresh();
				ctx.ui.notify(showRight ? "右区（MCP/插件/助理）：显示" : "右区（MCP/插件/助理）：隐藏", "info");
				return;
			}

			if (a === "mid") {
				showMid = !showMid;
				refresh();
				ctx.ui.notify(showMid ? "中栏：显示" : "中栏：隐藏", "info");
				return;
			}

			if (a === "on") showWidget = true;
			else if (a === "off") showWidget = false;
			else showWidget = !showWidget;

			refresh(true);
			ctx.ui.notify(showWidget ? "面板：开" : "面板：关", "info");
		},
	});

	// ---------- 生命周期 ----------
	api.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		sessionStart = Date.now(); // 仅作挂钟参考；「会话」行显示的是活跃时长
		resetProgressWatch();
		running = false;
		runAccounted = false;
		runStart = 0;
		runFrozenMs = 0;
		pausedTotal = 0;
		pauseStart = 0;
		activeTotalMs = 0;
		runCount = 0;
		runTokIn = 0;
		runTokOut = 0;
		runTokCache = 0;
		genStart = 0;
		genChars = 0;
		lastTps = 0;
		sessTok = { input: 0, output: 0, cacheRead: 0 };

		try {
			const entries = ctx.sessionManager.getEntries();
			const last = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "task-board")
				.pop() as { data?: { title?: string; steps?: Step[]; blocker?: string } } | undefined;
			if (last?.data) {
				title = last.data.title ?? "";
				steps = last.data.steps ?? [];
				blocker = last.data.blocker;
			}
		} catch {
			/* ignore */
		}

		refreshData(ctx);
		startTimer();
		refresh(true);
	});

	api.on("session_shutdown", async () => {
		stopTimer();
	});

	// 停用闸门：最后登记（此时工具定义 / 模块状态都已就绪；登记时立刻按当前状态跑一次）
	onGateApply("board", applyBoardGate);
}
