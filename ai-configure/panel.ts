/**
 * 子代理实时面板 —— 把 live.ts 的状态画到屏幕上。
 *
 * 主路线：**右侧浮层**（overlay）
 *   - `anchor: "right-center"` + `width: "42%"` + `margin.right: 0` → 贴右边缘，视觉上就是一根侧栏
 *   - `nonCapturing: true`  → **不抢键盘焦点**，左边对话与输入框照常能用（这是官方开关，不用自己造反制）
 *   - `visible: (w) => w >= MIN_TERM_COLS` → 太窄自动不渲染（官方内置的响应式降级）
 *   - 高度补齐到底，看起来像侧栏而不是一块飘着的框
 *   - **每秒 requestRender 一次**：长命令跑着的时候事件流是静默的（bash 不吐 partial），
 *     「已跑 2:31 / 40s 无动静」这两个数字只能靠自己走表，否则用户会以为死机
 *
 * 退路：输入框上方的 widget（跟任务看板同一机制）
 *   - overlay 起不来（ctx.mode 不是 tui、custom() 抛错）时自动降级
 *   - 也可以 /agents widget 手动切
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	clearJobs,
	liveJobs,
	onLiveChange,
	plainLines,
	renderCompact,
	renderJobs,
	type LiveJob,
	type LiveLine,
	type Tone,
} from "./live";

const WIDGET_KEY = "agent-live";

/** 比这窄就不画浮层（直接靠 visible() 让 pi 不渲染）—— 注意这是**终端列数** */
const MIN_TERM_COLS = 100;
/** 面板自身列数比这窄、或高度不够，就只画一行摘要（浮层占 42%，所以对应约 95 列终端） */
const COMPACT_COLS = 40;
const COMPACT_ROWS = 12;

// ======================= 状态 =======================

interface OverlayState {
	comp: AgentPanel;
	done: () => void;
}

let overlay: OverlayState | undefined;
let widgetCtx: ExtensionContext | undefined;
let widgetTui: TUI | undefined;
let unsub: (() => void) | undefined;

/** 是否展开思考过程 */
let detail = false;
/** 用户是否手动关掉了（关了就别自动弹回来） */
let suppressed = false;
/** 用户指定了「用输入框上方那个」（/agents widget）—— 那就不再尝试浮层 */
let preferWidget = false;

export function isPanelOpen(): boolean {
	return Boolean(overlay) || Boolean(widgetCtx);
}

export function isDetail(): boolean {
	return detail;
}

/** 面板当前用的是哪种形态（给 /agents 提示用） */
export function panelMode(): "overlay" | "widget" | "closed" {
	if (overlay) return "overlay";
	if (widgetCtx) return "widget";
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
	if (overlay || widgetCtx || !unsub) return;
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
		const rows = Math.max(6, (this.tui.terminal?.rows ?? 24) - 1);
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
			maxLines: rows - 3,
		});

		const out: string[] = [];
		out.push(truncateToWidth(`${this.theme.fg("accent", title)} ${this.theme.fg("borderMuted", bar)}`, width));
		for (const l of body) out.push(truncateToWidth(` ${paintLine(this.theme, l)}`, width));
		// 补空行到底，看起来像一根侧栏
		const guard = this.theme.fg("borderMuted", "│");
		while (out.length < rows) out.push(guard);
		return out.slice(0, rows);
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
						maxHeight: "100%",
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

/** 退路：输入框上方的常驻面板（跟看板同一机制）。非 TUI 环境什么都不做。 */
function openWidget(ctx: ExtensionContext, why?: string): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	try {
		widgetCtx = ctx;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				widgetTui = tui;
				return new WidgetPanel(() => detail);
			},
			{ placement: "aboveEditor" },
		);
	} catch {
		// 面板起不来不能连累派活
		widgetCtx = undefined;
		widgetTui = undefined;
		return;
	}
	if (why) ctx.ui.notify(`子代理面板退到输入框上方（浮层不可用：${why}）`, "warning");
}

/** widget 形态的组件：只画行，不管边框。 */
class WidgetPanel implements Component {
	constructor(private getDetail: () => boolean) {}
	invalidate(): void {}
	render(width: number): string[] {
		const jobs = liveJobs() as LiveJob[];
		if (!jobs.length) return [];
		const inner = Math.max(16, width - 2);
		const lines = plainLines(
			renderJobs(jobs, { width: inner, now: Date.now(), detail: this.getDetail(), maxLines: 8 }),
		);
		const head = `🤖 子代理  ${jobs.filter((j) => j.status === "running").length} 个在跑`;
		return [truncateToWidth(head, width), ...lines.map((l) => truncateToWidth(` ${l}`, width))];
	}
}

/** 打开面板（默认浮层，不行退 widget）。已经开着就什么都不做。 */
export function openAgentPanel(ctx: ExtensionContext, opts: { force?: boolean } = {}): void {
	if (!ctx.hasUI) return;
	try {
		if (opts.force) {
			suppressed = false;
		} else if (suppressed) {
			return;
		}
		if (isPanelOpen()) {
			subscribe();
			overlay?.comp.requestRender();
			widgetTui?.requestRender();
			return;
		}
		subscribe();
		if (!preferWidget && openOverlay(ctx)) return;
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
	try {
		if (overlay) {
			overlay.comp.dispose();
			overlay.done();
			overlay = undefined;
		}
		if (widgetCtx) {
			widgetCtx.ui.setWidget(WIDGET_KEY, undefined);
			widgetCtx = undefined;
			widgetTui = undefined;
		}
	} catch {
		// 面板收不起来也不能连累派活
		overlay = undefined;
		widgetCtx = undefined;
		widgetTui = undefined;
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

/** 切换形态偏好：true = 只用输入框上方的 widget */
export function setPreferWidget(v: boolean): void {
	preferWidget = v;
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
