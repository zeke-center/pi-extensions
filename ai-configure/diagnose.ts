/**
 * diagnose.ts —— 给别人（以及**读报告的另一个 AI**）用的全量自检报告（v2.9.0）
 *
 * 定位：这不是给人扫一眼的摘要，而是**交给 AI 排障的上下文包**。
 * 所以原则是「宁多勿少、事无巨细，但要有结构」：
 *   - 每个事实都写清「值 + 从哪来 + 意味着什么」
 *   - 配置原文、助理 frontmatter 原文、影子里的 mcp.json / permissions.json 都给全
 *   - 敏感信息（密码 / token）自动打码，并在报告里**明确列出哪些被打了码**
 *   - 最后附「已知问题」「推断」「还需要问用户什么」，让对面的 AI 能直接接着干活
 *
 * 纯函数：`buildDiagnoseReport(facts)` / `collectIssues(facts)` / `redactSecrets(s)`
 * 采集：`collectDiagnoseFacts(cwd, pluginVersion, piVersion)` —— 只读，失败降级成备注
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { badEnumValues, configConflicts, permSummary, type WorkerPermissions } from "./permissions";
import { loadTemplates, projectTrusted, shadowDetail } from "./delegate";
import { isSensitiveKey, redactArgList, redactDeep, redactSecrets } from "./redact";
import { readRecentLogs, summarizeLogs } from "./log";
import { loadMcpPool } from "./mcp-pool";
import { herdrStatus } from "./herdr";

// ======================= 类型 =======================

export interface DiagnoseIssue {
	level: "block" | "warn" | "info";
	text: string;
	fix?: string;
}

/** 文件存在性 + 摘要（配置类事实） */
export interface FileFact {
	path: string;
	exists: boolean;
	sizeBytes?: number;
	mtime?: string;
	/** 脱敏后的内容（截断） */
	content?: string;
	note?: string;
}

export interface DiagnoseAssistant {
	key: string;
	name: string;
	source: "项目" | "全局" | "包自带";
	file: string;
	/** 有没有被另一级的同名文件盖住 */
	shadowed: boolean;
	/** 同名但被盖住的那些文件（项目 > 全局 > 包自带；只有第一个生效） */
	ignoredFiles: string[];
	extends?: string;
	base: boolean;
	demo: boolean;
	desc: string;
	descMissing: boolean;
	perms: WorkerPermissions;
	mcp: string[];
	cwd?: string;
	cwdExists: boolean;
	timeoutMs?: number;
	maxTurns?: number;
	model?: string;
	conflicts: { code: string; text: string }[];
	badEnums: { key: string; value: string; allowed: string[]; used: string }[];
	/** 原始 frontmatter（脱敏，逐行） */
	frontmatterRaw?: string;
	/** 正文摘要（脱敏，前 400 字） */
	bodyHead?: string;
	/** 「它到底能干什么」的人话清单（由权限推导，供对面 AI 判断） */
	canDo: string[];
	cannotDo: string[];
}

export interface DiagnoseFacts {
	pluginVersion: string;
	piVersion: string;
	nodeVersion: string;
	os: string;
	cwd: string;
	agentDir: string;
	trusted?: boolean;
	globalConfig?: Record<string, unknown>;
	/** pi 自己的 settings.json（脱敏）—— 压缩阈值 / 扩展开关都在这，排障常要看 */
	piSettings?: Record<string, unknown>;
	projectConfig?: Record<string, unknown>;
	assistants: DiagnoseAssistant[];
	/** 候选池全量（含定义，env 值脱敏、key 保留） */
	mcpPool: { name: string; exposure?: string; command?: string; args?: string[]; envKeys?: string[]; note?: string }[];
	/** 每个助理实际会拿到的影子 mcp.json（关系到「到底注入了什么」） */
	shadowMcp?: FileFact;
	shadowPerms?: FileFact;
	/** 影子目录概况 */
	shadow: { count: number; newestMinutes?: number; newestName?: string; files?: string[] };
	/** 关键文件清单 */
	files: FileFact[];
	/** 已装扩展 / 插件包 */
	extensions?: string[];
	/** 最近任务（.bg 记录摘要） */
	taskHistory: { id: string; status: string; reason?: string; lastError?: string; elapsedMs?: number; note?: string }[];
	herdr: { ok: boolean; reason?: string; panes?: number; term?: string };
	logs: {
		/** 结构化事件统计（v2.10.0 新增，最重要的一段） */
		events?: { ev: string; lvl: string; count: number; last: string; sample?: string }[];
		/** 最近的 error/warn 原文（最多 50 条，已脱敏） */
		eventTail?: Record<string, unknown>[];
		guardTail: string[];
		herdrTail: string[];
		crashes: string;
		guardStats?: { kind: string; count: number }[];
	};
	notes: string[];
}

// ======================= 脱敏（实现搬到 redact.ts） =======================

export { isSensitiveKey, redactArgList, redactDeep, redactSecrets } from "./redact";

// ======================= 问题提炼 =======================

export function collectIssues(f: DiagnoseFacts): DiagnoseIssue[] {
	const out: DiagnoseIssue[] = [];
	if (f.trusted === false) {
		out.push({
			level: "warn",
			text: "项目未信任（pi 的 trust.json 判 false）→ 项目级 .pi 配置（助理 / MCP / settings）会被忽略，实际用的是全局那份",
			fix: "在主会话输入 /trust 保存信任决定，然后**重启 pi**（/reload 对已注册的工具不生效）",
		});
	}
	if (!f.herdr.ok) out.push({ level: "info", text: `Herdr 不可用（${f.herdr.reason || "未知"}）→ 子助理走面板卡片，功能不受影响` });
	for (const a of f.assistants) {
		for (const b of a.badEnums) {
			out.push({
				level: "warn",
				text: `助理「${a.key}」写了不认识的 ${b.key}: ${b.value}（合法 ${b.allowed.join("/")}）→ 实际按 ${b.used} 跑，看起来「配了却没生效」`,
				fix: `改成 ${b.key}: ${b.allowed[0]}`,
			});
		}
		for (const c of a.conflicts) out.push({ level: "warn", text: `助理「${a.key}」配置矛盾：${c.text}` });
		if (a.descMissing) out.push({ level: "warn", text: `助理「${a.key}」描述为空 → Router 挑不到它`, fix: `/assistants edit ${a.key} 补一句` });
		if (!a.cwdExists) out.push({ level: "block", text: `助理「${a.key}」的工作目录不存在：${a.cwd}`, fix: "改 cwd，或清空让它跟随当前项目" });
		for (const name of a.mcp) {
			if (name.toLowerCase() === "inherit") continue;
			if (!f.mcpPool.some((m) => m.name === name)) {
				out.push({
					level: "block",
					text: `助理「${a.key}」要连的 MCP「${name}」在候选池里找不到 → 派发会被拒或工具挂不上`,
					fix: "把定义加到 ~/.pi/agent/mcp-catalog.json，或改助理的 mcp 行",
				});
			}
		}
	}
	for (const m of f.mcpPool) {
		if (m.exposure === "codemode") {
			out.push({
				level: "info",
				text: `MCP「${m.name}」是 exposure=codemode → 它的工具**不会**以 mcp__${m.name}__* 出现，要用 codemode 里的 searchTools 找（别误判成「没注入」）`,
			});
		}
	}
	const failed = f.taskHistory.filter((t) => ["failed", "empty", "timeout"].includes(String(t.status)));
	if (failed.length) {
		out.push({ level: "warn", text: `最近 ${f.taskHistory.length} 次派活里有 ${failed.length} 次失败/空跑（详见「最近任务」段）` });
	}
	return out;
}

// ======================= 报告 =======================

const md = {
	/** 代码块：接受字符串（按行拆）或行数组 —— 以前只接数组，传字符串会被逐字拆开 */
	code: (label: string, body: string | string[]): string[] => {
		const ls = typeof body === "string" ? body.split(/\r?\n/) : body;
		return ["```" + label, ...(ls.length ? ls : ["(空)"]), "```"];
	},
	bullets: (arr: string[]): string[] => (arr.length ? arr.map((x) => `- ${x}`) : ["- (无)"]),
};

export function buildDiagnoseReport(f: DiagnoseFacts): string {
	const issues = collectIssues(f);
	const block = issues.filter((i) => i.level === "block");
	const warn = issues.filter((i) => i.level === "warn");
	const info = issues.filter((i) => i.level === "info");
	const L: string[] = [];

	// ---------- 0. 给读报告的 AI ----------
	L.push("# pi-extensions 自检报告（供 AI 排障用）", "");
	L.push("> **给读这份报告的 AI**：这是一个 pi 编码 agent 插件（`@zeke-center/pi-extensions`）的运行时快照。");
	L.push("> 报告由插件自己生成（`/aidoctor export`），事实优先、未经人工修饰；");
	L.push("> 敏感值（密码 / token / api key）已自动替换成 `***`，**键名保留**，所以你能判断「配了哪一项」但看不到值。");
	L.push("> 建议阅读顺序：结论 → 助理 → MCP → 影子目录 → 最近任务 → 日志尾巴。");
	L.push("> 需要更多信息时，看最后一节「还需要用户提供什么」。");
	L.push("");
	L.push(`生成时间：${new Date().toISOString()}`);
	L.push(`插件版本：${f.pluginVersion}　pi：${f.piVersion}　node：${f.nodeVersion}`);
	L.push(`系统：${f.os}　项目目录（cwd）：${f.cwd}`, "");

	// ---------- 1. 结论 ----------
	L.push("## 1. 结论", "");
	if (!block.length && !warn.length) L.push("✅ 没发现会导致故障的问题。", "");
	else {
		if (block.length) L.push(`❌ 严重问题 **${block.length}** 个（会导致派活失败 / 配置不生效）`);
		if (warn.length) L.push(`⚠ 需要注意 **${warn.length}** 个`);
		L.push("");
		for (const i of [...block, ...warn]) {
			L.push(`- ${i.level === "block" ? "❌" : "⚠"} ${i.text}`);
			if (i.fix) L.push(`  - 修法：${i.fix}`);
		}
		L.push("");
	}
	if (info.length) {
		L.push("补充说明（不影响使用）：", "");
		L.push(...md.bullets(info.map((i) => i.text)), "");
	}

	// ---------- 2. 环境 ----------
	L.push("## 2. 环境与路径", "");
	L.push(...md.code("", [
		`插件版本        ${f.pluginVersion}`,
		`pi 版本         ${f.piVersion}`,
		`node            ${f.nodeVersion}`,
		`系统            ${f.os}`,
		`项目目录 cwd    ${f.cwd}`,
		`agentDir        ${f.agentDir}`,
		`项目信任状态    ${f.trusted === undefined ? "(trust.json 里没有记录 → 按未明确处理)" : f.trusted ? "已信任 true" : "未信任 false"}`,
		`Herdr           ${f.herdr.ok ? `可用（pane ${f.herdr.panes ?? "?"} 个${f.herdr.term ? `，term=${f.herdr.term}` : ""}）` : `不可用（${f.herdr.reason || "未知原因"}）`}`,
		`影子目录        ${f.shadow.count} 个${f.shadow.newestMinutes !== undefined ? `，最新 ${f.shadow.newestMinutes} 分钟前` : ""}${f.shadow.newestName ? `（${f.shadow.newestName}）` : ""}`,
	]), "");
	if (f.extensions?.length) {
		L.push("已装的 pi 扩展（`~/.pi/agent/extensions/`）：", "");
		L.push(...md.bullets(f.extensions), "");
	}

	// ---------- 3. 关键文件 ----------
	L.push("## 3. 关键文件清单", "");
	L.push("| 文件 | 存在 | 大小 | 修改时间 | 说明 |", "|---|---|---|---|---|");
	for (const x of f.files) {
		L.push(
			`| \`${x.path}\` | ${x.exists ? "✅" : "❌"} | ${x.sizeBytes ?? "-"} | ${x.mtime ?? "-"} | ${x.note ?? ""} |`,
		);
	}
	L.push("");

	// ---------- 4. 配置 ----------
	L.push("## 4. 配置（已脱敏）", "", "全局 `<agentDir>/ai-extensions.json`：", "");
	L.push(...md.code("json", JSON.stringify(redactDeep(f.globalConfig ?? {}), null, 2)), "");

	L.push("<agentDir>/settings.json" + "（pi 自己的全局设置，脱敏）：", "");
	L.push(...md.code("json", JSON.stringify(redactDeep(f.piSettings ?? {}), null, 2)), "");
	L.push("项目 `<cwd>/.pi/ai-extensions.json`（无则空对象）：", "");
	L.push(...md.code("json", JSON.stringify(redactDeep(f.projectConfig ?? {}), null, 2)), "");
	L.push("> 注意：项目级会**覆盖**全局同名项（`superagent.enabled` 等）；所以「全局关了但项目里开着」是正常现象。", "");

	// ---------- 5. 助理 ----------
	L.push("## 5. 助理（子代理）逐个说明", "");
	if (!f.assistants.length) L.push("（一个都没有）", "");
	for (const a of f.assistants) {
		L.push(`### 5.${f.assistants.indexOf(a) + 1} \`${a.key}\` — ${a.name}`, "");
		L.push(...md.code("", [
			`来源        ${a.source}${a.shadowed ? "　⚠ 同名文件有 " + a.ignoredFiles.length + " 份被盖住（见下）" : ""}`,
			`文件        ${a.file}`,
			`类型        ${a.base ? "底座（base，只读，只能被 extends）" : a.demo ? "示例（demo，不能派）" : "可派发"}`,
			`extends     ${a.extends ?? "(无)"}`,
			`描述        ${a.descMissing ? "⚠ 空（Router 挑不到它）" : a.desc}`,
			`工作目录    ${a.cwd ?? "(跟随当前项目)"}${a.cwdExists ? "" : "   ⚠ 不存在"}`,
			`权限        ${permSummary(a.perms)}`,
			`MCP         ${a.mcp.length ? a.mcp.join(", ") : "(不连，默认隔离)"}`,
			`模型        ${a.model ?? "(继承主会话)"}`,
			`超时        ${a.timeoutMs ? `${Math.round(a.timeoutMs / 60000)} 分钟` : "(默认)"}`,
			`轮数上限    ${a.maxTurns ?? "(用全局配置)"}`,
		]), "");
		L.push("**它能做 / 不能做（由权限推导）**：", "", "能做：", ...md.bullets(a.canDo), "", "不能做：", ...md.bullets(a.cannotDo), "");
		if (a.ignoredFiles.length) {
			L.push("**被盖住的同名文件**（这些**没有生效**，改它们没用）：", "");
			for (const f of a.ignoredFiles) L.push("- " + "`" + f + "`");
			L.push("");
		}
		if (a.badEnums.length || a.conflicts.length) {
			L.push("**配置问题**：", "");
			for (const b of a.badEnums) L.push(`- ⚠ \`${b.key}: ${b.value}\` 不认识（合法 ${b.allowed.join(" / ")}）→ 实际按 \`${b.used}\` 运行`);
			for (const c of a.conflicts) L.push(`- ⚠ [${c.code}] ${c.text}`);
			L.push("");
		}
		if (a.frontmatterRaw) {
			L.push("原始 frontmatter（脱敏）：", "");
			L.push(...md.code("yaml", a.frontmatterRaw.split(/\r?\n/)), "");
		}
		if (a.bodyHead) {
			L.push("正文开头（400 字，脱敏）：", "");
			L.push(...md.code("", a.bodyHead.split(/\r?\n/).slice(0, 12)), "");
		}
	}

	// ---------- 6. MCP ----------
	L.push("## 6. MCP（候选池 + 实际注入）", "");
	L.push("候选池来源：`<agentDir>/mcp-catalog.json` 与 `<cwd>/.pi/mcp.json`（后者要项目已信任）。", "");
	if (!f.mcpPool.length) L.push("（候选池是空的）", "");
	else {
		L.push("| server | exposure | command | args | env 键名 | 备注 |", "|---|---|---|---|---|---|");
		for (const m of f.mcpPool) {
			L.push(
				`| \`${m.name}\` | ${m.exposure ?? "(默认)"} | ${m.command ?? "-"} | ${(m.args ?? []).join(" ") || "-"} | ${(m.envKeys ?? []).join(", ") || "-"} | ${m.note ?? ""} |`,
			);
		}
		L.push("");
	}
	L.push("**关于 exposure**：`direct` 的 MCP 工具会以 \`mcp__<名字>__<工具>\` 出现在工具清单里；");
	L.push("\`codemode\` 的**不会**直接出现，要通过 \`codemode\` 里的 \`searchTools()\` / \`describeTool()\` 访问 —— **别把「没有 mcp__* 工具」当成「MCP 没注入」**。", "");
	if (f.shadowMcp?.exists) {
		L.push("最近一个影子目录里**实际写入**的 `mcp.json`（这就是 Worker 真正会加载的）：", "");
		L.push(...md.code("json", String(f.shadowMcp.content ?? "").split(/\r?\n/)), "");
	}
	if (f.shadowPerms?.exists) {
		L.push("影子里的 `permissions.json`（L3 守卫读的就是这个）：", "");
		L.push(...md.code("json", String(f.shadowPerms.content ?? "").split(/\r?\n/)), "");
	}

	// ---------- 7. 影子目录 ----------
	L.push("## 7. 影子目录（Worker 的 PI_CODING_AGENT_DIR）", "");
	L.push(`共 ${f.shadow.count} 个；每个 Worker 一个，带自己的一份 \`mcp.json\` / \`permissions.json\` / \`settings.json\`。`, "");
	if (f.shadow.files?.length) {
		L.push("最新那个的文件清单：", "");
		L.push(...md.bullets(f.shadow.files), "");
	}

	// ---------- 8. 最近任务 ----------
	L.push("## 8. 最近任务（.bg 记录，最多 20 条）", "");
	if (!f.taskHistory.length) L.push("（没有记录）", "");
	else {
		L.push("| id | 状态 | 判定原因 | 耗时 | 提示 | 最后一次错误 |", "|---|---|---|---|---|---|");
		for (const t of f.taskHistory) {
			L.push(`| \`${t.id}\` | ${t.status} | ${t.reason ?? "-"} | ${t.elapsedMs ? `${Math.round(t.elapsedMs / 1000)}s` : "-"} | ${t.note ?? "-"} | ${(t.lastError ?? "").slice(0, 120) || "-"} |`);
		}
		L.push("");
	}

	// ---------- 9. 日志 ----------
	L.push("## 9. 日志（已脱敏）", "");

	// 9a. 结构化事件（v2.10.0）—— 先看这段，通常一眼就能定位
	L.push("### 9a. 最近 3 天事件统计（最重要）", "");
	L.push("> 这些是插件自己埋的点：每条都是**真实发生过**的事实，不是推测。");
	L.push("> `worker.mode=rpc` 说明分屏降级了；`herdr.degrade` 说明本会话不再试分屏；");
	L.push("> `dispatch.reject` 说明派活被拒了（括号里是原因）；`perm.deny` 说明守卫拦了一次工具调用。", "");
	if (!f.logs.events?.length) {
		L.push("（没有事件记录。可能是：① 日志功能关着 ② 最近 3 天没派过活 ③ `<agentDir>/logs/` 被清掉了）", "");
	} else {
		L.push("| 事件 | 级别 | 次数 | 最后发生 | 样例（错误/原因） |", "|---|---|---|---|---|");
		for (const e of f.logs.events.slice(0, 40)) {
			const lv = e.lvl === "error" ? "❌ error" : e.lvl === "warn" ? "⚠️ warn" : "info";
			const when = String(e.last).replace("T", " ").replace("Z", "");
			L.push("| " + "`" + e.ev + "`" + " | " + lv + " | " + e.count + " | " + when + " | " + (e.sample ? String(e.sample).slice(0, 120) : "") + " |");
		}
		L.push("");
	}
	if (f.logs.eventTail?.length) {
		L.push("### 9b. 最近的 error / warn 原文（最多 50 条）", "");
		L.push("```json");
		for (const r of f.logs.eventTail) L.push(JSON.stringify(r));
		L.push("```", "");
	}

	// 9c. 老的纯文本日志（向后兼容）
	L.push("### 9c. 旧日志尾巴", "");
	if (f.logs.guardStats?.length) {
		L.push("guard 命中统计：", "");
		L.push(...md.bullets(f.logs.guardStats.map((g) => `${g.kind}: ${g.count} 次`)), "");
	}
	L.push("`guard.log`（最近 200 行）：", "");
	L.push(...md.code("", f.logs.guardTail.map(redactSecrets)), "");
	L.push("`herdr.log`（最近 100 行）：", "");
	L.push(...md.code("", f.logs.herdrTail.map(redactSecrets)), "");
	L.push("崩溃记录（`<agentDir>/crashes.json`）：", "");
	L.push(...md.code("", [redactSecrets(f.logs.crashes)]), "");

	// ---------- 10. 采集备注 ----------
	if (f.notes.length) {
		L.push("## 10. 采集过程中的问题（这些信息本报告里可能缺失）", "");
		L.push(...md.bullets(f.notes.map(redactSecrets)), "");
	}

	// ---------- 11. 还需要用户提供什么 ----------
	L.push("## 11. 还需要用户提供什么（给对面的 AI）", "");
	L.push(...md.bullets([
		"**具体现象**：点哪个命令 / 派了哪个助理 / 期望什么 / 实际看到什么（越具体越好，比如卡片原文）",
		"**是否重启过 pi**：`/reload` 对已注册的工具不生效，改完代码必须重启进程",
		"**失败那次的会话 ID**（卡片上的 `sessionId`）：可以 `/resume-agent` 看过程，或 `/batch <id>` 看归档正文",
		"**如果涉及 MCP**：那个 server 的 command 能不能在终端里手动跑起来（这决定是「注入问题」还是「server 本身起不来」）",
		"**如果涉及网络/数据库**：目标地址是否可达、凭据是否有效（**不要贴密码**，只说「能否连通」）",
	]), "");
	L.push("---", "本报告由插件自动生成；密码 / token 已打码，项目路径与库名按原样保留。");
	return L.join("\n");
}

// ======================= 采集 =======================

const readText = (p: string, limit = 8000): string | undefined => {
	try {
		const s = readFileSync(p, "utf8");
		return s.length > limit ? `${s.slice(0, limit)}\n…（截断，原文件 ${s.length} 字）` : s;
	} catch {
		return undefined;
	}
};

const fileFact = (p: string, note?: string, withContent = false): FileFact => {
	try {
		const st = statSync(p);
		const fact: FileFact = {
			path: p,
			exists: true,
			sizeBytes: st.size,
			mtime: new Date(st.mtimeMs).toISOString().slice(0, 19).replace("T", " "),
			...(note ? { note } : {}),
		};
		if (withContent) {
			const raw = readText(p);
			if (raw !== undefined) {
				try {
					fact.content = JSON.stringify(redactDeep(JSON.parse(raw)), null, 2);
				} catch {
					fact.content = redactSecrets(raw);
				}
			}
		}
		return fact;
	} catch {
		return { path: p, exists: false, ...(note ? { note } : {}) };
	}
};

/** 由权限推导「能做/不能做」（给对面 AI 直接判断，不用自己推） */
export function capabilityLines(p: WorkerPermissions): { canDo: string[]; cannotDo: string[] } {
	const can: string[] = [];
	const cannot: string[] = [];
	if (p.fs === "write") {
		can.push(p.paths.length ? `改文件：仅限 ${p.paths.join("、")}（相对工作目录）` : "改文件：任意路径（插件源码 / ~/.pi / .git 除外）");
	} else {
		can.push("读文件：任意路径");
		cannot.push("改文件：完全不能（fs=read）");
	}
	if (p.exec === "any") can.push("跑命令：不限");
	else if (p.exec === "safe") {
		can.push(p.cmds.length ? `跑命令：仅白名单 ${p.cmds.join("、")}` : "跑命令：白名单为空 = 实际不能跑");
		if (!p.cmds.length) cannot.push("跑命令：白名单空 → 等于禁止");
	} else cannot.push("跑命令：完全不能（exec=none）");
	if (p.net === "allow") can.push("联网：允许（MCP / psql / curl 等都可能连）");
	else {
		cannot.push("联网：不允许 —— 联网类工具被摘掉，bash 里的 psql/curl/wget/ssh/git push/npm install 会被拦");
		cannot.push("MCP：若模板写了 mcp:，需要 net=allow 才能起得来");
	}
	if (p.budget) can.push(`预算声明：${p.budget}（仅显示，不做实际限制）`);
	return { canDo: can, cannotDo: cannot };
}

/**
 * pi 版本兜底：`ctx.getVersion()` 很多版本根本没有（报告里会变成「(未知)」，
 * 那整份报告的可比性就没了）。这里直接读 pi 包的 `package.json`，再退到 `npm ls` 之外的常见位置。
 */
export function detectPiVersion(): string {
	const cands = [
		join(dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
		join(process.env.APPDATA ?? "", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
		join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
	];
	for (const p of cands) {
		try {
			const j = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
			if (j.version) return j.version;
		} catch {
			/* 下一个 */
		}
	}
	return "(未知)";
}

export function collectDiagnoseFacts(cwd: string, pluginVersion: string, piVersion = "(未知)"): DiagnoseFacts {
	const notes: string[] = [];
	const agentDir = getAgentDir();
	const readJson = (p: string): Record<string, unknown> | undefined => {
		try {
			return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	};

	// ---- 助理 ----
	let tpls: ReturnType<typeof loadTemplates> = [];
	try {
		tpls = loadTemplates(cwd);
	} catch (e) {
		notes.push(`读助理模板失败：${e instanceof Error ? e.message : String(e)}`);
	}
	let shadowMap = new Map<string, string[]>();
	try {
		shadowMap = shadowDetail(cwd, tpls);
	} catch {
		/* 忽略 */
	}
	const globalDir = join(agentDir, "assistants");
	const projDir = join(cwd, ".pi", "assistants");
	const sourceOf = (file: string): DiagnoseAssistant["source"] =>
		file.startsWith(globalDir) ? "全局" : file.startsWith(projDir) ? "项目" : "包自带";

	const assistants: DiagnoseAssistant[] = tpls.map((t) => {
		let badEnums: DiagnoseAssistant["badEnums"] = [];
		let frontmatterRaw: string | undefined;
		let bodyHead: string | undefined;
		try {
			const raw = readFileSync(t.file, "utf8");
			const fm: Record<string, string> = {};
			for (const line of raw.split(/\r?\n/)) {
				const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
				if (m) fm[m[1].toLowerCase()] = m[2].trim();
			}
			badEnums = badEnumValues(fm);
			const end = raw.indexOf("\n---", 3);
			frontmatterRaw = redactSecrets(end > 0 ? raw.slice(0, end + 4) : raw.split(/\r?\n/).slice(0, 30).join("\n"));
			const body = end > 0 ? raw.slice(end + 4).trim() : "";
			bodyHead = redactSecrets(body.slice(0, 400));
		} catch {
			notes.push(`读助理原文失败：${t.file}`);
		}
		const cap = capabilityLines(t.perms);
		return {
			key: t.key,
			name: t.name,
			source: sourceOf(t.file),
			file: t.file,
			shadowed: shadowMap.has(t.key),
			ignoredFiles: shadowMap.get(t.key) ?? [],
			extends: t.extends,
			base: t.base === true,
			demo: t.demo === true,
			desc: t.desc,
			descMissing: !String(t.desc ?? "").trim() || t.desc === "(没有描述)",
			perms: t.perms,
			mcp: t.mcp ?? [],
			cwd: t.cwd,
			cwdExists: !t.cwd || existsSync(t.cwd),
			timeoutMs: t.timeoutMs,
			maxTurns: t.maxTurns,
			model: t.model,
			conflicts: configConflicts(t),
			badEnums,
			frontmatterRaw,
			bodyHead,
			canDo: cap.canDo,
			cannotDo: cap.cannotDo,
		};
	});

	// ---- MCP 候选池 ----
	let mcpPool: DiagnoseFacts["mcpPool"] = [];
	try {
		const pool = loadMcpPool(cwd);
		mcpPool = Object.entries(pool.servers ?? {}).map(([name, def]) => {
			const d = def as { exposure?: string; command?: string; args?: string[]; env?: Record<string, string>; description?: string };
			return {
				name,
				exposure: d.exposure,
				command: d.command,
				args: d.args ? redactArgList(d.args) : undefined,
				envKeys: d.env ? Object.keys(d.env) : [],
				note: d.description,
			};
		});
	} catch (e) {
		notes.push(`读 MCP 候选池失败：${e instanceof Error ? e.message : String(e)}`);
	}

	// ---- 影子目录 ----
	let shadow: DiagnoseFacts["shadow"] = { count: 0 };
	let shadowMcp: FileFact | undefined;
	let shadowPerms: FileFact | undefined;
	try {
		const root = join(agentDir, "shadow");
		const entries = readdirSync(root)
			.map((d) => {
				try {
					return { d, t: statSync(join(root, d)).mtimeMs };
				} catch {
					return { d, t: 0 };
				}
			})
			.sort((a, b) => b.t - a.t);
		const newest = entries[0];
		shadow = {
			count: entries.length,
			newestMinutes: newest?.t ? Math.round((Date.now() - newest.t) / 60000) : undefined,
			newestName: newest?.d,
		};
		if (newest) {
			const dir = join(root, newest.d);
			try {
				shadow.files = readdirSync(dir).map((x) => `\`${x}\``);
			} catch {
				/* 忽略 */
			}
			shadowMcp = fileFact(join(dir, "mcp.json"), "Worker 实际加载的 MCP 清单", true);
			shadowPerms = fileFact(join(dir, "permissions.json"), "L3 守卫读的权限", true);
		}
	} catch {
		/* 没有影子目录：正常 */
	}

	// ---- Herdr ----
	let herdr: DiagnoseFacts["herdr"] = { ok: false, reason: "探测失败" };
	try {
		const st = herdrStatus() as { ok: boolean; reason?: string; panes?: number; term?: string };
		herdr = { ok: st.ok, reason: st.reason, panes: st.panes, term: st.term };
	} catch (e) {
		herdr = { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}

	// ---- 关键文件 ----
	const files: FileFact[] = [
		fileFact(join(agentDir, "ai-extensions.json"), "全局配置"),
		fileFact(join(cwd, ".pi", "ai-extensions.json"), "项目配置（覆盖全局）"),
		fileFact(join(agentDir, "trust.json"), "pi 的项目信任记录"),
		fileFact(join(agentDir, "mcp-catalog.json"), "MCP 候选池"),
		fileFact(join(agentDir, "mcp.json"), "用户级 MCP（会被影子覆盖）"),
		fileFact(join(cwd, ".pi", "mcp.json"), "项目级 MCP（需已信任）"),
		fileFact(join(agentDir, "settings.json"), "pi 全局设置"),
		fileFact(join(agentDir, "extensions"), "已装扩展目录"),
		fileFact(join(agentDir, "assistants"), "全局助理目录"),
		fileFact(projDir, "项目级助理目录"),
		fileFact(join(cwd, "guard.log"), "守卫日志（本项目的）"),
		fileFact(join(agentDir, "herdr.log"), "Herdr 探测日志"),
		fileFact(join(agentDir, "crashes.json"), "崩溃记录"),
	];

	// ---- 扩展列表 ----
	let extensions: string[] | undefined;
	try {
		extensions = readdirSync(join(agentDir, "extensions"));
	} catch {
		extensions = undefined;
	}

	// ---- 任务历史 ----
	const taskHistory: DiagnoseFacts["taskHistory"] = [];
	try {
		const bgDir = join(agentDir, "assistant-sessions", ".bg");
		const rows = readdirSync(bgDir)
			.filter((x) => x.endsWith(".json"))
			.map((x) => {
				try {
					const st = statSync(join(bgDir, x));
					const j = JSON.parse(readFileSync(join(bgDir, x), "utf8")) as Record<string, unknown>;
					return { x, st, j };
				} catch {
					return undefined;
				}
			})
			.filter((r): r is { x: string; st: ReturnType<typeof statSync>; j: Record<string, unknown> } => Boolean(r))
			.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
			.slice(0, 20);
		for (const r of rows) {
			taskHistory.push({
				id: String(r.j.id ?? r.x).slice(0, 60),
				status: String(r.j.status ?? "?"),
				reason: r.j.reason === undefined ? undefined : String(r.j.reason),
				lastError: r.j.lastError === undefined ? undefined : redactSecrets(String(r.j.lastError)),
				elapsedMs: typeof r.j.elapsedMs === "number" ? r.j.elapsedMs : undefined,
				note: r.j.note === undefined ? undefined : String(r.j.note),
			});
		}
	} catch {
		/* 没有 .bg：正常 */
	}

	// ---- 日志 + 统计 ----
	const tailOf = (file: string, n: number): string[] => {
		try {
			return readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-n);
		} catch {
			return [];
		}
	};
	const guardTail = tailOf(join(cwd, "guard.log"), 200);
	const guardStats: { kind: string; count: number }[] = [];
	try {
		const counts = new Map<string, number>();
		for (const line of guardTail) {
			const m = line.match(/\b(ROUTER_DENY|ROUTER_NARROW_PARTIAL|WOULD_BLOCK|BLOCK|L1_MASK|DENY)\b\s*([a-z]*)/i);
			const key = m ? `${m[1]}${m[2] ? `:${m[2]}` : ""}` : undefined;
			if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		for (const [kind, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) guardStats.push({ kind, count });
	} catch {
		/* 忽略 */
	}
	let crashes = "(没有记录)";
	const c = readJson(join(agentDir, "crashes.json"));
	if (Array.isArray(c) && c.length) {
		const last = c[c.length - 1] as Record<string, unknown>;
		crashes = `共 ${c.length} 条，最近：${String(last.at ?? last.time ?? "?")} ${String(last.reason ?? last.message ?? "").slice(0, 160)}`;
	}

	return {
		pluginVersion,
		piVersion: piVersion && piVersion !== "(未知)" ? piVersion : detectPiVersion(),
		nodeVersion: process.version,
		os: `${platform()} ${release()}`,
		cwd,
		agentDir,
		trusted: projectTrusted(cwd),
		globalConfig: readJson(join(agentDir, "ai-extensions.json")),
	piSettings: readJson(join(agentDir, "settings.json")),
		projectConfig: readJson(join(cwd, ".pi", "ai-extensions.json")),
		assistants,
		mcpPool,
		shadowMcp,
		shadowPerms,
		shadow,
		files,
		extensions,
		taskHistory,
		herdr,
		logs: {
			events: summarizeLogs(),
			eventTail: readRecentLogs(50, { lvl: "warn" }).rows,
			guardTail,
			herdrTail: tailOf(join(agentDir, "herdr.log"), 100),
			crashes,
			guardStats,
		},
		notes,
	};
}

/** 报告落在项目里，好找、随项目走 */
export function diagnoseFilePath(cwd: string): string {
	return join(cwd, ".pi", "pi-extensions-diagnose.md");
}

export function writeDiagnoseReport(f: DiagnoseFacts): { path: string; text: string } | { error: string } {
	const text = buildDiagnoseReport(f);
	try {
		const p = diagnoseFilePath(f.cwd);
		mkdirSync(join(f.cwd, ".pi"), { recursive: true }); // 项目里可能还没有 .pi 目录
		writeFileSync(p, `${text}\n`, "utf8");
		return { path: p, text };
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

export function diagnoseSummaryLine(f: DiagnoseFacts): string {
	const issues = collectIssues(f);
	const block = issues.filter((i) => i.level === "block").length;
	const warn = issues.filter((i) => i.level === "warn").length;
	if (!block && !warn) return "✅ 自检通过：没发现问题";
	return `❌ ${block} 个严重 / ⚠ ${warn} 个注意`;
}
