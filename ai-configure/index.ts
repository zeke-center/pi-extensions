/**
 * AI configure —— 一个插件，四块功能。
 *
 * 为什么是「目录」而不是单个 .ts：
 *   pi 原生支持目录式插件（`extensions/<name>/index.ts` 会被当成一个扩展加载，
 *   并且支持相对 import）。合并前是三个各 700~830 行的独立文件，挤进一个文件要
 *   处理 7 处顶层重名，且一处笔误带下水全部功能。分模块就没有这些问题。
 *
 * 模块分工：
 *   config.ts    从 Center 后端拉连接台账 → 注册成 MCP server（命令 /ai）
 *   board.ts     输入框上方的任务进度看板（命令 /board，工具 progress）
 *   delegate.ts  派活给临时助理（命令 /assistants，工具 delegate）
 *   live.ts      子代理实时状态机（消费子进程的 JSON 事件流）
 *   panel.ts     看板正上方的子代理实时面板（命令 /agents）
 *   help.ts      /aihelp 与 /ai help 共用的文案
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setupConfig } from "./config";
import { setupBoard } from "./board";
import { setupPanel } from "./panel";
import { setupDelegate } from "./delegate";
import { showHelp } from "./help";

export default function (api: ExtensionAPI): void {
	setupConfig(api);
	// ⚠️ 必须在 setupBoard 之前：widget 按注册顺序从上往下排，
	// 抢在看板前面注册，面板才稳定落在「看板正上方」
	setupPanel(api);
	setupBoard(api);
	setupDelegate(api);

	// ---------- /aihelp（/ai help 的快捷别名）----------
	api.registerCommand("aihelp", {
		description: "打印 AI configure 的全部功能与参数（等于 /ai help）",
		handler: async (_args: string, ctx: ExtensionContext) => {
			showHelp(ctx);
		},
	});
}
