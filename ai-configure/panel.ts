/**
 * 子代理实时面板 —— 把 live.ts 的状态画到屏幕上。
 *
 * 落点：**看板正上方的整宽 widget**（就是任务看板那套机制）
 *   - `setWidget(key, factory, { placement: "aboveEditor" })` → 整宽、高度按内容走（上限 10 行）
 *   - 它是**布局的一部分**：顶上去会把对话区缩小几行，但**永远不覆盖任何东西**
 *   - 窄屏（< MIN_TERM_COLS 列）自动降级成一行摘要
 *   - ⚠️ **只在 session_start 注册一次**，之后只 requestRender：
 *     pi 的 widget 按**注册顺序**从上往下排，而每次 setWidget 都会把该 key 挪到末尾 ——
 *     重复注册会把自己送到看板后面去。想稳定排在看板**前面**，就得比看板早一步注册且不再注册。
 *   - **每秒 requestRender 一次**：长命令跑着的时候事件流是静默的（bash 不吐 partial），
 *     「已跑 2:31 / 40s 无动静」这两个数字只能靠自己走表，否则用户会以为死机
 *
 * 备选：`/agents float` 换成右侧浮层（overlay）
 *   - nonCapturing 不抢键盘焦点；visible() 窄屏自动不渲染；maxHeight 60% 保住底部
 *   - 但浮层再漂亮也会盖住右边一块（实测被用户点出来两次），所以只是「我就想让它飘着」时的选项
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	clearJobs,
	liveJobs,
	onLiveChange,
	plainLines,
	renderCompact,
	renderJobs,
	renderJobsColumns,
	type LiveJob,
	type LiveLine,
	type Tone,
} from "./live";

const WIDGET_KEY = "agent-live";

/** 终端列数比这窄 → 面板只画一行摘要（两种形态共用这个阈值） */
const MIN_TERM_COLS = 100;
/**
 * 整宽 widget 的**行数上限**。
 * 取 10 是跟 pi 自己对齐：字符串数组形式的 widget 会被 `MAX_WIDGET_LINES = 10` 截断，
 * 组件形式虽然不受限，但超过这个高度就该用户自己决定要不要看了。
 */
const MAX_WIDGET_ROWS = 10;
/** 浮层形态：面板自己算出来比这窄 / 比这矮，也只画一行 */
const COMPACT_COLS = 40;
const COMPACT_ROWS = 12;
/** 浮层形态：最多占屏幕高度比例（保住底部的看板与输入框） */
const MAX_ROWS_PCT = 0.6;

// ======================= 状态 =======================

interface OverlayState {
	comp: AgentPanel;
	done: () => void;
}

let overlay: OverlayState | undefined;
let widgetCtx: ExtensionContext | undefined;
let widgetTui: TUI | undefined;
/** widget 是否已注册（注册过就**不再注册**，否则会被挪到看板后面） */
let widgetRegistered = false;
let widgetTimer: ReturnType<typeof setInterval> | undefined;
let unsub: (() => void) | undefined;

/** 是否展开思考过程 */
let detail = false;
/** 用户是否手动关掉了（关了就别自动弹回来） */
let suppressed = false;
/**
 * 面板当前要不要显示。
 * 为什么不靠「注册/注销」来控制：widget 一旦注销，下次注册就跑到看板后面去了。
 * 所以关掉 = 只把 `visible` 置 false（内容画 0 行，占 0 行高），注册一直留着。
 */
let visible = false;
/** 用户明确要求用浮层（/agents float）—— 那就不走 widget */
let preferOverlay = false;

export function isPanelOpen(): boolean {
	return Boolean(overlay) || (widgetRegistered && visible);
}

export function isDetail(): boolean {
	return detail;
}

/** 面板当前用的是哪种形态（给 /agents 提示用） */
export function panelMode(): "overlay" | "widget" | "closed" {
	if (overlay) return "overlay";
	if (widgetRegistered && visible) return "widget";
	return "closed";
}

function subscribe(): void {
	if (unsub) return;
	unsub = onLiveChange(() => {
		overlay?.comp.requestRender();
		widgetTui?.requestRender();
	});
}

function unsubscribeIfIdle(): void {
	if (overlay || visible || !unsub) return;
	unsub();
	unsub = undefined;
}

// ======================= 上色 =======================

function paint(theme: Theme, seg: { text: string; tone?: Tone }): string {
	switch (seg.tone) {
		case "accent":
			return theme.fg("accent", seg.text);
		case "ok":
			return theme.fg("success", seg.text);
		case "warn":
			return theme.fg("warning", seg.text);
		case "err":
			return theme.fg("error", seg.text);
		case "muted":
			return theme.fg("muted", seg.text);
		case "bold":
			return theme.bold(seg.text);
		default:
			return theme.fg("text", seg.text);
	}
}

function paintLine(theme: Theme, line: LiveLine): string {
	return line.segs.map((s) => paint(theme, s)).join("");
}

// ======================= 组件 =======================

export class AgentPanel implements Component {
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private getDetail: () => boolean,
	) {
		// 走表：事件静默时全靠它把「已跑多久」推着走。
		// 注意这个 interval 活到面板关闭 —— 中间可能经历 /reload、切会话、会话重载，
		// 那时候 tui 已经失效，requestRender 会抛。定时器里的异常是**没有人接**的，
		// 会直接把进程干挂（实测踩过一次），所以这里必须自己吞。
		this.timer = setInterval(() => this.requestRender(), 1000);
	}

	requestRender(): void {
		try {
			this.tui.requestRender();
		} catch {
			// 会话可能已经换过/重载过，旧 tui 不可用 —— 绝不能让它的异常打挂进程
		}
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	/** 内容随时间和事件变化，所以每次 render 都重算（几十行字符串，便宜） */
	invalidate(): void {}

	render(width: number): string[] {
		const jobs = liveJobs() as LiveJob[];
		const rows = Math.max(6, this.tui.terminal?.rows ?? 24);
		// 高度按内容走，**不补空行铺满**（否则会遮住看板和输入框）
		const maxRows = Math.max(6, Math.floor(rows * MAX_ROWS_PCT));
		const inner = Math.max(16, width - 2);

		if (!jobs.length) {
			return [truncateToWidth(this.theme.fg("muted", "空闲 —— 没有在跑的助理"), width)];
		}

		// 窄/矮 → 只给一行摘要，别硬塞
		if (width < COMPACT_COLS || rows < COMPACT_ROWS) {
			const head = this.theme.fg("accent", "🤖 子代理 ");
			const body = paintLine(this.theme, renderCompact(jobs, inner, Date.now()));
			return [truncateToWidth(head + body, width)];
		}

		const running = jobs.filter((j) => j.status === "running").length;
		const title = `🤖 子代理  ${running ? `${running} 个在跑` : `${jobs.length} 个已结束`}`;
		const bar = "─".repeat(Math.max(1, inner - visibleWidth(title) - 1));

		const body = renderJobs(jobs, {
			width: inner,
			now: Date.now(),
			detail: this.getDetail(),
			maxLines: maxRows - 2,
		});

		const out: string[] = [];
		out.push(truncateToWidth(`${this.theme.fg("accent", title)} ${this.theme.fg("borderMuted", bar)}`, width));
		for (const l of body) out.push(truncateToWidth(` ${paintLine(this.theme, l)}`, width));
		return out.slice(0, maxRows);
	}
}

// ======================= 开关 =======================

/** 打开浮层。返回 true 表示浮层起来了；false 表示得走 widget 退路。 */
function openOverlay(ctx: ExtensionContext): boolean {
	if (!ctx.hasUI || ctx.mode !== "tui") return false;
	let opened = false;
	try {
		void ctx.ui
			.custom(
				(tui, theme, _kb, done) => {
					const doneFn = (): void => done(undefined);
					const comp = new AgentPanel(tui, theme, () => detail);
					overlay = { comp, done: doneFn };
					opened = true;
					return comp;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "42%",
						maxHeight: "60%", // 保住屏幕底部（看板 + 输入框）
						margin: { right: 0 },
						nonCapturing: true, // 不抢键盘焦点：左边照常打字
						visible: (w) => w >= MIN_TERM_COLS, // 窄屏由 pi 直接不渲染
					},
				},
			)
			.then(
				() => {
					overlay?.comp.dispose();
					overlay = undefined;
					unsubscribeIfIdle();
				},
				(e: unknown) => {
					overlay?.comp.dispose();
					overlay = undefined;
					unsubscribeIfIdle();
					// 浮层这条路走不通（比如在工具执行里不让开）→ 静静退到 widget
					if (!opened) openWidget(ctx, e instanceof Error ? e.message : String(e));
				},
			);
	} catch (e) {
		openWidget(ctx, e instanceof Error ? e.message : String(e));
		return false;
	}
	if (!opened) {
		openWidget(ctx);
		return false;
	}
	return true;
}

/** 退路 / 默认：输入框上方的整宽 widget（跟看板同一机制，永不覆盖）。非 TUI 环境什么都不做。 */
function openWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	try {
		widgetCtx = ctx;
		visible = true;
		if (widgetRegistered) {
			// 已经挂着了 —— 只重绘，**绝不能**再 setWidget（否则被挪到看板后面）
			widgetTui?.requestRender();
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				widgetTui = tui;
				return new WidgetPanel(theme, () => detail);
			},
			{ placement: "aboveEditor" },
		);
		widgetRegistered = true;
	} catch {
		// 面板起不来不能连累派活
		widgetCtx = undefined;
		widgetTui = undefined;
		widgetRegistered = false;
	}
}

/**
 * 整宽 widget 形态：只画行，不画框。
 * （pi **不会**给 widget 加框 —— 看板那个 `▛ 任务` 的观感是它自己画的，这里照样画一个 `▛ 子代理` 对齐。）
 */
class WidgetPanel implements Component {
	constructor(
		private theme: Theme,
		private getDetail: () => boolean,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		if (!visible) return [];
		const jobs = liveJobs() as LiveJob[];
		if (!jobs.length) return [];
		const now = Date.now();
		const inner = Math.max(16, width - 2);

		// 窄屏 → 一行摘要，别硬塞
		if (width < MIN_TERM_COLS) {
			const body = paintLine(this.theme, renderCompact(jobs, inner, now));
			return [truncateToWidth(`${this.theme.fg("accent", "🤖 子代理 ")}${body}`, width)];
		}

		const running = jobs.filter((j) => j.status === "running").length;
		// 分栏轮播：超过 COLS 个时每 4 秒换一批（窗口起点用 now 算，渲染保持纯函数）
		const COLS = 3;
		const win = jobs.length > COLS ? Math.floor(now / 4000) % (jobs.length - COLS + 1) : 0;
		const shown = jobs.slice(win, win + COLS);
		const extra = jobs.length > COLS ? ` · 还有 ${jobs.length - COLS} 个（轮播中）` : "";
		const head =
			this.theme.fg("accent", this.theme.bold("▛ 子代理")) +
			" " +
			this.theme.fg("muted", (running ? `${running} 个在跑` : `${jobs.length} 个已结束`) + extra);
		const lines = renderJobsColumns(shown, {
			width: inner,
			now,
			detail: this.getDetail(),
			maxLines: MAX_WIDGET_ROWS - 1, // 留一行给标题
			columns: COLS,
		});
		const out = [truncateToWidth(` ${head}`, width)];
		for (const l of lines) out.push(truncateToWidth(` ${paintLine(this.theme, l)}`, width));
		return out.slice(0, MAX_WIDGET_ROWS);
	}
}

/**
 * 在 `session_start` 把面板挂上去（**只在这一刻注册**）。
 *
 * 为什么必须提前：看板在它自己的 session_start 里也会（重新）注册 widget，
 * 而后面注册的排在下面 —— 所以只要我们在**它之前**注册一次，面板就稳定落在「看板正上方」。
 * `index.ts` 里必须在 `setupBoard()` 之前调用本函数。
 */
export function setupPanel(api: ExtensionAPI): void {
	api.on("session_start", async (_event, ctx) => {
		try {
			overlay?.comp.dispose();
			overlay = undefined;
			widgetTui = undefined;
			widgetRegistered = false;
			visible = false;
			suppressed = false;
			preferOverlay = false;
			clearJobs(); // 上个会话的残留别带过来

			if (!ctx.hasUI || ctx.mode !== "tui") return;
			openWidget(ctx);
			visible = false; // 挂上去但不显示（空闲时画 0 行，不占高度）

			// 走表：长命令期间事件流是静的，秒表与「Ns 无动静」全靠它。
			// 定时器里的异常**没人接**，会直接把进程干挂（实测踩过），所以自己吞。
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = setInterval(() => {
				try {
					if (!visible) return;
					if (!liveJobs().some((j) => j.status === "running")) return;
					widgetTui?.requestRender();
				} catch {
					/* 吞掉 */
				}
			}, 1000);
		} catch {
			// 面板挂不上不能连累别的
		}
	});

	api.on("session_shutdown", async () => {
		try {
			overlay?.comp.dispose();
		} catch {
			/* 吞掉 */
		}
		overlay = undefined;
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
	});
}

/** 打开面板（默认走看板正上方的 widget；`preferOverlay` 时才用浮层）。已经开着就什么都不做。 */
export function openAgentPanel(ctx: ExtensionContext, opts: { force?: boolean } = {}): void {
	if (!ctx.hasUI) return;
	try {
		if (opts.force) {
			suppressed = false;
		} else if (suppressed) {
			return;
		}

		visible = true;
		subscribe();

		if (preferOverlay) {
			if (overlay) {
				overlay.comp.requestRender();
				return;
			}
			if (openOverlay(ctx)) return;
			// 浮层起不来（不是 tui / custom 抛错）→ 静静落回 widget
		}
		openWidget(ctx);
	} catch {
		// 面板只是看的，报错不能连累派活
		overlay = undefined;
	}
}

/** 派活开始时自动叫出来（用户手动关过就不再打扰）。 */
export function ensureAgentPanel(ctx: ExtensionContext): void {
	if (!suppressed) openAgentPanel(ctx);
}

/** 关掉面板（两种形态都关）。user=true 表示用户主动关的，那就别再自动弹回来。
 *
 * 注意：这个函数**刻意不碰 ctx** —— 它会被 45 秒后的定时器调到，那时候会话可能已经
 * 换过或重载过，访问 stale ctx 会触发 pi 的 assertActive 直接抛错（定时器里没人接 → 进程挂）。
 */
export function closeAgentPanel(opts: { user?: boolean } = {}): void {
	if (opts.user) suppressed = true;
	// 只隐藏，**不注销** widget —— 注销了下次注册就会掉到看板后面去
	visible = false;
	try {
		if (overlay) {
			overlay.comp.dispose();
			overlay.done();
			overlay = undefined;
		}
		widgetTui?.requestRender();
	} catch {
		// 面板收不起来也不能连累派活
		overlay = undefined;
	}
	unsubscribeIfIdle();
}

let autoCloseTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 全部跑完后**过一会儿自动收起**，免得一直占着屏幕右边。
 * 其间又派了新活就取消（不会把新面板关掉）。
 */
export function autoClosePanel(ctx: ExtensionContext, ms = 45_000): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	if (autoCloseTimer) clearTimeout(autoCloseTimer);
	autoCloseTimer = setTimeout(() => {
		autoCloseTimer = undefined;
		try {
			if (liveJobs().some((j) => j.status === "running")) return;
			closeAgentPanel({ user: false });
		} catch {
			// 定时器里抛异常没人接 —— 自己吃掉
		}
	}, ms);
}

/** 切换形态偏好：true = 用右侧浮层（默认 false，走看板正上方的 widget） */
export function setPreferOverlay(v: boolean): void {
	preferOverlay = v;
}
/** 切换「展开思考」。 */
export function toggleDetail(): boolean {
	detail = !detail;
	overlay?.comp.requestRender();
	widgetTui?.requestRender();
	return detail;
}

/** 清空注册表（面板关掉时顺手调）。 */
export function clearPanelJobs(): void {
	clearJobs();
	overlay?.comp.requestRender();
	widgetTui?.requestRender();
}

/** 供 /agents 用：当前面板的几行纯文本（RPC/无 UI 环境也能看）。 */
export function snapshotLines(width = 46, maxLines = 20): string[] {
	const jobs = liveJobs() as LiveJob[];
	if (!jobs.length) return ["(没有在跑的助理)"];
	return plainLines(renderJobs(jobs, { width, now: Date.now(), detail, maxLines }));
}
