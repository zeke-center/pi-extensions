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
import { type Focusable, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { loadTemplates, undeliveredBgCount } from "./delegate";

const WIDGET_KEY = "task-board";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_VISIBLE_STEPS = 8;
const RIGHT_WIDTH = 26; // 右区（MCP/插件/助理）每栏宽度上限
const RIGHT_MIN = 9; // 右区每栏宽度下限（再窄就没法看了）
const LEFT_MIN = 28; // 左栏（任务进度）保底宽度
const MID_WIDTH = 24;
const MID_MIN_COLS = 110; // 面板总宽 ≥ 此值才显示中栏（运行状态）
const NARROW_COLS = 88; // 总宽 < 此值：右区三栏退回「三段叠一栏」
const MAX_LISTED = 6;

type StepStatus = "pending" | "doing" | "done" | "blocked";
type Placement = "aboveEditor" | "belowEditor";

interface Step {
	text: string;
	status: StepStatus;
}

type McpLevel = "session" | "project" | "global";

interface McpEntry {
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

// 中栏「运行」统计
let turnStart = 0; // 本轮开始时间
let turnCalls = 0; // 本轮工具调用次数
let activityStart = 0; // 当前动作开始时间
let sessionStart = 0; // 本 pi 会话开始时间
let sessionTurns = 0; // 会话轮数

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

/** 中栏：运行状态（动态过程）—— 底部状态栏已经有的东西这里不放 */
function midLines(theme: Theme): string[] {
	const t = theme;
	const out: string[] = [];
	out.push(` ${t.fg("accent", t.bold("⚙ 运行"))}`);

	const now = activity ? `${activity} · ${fmtDur(Date.now() - activityStart)}` : "待命";
	out.push(` ${t.fg("muted", "现在")} ${t.fg(activity ? "text" : "dim", shortText(now, MID_WIDTH - 6))}`);

	const t0 = turnStart || sessionStart;
	const calls = t0 ? `${turnCalls} 次 · ${fmtDur(Date.now() - t0)}` : "—";
	out.push(` ${t.fg("muted", "本轮")} ${t.fg("text", shortText(calls, MID_WIDTH - 6))}`);

	const sess = sessionStart ? `${fmtDur(Date.now() - sessionStart)} · ${sessionTurns} 轮` : "—";
	out.push(` ${t.fg("muted", "会话")} ${t.fg("text", shortText(sess, MID_WIDTH - 6))}`);

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

function computeMcp(cwd: string, trusted: boolean): McpEntry[] {
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
	if (steps.length) {
		const done = steps.filter((s) => s.status === "done").length;
		ctx.ui.setStatus(WIDGET_KEY, ctx.ui.theme.fg("accent", `📋 ${done}/${steps.length}`));
	} else {
		ctx.ui.setStatus(WIDGET_KEY, undefined);
	}
}

function refresh(force = false): void {
	renderWidget(force);
	refreshStatus();
}

function startTimer(): void {
	if (timer) return;
	timer = setInterval(() => {
		tickCount++;
		const busy = steps.some((s) => s.status === "doing") || !!activity;
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
export function setupBoard(api: ExtensionAPI): void {
	pi = api;

	// ---------- 工具：模型用来汇报进度 ----------
	api.registerTool({
		name: "progress",
		label: "Progress",
		description:
			"更新用户的常驻任务进度看板。多步骤任务（>=3 步）开始时必须先用 action=plan 声明步骤，用户会看到并确认；" +
			"每开始一步用 action=step status=doing，完成用 done；遇到卡点用 action=block；全部完成用 action=clear。" +
			"步骤文案要简短（<=20 字），描述『做什么』而不是『怎么做』。",
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

				if (params.skipConfirm !== true && ctx?.hasUI) {
					// 用 pi 自带的 select + editor（不自己写组件）。
					// 步骤列表在对话表格和面板里都能看到，弹窗只需要“确认 / 改 / 取消”。
					const choice = await ctx.ui.select(
						`开始执行这个方案？${title ? `（${title}）` : ""} · 共 ${steps.length} 步`,
						["✅ 按这个执行", "✏️ 我要改（输入意见）", "⛔ 先别做"],
					);

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
	});

	// ---------- 事件 ----------
	api.on("tool_call", async (event, ctx) => {
		lastCtx = ctx;
		turnCalls++;
		if (event.toolName === "progress") return;
		activity = summarizeTool(event.toolName);
		activityStart = Date.now();
		renderWidget();
	});

	api.on("turn_start", async (_event, ctx) => {
		lastCtx = ctx;
		turnStart = Date.now();
		turnCalls = 0;
		sessionTurns++;
		// 每轮开头也重算一次：保证「一轮里至少刷一次」
		refreshMcp(ctx);
		renderWidget();
	});

	api.on("turn_end", async (_event, ctx) => {
		lastCtx = ctx;
		activity = undefined;
		refreshData(ctx);
		refresh();
	});

	api.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		activity = undefined;
		refreshData(ctx);
		refresh();
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
	api.on("before_agent_start", async () => {
		turnNo++;
		const doneN = steps.filter((s) => s.status === "done").length;
		const doingIdx = steps.findIndex((s) => s.status === "doing");
		const staleTurns = steps.length > 0 ? turnNo - lastProgressTurn : 0;

		// 把面板的【真实状态】告诉模型，而不是只给一套静态规则
		let planLine: string;
		if (steps.length === 0) {
			planLine = "当前面板：**空**（没有进行中的计划）";
		} else {
			planLine =
				`当前面板：计划「${title || "(无标题)"}」 ${doneN}/${steps.length} 步` +
				(doingIdx >= 0 ? `，正在做第 ${doingIdx + 1} 步「${steps[doingIdx]!.text}」` : "") +
				(blocker ? `，卡点：${blocker}` : "");
			if (staleTurns >= 2) {
				planLine +=
					`\n⚠️ 这个计划已经 ${staleTurns} 轮没有任何 progress() 更新，**很可能已作废**。` +
					`执行前必须先确认它还对得上用户最新的要求；对不上就先 progress(action="clear")。`;
			}
		}

		// 面板空 → 只给一句短提示（省 token：完整规则每轮都进上下文，很重）
		if (steps.length === 0) {
			return {
				message: {
					customType: "task-board-hint",
					content:
						"[任务进度看板] 输入框上方有进度看板，当前为空。\n" +
						'多步骤任务（>=3 步）开始前：先在对话给详细计划表，再 progress(action="plan", title, steps) 声明步骤（每条 <=20 字）；' +
						'每步 progress(action="step", index, status="doing"/"done")；卡点 progress(action="block", text)；全部完成 progress(action="clear")。' +
						"单步任务 / 纯问答不用。",
					display: false,
				},
			};
		}

		return {
			message: {
				customType: "task-board-hint",
				content: `[任务进度看板]
用户有一个常驻在输入框上方的进度看板（左栏任务进度，右侧几栏会话信息）。

${planLine}

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
- 上面「当前面板」那一行是**真实状态**，以它为准。不要凭对话历史里的旧计划行事。
- 面板上的计划如果和用户最新的话对不上、或用户说了“算了/先不管/换个事” → **先调 progress(action="clear")**，再按用户最新要求来。
- **面板为空时，不要去“补做”以前讨论过但没确认的任务。**
- 用户否掉方案（“我要改”/“先别做”）时，面板会自动还原到声明前的状态；不要把它当成“计划还在进行中”。`,
				display: false,
			},
		};
	});

	// ---------- 命令 ----------
	api.registerCommand("board", {
		description: "任务/会话面板：/board [on|off|clear|above|below|right|mid]",
		handler: async (args: string, ctx: ExtensionContext) => {
			lastCtx = ctx;
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
		sessionStart = Date.now();
		turnStart = Date.now();
		turnCalls = 0;
		sessionTurns = 0;

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
}
