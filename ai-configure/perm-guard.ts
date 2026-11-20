/**
 * perm-guard.ts —— L3 兜底：Worker 侧的权限守卫（**纯函数**，不碰 pi 运行时，可单测）。
 *
 * 为什么还要这一层（L1 已经不发工具了、L2 已经写进提示词了）
 * ----------------------------------------------------------
 * L1 是「动作空间里没这个选项」，但只要有一条缝隙就会漏：
 *   - 模板用 `tools:` 显式列了 write（人的手滑）
 *   - MCP 工具/子代理自己带写能力（红队式的间接越界）
 *   - 模型把 `bash` 留着没删干净（老模板、-xt 只减没加，但仍可能残留）
 * L3 就是那个**保险丝**：真到要落盘/要执行的那一刻再判一次。
 *
 * 三条设计原则（很重要，别改回去）
 * ------------------------------
 * 1. **fail-open**：参数结构不认识 → 放行。守卫的价值是拦「明确越界」，
 *    不是拦「我没看懂」。看不懂就拦会把 Worker 锁死，比不拦更糟。
 * 2. **exec / net 先只记录（logOnly）**：先观察一段时间真实误拦率，再切硬拦。
 * 3. **拒绝文案要给出路**：只写 "EPERM" 模型就会开始穷举重试；写了替代方案才会收手。
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { WorkerPermissions } from "./permissions";

export type GuardKind = "protected" | "fs" | "exec" | "net";

export interface GuardDecision {
	/** 是否要拒（logOnly 时为 true = 「本该拒，但这次只记录」） */
	block: boolean;
	kind?: GuardKind;
	reason?: string;
	/** 只写日志不真拦（观察期用） */
	logOnly?: boolean;
}

/** 会写文件的工具（名字按 pi 内置工具 + 常见别名） */
const WRITE_TOOLS = ["write", "edit", "apply_patch", "multiedit", "multi_edit", "patch"];
/** 会执行命令的工具 */
const EXEC_TOOLS = ["bash", "shell", "exec", "powershell", "run_command", "terminal"];
/** 名字里带这些词的，当成网络类工具 */
const NET_HINTS = ["fetch", "http", "web", "curl", "request"];

/** 这些 key 可能是「目标路径」（按顺序取第一个字符串） */
const PATH_KEYS = ["path", "file_path", "filePath", "target", "filename", "file", "dir", "destination"];
const CMD_KEYS = ["command", "cmd", "script", "shell", "commandLine"];

// ======================= 路径工具 =======================

/** `~` 展开（只在**开头**，避免把命令里的 ~ 也展开） */
function expandHome(p: string): string {
	return p.replace(/^~(?=[/\\]|$)/, homedir());
}

/** `${cwd}` / `$CWD` 占位符展开 */
function expandCwd(p: string, cwd: string): string {
	return p.replace(/\$\{cwd\}/gi, cwd).replace(/^\$cwd(?=[/\\]|$)/i, cwd);
}

/**
 * 归一化 + 防 symlink 逃逸：对**最深的已存在祖先**做 realpath，再把还不存在的尾部拼回去。
 * 只对整条路径 realpath 的话，「要新建的文件」一定报错，等于防线失效。
 */
export function realish(p: string): string {
	const abs = resolve(p);
	let cur = abs;
	const tail: string[] = [];
	for (let i = 0; i < 64; i++) {
		try {
			const rp = realpathSync(cur);
			return tail.length ? join(rp, ...tail) : rp;
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return abs; // 到根了还不行 → 退回纯字面归一化
			tail.unshift(basename(cur));
			cur = parent;
		}
	}
	return abs;
}

function norm(p: string): string {
	// Windows 路径不分大小写；统一去尾分隔符，避免 C:\a\ vs C:\a
	const s = p.replace(/[/\\]+$/, "");
	return process.platform === "win32" ? s.toLowerCase() : s;
}

/** child 是否在 parent 里（含相等） */
function isInside(child: string, parent: string): boolean {
	const c = norm(child);
	const p = norm(parent);
	if (!p) return false;
	if (c === p) return true;
	return c.startsWith(p + sep) || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`);
}

/** `.git` 目录（任意层级）：路径里**任何一段**叫 .git 都算 */
function inGitDir(p: string): boolean {
	return p.split(/[/\\]+/).some((seg) => seg.toLowerCase() === ".git");
}

/** 硬保护目标（每次现算，避免 import 时就定死 homedir） */
function hardProtected(): string[] {
	const agent = join(homedir(), ".pi", "agent");
	return [
		join(agent, "extensions"),
		join(agent, "assistants"),
		join(agent, "shadow"),
		join(agent, "ai-extensions.json"),
		join(agent, "mcp-catalog.json"),
		join(agent, "mcp.json"),
	];
}

// ======================= 参数抽取（抽不到 = 放行） =======================

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** 从参数里找目标路径；找不到返回 undefined（= 不认识这个结构，别误伤） */
export function extractPath(args: unknown, cwd: string): string | undefined {
	const raw: string[] = [];
	const rec = asRecord(args);
	if (rec) {
		for (const k of PATH_KEYS) {
			const v = rec[k];
			if (typeof v === "string" && v.trim()) raw.push(v.trim());
		}
		// apply_patch / 多文件工具：files: [{path}] 或 file_paths: [...]
		const files = rec.files;
		if (Array.isArray(files)) {
			for (const f of files) {
				const fr = asRecord(f);
				const v = fr?.path ?? fr?.file_path;
				if (typeof v === "string" && v.trim()) raw.push(v.trim());
			}
		}
		const paths = rec.paths ?? rec.file_paths;
		if (Array.isArray(paths)) {
			for (const v of paths) if (typeof v === "string" && v.trim()) raw.push(v.trim());
		}
	} else if (typeof args === "string" && args.trim()) {
		raw.push(args.trim());
	}
	const first = raw[0];
	if (!first) return undefined;
	const expanded = expandCwd(expandHome(first), cwd);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** 从参数里找命令串；找不到返回 undefined */
export function extractCommand(args: unknown): string | undefined {
	const rec = asRecord(args);
	if (rec) {
		for (const k of CMD_KEYS) {
			const v = rec[k];
			if (typeof v === "string" && v.trim()) return v.trim();
		}
		const argv = rec.argv ?? rec.args;
		if (Array.isArray(argv)) {
			const parts = argv.filter((x): x is string => typeof x === "string");
			if (parts.length) return parts.join(" ");
		}
	}
	if (typeof args === "string" && args.trim()) return args.trim();
	return undefined;
}

// ======================= 拒绝文案 =======================

const ADVICE: Record<GuardKind, string[]> = {
	protected: [
		"要改的是**工作目录里**的对应文件（不是插件源码 / agent 配置 / .git）",
		"把要改的内容写进回执，让派你的人改",
		"改 git 历史用 `git` 命令，别直接写 .git/",
	],
	fs: [
		"换个路径：写进工作目录（`${cwd}`）里",
		"把方案交回执，让派你的人落地",
		"确实需要写这里 → 让派你的人把该目录加进 paths",
	],
	exec: [
		"用只读工具拿到信息（read / grep）",
		"换成白名单里的命令（例如 `npm test`、`npx tsc`）",
		"让派你的人去执行这条命令",
	],
	net: [
		"用本地已有的数据 / 文件",
		"让派你的人去联网取，再把结果给你",
	],
};

export function denyText(kind: GuardKind, why: string): string {
	const lines = [
		`EPERM[${kind}] ${why}`,
		"这是策略性拒绝：换参数、换路径、换工具都不会成功，不要重试。",
		"可继续的动作：",
		...ADVICE[kind].map((a, i) => `  ${i + 1}. ${a}`),
	];
	return lines.join("\n");
}

function deny(kind: GuardKind, why: string, opts: { logOnly?: boolean } = {}): GuardDecision {
	return { block: true, kind, reason: denyText(kind, why), ...(opts.logOnly ? { logOnly: true } : {}) };
}

// ======================= 命令白名单 =======================

/** 一条规则是否匹配命令：末尾 `*` = 前缀匹配；否则「完全相同」或「同一条命令带参数」 */
export function cmdMatches(rule: string, command: string): boolean {
	const r = rule.trim();
	const c = command.trim();
	if (!r) return false;
	if (r.endsWith("*")) {
		const pre = r.slice(0, -1).trim();
		return pre ? c.startsWith(pre) : true;
	}
	return c === r || c.startsWith(`${r} `) || c.startsWith(`${r}\t`);
}

// ======================= 主判定 =======================

export interface GuardOpts {
	/** Worker 的工作目录（`${cwd}` 与相对路径都按它展开） */
	cwd: string;
	/** 额外保护目录（调用方传：本插件源码目录等）；会与内置硬保护取并集 */
	protectedPaths: string[];
}

/**
 * 判一次工具调用。**纯函数**：不吃环境、不写文件、不抛异常。
 *
 * 优先级：protected（硬拦）→ fs → exec（logOnly）→ net（logOnly）
 */
export function decideToolCall(
	perms: WorkerPermissions,
	opts: GuardOpts,
	toolName: string,
	args: unknown,
): GuardDecision {
	try {
		return decide(perms, opts, String(toolName ?? ""), args);
	} catch {
		// 守卫自己炸了 → 放行（fail-open），绝不能让保险丝把 Worker 锁死
		return { block: false };
	}
}

function decide(perms: WorkerPermissions, opts: GuardOpts, toolName: string, args: unknown): GuardDecision {
	const name = toolName.toLowerCase();
	const cwd = opts.cwd ? resolve(expandHome(opts.cwd)) : process.cwd();
	const isWrite = WRITE_TOOLS.includes(name) || /(^|_)(write|edit|patch)/.test(name);
	const isExec = EXEC_TOOLS.includes(name) || name === "bash";

	// 只有写/执行类才需要看目标路径
	const target = isWrite || isExec ? extractPath(args, cwd) : undefined;

	// ---------- 1. protected：硬拦（写/执行都不许碰） ----------
	if (target) {
		const protectedDirs = [...hardProtected(), ...(opts.protectedPaths ?? [])]
			.filter((p) => typeof p === "string" && p.trim())
			.map((p) => realish(resolve(cwd, expandCwd(expandHome(p.trim()), cwd))));
		const real = realish(target);
		const hit = protectedDirs.find((d) => isInside(real, d));
		if (hit) return deny("protected", `目标落在受保护位置：${target}（受保护：${hit}）`);
		if (inGitDir(real) || inGitDir(target)) return deny("protected", `目标在 .git 目录里：${target}`);
	}

	// ---------- 2. fs ----------
	if (isWrite) {
		// 参数结构不认识（提不出路径）→ 放行。守卫只拦「明确的越界」，不拦「我没看懂」；
		// 写类工具本身在 L1 层就不发了（fs=read 时没有 write/edit），所以这里 fail-open 是安全的。
		if (!target) return { block: false };
		if (perms.fs === "read") {
			return deny("fs", `当前 Worker 是 fs=read（只读），不能写文件：${target ?? "(未识别路径)"}`);
		}
		// fs=write：paths 为空 = 不额外限制（和 permissions.ts 的既有语义一致）；非空则必须落在里面
		const allow = (perms.paths ?? [])
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => realish(resolve(cwd, expandCwd(expandHome(p), cwd))));
		if (allow.length) {
			const real = realish(target);
			if (!allow.some((d) => isInside(real, d))) {
				return deny("fs", `路径不在可写范围（paths）里：${target}；允许：${perms.paths.join("、")}`);
			}
		}
	}

	// ---------- 3. exec：**观察期只记录** ----------
	if (isExec && perms.exec !== "any") {
		const cmd = extractCommand(args);
		if (perms.exec === "none") {
			// 全禁是「明确越界」，硬拦（L1 本来就不给它 bash，走到这儿已经是异常路径）
			return deny("exec", `当前 Worker 是 exec=none（不能执行命令）：${cmd ?? "(未识别命令)"}`);
		}
		// exec=safe：先只记录，观察期结束再切硬拦
		if (cmd && !(perms.cmds ?? []).some((r) => cmdMatches(r, cmd))) {
			return deny("exec", `命令不在白名单（cmds）里：${cmd}`, { logOnly: true });
		}
	}

	// ---------- 4. net：只记录 ----------
	if (perms.net === "none" && NET_HINTS.some((h) => name.includes(h))) {
		return deny("net", `当前 Worker 是 net=none（不可联网），工具：${toolName}`, { logOnly: true });
	}

	return { block: false };
}

/** 一行摘要（写 guard.log 用） */
export function summarizeCall(toolName: string, args: unknown): string {
	const p = extractPath(args, process.cwd());
	const c = extractCommand(args);
	const bit = p ?? c ?? (args === undefined ? "" : JSON.stringify(args));
	const s = String(bit ?? "").replace(/\s+/g, " ").trim();
	return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}
