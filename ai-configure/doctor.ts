/**
 * /ai doctor —— AI configure 自检。
 *
 * 为什么要有：以前出错只能靠猜（"MCP 绿点不对"「台账连不上」）。
 * 这里把所有真实状态一次摊开：模块健康度 / 配置中心 / MCP 连接 / 助理 / 看板。
 *
 * 用法：/ai doctor   或   /aidoctor
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boardSnapshot, computeMcp } from "./board";
import { loadTemplates, undeliveredBgCount } from "./delegate";
import { healthReport } from "./health";
import { liveJobs } from "./live";
import { assistantSessionRoot, localCatalogPath, shadowRoot } from "./mcp-pool";
import { panelMode } from "./panel";

export function showDoctor(ctx: ExtensionContext): void {
	const cwd = ctx.cwd ?? process.cwd();
	const L: string[] = ["ai-configure doctor", ""];

	// ---------- 1. 模块健康度（入口 try/catch 上报）----------
	L.push("## 模块健康度");
	L.push(...healthReport());
	L.push("");

	// ---------- 2. 配置中心 ----------
	L.push("## 配置中心");
	const api = (process.env.CENTER_API ?? "").replace(/\/+$/, "");
	L.push(`- CENTER_API: ${api || "（未设置 → /ai 拉连接会报错）"}`);
	L.push(
		`- CENTER_TOKEN: ${
			process.env.CENTER_TOKEN ? "已设（环境变量）" : "未设环境变量（可在 /ai 时弹框输入，仅本次会话）"
		}`,
	);
	L.push("");

	// ---------- 3. MCP ----------
	let mcp: ReturnType<typeof computeMcp> = [];
	try {
		mcp = computeMcp(cwd, ctx.isProjectTrusted());
	} catch {
		/* 探测失败就当空 */
	}
	L.push(`## MCP（共 ${mcp.length}）`);
	if (mcp.length === 0) {
		L.push("- （无）—— /ai 拉台账、或手写 .pi/mcp.json 后 /reload");
	}
	for (const m of mcp) {
		L.push(`${m.connected ? "●" : "○"} ${m.name} [${m.level}] ${m.connected ? "已连接" : "未连 / 未验证"}`);
	}
	if (mcp.some((m) => !m.connected)) {
		L.push(
			"  ⚠ ○ 的判定方式 = 工具名里有没有 mcp__<server>__*；为 ○ 可能是：①服务慢/冷启动没连上 ②本会话还没调过它" +
				" ③名字含特殊字符。用 /mcp 看真实连接、/reload 重连，或随便调一次该工具触发重连。",
		);
	}
	L.push("");

	// ---------- 4. 助理 / 子进程 ----------
	L.push("## 助理");
	try {
		const all = loadTemplates(cwd);
		const usable = all.filter((t) => !t.base && !t.demo);
		L.push(
			`- 模板：${all.length} 个（可派 ${usable.length} · base ${all.filter((t) => t.base).length} · demo ${
				all.filter((t) => t.demo).length
			}）`,
		);
	} catch (e) {
		L.push(`- ❌ 模板读取失败：${e instanceof Error ? e.message : String(e)}`);
	}
	L.push(`- 未回投：${undeliveredBgCount()}`);
	L.push(`- 运行中子进程：${liveJobs().filter((j) => j.status === "running").length}`);
	L.push(`- 子代理面板：${panelMode()}`);
	L.push(`- 助理会话目录：${assistantSessionRoot()}`);
	L.push(`- 影子目录根：${shadowRoot()} · 本地 MCP 目录：${localCatalogPath()}`);
	L.push("");

	// ---------- 5. 看板 ----------
	const b = boardSnapshot();
	L.push("## 看板");
	if (b.steps.length === 0) {
		L.push("- 空");
	} else {
		const done = b.steps.filter((s) => s.status === "done").length;
		L.push(`- 「${b.title || "(无标题)"}」 ${done}/${b.steps.length} 步`);
		const doing = b.steps.findIndex((s) => s.status === "doing");
		if (doing >= 0) L.push(`- 正在做：第 ${doing + 1} 步「${b.steps[doing]?.text ?? ""}」`);
		if (b.blocker) L.push(`- 卡点：${b.blocker}`);
	}

	ctx.ui.notify(L.join("\n"), "info");
}

export function setupDoctor(api: ExtensionAPI): void {
	api.registerCommand("aidoctor", {
		description: "AI configure 自检：MCP 连接 / 台账 / 助理 / 看板 / 模块健康度",
		handler: async (_args: string, ctx: ExtensionContext) => {
			showDoctor(ctx);
		},
	});
}
