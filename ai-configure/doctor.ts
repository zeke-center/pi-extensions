/**
 * /ai doctor —— AI configure 自检。
 *
 * 为什么要有：以前出错只能靠猜（"MCP 绿点不对"「连接连不上」）。
 * 这里把所有真实状态一次摊开：模块健康度 / 密钥 / MCP 连接 / 助理 / 看板。
 *
 * 用法：/ai doctor   或   /aidoctor
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectDiagnoseFacts, diagnoseSummaryLine, writeDiagnoseReport } from "./diagnose";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 插件版本：从包根 package.json 读（读不到就 "?"，报告里不影响排障） */
const PLUGIN_VERSION = (() => {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
		return pkg.version ?? "?";
	} catch {
		return "?";
	}
})();
import { boardSnapshot, computeMcp } from "./board";
import { loadTemplates, undeliveredBgCount } from "./delegate";
import { formatHerdrDiagnostic, herdrStatus, readUiConfig, resolveUiMode, type HerdrDiagInput } from "./herdr";
import { healthReport } from "./health";
import { liveJobs } from "./live";
import { assistantSessionRoot, localCatalogPath, shadowRoot } from "./mcp-pool";
import { panelMode } from "./panel";
import { resolveRouterPrompt } from "./superagent";

import { logSummaryLine, readRecentLogs, summarizeLogs, cleanLogs, logsDir, LOG_RETAIN_DAYS } from "./log";
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

/**
 * `/aidoctor export`：把自检结果写成一份**可以整份发给作者**的 markdown（已脱敏）。
 *
 * 为什么要有它：别人报问题时最缺的是"事实" —— 版本、哪份助理在生效、MCP 有没有定义、
 * 配置有没有写错、日志尾巴长什么样。以前全靠来回问 5 轮；现在一条命令出文档。
 */
function writeDiagnose(ctx: ExtensionContext): void {
	const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
	const version = (ctx as { getVersion?: () => string }).getVersion?.() ?? "(未知)";
	const facts = collectDiagnoseFacts(cwd, PLUGIN_VERSION, version);
	const line = diagnoseSummaryLine(facts);
	const out = writeDiagnoseReport(facts);
	if ("error" in out) {
		ctx.ui.notify(`报告写不出去：${out.error}\n（可以直接把 ${line} 发我，但信息少很多）`, "error");
		return;
	}
	ctx.ui.notify(
		`${line}\n\n报告已写到：\n${out.path}\n\n发给作者前扫一眼：密码/token 已自动打码，但项目路径和库名会原样保留。`,
		"info",
	);
}

export function setupDoctor(api: ExtensionAPI): void {
	api.registerCommand("aidoctor", {
		description: "AI configure 自检：模块健康度 / MCP 连接 / 助理 / 看板（\`/aidoctor export\` 生成可外发的诊断报告）",
		handler: async (args: string, ctx: ExtensionContext) => {
			const a = String(args ?? "").trim().toLowerCase();
			// /aidoctor log [条数] [级别] —— 不用开文件、不用导出报告，直接看最近埋点
			if (a === "log" || a.startsWith("log ")) {
				showLog(ctx, a.replace(/^log\s*/, ""));
				return;
			}			if (a === "export" || a === "report") {
				writeDiagnose(ctx);
				return;
			}
			showDoctor(ctx);
		},
	});
}

/**
 * `/aidoctor log [条数] [级别]`：直接打印最近事件（默认 30 条、warn 以上）。
 *
 * 为什么需要：`/aidoctor export` 是「打包发给作者」用的完整报告；
 * 自己排查时只想看「刚才那条错误长什么样」，翻文件太慢。
 */
export function showLog(ctx: ExtensionContext, arg = ""): void {
	const parts = String(arg ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	let limit = 30;
	let lvl: "info" | "warn" | "error" = "warn";
	for (const p of parts) {
		const n = Number(p);
		if (Number.isFinite(n) && n > 0) limit = Math.min(500, Math.floor(n));
		else if (p === "info" || p === "warn" || p === "error") lvl = p;
	}
	// 兜底：先清一遍过期文件（用户可能是几天后第一次来看）
	cleanLogs();
	const { rows, files } = readRecentLogs(limit, { lvl });
	const sum = summarizeLogs();
	const lines: string[] = [];
	lines.push(`事件日志：${logsDir()}`);
	lines.push(`保留 ${LOG_RETAIN_DAYS} 天　${logSummaryLine()}`);
	if (!files.length) {
		lines.push("");
		lines.push("（还没有日志。派一次活、出一次错之后再看，或者 /aidoctor export 拿完整报告）");
	} else {
		lines.push("");
		for (const r of rows) {
			const d = (r.d ?? {}) as Record<string, unknown>;
			const time = String(r.t ?? "").replace("T", " ").replace("Z", "");
			const bits = Object.entries(d)
				.filter(([, v]) => v !== undefined && v !== "")
				.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
				.join(" ");
			lines.push(`${time}  ${String(r.lvl).toUpperCase().padEnd(5)} ${r.ev}  ${bits}`);
		}
	}
	if (sum.length) {
		lines.push("");
		lines.push("按事件汇总（近 3 天）：");
		for (const s of sum.slice(0, 12)) lines.push(`  ${s.lvl === "error" ? "❌" : s.lvl === "warn" ? "⚠️" : "  "} ${s.ev}  ×${s.count}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}