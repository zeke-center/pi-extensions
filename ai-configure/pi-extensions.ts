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
 *   config.ts    从 Center 后端拉连接台账 → 注册成 MCP server（命令 /ai）
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
import { setupDoctor } from "./doctor";
import { showHelp } from "./help";
import { healthLine, markFail, markOk } from "./health";

export default function (api: ExtensionAPI): void {
	// ⚠️ 每个模块各自 try/catch：一块坏不许带下水（比如后端连不上，看板/派活要照常用）。
	// 顺序也重要：panel 必须在 board 之前（widget 按注册顺序从上往下排）。
	const parts: Array<[string, (a: ExtensionAPI) => void]> = [
		["config", setupConfig],
		["panel", setupPanel],
		["board", setupBoard],
		["delegate", setupDelegate],
		["doctor", setupDoctor],
	];
	for (const [name, setup] of parts) {
		try {
			setup(api);
			markOk(name);
		} catch (e) {
			markFail(name, e);
			console.error(`[ai-configure] 模块 ${name} 加载失败：`, e);
		}
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

	// ---------- /aihelp（/ai help 的快捷别名）----------
	api.registerCommand("aihelp", {
		description: "打印 AI configure 的全部功能与参数（等于 /ai help）",
		handler: async (_args: string, ctx: ExtensionContext) => {
			showHelp(ctx);
		},
	});
}
