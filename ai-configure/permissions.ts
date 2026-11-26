/**
 * permissions.ts —— Worker 的能力权限（Super Agent 的"你能不能干这件事"）。
 *
 * 这份配置要**同时**变成三样东西（三层表达，缺一层就会出现"先试再被拦"的难看体验）：
 *
 *   L1 工具面（最强）：fs=read 就不发 write/edit；exec=none 就不发 bash —— **动作空间里没这个选项**
 *   L2 声明面（省钱）：这段权限写进 Worker 的提示词，让它**规划时就不设计越界步骤**
 *   L3 兜底面（保险丝）：guard 在 tool_call 里拦（还没做，本文件先负责解析与声明）
 *
 * frontmatter 里就 6 个扁平键（和现有风格一致，解析器只认 key: value）：
 *
 *   fs: read | write                 默认 read
 *   paths: src/, tests/              可写目录（相对 cwd；支持 ${cwd}）
 *   exec: none | safe | any          默认 none；safe = 只允许 cmds 里的命令
 *   cmds: npm test*, npx tsc*        safe 档的白名单（逗号分隔，支持末尾 * 前缀匹配）
 *   net: none | allow                默认 none
 *   budget: 120k/10m                 token 预算 / 时间预算（只做声明，暂不强制）
 *
 * 为什么默认这么保守：默认是 read/none/none，**要写、要跑、要联网都得显式打开**。
 * 反过来（默认全开、出事再关）会让人误以为"已经限制住了"，比不限制更危险。
 */

export type FsMode = "read" | "write";
export type ExecMode = "none" | "safe" | "any";
export type NetMode = "none" | "allow";

export interface WorkerPermissions {
	fs: FsMode;
	/** 可写目录（相对 cwd）；空 = 不额外限制（但 fs=read 时仍然只读） */
	paths: string[];
	exec: ExecMode;
	/** safe 档的白名单命令（支持 "npm test*" 这种前缀通配） */
	cmds: string[];
	net: NetMode;
	/** token / 时间预算，只用于声明与卡片显示 */
	budget?: string;
}

export const PERM_DEFAULTS: WorkerPermissions = {
	fs: "read",
	paths: [],
	exec: "none",
	cmds: [],
	net: "none",
};

const FS_VALUES: FsMode[] = ["read", "write"];
const EXEC_VALUES: ExecMode[] = ["none", "safe", "any"];
const NET_VALUES: NetMode[] = ["none", "allow"];

function split(s: string | undefined): string[] {
	return (s ?? "")
		.split(/[,，]/)
		.map((x) => x.trim())
		.filter(Boolean);
}

/** 从 frontmatter 的原始键值解析（不认识 / 写错了一律回默认，绝不让一个字段把派活搞挂） */
/**
 * 上次 `parsePerms` 遇到的非法枚举值（模块级记账，供面板/卡片/aidoctor 报出来）。
 *
 * 为什么需要：`exec: restrict`、`net: yes` 这种写错的值以前**静默回落默认**，
 * 用户以为改好了，实际一直跑默认 —— 「改了没反应」的头号原因。
 */
let lastBadEnums: { key: string; value: string; allowed: string[]; used: string }[] = [];

/** 读走（并清空）上一次解析到的非法值 */
export function takeBadEnums(): { key: string; value: string; allowed: string[]; used: string }[] {
	const out = lastBadEnums;
	lastBadEnums = [];
	return out;
}

/** 直接问「这些 frontmatter 值里哪些是不认识的」（纯函数，不依赖上次解析） */
export function badEnumValues(fm: Record<string, string | undefined>): { key: string; value: string; allowed: string[]; used: string }[] {
	const out: { key: string; value: string; allowed: string[]; used: string }[] = [];
	const check = (key: string, allowed: readonly string[], fallback: string) => {
		const raw = String(fm[key] ?? "").trim();
		if (!raw) return;
		if (allowed.includes(raw.toLowerCase())) return;
		out.push({ key, value: raw, allowed: [...allowed], used: fallback });
	};
	check("fs", FS_VALUES, PERM_DEFAULTS.fs);
	check("exec", EXEC_VALUES, PERM_DEFAULTS.exec);
	check("net", NET_VALUES, PERM_DEFAULTS.net);
	return out;
}

export function parsePerms(fm: Record<string, string | undefined>): WorkerPermissions {
	lastBadEnums = badEnumValues(fm);
	const fs = String(fm.fs ?? "").trim().toLowerCase();
	const exec = String(fm.exec ?? "").trim().toLowerCase();
	const net = String(fm.net ?? "").trim().toLowerCase();
	return {
		fs: FS_VALUES.includes(fs as FsMode) ? (fs as FsMode) : PERM_DEFAULTS.fs,
		paths: split(fm.paths),
		exec: EXEC_VALUES.includes(exec as ExecMode) ? (exec as ExecMode) : PERM_DEFAULTS.exec,
		cmds: split(fm.cmds),
		net: NET_VALUES.includes(net as NetMode) ? (net as NetMode) : PERM_DEFAULTS.net,
		budget: (fm.budget ?? "").trim() || undefined,
	};
}

/** 这 6 个键（用于判断"子模板有没有显式写过权限"，决定要不要继承父模板） */
export const PERM_KEYS = ["fs", "paths", "exec", "cmds", "net", "budget"] as const;

export function permsDeclared(fm: Record<string, string | undefined>): boolean {
	return PERM_KEYS.some((k) => (fm[k] ?? "").trim() !== "");
}

/** 面板里的 enum 选项 ↔ 真实值（顺序要和 options 对应） */
export const FS_OPTIONS = ["只读", "可写"];
export const FS_KEYS: FsMode[] = ["read", "write"];
export const EXEC_OPTIONS = ["禁止执行", "只允许白名单命令", "不限"];
export const EXEC_KEYS: ExecMode[] = ["none", "safe", "any"];
export const NET_OPTIONS = ["禁止联网", "允许联网"];
export const NET_KEYS: NetMode[] = ["none", "allow"];

/** enum 值 → 面板显示 */
export function toLabel(keys: readonly string[], options: readonly string[], v: string): string {
	const i = keys.indexOf(v);
	return options[i >= 0 ? i : 0] ?? options[0] ?? v;
}

/** enum 显示 → 真实值 */
export function fromLabel(keys: readonly string[], options: readonly string[], label: string): string {
	const i = options.indexOf(label);
	return keys[i >= 0 ? i : 0] ?? keys[0] ?? "";
}

/** 一行摘要（面板值列 / 卡片里用）：`读写 2 个目录 · 白名单 3 条 · 无网` */
export function permSummary(p: WorkerPermissions): string {
	const fsBit = p.fs === "read" ? "只读" : p.paths.length ? `可写 ${p.paths.length} 个目录` : "可写（不限目录）";
	const execBit =
		p.exec === "none" ? "不执行" : p.exec === "any" ? "命令不限" : `白名单 ${p.cmds.length} 条`;
	const netBit = p.net === "none" ? "无网" : "可联网";
	const budgetBit = p.budget ? ` · 预算 ${p.budget}` : "";
	return `${fsBit} · ${execBit} · ${netBit}${budgetBit}`;
}

/**
 * 配置矛盾检测（纯函数）：**声明面和事实面打架**的地方，必须说出来。
 *
 * 踩过的坑：助理写了 `mcp: dbx`、`net: none` ——
 *   - 卡片「连接 (dbx)」看起来一切正常
 *   - 实际 MCP 是「子进程 + 走网络」，被 `net: none` 拦掉 → **一个工具都没挂上**
 * 用户看到的"连上了"和实际"什么都没有"完全相反。
 *
 * `mcp` 里若含 `inherit` 也照样算「要连 MCP」（继承主会话也是要走网络的）。
 * 返回空数组 = 没矛盾。每条都带可执行的修法。
 */
export function configConflicts(tpl: { mcp: string[]; perms: WorkerPermissions }): { code: string; text: string }[] {
	const out: { code: string; text: string }[] = [];
	const wantsMcp = (tpl.mcp ?? []).length > 0;
	const names = (tpl.mcp ?? []).filter((n) => n.toLowerCase() !== "inherit");
	if (wantsMcp && tpl.perms.net !== "allow") {
		const which = names.length ? names.join(", ") : "inherit";
		out.push({
			code: "mcp-net",
			text: `声明连 MCP（${which}）但 net=${tpl.perms.net}：MCP 是子进程且要联网，会被拦掉 → 一个工具都挂不上。要连就把 net 设成 allow`,
		});
	}
	if (tpl.perms.fs === "write" && tpl.perms.paths.length === 0) {
		out.push({
			code: "write-all",
			text: "fs=write 且可写目录留空 = 全盘可写（插件源码/~/.pi/.git 除外）。建议至少写一个目录",
		});
	}
	if (tpl.perms.exec === "cmds" && tpl.perms.cmds.length === 0) {
		out.push({
			code: "exec-empty",
			text: "exec=cmds 但白名单是空的 = 什么命令都不能跑。要么写命令，要么改成 none",
		});
	}
	return out;
}

/** 卡片「连接」行的**事实**写法：矛盾时直接说明挂不上，而不是假装连上了 */
export function mcpFactLine(tpl: { mcp: string[]; perms: WorkerPermissions }): string {
	if (!(tpl.mcp ?? []).length) return "(不连 MCP)";
	const joined = tpl.mcp.join(", ");
	if (tpl.perms.net !== "allow") {
		return `${joined}（⚠ 挂不上：net=${tpl.perms.net}，MCP 起不来 → 0 个工具）`;
	}
	return joined;
}

/** 多行详情（面板右栏用） */
export function permDetail(p: WorkerPermissions): string {
	const lines: string[] = [];
	lines.push(`**文件**：${p.fs === "read" ? "只读（不能改任何文件）" : "可写"}`);
	if (p.fs === "write") {
		lines.push(p.paths.length ? `  可写目录：${p.paths.join("、")}` : "  可写目录：不限（谨慎 —— 等于全盘可写）");
		lines.push("  默认保护：插件源码、`~/.pi/agent/**`、`.git` 一律不可写");
	}
	lines.push(`**命令**：${p.exec === "none" ? "不能执行任何命令" : p.exec === "any" ? "随意执行（等于给 shell）" : "只允许白名单"}`);
	if (p.exec === "safe") {
		lines.push(p.cmds.length ? `  白名单（${p.cmds.length}）：${p.cmds.join("、")}` : "  白名单是空的 → 等于禁止执行");
	}
	lines.push(`**网络**：${p.net === "none" ? "不可用" : "允许（可以拉依赖 / 调外部接口）"}`);
	if (p.budget) lines.push(`**预算**：${p.budget}（超了让它收尾）`);
	lines.push("");
	lines.push("这份权限会：① 决定给它哪些工具 ② 写进它的提示词（让它一开始就不越界）③ 派发时拦越界动作。");
	return lines.join("\n");
}

/**
 * L2：注入 Worker 系统提示的那段。**模式关着时不要加**（省 token）。
 *
 * 写法要点（很重要，别改回去）：
 *   - 明确"越界不会成功"，断掉它"试试看"的念头
 *   - 给**替代方案**（找派它的人 / 换做法），而不是只给拒绝
 *   - 结尾一句"不要尝试绕过"，这是唯一能减少穷举行为的提示词手段
 */
export function permissionRule(p: WorkerPermissions, cwd: string): string {
	const lines: string[] = ["【你的权限】（越界不会成功，不要尝试绕过）"];
	const scope = cwd ? `（工作目录 ${cwd}）` : "";
	lines.push(
		`- 文件：${p.fs === "read" ? "**只读**，不要尝试写任何文件" : p.paths.length ? `可写：${p.paths.join("、")}；其它位置只读` : "可写（不限目录）"}${scope}`,
	);
	lines.push(
		`- 命令：${p.exec === "none" ? "**不能执行命令**（没有 bash）" : p.exec === "any" ? "可执行命令" : `只能用这些命令：${p.cmds.length ? p.cmds.map((c) => `\`${c}\``).join(" ") : "（无）→ 等于不能执行"}`}`,
	);
	lines.push(`- 网络：${p.net === "none" ? "**不可用**" : "可用"}`);
	if (p.budget) lines.push(`- 预算：${p.budget}（接近上限时先收尾交回执，不要开新活）`);
	lines.push("");
	lines.push("做不到的事：直接说明「需要什么权限」，让派你的人决定；**不要换工具、换路径、换写法去绕**。");
	return lines.join("\n");
}

/**
 * 预设：新建助理 / 面板里一键套用。
 *
 * dev   = 能改当前目录、能跑常见检查、能装依赖（日常开发默认）
 * reader= 只读、不跑、不联网（查数据 / 看服务器）
 */
export const PERM_PRESETS: Record<"dev" | "reader", WorkerPermissions> = {
	dev: {
		fs: "write",
		paths: ["${cwd}"],
		exec: "safe",
		cmds: ["npm test*", "npm run build*", "npx tsc*", "pytest*", "git status*", "git diff*", "git log*", "rg *"],
		net: "allow",
	},
	reader: { fs: "read", paths: [], exec: "none", cmds: [], net: "none" },
};
