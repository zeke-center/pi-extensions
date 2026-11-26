/**
 * AI configure —— 一个插件，四块功能。
 *
 * 为什么是「目录」而不是单个 .ts：
 *   pi 原生支持目录式插件（`extensions/<name>/index.ts` 会被当成一个扩展加载，
 *   并且支持相对 import）。合并前是三个各 700~830 行的独立文件，挤进一个文件要
 *   处理 7 处顶层重名，且一处笔误带下水全部功能。分模块就没有这些问题。
 *   入口不叫 index.ts（叫 pi-extensions.ts），本目录的 package.json 里用 pi.extensions 显式声明，
 *   这样 pi 的显示名是 `pi-extensions`，不会和别的插件的 `index` 撞。
 *
 * 模块分工：
 *   config.ts    MCP 配置管理命令（/ai 撤销 / 状态 / 密钥；拉取功能已删）
 *   board.ts     输入框上方的任务进度看板（命令 /board，工具 progress）
 *   delegate.ts  派活给临时助理（命令 /assistants，工具 delegate）
 *   live.ts      子代理实时状态机（消费子进程的 JSON 事件流）
 *   panel.ts     看板正上方的子代理实时面板（命令 /agents）
 *   health.ts    模块健康度登记（入口失败上报，供 doctor / 状态栏读）
 *   doctor.ts    /ai doctor 自检报告
 *   help.ts      /aihelp 与 /ai help 共用的文案
 *
 * 提示词模板（prompts/）怎么被发现：
 *   包通道（pi install）→ 靠外层 package.json 的 pi.prompts 清单
 *   拷贝通道（install.ps1）→ 靠 pi 的约定目录 <agentDir>/prompts
 *   两条路各管一边，所以**不再**用 resources_discover 声明一次
 *   （那会和清单重复注册同一文件，触发 `name "/ai-delegate" collision`）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setupConfig } from "./config";
import { setupBoard } from "./board";
import { setupPanel } from "./panel";
import { setupDelegate } from "./delegate";
import { setupSuperAgent } from "./superagent";
import { setupGitRead } from "./gitread";
import { setupDoctor } from "./doctor";
import { isExtDisabled, setupGate } from "./gate";
import { openSettings } from "./settings";
import { registerPanelActions } from "./actions";
import { failedParts, healthLine, markFail, markOk } from "./health";

// 供测试/诊断用：把配置面板的注册表暴露出来（面板本体在 settings.ts）
export { settingsSnapshot } from "./settings";

/** 命令名 → handler（/aihelp 面板里的「命令」组靠它执行，不用重写一套） */
export type CommandMap = Map<string, (args: string, ctx: ExtensionContext) => void | Promise<void>>;

/**
 * 包一层 api：模块注册的命令顺便记进 map。
 * 为什么不改各模块：命令注册点有 11 处，包一层只碰入口一个文件。
 */
function withCommandIndex(api: ExtensionAPI, cmds: CommandMap): ExtensionAPI {
	return new Proxy(api, {
		get(target, prop, recv) {
			if (prop === "registerCommand") {
				return (name: string, def: { handler: (args: string, ctx: ExtensionContext) => void | Promise<void> }) => {
					cmds.set(name, (args, ctx) => def.handler(args, ctx));
					return (target as unknown as { registerCommand: (n: string, d: unknown) => void }).registerCommand(name, def);
				};
			}
			const v = Reflect.get(target, prop, recv);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
}

import { configureLog, logError, logEvent } from "./log";
import { readExtCfg } from "./shared";

/** 装配全部模块（默认导出就是它；另起个名字是为了测试能直接调） */
export function setupAll(api: ExtensionAPI): void {
	// ⚠ 每个模块各自 try/catch：一块坏不许带下水（比如后端连不上，看板/派活要照常用）。
	// 顺序也重要：① gate 最前（它的 session_start 要最先跑，否则会先画一帧再隐藏）
	//            ② panel 必须在 board 之前（widget 按注册顺序从上往下排）。
	const cmds: CommandMap = new Map();
	const mApi = withCommandIndex(api, cmds);
	const parts: Array<[string, (a: ExtensionAPI) => void]> = [
		["gate", setupGate],
		["config", setupConfig],
		["panel", setupPanel],
		["board", setupBoard],
		["delegate", setupDelegate],
		["superagent", setupSuperAgent],
		["gitread", setupGitRead],
		["doctor", setupDoctor],
	];
	for (const [name, setup] of parts) {
		try {
			setup(mApi);
			markOk(name);
		} catch (e) {
			markFail(name, e);
			logError("ext.module.fail", e, { module: name });
			console.error(`[ai-configure] 模块 ${name} 加载失败：`, e);
		}
	}

	// ---------- 事件日志（v2.10.0）----------
	// 配置：ai-extensions.json 里 `log: { enabled, level }`；不写就用默认（开、info、保留 3 天）
	try {
		const cfg = readExtCfg();
		const lc = (cfg.log ?? {}) as { enabled?: boolean; level?: "info" | "warn" | "error" };
		configureLog({ enabled: lc.enabled !== false, level: lc.level });
	} catch {
		/* 配置读不了就用默认 */
	}
	logEvent("ext.load", { parts: parts.length, failed: failedParts().map((x) => x.name) });
	// 未捕获异常：**只记录，不改变进程行为**（不重抛、不退出）——
	// 插件里的定时器/回调抛错以前是彻底静默的，现在至少留下一条现场。
	try {
		process.on("uncaughtException", (e) => logError("crash.uncaught", e));
		process.on("unhandledRejection", (e) => logError("crash.unhandled", e));
	} catch {
		/* 老版本 node 忽略 */
	}
	// 状态栏露出健康度：全好就不占地方，坏了几块一眼看见
	api.on("session_start", (_event, ctx) => {
		try {
			const bad = healthLine();
			ctx.ui.setStatus(
				"ai-configure-health",
				bad === "ok" ? undefined : ctx.ui.theme.fg("error", `⚠ ai-configure ${bad}`),
			);
		} catch {
			/* 状态栏失败不影响功能 */
		}
	});

	// ---------- /aihelp：总控制台（配置项 + 助理 + 命令）----------
	// 面板靠 actions.ts 把各命令挂成「动作行」；命令本身照旧能用，只是不再提倡手敲。
	api.registerCommand("aihelp", {
		description: "总控制台：配置项 / 助理 / 命令都能在这儿点（文本版 = /ai help）",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (isExtDisabled()) {
				ctx.ui.notify("扩展已停用（/ai-ext on 恢复）", "info");
				return;
			}
			await openSettings(ctx);
		},
	});

	// 动作行要调各模块的命令 handler —— 这时它们都已注册完了
	try {
		registerPanelActions(cmds);
		markOk("actions");
	} catch (e) {
		markFail("actions", e);
		console.error("[ai-configure] 模块 actions 加载失败：", e);
	}
}

export default function (api: ExtensionAPI): void {
	setupAll(api);
}
