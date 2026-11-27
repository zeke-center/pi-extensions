/**
 * shared.ts —— 模块之间的**小共享状态**（避免循环引用）。
 *
 * 为什么要有它：`settings.ts`、`board.ts`、`delegate.ts`、`gate.ts` 之间互相要用一点状态，
 * 直接互相 import 会绕成环（A → B → A，Node 的 ESM 下会拿到半截模块）。
 * 于是把这些东西放这里，谁都只依赖它：
 *   - 计划确认的挂起状态（谁在等答复、超时多久）
 *   - 扩展配置文件（`ai-extensions.json`）的读写
 *   - 「面板打开前刷新助理列表」这类回调注册
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
// 放这里是因为 settings.ts（面板）、delegate.ts（派活）、gate.ts（总开关）都要读写，谁都不该依赖谁。

/** 配置文件路径：<agent dir>/ai-extensions.json */
export function extCfgFile(): string {
	return join(getAgentDir(), "ai-extensions.json");
}

/**
 * 最近一次「配置文件读坏了」的现场（没坏就是 undefined）。
 *
 * 为什么要留这个：读不到配置时以前**静默回落默认值**（router 默认 blind = 最严档），
 * 用户改一下配置反而把自己锁死，且一句提示都没有。现在调用方可以据此 fail-open + 报警。
 */
let cfgParseErr: { file: string; err: string; at: number } | undefined;

/** 最近一次配置解析失败的信息（读成功过一次且没坏 → undefined） */
export function cfgParseError(): { file: string; err: string; at: number } | undefined {
	return cfgParseErr;
}

/** 手动清掉（面板保存成功后调） */
export function clearCfgParseError(): void {
	cfgParseErr = undefined;
}

/**
 * 剥掉 UTF-8 BOM。
 *
 * ⚠️ 真机踩过：Windows 记事本 / PowerShell 5.1 的 `Set-Content -Encoding UTF8` 都会在文件头写
 * `EF BB BF`，而 `JSON.parse` **不认 BOM** → 整份配置解析失败 → 所有配置项回落默认值。
 * 用户看到的就是「改了一下设置，插件行为全变了，还没任何提示」。
 */
export function stripBom(s: string): string {
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 读 JSON 文件（剥 BOM；解析不了返回 undefined 并记下现场） */
export function readJsonFile(file: string): unknown | undefined {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		// 文件不存在是**正常**的（首次使用 / 用户没配过），不算坏
		return undefined;
	}
	const hadBom = raw.charCodeAt(0) === 0xfeff;
	try {
		return JSON.parse(stripBom(raw)) as unknown;
	} catch (e) {
		const err = e instanceof Error ? e.message : String(e);
		cfgParseErr = { file, err, at: Date.now() };
		try {
			logEvent("config.parse.fail", { file, hadBom, err: err.slice(0, 200) }, "error");
		} catch {
			/* 日志也挂了就算了 */
		}
		return undefined;
	}
}

/** 读配置；文件没了/坏了都返回 {}（绝不因为一个配置项把插件搞挂），但**坏了会留现场** */
export function readExtCfg(): Record<string, unknown> {
	const raw = readJsonFile(extCfgFile());
	if (raw && typeof raw === "object") return raw as Record<string, unknown>;
	return {};
}

/** 改键**合并**写回（别把别人的键冲掉）；写入一律**不带 BOM** */
export function patchExtCfg(patch: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(extCfgFile()), { recursive: true });
		const body = JSON.stringify({ ...readExtCfg(), ...patch }, null, 2) + String.fromCharCode(10);
		writeFileSync(extCfgFile(), body, "utf8");
		clearCfgParseError();
	} catch {
		/* 写不进去就算了，内存里照样生效 */
	}
}

// ======================= 计划确认的答复通道 =======================

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { logEvent } from "./log";
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
