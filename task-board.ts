/**
 * 任务进度看板 + 会话信息栏 (Task Board / Session Panel)
 *
 * 一个 pi 扩展：在编辑器上方常驻一个"左大右小"的双栏面板。
 *   左栏：任务进度（AI 通过 progress 工具打点；自动跟踪当前动作）
 *   右栏：会话信息（模型 / token 用量 / git 分支 / MCP 服务 / 插件）
 *
 * 命令:
 *   /board                 显示/隐藏整个面板
 *   /board on|off          显式开关
 *   /board clear           清空任务
 *   /board above|below     面板位置（输入框上方 / 下方）
 *   /board right           显示/隐藏右栏
 *
 * 注意: pi 的 widget 只支持 above/below 两个位置，"左右分栏"是本组件自己画出来的。
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";

const WIDGET_KEY = "task-board";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_VISIBLE_STEPS = 8;
const RIGHT_WIDTH = 26;
const MID_WIDTH = 24;
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

let gitBranch: string | undefined;
let cachedMcp: McpEntry[] = [];
let cachedPlugins: string[] = [];

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

function fmtK(n: number): string {
	if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return `${n}`;
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

// ======================= 右栏：会话信息 =======================
function rightLines(theme: Theme): string[] {
	const t = theme;
	const ctx = lastCtx;
	const out: string[] = [];
	const H = (s: string) => t.fg("accent", t.bold(s));

	// --- 模型 / 用量 / 分支 ---
	out.push(H("会话"));
	const model = ctx?.model;
	const modelName = model?.name ?? model?.id ?? "-";
	out.push(` ${t.fg("muted", "模型")} ${t.fg("text", shortText(modelName, RIGHT_WIDTH - 7))}`);
	if (model?.provider) out.push(` ${t.fg("muted", "提供")} ${t.fg("dim", shortText(model.provider, RIGHT_WIDTH - 7))}`);

	const usage = ctx?.getContextUsage();
	if (usage && usage.tokens != null && usage.percent != null) {
		out.push(
			` ${t.fg("muted", "上下文")} ${t.fg("text", `${Math.round(usage.percent)}%`)} ${t.fg("dim", `(${fmtK(usage.tokens)}/${fmtK(usage.contextWindow)})`)}`,
		);
	}
	if (ctx?.thinkingLevel) out.push(` ${t.fg("muted", "思考")} ${t.fg("text", ctx.thinkingLevel)}`);
	if (gitBranch) out.push(` ${t.fg("muted", "分支")} ${t.fg("text", shortText(gitBranch, RIGHT_WIDTH - 7))}`);

	// --- MCP 服务 ---
	out.push(H(`MCP ${cachedMcp.length}`));
	if (cachedMcp.length === 0) {
		out.push(` ${t.fg("dim", "（无）")}`);
	} else {
		for (const s of cachedMcp.slice(0, MAX_LISTED)) {
			out.push(
				` ${s.connected ? t.fg("success", "●") : t.fg("dim", "○")} ${t.fg("dim", LEVEL_TAG[s.level])} ${t.fg(s.connected ? "muted" : "dim", shortText(s.name, RIGHT_WIDTH - 8))}`,
			);
		}
		if (cachedMcp.length > MAX_LISTED) out.push(` ${t.fg("dim", `+${cachedMcp.length - MAX_LISTED}`)}`);
	}

	// --- 插件 ---
	out.push(H(`插件 ${cachedPlugins.length}`));
	if (cachedPlugins.length === 0) {
		out.push(` ${t.fg("dim", "（无）")}`);
	} else {
		for (const n of cachedPlugins.slice(0, MAX_LISTED)) {
			out.push(` ${t.fg("success", "●")} ${t.fg("muted", shortText(n, RIGHT_WIDTH - 4))}`);
		}
		if (cachedPlugins.length > MAX_LISTED) out.push(` ${t.fg("dim", `+${cachedPlugins.length - MAX_LISTED}`)}`);
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
			// 工具名把非字母数字下划线都换成了 _，需要跟配置名对上
			let hit: string | undefined;
			for (const n of levels.keys()) {
				if (n.replace(/[^A-Za-z0-9_]/g, "_") === derived) {
					hit = n;
					break;
				}
			}
			const name = hit ?? derived;
			if (!levels.has(name)) levels.set(name, "session");
			connected.add(name);
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

async function refreshGitBranch(cwd: string): Promise<void> {
	try {
		const r = await pi.exec("git", ["branch", "--show-current"], { cwd });
		const b = String(r?.stdout ?? "").trim();
		gitBranch = b || undefined;
	} catch {
		gitBranch = undefined;
	}
}

function refreshData(ctx: ExtensionContext): void {
	lastCtx = ctx;
	try {
		cachedMcp = computeMcp(ctx.cwd, ctx.isProjectTrusted());
	} catch {
		cachedMcp = [];
	}
	try {
		cachedPlugins = computePlugins();
	} catch {
		cachedPlugins = [];
	}
}

// ======================= 组件 =======================
class BoardComponent implements Focusable {
	focused = false;

	constructor(
		private theme: Theme,
		private getLeft: () => string[],
		private getMid: () => string[],
		private getRight: () => string[],
	) {}

	render(width: number): string[] {
		const t = this.theme;
		const left = this.getLeft();
		const right = this.getRight();
		const rw = showRight ? Math.min(RIGHT_WIDTH, Math.max(10, Math.floor(width * 0.32))) : 0;
		// 窄屏自动降级：放不下三栏就不显示中栏
		const mw = showMid && width >= 110 ? MID_WIDTH : 0;
		const mid = mw ? this.getMid() : [];
		const lw = Math.max(8, width - rw - mw - (mw ? 1 : 0) - (rw ? 1 : 0));
		const n = Math.max(left.length, right.length, mid.length);
		const out: string[] = [];

		for (let i = 0; i < n; i++) {
			let line = fit(left[i] ?? "", lw);
			if (mw) line += t.fg("borderMuted", "│") + fit(mid[i] ?? "", mw);
			if (rw) line += t.fg("borderMuted", "│") + fit(right[i] ?? "", rw);
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
				() => rightLines(theme),
			);
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
			renderWidget();
			return;
		}
		// 空闲时低频刷新（更新 token 用量 / git 分支 / MCP 连接状态）
		if (tickCount % 8 === 0) {
			if (lastCtx) {
				refreshData(lastCtx);
				void refreshGitBranch(lastCtx.cwd);
			}
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
export default function (api: ExtensionAPI): void {
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

		return {
			message: {
				customType: "task-board-hint",
				content: `[任务进度看板]
用户有一个常驻在输入框上方的进度看板（左栏任务进度，右栏会话信息）。

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
				ctx.ui.notify(showRight ? "右栏：显示" : "右栏：隐藏", "info");
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
		void refreshGitBranch(ctx.cwd);
		startTimer();
		refresh(true);
	});

	api.on("session_shutdown", async () => {
		stopTimer();
	});
}
