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

/** 计划确认的兜底参数（以前能在 /aihelp 里调；面板删了，就用这两个常量） */
const PLAN_CFG = {
	/** 超时秒数（0 = 一直等） */
	timeoutSec: 120,
	/** 超时后怎么办（true = 按同意执行；false = 当没确认，更安全） */
	timeoutRun: false,
} as const;

export function getPlanCfg(): typeof PLAN_CFG {
	return PLAN_CFG;
}
