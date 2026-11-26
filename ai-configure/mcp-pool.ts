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
import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerPermissions } from "./permissions";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 一个 MCP server 的原始定义（直接透传 pi 的格式） */
export type McpServerDef = Record<string, unknown>;

/**
 * 助理 frontmatter 里 `mcp: inherit` 的**保留字**：
 * 不是候选池里的 server 名，而是「把这个 worker 该连的东西 = 主会话实际加载的那套」。
 * 允许和真名字混写：`mcp: inherit, center-pg`（同名时以显式写的为准）。
 */
export const MCP_INHERIT = "inherit";

export interface McpPool {
	/** 名字 → 定义 */
	servers: Record<string, McpServerDef>;
	/** 名字 → 来源标签（给 UI 显示用） */
	origin: Record<string, string>;
}

/** 影子目录要复制过去的「小配置」 */
const SHADOW_COPY = ["models.json", "auth.json", "models-store.json"];
// settings.json 单独处理：**不能整份复制** —— 里面的 packages 会让助理去重新克隆插件。

/**
 * 「压缩窗口百分比」→ pi 真正认的那个字段（v2.6.0）。
 *
 * pi 的压缩只在**绝对 token 阈值**上做文章（`compaction.reserveTokens` ＝ 窗口里给输出/系统
 * 留多少不用于历史），`docs/settings.md` 里没有百分比口径，也没有按项目/目录的开关：
 *   `contextTokens > contextWindow - reserveTokens` → 开始压缩
 * 所以「用到 60% 就压」只能在影子目录里换算成 `reserveTokens = (100% − 60%) × 窗口`。
 *
 * 注意：这是**兜底转换**，不是 pi 原生支持的百分比 —— 换模型（窗口变了）要重新派活才会刷新。
 */
export function compactReserveTokens(percent: number, contextWindow: number): number {
	const pct = Math.min(95, Math.max(30, Math.round(percent)));
	const win = Math.max(1000, Math.round(contextWindow));
	return Math.max(1, Math.round((win * (100 - pct)) / 100));
}

/**
 * 写进影子 settings.json 的压缩补丁：`{ compaction: { reserveTokens } }`。
 *
 * 返回 undefined 的条件（宁可不开，也不瞎写）：
 *   - `percent <= 0` → 用户显式说「不设」
 *   - 拿不到模型窗口 → 没法换算（pi 只认绝对 token）
 */
export function compactSettingsPatch(
	percent?: number,
	contextWindow?: number,
): { compaction: { reserveTokens: number } } | undefined {
	const p = Number(percent);
	if (!Number.isFinite(p) || p <= 0) return undefined;
	const w = Number(contextWindow);
	if (!Number.isFinite(w) || w <= 0) return undefined;
	return { compaction: { reserveTokens: compactReserveTokens(p, w) } };
}

/**
 * 影子目录必须能看见这两个本地二进制。
 * 缺了它们，pane 里起 pi 会打印 `fd not found. Downloading... / ripgrep not found. Downloading...`，
 * 卡几秒再 timeout（用户没梯子），每个子助理都要来一遍 —— 压测里最响的报警就是这个。
 */
const SHADOW_BINS = process.platform === "win32" ? ["fd.exe", "rg.exe"] : ["fd", "rg"];

/** 文件存在、是文件、非空（断链/空目录/半个复制都会在这里被判死） */
function binFileOk(p: string): boolean {
	try {
		const st = statSync(p);
		return st.isFile() && st.size > 0;
	} catch {
		return false;
	}
}

/** 目录项存在（含断链：断链的 existsSync 是 false，但 lstat 能看见） */
function entryExists(p: string): boolean {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

function shadowBinReady(binDir: string): boolean {
	return SHADOW_BINS.every((n) => binFileOk(join(binDir, n)));
}

/**
 * 保证 `<dir>/bin/{fd,rg}` 可用：优先 **目录 junction**（零成本，Windows 不需要管理员权限），
 * 建不成 / 建成了却读不到 → 退化成复制两个 exe。
 *
 * 返回 warning 列表（**绝不抛**）：这一步失败只是「启动时联网下载、慢几秒」，
 * 不该把整条派活搞挂（errors 是给「宁可不起」用的，别混）。
 */
export function ensureShadowBin(dir: string, agentDir: string): string[] {
	const warnings: string[] = [];
	const src = join(agentDir, "bin");
	const dest = join(dir, "bin");

	// 已经可用（上一次的 junction，或上次退化复制的）→ 什么都不动
	if (shadowBinReady(dest)) return warnings;

	// 存在但不可用（空目录 / 断链 / 只拷了一半）→ 先摘干净，否则 junction 会 EEXIST
	if (entryExists(dest)) {
		try {
			// 先 unlink：目录 junction 用 unlink 摘最安全（不会顺着链接去动目标）
			try {
				unlinkSync(dest);
			} catch {
				rmSync(dest, { recursive: true, force: true });
			}
		} catch (e) {
			warnings.push(`shadow bin 清不掉（残留）：${e instanceof Error ? e.message : String(e)}`);
			return warnings;
		}
	}

	// ① junction：一次就能让所有影子目录共享同一份 bin
	if (existsSync(src)) {
		try {
			symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
			if (shadowBinReady(dest)) return warnings;
			// 链建成了但目标里没有那两个 exe → 摘掉，走复制
			try {
				unlinkSync(dest);
			} catch {
				/* ignore */
			}
		} catch (e) {
			warnings.push(`shadow bin junction 失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ② 退化：复制两个 exe（约 8MB，只在 junction 不可用时发生）
	if (existsSync(src)) {
		try {
			mkdirSync(dest, { recursive: true });
			for (const n of SHADOW_BINS) {
				const from = join(src, n);
				if (!existsSync(from)) continue;
				copyFileSync(from, join(dest, n));
			}
		} catch (e) {
			warnings.push(`shadow bin 复制失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	if (!shadowBinReady(dest)) {
		const lack = SHADOW_BINS.filter((n) => !binFileOk(join(dest, n))).join("/");
		warnings.push(`shadow bin 缺 ${lack}（子助理启动时会联网下载，且没网就 timeout）`);
	}
	return warnings;
}

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

/**
 * 主会话会加载的 MCP（用户级 + 项目级，项目级覆盖同名）；**不含候选池**。
 *
 * 为什么单独一个函数：worker 是带 `-na` 跑的（忽略项目级资源），
 * 所以「继承主会话」不能指望它自己去读 `<cwd>/.pi/mcp.json` ——
 * 必须由我们把主会话会加载的那一份**显式写进影子目录**，否则项目级的一个都继承不到。
 */
export function mainSessionMcpServers(cwd: string): Record<string, McpServerDef> {
	const out: Record<string, McpServerDef> = {};
	for (const file of [join(getAgentDir(), "mcp.json"), join(cwd, ".pi", "mcp.json")]) {
		for (const [name, def] of Object.entries(readMcpFile(file))) out[name] = def;
	}
	return out;
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
	/** 其中来自「继承主会话」的那几个（被显式点名覆盖掉的不算）—— 卡片提示用 */
	inherited: string[];
	/** 模板要了、但池子里找不到的名字 */
	missing: string[];
	/** 关键配置写失败的原因（非空 = 应该拒绝启动，别拿半截配置去跑） */
	errors: string[];
	/** 不致命的问题（例如 bin 没接上 → 启动时会联网下载）：只记，不拦启动 */
	warnings: string[];
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
	opts: {
		agentsMd?: boolean;
		exposure?: string;
		runSuffix?: string;
		/**
		 * 「继承主会话」时要带进来的 server（调用方用 mainSessionMcpServers() 拿）。
		 * 只放这里传进来的这些 —— 候选池里没被点名的仍然一个都不带（隔离原则不变）。
		 */
		inheritServers?: Record<string, McpServerDef>;
		/**
		 * worker 的压缩窗口（%）：多少上下文用量时自动压缩（`superagent.workerCompactPercent`）。
		 * 0 / 不传 = 不写（用 pi 自己的默认阈值）。
		 */
		compactPercent?: number;
		/** 当前模型的上下文窗口（tokens）。拿不到就**不写**压缩配置（不瞎猜）。 */
		contextWindow?: number;
	} = {},
): ShadowResult {
	const agentDir = getAgentDir();
	const errors: string[] = [];
	const warnings: string[] = [];
	// 目录名加「本次派发」后缀：同一个助理并发派发时不再互相覆盖 mcp.json
	const suffix = opts.runSuffix ? `-${opts.runSuffix}` : "";
	const dir = join(agentDir, "shadow", `${safeName(key)}${suffix}`);
	mkdirSync(dir, { recursive: true });

	// bin：不给它接上 fd/rg，每个子助理启动都要联网下载一次（慢 + 报警）
	try {
		warnings.push(...ensureShadowBin(dir, agentDir));
	} catch (e) {
		warnings.push(`shadow bin 准备失败：${e instanceof Error ? e.message : String(e)}`);
	}

	for (const f of SHADOW_COPY) {
		const src = join(agentDir, f);
		if (!existsSync(src)) continue;
		try {
			copyFileSync(src, join(dir, f));
		} catch {
			/* 单个文件失败不致命 */
		}
	}
	// settings.json：剔掉 packages 再写（否则助理会去重新克隆插件）；再叠上压缩窗口。
	const settingsSrc = join(agentDir, "settings.json");
	const patch = compactSettingsPatch(opts.compactPercent, opts.contextWindow);
	let settings: Record<string, unknown> | undefined;
	let settingsBroken = false;
	if (existsSync(settingsSrc)) {
		try {
			const raw = JSON.parse(readFileSync(settingsSrc, "utf8")) as Record<string, unknown>;
			delete raw.packages;
			settings = raw;
		} catch {
			settingsBroken = true;
			try {
				copyFileSync(settingsSrc, join(dir, "settings.json"));
			} catch {
				errors.push("settings.json 写入失败");
			}
		}
	}
	if (patch) {
		if (settingsBroken) {
			// 原文件不是合法 JSON，已经原样复制了一份；**不覆盖**它（别把用户的配置搞没）
			warnings.push(`settings.json 不是合法 JSON，压缩窗口（${opts.compactPercent}%）没写进去`);
		} else {
			// 只盖 `compaction.reserveTokens`：用户原来写的 enabled / keepRecentTokens / modelOverrides 必须保住
			// （整块替换会把它们冲掉 —— 那等于替用户改了压缩策略）。
			const prev = (settings?.compaction ?? {}) as Record<string, unknown>;
			settings = { ...(settings ?? {}), compaction: { ...prev, ...patch.compaction } };
		}
	} else if (Number(opts.compactPercent) > 0) {
		warnings.push("拿不到模型上下文窗口，worker 压缩窗口没写（不会瞎猜 token 数）");
	}
	if (settings) {
		try {
			writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		} catch {
			errors.push("settings.json 写入失败");
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
	// 组装顺序：① 继承来的先放 → ② 显式点名的后放（同名覆盖 ①，即「显式写的为准」）
	// 继承来的定义**原样透传**（exposure 之类是主会话那份配置的事，我们不替它改）。
	const inherit = opts.inheritServers ?? {};
	const chosen: Record<string, McpServerDef> = {};
	for (const [name, def] of Object.entries(inherit)) chosen[name] = { ...def };
	const missing: string[] = [];
	for (const name of want) {
		// 池子里没有、但主会话本来就连着 → 用继承那份（`mcp: inherit, X` 里 X 没进候选池也不至于被拒）
		const def = pool.servers[name] ?? inherit[name];
		if (!def) {
			missing.push(name);
			continue;
		}
		chosen[name] = opts.exposure ? { ...def, exposure: opts.exposure } : { ...def };
	}
	// 真正「继承来的」= 继承里有、且没被显式点名顶掉（卡片上要说 N 个）
	const inherited = Object.keys(inherit).filter((n) => !want.includes(n));
	try {
		writeFileSync(join(dir, "mcp.json"), `${JSON.stringify({ mcpServers: chosen }, null, 2)}\n`, "utf8");
	} catch (e) {
		// 写不进去 = 助理会挂到错的 MCP（甚至一个都没有），宁可不起
		errors.push(`mcp.json 写入失败：${e instanceof Error ? e.message : String(e)}`);
	}

	return { dir, names: Object.keys(chosen), inherited, missing, errors, warnings };
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
		inheritUserExtensions(extDir, errors);
	} catch (e) {
		errors.push(`守卫复制失败：${e instanceof Error ? e.message : String(e)}`);
	}
	return errors;
}

/** 我们自己这套插件在 extensions/ 下的名字（不能带进影子，否则递归 + 双份 Router） */
const SELF_EXT_DIR = "ai-configure";

/**
 * 把**用户级扩展**继承进影子目录（v2.8.0）。
 *
 * 踩过的坑（别人的机器）：用户把内置 MCP 关了、改用 `pi-mcp-adapter` 扩展来加载 MCP。
 * 影子目录以前**只放我们自己的 guard**、一个用户扩展都不带 —— 于是 worker 里没有适配器，
 * `mcp: xxx` 声明得好好的，工具一个都挂不上，卡片却显示「连接 xxx」。
 *
 * 策略：
 *   - 目录 → 建 **junction**（零拷贝，Windows 不需要管理员权限）；建不成退回复制
 *   - 单文件 `.ts` → 复制（很小）
 *   - 跳过我们自己的 `ai-configure`，跳过已存在的同名项
 *   - **任何失败只记 warning，不抛**（少个扩展不该让整条派活挂掉）
 */
function inheritUserExtensions(extDir: string, errors: string[]): void {
	let entries: string[] = [];
	try {
		entries = readdirSync(join(getAgentDir(), "extensions"));
	} catch {
		return; // 用户没有 extensions 目录：正常
	}
	for (const name of entries) {
		if (name === SELF_EXT_DIR) continue;
		const from = join(getAgentDir(), "extensions", name);
		const to = join(extDir, name);
		if (existsSync(to)) continue;
		try {
			const st = statSync(from);
			if (st.isDirectory()) {
				try {
					symlinkSync(from, to, "junction"); // Windows 目录 junction，零成本
				} catch {
					cpSync(from, to, { recursive: true }); // 退回复制
				}
			} else if (st.isFile()) {
				copyFileSync(from, to);
			}
		} catch (e) {
			errors.push(`继承用户扩展失败（${name}）：${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

/** 助理会话根目录：刻意**不在** sessions/ 下，这样 pi 自带的 /resume 看不见助理会话 */
export function assistantSessionRoot(): string {
	return join(getAgentDir(), "assistant-sessions");
}

/** 影子目录的根（调试用） */
export function shadowRoot(): string {
	return join(getAgentDir(), "shadow");
}

/** 影子目录存活上限：一天派 50 个 × 每个带一份扩展副本，24h 会攒一堆旧代码快照 */
export const SHADOW_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * 回收过期的影子目录（每次派发都会新建一个，session_start 时清超 2h 的）
 *
 * 以前是 24h —— 实测一天攒了 50 个目录，每个 22~650KB 且各带一份**当时的**扩展代码副本，
 * 排查「为什么这个子助理行为不对」时会被这些旧快照骗。
 */
export function reapStaleShadowDirs(maxAgeMs = SHADOW_TTL_MS): number {
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
