/**
 * /ai doctor —— AI configure 自检。
 *
 * 为什么要有：以前出错只能靠猜（"MCP 绿点不对"「连接连不上」）。
 * 这里把所有真实状态一次摊开：模块健康度 / 密钥 / MCP 连接 / 助理 / 看板。
 *
 * 用法：/ai doctor   或   /aidoctor
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boardSnapshot, computeMcp } from "./board";
import { loadTemplates, undeliveredBgCount } from "./delegate";
import { formatHerdrDiagnostic, herdrStatus, readUiConfig, resolveUiMode, type HerdrDiagInput } from "./herdr";
import { healthReport } from "./health";
import { liveJobs } from "./live";
import { assistantSessionRoot, localCatalogPath, shadowRoot } from "./mcp-pool";
import { panelMode } from "./panel";
import { resolveRouterPrompt } from "./superagent";

export function showDoctor(ctx: ExtensionContext): void {
	const cwd = ctx.cwd ?? process.cwd();
	const L: string[] = ["ai-configure doctor", ""];

	// ---------- 1. 模块健康度（入口 try/catch 上报）----------
	L.push("## 模块健康度");
	L.push(...healthReport());
	L.push("");

	// ---------- 2. 密钥 ----------
	// 「从配置中心拉取连接」整段已删（CENTER_API / fetchConnectors），只剩密钥这一项。
	L.push("## 密钥");
	L.push(
		`- CENTER_TOKEN: ${
			process.env.CENTER_TOKEN ? "已设（环境变量）" : "未设环境变量（可用 /ai token 设置，仅本次会话）"
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
		L.push("- （无）—— 手写 .pi/mcp.json 后 /reload");
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
	// 分屏为什么没生效 / Router 提示词到底读的哪份 —— 都摊开（全部 try/catch，绝不抛）
	L.push(...herdrDiagnosticLines(cwd));
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

/**
 * Herdr / Router 诊断行（给 `/aidoctor` 用）。
 * 每一项都单独 try/catch：任何一项取不到就写「(取不到)」，**绝不把整个 doctor 搞崩**。
 */
export function herdrDiagnosticLines(cwd: string): string[] {
	let st: ReturnType<typeof herdrStatus> | undefined;
	try {
		st = herdrStatus();
	} catch {
		st = undefined;
	}
	let ui: string | undefined;
	let actual: string | undefined;
	let running = 0;
	try {
		running = liveJobs().filter((j) => j.status === "running").length;
	} catch {
		running = 0;
	}
	try {
		const cfg = readUiConfig();
		ui = cfg.ui;
		actual = resolveUiMode(cfg, running, st?.ok === true);
	} catch {
		actual = undefined; // 配置读不到 / 算不出来 → 格式化时写 (取不到)
	}
	const router: Partial<HerdrDiagInput> = {};
	try {
		const rp = resolveRouterPrompt(cwd);
		router.routerSource = rp.source;
		router.routerBytes = rp.bytes;
		router.routerFile = rp.file;
		router.routerExtraFile = rp.extraFile;
	} catch {
		/* 取不到就留空 → 格式化时写 (取不到) */
	}
	const input: HerdrDiagInput = {
		term: st?.term,
		panes: st?.panes,
		ok: st?.ok,
		reason: st?.reason,
		ui,
		actual,
		...router,
	};
	try {
		return formatHerdrDiagnostic(input);
	} catch {
		return formatHerdrDiagnostic(undefined);
	}
}

export function setupDoctor(api: ExtensionAPI): void {
	api.registerCommand("aidoctor", {
		description: "AI configure 自检：模块健康度 / MCP 连接 / 助理 / 看板",
		handler: async (_args: string, ctx: ExtensionContext) => {
			showDoctor(ctx);
		},
	});
}
