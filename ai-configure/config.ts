/**
 * AI configure · 会话级 / 项目级 MCP 管理
 *
 * 历史：以前这里还有一条「从 AI 配置中心拉取连接台账 → 多选 → 应用到会话级/项目级」的入口
 * （CENTER_API + fetchConnectors + withRetry 那一套），用户明确说没用，**已整段删掉**。
 * 现在只剩管理动作：撤销 / 看状态 / 设密钥 / 自检 / 帮助。
 *
 * 用法:
 *   /ai token          手动输入 Master 密钥（只存内存，不落盘；拉取功能删了，现在只有 /ai status 会看）
 *   /ai off            撤销本次会话级注册
 *   /ai project off    从当前项目的 .pi/mcp.json 移除本扩展写入的条目
 *   /ai status         看当前状态
 *   /ai doctor         自检（= /aidoctor）
 *   /ai help           打印全部功能（= /aihelp）
 *
 * 环境变量:
 *   CENTER_TOKEN       Master 密钥初始值（也可用 /ai token 设置）
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { showHelp } from "./help";
import { showDoctor } from "./doctor";
import { isExtDisabled, onGateApply } from "./gate";
import { stripBom } from "./shared";

/** Master 密钥：优先环境变量 CENTER_TOKEN；也可用 /ai token 设置（只存在内存） */
let token = process.env.CENTER_TOKEN ?? "";
const STATUS_KEY = "ai-config";
const PROJECT_FILE = ".pi/mcp.json";

// ======================= 类型 =======================
interface McpEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	description?: string;
	exposure?: string;
	toolExposure?: Record<string, string>;
}

// ======================= 状态 =======================
let pi: ExtensionAPI;
let lastCtx: ExtensionContext | undefined;
/** 本扩展在本次会话里注册过的 MCP 名字 */
let sessionNames: string[] = [];
/** 本扩展写进项目 .pi/mcp.json 的名字 */
let projectNames: string[] = [];

// ======================= 项目级文件 =======================
function projectFilePath(cwd: string): string {
	return join(cwd, PROJECT_FILE);
}

function readProjectMcp(cwd: string): { mcpServers: Record<string, McpEntry> } {
	const f = projectFilePath(cwd);
	if (!existsSync(f)) return { mcpServers: {} };
	try {
		const j = JSON.parse(stripBom(readFileSync(f, "utf8"))) as { mcpServers?: Record<string, McpEntry> };
		return { mcpServers: j.mcpServers ?? {} };
	} catch {
		return { mcpServers: {} };
	}
}

function writeProjectMcp(cwd: string, data: { mcpServers: Record<string, McpEntry> }): string {
	const f = projectFilePath(cwd);
	mkdirSync(dirname(f), { recursive: true });
	writeFileSync(f, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	return f;
}

// ======================= 状态显示 =======================
function refreshStatus(): void {
	const ctx = lastCtx;
	if (!ctx?.hasUI) return;
	const n = sessionNames.length;
	ctx.ui.setStatus(
		STATUS_KEY,
		n ? ctx.ui.theme.fg("accent", `⚙ AI ${n}`) : undefined,
	);
}

// ======================= 命令 =======================
export function setupConfig(api: ExtensionAPI): void {
	pi = api;

	api.registerCommand("ai", {
		description: "AI 配置：状态 / 撤销 / 密钥 / 自检（/ai help 看全部功能）",
		handler: async (args: string, ctx: ExtensionContext) => {
			lastCtx = ctx;
			if (isExtDisabled()) {
				ctx.ui.notify("扩展已停用（/ai-ext on 恢复）", "info");
				return;
			}
			const a = (args ?? "").trim().toLowerCase();

			// ---------- /ai help ----------
			if (a === "help" || a === "?" || a === "h") {
				showHelp(ctx);
				return;
			}

			// ---------- /ai off ----------
			if (a === "off") {
				const n = sessionNames.length;
				for (const name of sessionNames) {
					try {
						pi.unregisterMcpServer(name);
					} catch {
						/* ignore */
					}
				}
				sessionNames = [];
				refreshStatus();
				ctx.ui.notify(`已撤销 ${n} 个会话级连接`, "info");
				return;
			}

			// ---------- /ai project off ----------
			if (a === "project off" || a === "project clear") {
				const data = readProjectMcp(ctx.cwd);
				let removed = 0;
				for (const name of projectNames) {
					if (name in data.mcpServers) {
						delete data.mcpServers[name];
						removed++;
					}
				}
				if (removed > 0) {
					writeProjectMcp(ctx.cwd, data);
					projectNames = [];
				}
				ctx.ui.notify(`已从 ${PROJECT_FILE} 移除 ${removed} 条`, "info");
				return;
			}

			// ---------- /ai token ----------
			if (a === "token") {
				if (!ctx.hasUI) {
					ctx.ui.notify("需要交互式界面", "warning");
					return;
				}
				const t = await ctx.ui.input(
					"Center Master 密钥",
					token ? "留空并回车 = 清除已保存的密钥" : "粘贴你的 Master 密钥",
				);
				const v = (t ?? "").trim();
				token = v;
				ctx.ui.notify(v ? "密钥已设置（本次会话有效）" : "密钥已清除", "info");
				return;
			}

			// ---------- /ai status ----------
			// ---------- /ai doctor ----------
			if (a === "doctor" || a === "diag") {
				showDoctor(ctx);
				return;
			}

			if (a === "status") {
				const s = sessionNames.length ? sessionNames.join(", ") : "（无）";
				const p = projectNames.length ? projectNames.join(", ") : "（无）";
				ctx.ui.notify(
					`密钥：${token ? "已设置" : "未设置"}\n会话级：${s}\n项目级：${p}`,
					"info",
				);
				return;
			}

			// 其它 / 无参数：原来这里是「从配置中心拉取连接」（已删）—— 现在打印说明书
			showHelp(ctx);
		},
	});

	api.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (isExtDisabled()) {
			// 停用态：不刷状态，也不显示状态栏那一行
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				/* ignore */
			}
			return;
		}
		refreshStatus();
	});

	api.on("session_shutdown", async () => {
		sessionNames = [];
	});

	// 停用闸门：撤 / 恢复状态栏那一行（⚙ AI n）
	onGateApply("config", (off) => {
		try {
			if (!lastCtx?.hasUI) return;
			if (off) lastCtx.ui.setStatus(STATUS_KEY, undefined);
			else refreshStatus();
		} catch {
			/* ignore */
		}
	});
}
