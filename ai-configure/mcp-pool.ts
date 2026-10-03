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
 *   <agentDir>/mcp-catalog.json   本地目录（自己手写的，不自动加载，当兜底/候选）
 *   <agentDir>/mcp.json           用户级（所有会话都加载的那种）
 *   <cwd>/.pi/mcp.json            项目级（/ai 拉的线上连接会落到这里）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const SHADOW_COPY = ["models.json", "auth.json", "settings.json", "models-store.json"];

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

/** 合并三处来源（本地目录 → 用户级 → 项目级，同名后者覆盖前者） */
export function loadMcpPool(cwd: string): McpPool {
	const servers: Record<string, McpServerDef> = {};
	const origin: Record<string, string> = {};
	const put = (file: string, label: string): void => {
		for (const [name, def] of Object.entries(readMcpFile(file))) {
			servers[name] = def;
			origin[name] = label;
		}
	};
	put(localCatalogPath(), "本地目录");
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
}

function safeName(s: string): string {
	const t = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
	return t || "assistant";
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
	opts: { agentsMd?: boolean; exposure?: string } = {},
): ShadowResult {
	const agentDir = getAgentDir();
	const dir = join(agentDir, "shadow", safeName(key));
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
	} catch {
		/* ignore */
	}

	return { dir, names: Object.keys(chosen), missing };
}

/** 真实会话根目录（配合 --session-dir，保证子会话还能 pi --resume 找到） */
export function realSessionDir(): string {
	return join(getAgentDir(), "sessions");
}

/** 影子目录的根（调试用） */
export function shadowRoot(): string {
	return join(getAgentDir(), "shadow");
}
