/**
 * shared.ts —— 模块之间的**小共享状态**（避免循环引用）。
 *
 * 为什么要有它：`voice.ts` 已经 import 了 `board.ts`（拿 boardSnapshot），
 * 所以 `board.ts` 不能反过来 import `voice.ts`；而「计划确认」这件事两边都要参与：
 *   - `board.ts`：计划要确认时，把问题挂出来等答复（终端弹窗 + 粘贴通道 + 超时）
 *   - `voice.ts`：剪贴板投进来的一句话可能就是那个答复（「同意」「不行」「改用…」）
 * 于是把这点状态放这里，两个模块都只依赖它。
 *
 * ⚠️ 这里全是**内存状态**，不落盘（粘贴内容绝不写文件）。
 */

// ======================= 旧 ctx 守卫（会话替换后不许再碰）=======================
// 背景回调（定时器 / 子进程输出 / 后台助理回投）最危险：
// 你做 newSession/switchSession/fork/reload 之后，pi 会把旧 ctx 标记失效 ——
// 旧 ctx 一碰就抛「This extension ctx is stale after session replacement or reload」，
// 定时器的回调里没人接这个异常 → **直接崩掉整个 pi 进程**（实测踩过，见 crashes.json）。

/** 是不是「会话已替换，旧 ctx 作废」这类错误 */
export function isStaleCtxError(e: unknown): boolean {
	const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
	return /stale after session replacement|ctx is stale|invalidated|not valid/i.test(m);
}

/**
 * 用缓存的 ctx 干活的统一入口：
 * - ctx 没缓存 → {ok:false}
 * - 一碰就抛（会话换了）→ 接住并告诉调用方 `stale:true`（调用方应把缓存清掉，等新的 session_start）
 * 背景路径**必须**走这里，否则会炸进程。
 */
export function guardCtx<T>(ctx: unknown, fn: (ctx: any) => T): { ok: boolean; stale: boolean; value?: T } {
	if (!ctx) return { ok: false, stale: false };
	try {
		return { ok: true, stale: false, value: fn(ctx) };
	} catch (e) {
		return { ok: false, stale: isStaleCtxError(e) };
	}
}

// ======================= 扩展配置文件（ai-extensions.json）=======================
// 放这里是因为 settings.ts（面板）、voice.ts、delegate.ts 都要读写，谁都不该依赖谁。

/** 配置文件路径：<agent dir>/ai-extensions.json */
export function extCfgFile(): string {
	return join(getAgentDir(), "ai-extensions.json");
}

/** 读配置；文件没了/坏了都返回 {}（绝不因为一个配置项把插件搞挂） */
export function readExtCfg(): Record<string, unknown> {
	try {
		const raw = JSON.parse(readFileSync(extCfgFile(), "utf8")) as unknown;
		return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** 改键**合并**写回（别把别人的键冲掉） */
export function patchExtCfg(patch: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(extCfgFile()), { recursive: true });
		writeFileSync(extCfgFile(), `${JSON.stringify({ ...readExtCfg(), ...patch }, null, 2)}
`, "utf8");
	} catch {
		/* 写不进去就算了，内存里照样生效 */
	}
}

// ======================= 计划确认的答复通道 =======================

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PlanAnswer = "yes" | "no" | "edit";

type PendingAsk = {
	title: string;
	steps: string[];
	/** board 收到答复后调用（undefined = 放弃/没答） */
	resolve: (a: PlanAnswer | undefined, note?: string) => void;
};

let pendingAsk: PendingAsk | undefined;

/**
 * 计划的**提问 / 收工**要通知谁？（`remote.ts` 用：把那个确认框同步到手机）
 *
 * 为什么做在 shared 里：状态本来就住在这儿，加一个监听比让 board 和 remote 互相认识干净。
 * 为什么是**纯增量**：没有监听者时行为跟以前一模一样（一行不改 board.ts）。
 */
type PlanAskListener = (ask: { title: string; steps: string[] } | undefined) => void;
const planAskListeners = new Set<PlanAskListener>();

export function onPlanAskChange(fn: PlanAskListener): () => void {
	planAskListeners.add(fn);
	return () => {
		planAskListeners.delete(fn);
	};
}

/**
 * 电脑端（终端选择框 / 超时）刚答了什么 —— 让**手机那张卡也能照原话追加一行**。
 * 为什么不用参数传：当时是在 `closePlanAsk()` 里一次性通知（钩子不带具体选择），
 * 这样两边说的话就一致了（“已答复” vs “已在电脑端选择：先别做”）。
 */
let askOutcome: string | undefined;

export function setAskOutcome(text: string): void {
	askOutcome = text;
}

/** 取走（读后即清，免得泄漏到下一条计划） */
export function takeAskOutcome(): string | undefined {
	const v = askOutcome;
	askOutcome = undefined;
	return v;
}

function emitPlanAsk(): void {
	const info = pendingAsk ? { title: pendingAsk.title, steps: pendingAsk.steps.slice() } : undefined;
	for (const fn of planAskListeners) {
		// 一个监听者炸了不能影响别的监听者，更不能影响 board 挂问题本身
		try {
			fn(info);
		} catch {
			/* ignore */
		}
	}
}

export function hasPendingPlanAsk(): boolean {
	return pendingAsk !== undefined;
}

/** board 挂出问题（若已有挂起的，旧的按"放弃"收掉，避免卡死后面的计划） */
export function openPlanAsk(title: string, steps: string[], resolve: PendingAsk["resolve"]): void {
	if (pendingAsk) {
		const old = pendingAsk;
		pendingAsk = undefined;
		old.resolve(undefined);
	}
	pendingAsk = { title, steps, resolve };
	emitPlanAsk();
}

/** 外部（voice：粘贴进来的一句话）答复。返回 true = 确实处理了一个挂起的问题 */
export function answerPlanAsk(a: PlanAnswer, note?: string): boolean {
	const p = pendingAsk;
	if (!p) return false;
	pendingAsk = undefined;
	emitPlanAsk();
	p.resolve(a, note);
	return true;
}

/** board 自己收工（超时/终端弹窗先答了）→ 清掉挂起状态 */
export function closePlanAsk(): void {
	if (!pendingAsk) return; // 没挂着的就别乱发通知（否则会去打一堆已经没用的卡）
	pendingAsk = undefined;
	emitPlanAsk();
}

/** 兼容导出：`takeAskOutcome` 名字太长，内部用短名 */
export const planAskOutcome = takeAskOutcome;

// ======================= 这一轮是不是"后台投递"来的 =======================

let backgroundTurn = false;

/** voice.ts 在剪贴板投递成功后置 true；每轮开始时 board.ts 会读它 */
export function setBackgroundTurn(v: boolean): void {
	backgroundTurn = v;
}
export function isBackgroundTurn(): boolean {
	return backgroundTurn;
}

/**
 * 一句话里有没有"同意"的意思。**纯函数**（可测）。
 * 只认短句 + 明确词，避免把「我不同意这个方案」这种当同意。
 */
export function parsePlanAnswer(text: string): { a: PlanAnswer; note?: string } | undefined {
	const t = (text ?? "").replace(/\s+/g, " ").trim();
	if (!t) return undefined;
	if (t.length > 60) return { a: "edit", note: t }; // 长句 = 在说想怎么改
	if (/不(同意|行|可以|要|用|对)|先别|别做|取消|算了|停|no|nope/i.test(t)) return { a: "no" };
	if (/^(同意|可以|行|好|好的|ok|OK|Ok|是|对|继续|确认|开始吧|按这个来|没问题)[。！!~\s]*$/i.test(t)) return { a: "yes" };
	if (/(同意|可以|没问题|按这个|就这么办|继续吧|开始吧)/.test(t) && t.length <= 14) return { a: "yes" };
	return { a: "edit", note: t };
}

// ======================= 计划风险判定（方案 C 用） =======================

/** 高风险动作词：只要步骤描述里出现，就必须问你（宁可多问一句，也别自作主张） */
const RISKY_RE =
	/(写|修改|改成|改一下|改掉|删|移除|清空|覆盖|提交|推送|回滚|部署|重启|安装|卸载|发送|发一条|发个|发布|上传|迁移|建表|执行脚本|改配置|修改配置|git |commit|push|deploy|restart|rm |mv |INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)/i;

/** 只读动作词：至少出现一个，才敢认为"这活是安全的" */
const READONLY_RE = /(查|看|读|统计|汇总|列出|列一下|分析|检查|对比|搜|grep|数一下|拉取|盘点|生成报告|看看)/i;

/**
 * 这个计划能不能"后台自动过"（不弹窗直接干）。**纯函数**（可测）。
 *
 * 条件（全满足才算低风险）：≤3 步 · 没有任何高风险词 · 至少有一个只读词。
 * 宁可判成"高风险"（多问你一句），也不能判成"低风险"却动了你的数据。
 */
export function isLowRiskPlan(steps: string[]): boolean {
	if (steps.length === 0 || steps.length > 3) return false;
	const all = steps.join(" ");
	if (RISKY_RE.test(all)) return false;
	return READONLY_RE.test(all);
}

// ======================= 计划确认的配置（voice 读配置后推过来） =======================

export type PlanCfg = {
	/** C：后台 + 低风险计划 → 不弹窗直接开工 */
	auto: boolean;
	/** B：超时秒数（0 = 一直等） */
	timeoutSec: number;
	/** B：超时后怎么办（true = 按同意执行，false = 当没确认，更安全） */
	timeoutRun: boolean;
};

let planCfg: PlanCfg = { auto: true, timeoutSec: 120, timeoutRun: false };

export function setPlanCfg(c: Partial<PlanCfg>): void {
	if (typeof c.auto === "boolean") planCfg.auto = c.auto;
	if (Number.isFinite(c.timeoutSec)) planCfg.timeoutSec = Math.max(0, Math.round(c.timeoutSec as number));
	if (typeof c.timeoutRun === "boolean") planCfg.timeoutRun = c.timeoutRun;
}
export function getPlanCfg(): PlanCfg {
	return { ...planCfg };
}
