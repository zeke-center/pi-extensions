/**
 * AI configure · 配置中心模块
 *
 * 从"AI 配置中心"（你的 Center 后端）拉取连接台账，选完之后**在会话内生效**。
 * 台账只存"账面信息"，把它翻译成 pi 能用的 MCP 配置这件事由本模块负责。
 *
 * 用法:
 *   /ai                拉取台账 → 多选 → 选应用方式 → 生效
 *   /ai token          手动输入 Master 密钥（只存内存，不落盘）
 *   /ai off            撤销本次会话级注册
 *   /ai project off    从当前项目的 .pi/mcp.json 移除本扩展写入的条目
 *   /ai status         看当前状态
 *   /ai help           打印全部功能（= /aihelp）
 *
 * 环境变量:
 *   CENTER_API         **必填**：你的配置中心地址（例：https://api.example.com）
 *   CENTER_TOKEN       Master 密钥；不设的话 /ai 时会弹框让你输
 *
 * 刻意没有默认地址 —— 这是一个通用插件，不该把别人导向某个人的服务器。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { showHelp } from "./help";

// 没有默认值：没设就报错提示，而不是偷偷指向某个人的服务器
const API = (process.env.CENTER_API ?? "").replace(/\/+$/, "");
/** Master 密钥：优先环境变量 CENTER_TOKEN；没有的话 /ai 时会弹框让你输（只存在内存） */
let token = process.env.CENTER_TOKEN ?? "";
const STATUS_KEY = "ai-config";
const PROJECT_FILE = ".pi/mcp.json";

// ======================= 类型 =======================
interface Connector {
	id: number;
	name: string;
	/** db=数据库 · server=服务器 */
	type: string;
	/** 连接串：postgresql://user:pw@host:5432/db 或 ssh://user:pw@host:22 */
	conn: string;
	/** 后端从 scheme 推导的类型（postgres / mysql / ssh…） */
	kind: string;
	description: string;
	/** read=只读 · readwrite=可修改 */
	access: string;
	enabled: boolean;
	tags: string[];
}

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

// ======================= 台账 → MCP 配置 =======================
const WRITE_PATTERNS: Record<string, string> = {
	"*_write": "hidden",
	"write_*": "hidden",
	"insert_*": "hidden",
	"update_*": "hidden",
	"delete_*": "hidden",
	"drop_*": "hidden",
	"create_*": "hidden",
	"alter_*": "hidden",
	"truncate*": "hidden",
	upload: "hidden",
	"upload_*": "hidden",
	execute: "hidden",
};

/**
 * SSH「只读」命令白名单（正则，逗号拼接传给 --whitelist）。
 *
 * ⚠️ ssh-mcp-server 的白名单是**整串匹配**（要求 match[0] === 整条命令），
 *    所以每条末尾都要 `( .*)?$` 才能带参数。
 * ⚠️ 它内建已拒绝 `; & | ` < > $(` 与换行 —— 重定向/管道/串联天然被挡。
 * ⚠️ 但「命令名对了」不等于安全：参数仍可能有副作用。所以这里刻意收窄：
 *    git 去掉 branch/remote（`git branch -D` 删分支、`git remote set-url` 改远端）；
 *    去掉裸 `ip`（`ip addr add` / `ip link set` 改网络）；去掉 `mount`（可 remount,rw）。
 *    真正的权限边界还是在服务器侧用**受限账号**。
 */
const SSH_ALLOW: string[] = [
	"^(ls|ll|cat|head|tail|less|more|wc|grep|rg|stat|file|du|df|tree|readlink|realpath|basename|dirname)( .*)?$",
	"^find(?! .*(-exec|-delete|-ok|-fprint|-fls))( .*)?$",
	"^(pwd|whoami|id|groups|hostname|uname|date|uptime|free|ps|printenv|which|type)( .*)?$",
	"^(ss|netstat|ping|dig|nslookup|traceroute)( .*)?$",
	"^ip (addr|a|route|r) show( .*)?$",
	"^ip link show( .*)?$",
	"^(systemctl (status|list-units|list-unit-files|show|is-active|is-enabled)|journalctl)( .*)?$",
	"^(docker (ps|images|logs|inspect|stats|version|info))( .*)?$",
	"^git (status|log|diff|show)( .*)?$",
	"^(lsblk|lsof|blkid|nvidia-smi)( .*)?$",
];

/**
 * 连接串 → pi 的 mcpServers 条目。
 * key 是后端从 scheme 推导出的 kind；想支持新类型，在这里加一行即可。
 */
const MCP_BY_KIND: Record<string, (conn: string, c: Connector) => McpEntry> = {
	// 用 mcp-postgres-server 而非官方的 server-postgres：
	// 官方那个**只有只读查询**，无法体现台账里的「可修改」。
	// PG_ALLOW_WRITE 正对应这个开关。
	postgres: (conn, c) => ({
		command: "npx",
		args: ["-y", "mcp-postgres-server"],
		env: {
			DATABASE_URL: conn,
			PG_ALLOW_WRITE: c.access === "readwrite" ? "true" : "false",
		},
		exposure: "codemode",
	}),
	sqlite: (conn) => ({
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-sqlite", conn.replace(/^(sqlite|file):(\/\/)?/, "")],
		exposure: "codemode",
	}),
	// 服务器：@fangjunjie/ssh-mcp-server（支持 --whitelist / --privateKey）
	ssh: (conn, c) => {
		const u = new URL(conn);
		const args = ["-y", "@fangjunjie/ssh-mcp-server", "--host", u.hostname];
		if (u.port) args.push("--port", u.port);
		if (u.username) args.push("--username", decodeURIComponent(u.username));
		if (u.password) args.push("--password", decodeURIComponent(u.password));
		// ?key=~/.ssh/id_ed25519 （或绝对路径）—— ~ 要自己展开
		const key = u.searchParams.get("key");
		if (key) args.push("--privateKey", key.replace(/^~(?=[/\\]|$)/, homedir()));
		const passphrase = u.searchParams.get("passphrase");
		if (passphrase) args.push("--passphrase", passphrase);
		// 不要 pty：否则 systemctl status / journalctl 会起分页器卡住
		args.push("--pty", "false");
		if (c.access === "read") args.push("--whitelist", SSH_ALLOW.join(","));
		return { command: "npx", args, exposure: "codemode" };
	},
};

/** 把一条台账翻译成 pi 的 mcpServers 条目。返回 null 表示这个类型还没有映射。 */
function toMcpEntry(c: Connector): McpEntry | null {
	const maker = MCP_BY_KIND[c.kind];
	if (!maker || !c.conn.trim()) return null;
	let entry: McpEntry;
	try {
		entry = maker(c.conn.trim(), c);
	} catch {
		return null; // 连接串解析失败
	}
	entry.description = c.description || `${c.name} (${c.kind})`;
	// 「只读」→ 屏蔽名字像写操作的 MCP 工具
	if (c.access === "read") entry.toolExposure = { ...WRITE_PATTERNS };
	return entry;
}

function labelOf(c: Connector): string {
	const bits = [c.name, `· ${c.kind}`];
	if (c.tags.length) bits.push(`· ${c.tags.join("/")}`);
	bits.push(c.access === "read" ? "· 只读" : "· 可修改");
	return bits.join(" ");
}

// ======================= 多选组件 =======================
interface Item {
	value: string;
	label: string;
	hint: string;
	checked: boolean;
}

class MultiSelect implements Focusable {
	focused = false;
	private sel = 0;

	constructor(
		private theme: Theme,
		private title: string,
		private items: Item[],
		private done: (values: string[] | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "up")) {
			this.sel = (this.sel - 1 + this.items.length) % this.items.length;
			return;
		}
		if (matchesKey(data, "down")) {
			this.sel = (this.sel + 1) % this.items.length;
			return;
		}
		if (matchesKey(data, "space")) {
			const it = this.items[this.sel];
			if (it) it.checked = !it.checked;
			return;
		}
		if (matchesKey(data, "return")) {
			this.done(this.items.filter((i) => i.checked).map((i) => i.value));
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const w = Math.min(78, width);
		const inner = w - 2;
		const out: string[] = [];
		const border = (s: string) => t.fg("border", s);

		out.push(border(`╭${"─".repeat(inner)}╮`));
		out.push(border("│") + padTo(" " + t.fg("accent", t.bold(this.title)), inner) + border("│"));
		out.push(border(`├${"─".repeat(inner)}┤`));

		this.items.forEach((it, i) => {
			const isSel = i === this.sel;
			const box = it.checked ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
			const text = isSel ? t.fg("accent", it.label) : t.fg("text", it.label);
			const prefix = isSel ? t.fg("accent", "▶ ") : "  ";
			let line = ` ${prefix}${box} ${text}`;
			if (it.hint) line += "  " + t.fg("dim", it.hint);
			out.push(border("│") + padTo(truncateToWidth(line, inner), inner) + border("│"));
		});

		out.push(border(`├${"─".repeat(inner)}┤`));
		const checked = this.items.filter((i) => i.checked).length;
		out.push(
			border("│") +
				padTo(" " + t.fg("dim", `↑↓ 移动 · 空格 勾选 · 回车 确定 · esc 取消`), inner) +
				border("│"),
		);
		out.push(border("│") + padTo(" " + t.fg("muted", `已选 ${checked} 项`), inner) + border("│"));
		out.push(border(`╰${"─".repeat(inner)}╯`));
		return out;
	}

	invalidate(): void {}
	dispose(): void {}
}

function padTo(s: string, w: number): string {
	const p = w - visibleWidth(s);
	return p > 0 ? s + " ".repeat(p) : s;
}

// ======================= 网络 =======================
async function fetchConnectors(tok: string): Promise<Connector[]> {
	if (!API) {
		throw new Error("没设配置中心地址。请先设环境变量 CENTER_API（例：CENTER_API=https://api.example.com）");
	}
	const r = await fetch(`${API}/api/ai/connectors`, {
		headers: { "X-Brain-Token": tok },
		signal: AbortSignal.timeout(10000),
	});
	if (r.status === 401) throw new Error("密钥不对（401）");
	if (!r.ok) throw new Error(`中心返回 HTTP ${r.status}`);
	const j = (await r.json()) as { connectors?: Connector[]; reveal?: boolean };
	if (!j.reveal) throw new Error("中心没给明文（Token 不对？）");
	return j.connectors ?? [];
}

/** 没密钥时弹框让用户输（只存在内存，不写任何文件）。返回 null 表示放弃。 */
async function ensureToken(ctx: ExtensionContext): Promise<string | null> {
	if (token) return token;
	const t = await ctx.ui.input("Center Master 密钥", "用于访问 AI 配置中心（本次会话有效，不落盘）");
	const v = (t ?? "").trim();
	if (!v) return null;
	token = v;
	return token;
}

// ======================= 项目级文件 =======================
function projectFilePath(cwd: string): string {
	return join(cwd, PROJECT_FILE);
}

function readProjectMcp(cwd: string): { mcpServers: Record<string, McpEntry> } {
	const f = projectFilePath(cwd);
	if (!existsSync(f)) return { mcpServers: {} };
	try {
		const j = JSON.parse(readFileSync(f, "utf8")) as { mcpServers?: Record<string, McpEntry> };
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
		description: "从 AI 配置中心拉取连接（/ai help 看全部功能）",
		handler: async (args: string, ctx: ExtensionContext) => {
			lastCtx = ctx;
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
			if (a === "status") {
				const s = sessionNames.length ? sessionNames.join(", ") : "（无）";
				const p = projectNames.length ? projectNames.join(", ") : "（无）";
				ctx.ui.notify(
					`密钥：${token ? "已设置" : "未设置"}\n会话级：${s}\n项目级：${p}`,
					"info",
				);
				return;
			}

			// ---------- /ai ----------
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/ai 需要交互式 TUI", "warning");
				return;
			}

			// 没有密钥就弹框让用户输
			const tok = await ensureToken(ctx);
			if (!tok) {
				ctx.ui.notify("没有密钥，已取消", "warning");
				return;
			}

			let connectors: Connector[];
			try {
				connectors = (await fetchConnectors(tok)).filter((c) => c.enabled);
			} catch (e) {
				ctx.ui.notify(`拉取失败：${e instanceof Error ? e.message : e}`, "error");
				return;
			}
			if (connectors.length === 0) {
				ctx.ui.notify("台账里没有启用的连接（去 AI 配置中心加一条）", "warning");
				return;
			}

			// 1) 多选
			const items: Item[] = connectors.map((c) => {
				const entry = toMcpEntry(c);
				return {
					value: c.name,
					label: labelOf(c),
					hint: entry ? "" : `（${c.kind} 暂未支持）`,
					checked: false,
				};
			});
			const picked = await ctx.ui.custom<string[] | null>(
				(_tui, theme, _kb, done) => new MultiSelect(theme, "AI 配置中心 · 选择连接", items, done),
				{ overlay: true },
			);
			if (!picked || picked.length === 0) return;

			// 2) 选应用方式
			const mode = await ctx.ui.select("应用到哪里？", [
				"会话级（立即生效，退出 pi 即消失）",
				"项目级（写入 " + PROJECT_FILE + "，下次启动生效）",
			]);
			if (!mode) return;

			const chosen = connectors.filter((c) => picked.includes(c.name));
			const entries: { name: string; entry: McpEntry }[] = [];
			const skipped: string[] = [];
			for (const c of chosen) {
				const e = toMcpEntry(c);
				if (e) entries.push({ name: c.name, entry: e });
				else skipped.push(c.name);
			}
			if (entries.length === 0) {
				ctx.ui.notify("选中的类型都还不支持", "warning");
				return;
			}

			// 3) 应用
			if (mode.startsWith("会话级")) {
				for (const { name, entry } of entries) {
					try {
						pi.registerMcpServer(name, entry as never);
						if (!sessionNames.includes(name)) sessionNames.push(name);
					} catch (err) {
						skipped.push(`${name}(${err instanceof Error ? err.message : err})`);
					}
				}
				refreshStatus();
				ctx.ui.notify(
					`已应用 ${entries.length} 个会话级连接（立即生效）` + (skipped.length ? `\n跳过：${skipped.join(", ")}` : ""),
					"info",
				);
			} else {
				const data = readProjectMcp(ctx.cwd);
				for (const { name, entry } of entries) {
					data.mcpServers[name] = entry;
					if (!projectNames.includes(name)) projectNames.push(name);
				}
				const f = writeProjectMcp(ctx.cwd, data);
				ctx.ui.notify(
					`已写入 ${f}（${entries.length} 条）\n项目级需要 /reload 或重开 pi 才生效` +
						(skipped.length ? `\n跳过：${skipped.join(", ")}` : ""),
					"info",
				);
			}
		},
	});

	api.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		refreshStatus();
	});

	api.on("session_shutdown", async () => {
		sessionNames = [];
	});
}
