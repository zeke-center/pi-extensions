/**
 * MCP 候选池 + 影子 agentDir。
 *
 * 为什么需要这个东西
 * ------------------
 * pi 的 MCP 是**由工作目录隐式决定**的：
 *   用户级  <agentDir>/mcp.json      → 任何目录都加载
 *   项目级  <cwd>/.pi/mcp.json       → 该目录被信任后加载
 * 但助理真正想要的是「按需挂几个 MCP」—— 这跟它在哪个目录干活**没关系**。
 *
 * 做法：给子进程一个独立的 PI_CODING_AGENT_DIR（影子目录），里面只写我们挑好的
 * mcp.json；再加 -na 掐掉项目的 .pi/mcp.json。这样模板写挂 1 个就真只连 1 个，
 * 另外那些 MCP 的进程**根本不会启动**，凭据也不会进那个进程 —— 是真隔离。
 *
 * 三个来源（后者覆盖前者同名项）
 * -----------------------------
 *   <agentDir>/mcp-catalog.json   候选池（自己手写的，不自动加载，只当候选）
 *   <agentDir>/mcp.json           用户级（所有会话都加载的那种）
 *   <cwd>/.pi/mcp.json            项目级（/ai 拉的线上连接会落到这里）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerPermissions } from "./permissions";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 一个 MCP server 的原始定义（直接透传 pi 的格式） */
export type McpServerDef = Record<string, unknown>;

export interface McpPool {
	/** 名字 → 定义 */
	servers: Record<string, McpServerDef>;
	/** 名字 → 来源标签（给 UI 显示用） */
	origin: Record<string, string>;
}

/** 影子目录要复制过去的「小配置」 */
const SHADOW_COPY = ["models.json", "auth.json", "models-store.json"];
// settings.json 单独处理：**不能整份复制** —— 里面的 packages 会让助理去重新克隆插件。

export function localCatalogPath(): string {
	return join(getAgentDir(), "mcp-catalog.json");
}

/** 本地 MCP 目录文件不存在就建一个空壳（这样用户知道去哪儿写） */
export function ensureCatalog(): string {
	const file = localCatalogPath();
	if (!existsSync(file)) {
		try {
			mkdirSync(getAgentDir(), { recursive: true });
			writeFileSync(file, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, "utf8");
		} catch {
			/* 建不了就算了，读的时候当空 */
		}
	}
	return file;
}

function readMcpFile(file: string): Record<string, McpServerDef> {
	try {
		const j = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: unknown };
		const s = j?.mcpServers;
		if (!s || typeof s !== "object" || Array.isArray(s)) return {};
		const out: Record<string, McpServerDef> = {};
		for (const [name, def] of Object.entries(s as Record<string, unknown>)) {
			if (def && typeof def === "object" && !Array.isArray(def)) out[name] = def as McpServerDef;
		}
		return out;
	} catch {
		return {};
	}
}

/** 合并三处来源（候选池 → 用户级 → 项目级，同名后者覆盖前者） */
export function loadMcpPool(cwd: string): McpPool {
	const servers: Record<string, McpServerDef> = {};
	const origin: Record<string, string> = {};
	const put = (file: string, label: string): void => {
		for (const [name, def] of Object.entries(readMcpFile(file))) {
			servers[name] = def;
			origin[name] = label;
		}
	};
	put(localCatalogPath(), "候选池");
	put(join(getAgentDir(), "mcp.json"), "用户级");
	put(join(cwd, ".pi", "mcp.json"), "项目级");
	return { servers, origin };
}

export interface ShadowResult {
	/** 影子目录的绝对路径 */
	dir: string;
	/** 实际写进去的 server 名字 */
	names: string[];
	/** 模板要了、但池子里找不到的名字 */
	missing: string[];
	/** 关键配置写失败的原因（非空 = 应该拒绝启动，别拿半截配置去跑） */
	errors: string[];
}

/**
 * 模板 key → 影子目录名。
 *
 * ⚠️ 不能只做「非 ASCII 换 _」：`我的示例数据库助理` 会被整串换成 `_________`，
 * 于是两个同字数的中文助理会撞同一个目录，**并行派发时互相覆盖 mcp.json**。
 * 所以末尾拼一个基于原名的短哈希 —— 名字不同目录必不同，还能看出是哪个助理。
 */
function safeName(s: string): string {
	const ascii = s
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, 32)
		.replace(/^_+|_+$/g, "");
	// FNV-1a，不引依赖，够用
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `${ascii || "assistant"}-${h.toString(36).padStart(6, "0")}`;
}

/**
 * 建（或刷新）某个助理的影子 agentDir，并返回路径。
 *
 * 复制过去：models.json / auth.json / settings.json / models-store.json（+ 可选 AGENTS.md）
 * 不复制：  trust.json（这样项目不会被信任 → 项目 .pi/mcp.json 不会 merge 回来）
 *          mcp.json（我们自己生成）
 *          sessions/ extensions/（保持子进程干净）
 */
export function buildShadow(
	key: string,
	want: string[],
	pool: McpPool,
	opts: { agentsMd?: boolean; exposure?: string; runSuffix?: string } = {},
): ShadowResult {
	const agentDir = getAgentDir();
	const errors: string[] = [];
	// 目录名加「本次派发」后缀：同一个助理并发派发时不再互相覆盖 mcp.json
	const suffix = opts.runSuffix ? `-${opts.runSuffix}` : "";
	const dir = join(agentDir, "shadow", `${safeName(key)}${suffix}`);
	mkdirSync(dir, { recursive: true });

	for (const f of SHADOW_COPY) {
		const src = join(agentDir, f);
		if (!existsSync(src)) continue;
		try {
			copyFileSync(src, join(dir, f));
		} catch {
			/* 单个文件失败不致命 */
		}
	}
	// settings.json：剔掉 packages 再写（否则助理会去重新克隆插件）
	const settingsSrc = join(agentDir, "settings.json");
	if (existsSync(settingsSrc)) {
		try {
			const raw = JSON.parse(readFileSync(settingsSrc, "utf8")) as Record<string, unknown>;
			delete raw.packages;
			writeFileSync(join(dir, "settings.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
		} catch {
			try {
				copyFileSync(settingsSrc, join(dir, "settings.json"));
			} catch {
				errors.push("settings.json 写入失败");
			}
		}
	}

	// 全局 AGENTS.md：要不要带上（关掉能省 ~1500 token/次）
	const agentMd = join(dir, "AGENTS.md");
	if (opts.agentsMd === false) {
		try {
			rmSync(agentMd, { force: true });
		} catch {
			/* ignore */
		}
	} else {
		const src = join(agentDir, "AGENTS.md");
		if (existsSync(src)) {
			try {
				copyFileSync(src, agentMd);
			} catch {
				/* ignore */
			}
		}
	}

	// 生成影子 mcp.json（空也要写，否则会沿用上一轮的内容）
	const chosen: Record<string, McpServerDef> = {};
	const missing: string[] = [];
	for (const name of want) {
		const def = pool.servers[name];
		if (!def) {
			missing.push(name);
			continue;
		}
		chosen[name] = opts.exposure ? { ...def, exposure: opts.exposure } : { ...def };
	}
	try {
		writeFileSync(join(dir, "mcp.json"), `${JSON.stringify({ mcpServers: chosen }, null, 2)}\n`, "utf8");
	} catch (e) {
		// 写不进去 = 助理会挂到错的 MCP（甚至一个都没有），宁可不起
		errors.push(`mcp.json 写入失败：${e instanceof Error ? e.message : String(e)}`);
	}

	return { dir, names: Object.keys(chosen), missing, errors };
}

/**
 * L3 兜底接线：把守卫装进影子目录（**只复制，不软链** —— 软链等于把源文件交给 Worker 改）。
 *
 * 写进去四样东西：
 *   <影子>/permissions.json      这个 Worker 的权限（guard 运行时读）
 *   <影子>/guard-config.json     { cwd, pluginDir, protectedPaths }
 *   <影子>/extensions/guard-entry.ts + perm-guard.ts   （pi 会自动发现 extensions/*.ts）
 *
 * 只在 Super Agent 模式开着时调用；关着就什么都不做（保持老的全权限行为）。
 * 返回写失败原因（非空也不致命：守卫缺失 = 退回老行为，别把派活搞挂）。
 */
export function installGuard(
	dir: string,
	opts: { perms: WorkerPermissions; cwd: string; pluginDir?: string; protectedPaths?: string[] },
): string[] {
	const errors: string[] = [];
	const here = dirname(fileURLToPath(import.meta.url));
	// 守卫源码从**插件源码目录**拿（delegate 传进来的 EXT_DIR）；没传就按本文件位置推
	const srcDir = opts.pluginDir ?? here;
	try {
		writeFileSync(join(dir, "permissions.json"), `${JSON.stringify(opts.perms, null, 2)}\n`, "utf8");
		writeFileSync(
			join(dir, "guard-config.json"),
			`${JSON.stringify(
				{ cwd: opts.cwd, pluginDir: srcDir, protectedPaths: opts.protectedPaths ?? [] },
				null,
				2,
			)}\n`,
			"utf8",
		);
	} catch (e) {
		errors.push(`guard 配置写入失败：${e instanceof Error ? e.message : String(e)}`);
		return errors;
	}

	const extDir = join(dir, "extensions");
	try {
		mkdirSync(extDir, { recursive: true });
		// ⚠️ perm-guard.ts 放进 **子目录**：pi 会把 `extensions/*.ts` 逐个当扩展加载，
		//    纯函数模块没有默认导出 → 直接放平会报「does not export a valid factory function」把 Worker 打死。
		//    自动发现只认 `extensions/*.ts` 和 `extensions/*/index.ts`，`extensions/guard/perm-guard.ts` 正好躲开。
		const guardDir = join(extDir, "guard");
		mkdirSync(guardDir, { recursive: true });
		const plan: [string, string][] = [
			["guard-entry.ts", join(extDir, "guard-entry.ts")],
			["perm-guard.ts", join(guardDir, "perm-guard.ts")],
		];
		for (const [from, to] of plan) {
			const src = join(srcDir, from);
			if (!existsSync(src)) {
				errors.push(`守卫源码缺失：${src}`);
				continue;
			}
			copyFileSync(src, to);
		}
	} catch (e) {
		errors.push(`守卫复制失败：${e instanceof Error ? e.message : String(e)}`);
	}
	return errors;
}

/** 助理会话根目录：刻意**不在** sessions/ 下，这样 pi 自带的 /resume 看不见助理会话 */
export function assistantSessionRoot(): string {
	return join(getAgentDir(), "assistant-sessions");
}

/** 影子目录的根（调试用） */
export function shadowRoot(): string {
	return join(getAgentDir(), "shadow");
}

/** 回收过期的影子目录（每次派发都会新建一个，session_start 时清超 24h 的） */
export function reapStaleShadowDirs(maxAgeMs = 24 * 60 * 60 * 1000): number {
	const root = shadowRoot();
	let entries: string[] = [];
	try {
		entries = readdirSync(root);
	} catch {
		return 0;
	}
	const now = Date.now();
	let removed = 0;
	for (const name of entries) {
		const p = join(root, name);
		try {
			if (now - statSync(p).mtimeMs > maxAgeMs) {
				rmSync(p, { recursive: true, force: true });
				removed++;
			}
		} catch {
			/* ignore */
		}
	}
	return removed;
}
