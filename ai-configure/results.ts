/**
 * results.ts —— 子助理结果的**正文归档**（2.5.6 第一批）。
 *
 * 为什么要有它：批量任务原来只把 90 字摘要塞进回投卡，**完整正文从来没落盘** ——
 * 事后想看全文只能 `/resume-agent` 重载整个会话上下文（贵、慢、还常常超时）。
 * 现在的做法：正文写进 `<agentDir>/results/<YYYY-MM-DD>/<kind>-<id>.md`，
 * 回投卡里只给「状态 + 摘要 + 路径」，要看全文就 `/batch <id>`（零上下文成本）。
 *
 * 文件格式（Markdown + 手写 YAML-ish 头，**不引 yaml 库**）：
 *
 *   # 通用助理 · a6tffv-xxx
 *   - 状态: done
 *   - 开始: 2026-11-25T09:59:21+08:00
 *   - 结束: 2026-11-25T09:59:33+08:00
 *   - 摘要: 改完了 README 版式
 *   - 元信息: {"sessionId":"a6tffv-xxx","paneId":"w2:pQ"}
 *
 *   ---
 *
 *   <完整正文>
 *
 * 设计底线：**归档失败绝不影响任务本身** —— 所有对外函数自己 try/catch，
 * 写不进去就返回 `undefined`，绝不抛错（写盘失败只是没归档，不是任务失败）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readExtCfg } from "./shared";

/** 一份归档的内容（= 一个 `.md` 文件） */
export interface ArchivedResult {
	id: string; // 任务/批次 id
	kind: "task" | "batch";
	name: string; // 助理名 或 "批次"
	status: string; // done / failed / timeout / aborted
	startedAt?: number;
	finishedAt?: number;
	summary: string; // 一句话摘要（≤120 字）
	body: string; // 完整正文
	meta?: Record<string, unknown>; // 会话 id / pane id / 权限摘要等
}

/** `<agentDir>/results` 这一层 */
const RESULTS_DIR = "results";
/** 摘要硬上限（头部那一行不许无限长） */
const SUMMARY_MAX = 120;
/** 安全化之后 id 的最大长度（文件名不能撑爆文件系统） */
const SAFE_ID_MAX = 80;
/** 标题里名字的最大长度 */
const NAME_MAX = 80;
/** 默认保留天数（配置项 `superagent.resultsKeepDays`） */
const DEFAULT_KEEP_DAYS = 30;
const DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** 本地日期键 `YYYY-MM-DD`（归档按**本地**日期分目录，用户按天找才对得上） */
function dateKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时刻的 ISO-ish 字符串（带时区偏移）：`2026-11-25T09:59:21+08:00` */
function localIso(ms: number): string {
	const d = new Date(ms);
	const offMin = -d.getTimezoneOffset();
	const sign = offMin >= 0 ? "+" : "-";
	const abs = Math.abs(offMin);
	return `${dateKey(ms)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(
		Math.floor(abs / 60),
	)}:${pad2(abs % 60)}`;
}

/** 日期目录名 → 那天 00:00 的时间戳（本地时区；算年龄用） */
function dayStartMs(name: string): number {
	const [y, m, d] = name.split("-").map((x) => Number(x));
	return new Date(y, (m || 1) - 1, d || 1).getTime();
}

function todayStartMs(now: number = Date.now()): number {
	const d = new Date(now);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 按**日历天**加减（不是 `±days*86400000`）：
 * 后者遇上夏令时那天会差一小时，"恰好第 N 天"的目录就会误判成过期。
 */
function shiftDays(fromMs: number, days: number): number {
	const d = new Date(fromMs);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/** 压成一行并截断（头部的每个字段都必须是单行，否则解析就散了） */
function oneLine(s: unknown, max: number): string {
	const t = String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * id → 文件名片段：Windows 不允许 `: * ? " < > |`，路径分隔符更不能进文件名。
 * 统一换成 `_`，长度截到 `SAFE_ID_MAX`。
 */
function safeId(id: string): string {
	const s = String(id ?? "").replace(/[:*?"<>|\\/\r\n\t]/g, "_");
	return s.length > SAFE_ID_MAX ? s.slice(0, SAFE_ID_MAX) : s;
}

/** 归档根目录（全部日期目录的父目录） */
function resultsDirRoot(): string {
	return join(getAgentDir(), RESULTS_DIR);
}

/** 归档根目录：`<agentDir>/results/<YYYY-MM-DD>/` */
export function resultsRoot(now?: number): string {
	const ms = Number.isFinite(now) ? Number(now) : Date.now();
	return join(resultsDirRoot(), dateKey(ms));
}

/** 拼一份归档文件的正文（纯函数，单测友好） */
function renderArchive(r: ArchivedResult, finishedAt: number): string {
	const head: string[] = [`# ${oneLine(r.name || "助理", NAME_MAX)} · ${oneLine(r.id, NAME_MAX)}`];
	head.push(`- 状态: ${oneLine(r.status || "unknown", 40)}`);
	if (Number.isFinite(r.startedAt)) head.push(`- 开始: ${localIso(Number(r.startedAt))}`);
	head.push(`- 结束: ${localIso(finishedAt)}`);
	head.push(`- 摘要: ${oneLine(r.summary, SUMMARY_MAX)}`);
	if (r.meta && typeof r.meta === "object") {
		try {
			head.push(`- 元信息: ${JSON.stringify(r.meta)}`);
		} catch {
			/* 循环引用这种怪东西就干脆不写元信息，正文照写 */
		}
	}
	return `${head.join("\n")}\n\n---\n\n${String(r.body ?? "")}`;
}

/** 分隔符（写和读只认这一个，改一处就全对上） */
const BODY_SEP = "\n---\n";

/** 把一个 `.md` 的原文解析回 `ArchivedResult`（解析不了返回 undefined，绝不抛） */
function parseArchive(text: string, fileName: string): ArchivedResult | undefined {
	try {
		const raw = String(text ?? "");
		const at = raw.indexOf(BODY_SEP);
		const headRaw = at >= 0 ? raw.slice(0, at) : raw;
		// 写的时候是 `<头>\n\n---\n\n<正文>`，所以这里只吃掉分隔符后**那一个**换行，
		// 正文本身的换行（含 ``` 代码块）原样保留 → 读回来跟写进去逐字一致。
		const body = at >= 0 ? raw.slice(at + BODY_SEP.length).replace(/^\n/, "") : "";
		const lines = headRaw.split(/\r?\n/);
		const kind: ArchivedResult["kind"] = fileName.startsWith("batch-") ? "batch" : "task";

		let name = "";
		let id = "";
		const title = lines.find((l) => l.startsWith("# "));
		if (title) {
			const t = title.slice(2).trim();
			const sep = t.lastIndexOf(" · ");
			if (sep > 0) {
				name = t.slice(0, sep).trim();
				id = t.slice(sep + 3).trim();
			} else {
				name = t;
			}
		}
		const field = (key: string): string | undefined => {
			const pre = `- ${key}:`;
			const hit = lines.find((l) => l.startsWith(pre));
			return hit ? hit.slice(pre.length).trim() : undefined;
		};

		if (!id) {
			// 标题里没 id（手写的 / 老文件）→ 从文件名退回来
			id = fileName.replace(/\.md$/i, "").replace(/^(task|batch)-/, "");
		}

		const startedRaw = field("开始");
		const finishedRaw = field("结束");
		const metaRaw = field("元信息");
		let meta: Record<string, unknown> | undefined;
		if (metaRaw) {
			try {
				const m = JSON.parse(metaRaw) as unknown;
				if (m && typeof m === "object" && !Array.isArray(m)) meta = m as Record<string, unknown>;
			} catch {
				/* 元信息坏了就当没有，正文还能看 */
			}
		}
		const startedAt = startedRaw ? Date.parse(startedRaw) : NaN;
		const finishedAt = finishedRaw ? Date.parse(finishedRaw) : NaN;

		return {
			id,
			kind,
			name,
			status: field("状态") ?? "unknown",
			...(Number.isFinite(startedAt) ? { startedAt } : {}),
			...(Number.isFinite(finishedAt) ? { finishedAt } : {}),
			summary: field("摘要") ?? "",
			body,
			...(meta ? { meta } : {}),
		};
	} catch {
		return undefined;
	}
}

/** 一个归档文件（路径 + 日期目录名） */
interface ArchiveFile {
	file: string;
	day: string;
}

/** 现有日期目录，**新的在前** */
function dateDirs(): { dir: string; name: string }[] {
	let names: string[] = [];
	try {
		names = readdirSync(resultsDirRoot()).filter((n) => DIR_RE.test(n));
	} catch {
		return []; // 还没有归档目录 = 空列表，不是错
	}
	names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
	return names.map((name) => ({ dir: join(resultsDirRoot(), name), name }));
}

/** 某个日期目录下的归档文件 */
function filesIn(dir: string, day: string): ArchiveFile[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.toLowerCase().endsWith(".md"))
			.map((f) => ({ file: join(dir, f), day }));
	} catch {
		return [];
	}
}

/**
 * 写一份归档，返回**存档路径**。
 *
 * 失败（目录建不了 / 磁盘满 / 权限不够）→ 返回 `undefined`，**绝不抛错**：
 * 归档是附赠品，不能因为它把任务本身弄挂。
 */
export function archiveResult(r: ArchivedResult): string | undefined {
	if (!r || typeof r !== "object") return undefined;
	try {
		const finishedAt = Number.isFinite(r.finishedAt) ? Number(r.finishedAt) : Date.now();
		const dir = resultsRoot(finishedAt);
		mkdirSync(dir, { recursive: true }); // 目录不存在就建（含中间层）
		const kind: ArchivedResult["kind"] = r.kind === "batch" ? "batch" : "task";
		const file = join(dir, `${kind}-${safeId(r.id)}.md`);
		writeFileSync(file, renderArchive(r, finishedAt), "utf8");
		return file;
	} catch {
		return undefined;
	}
}

/**
 * 读回一份归档：`id` 或**路径**都认。
 * id 走日期目录**倒序**找（新的一天优先），所以同名 id 拿到的是最新的那份。
 */
export function readArchivedResult(idOrPath: string): ArchivedResult | undefined {
	const raw = String(idOrPath ?? "").trim();
	if (!raw) return undefined;
	// 看着像路径（给了 .md / 带分隔符）**且真的存在**就直接读：
	// 注意不能只看「带 / 或 \\」—— 脏 id 里也可能有斜杠，那还是得按 id 找。
	if (/\.md$/i.test(raw) || raw.includes("/") || raw.includes("\\")) {
		let isFile = false;
		try {
			isFile = existsSync(raw) && statSync(raw).isFile();
		} catch {
			isFile = false;
		}
		if (isFile) {
			try {
				const text = readFileSync(raw, "utf8");
				const name = raw.split(/[\\/]/).pop() ?? raw;
				return parseArchive(text, name);
			} catch {
				return undefined;
			}
		}
	}
	for (const { dir, name } of dateDirs()) {
		for (const f of filesIn(dir, name)) {
			const r = parseArchive(readFileSync(f.file, "utf8"), f.file.split(/[\\/]/).pop() ?? "");
			if (r && r.id === raw) return r;
		}
	}
	return undefined;
}

/** 归档的「时间」：结束时间优先，否则开始时间，再否则 0（老文件排最后） */
function stampOf(r: ArchivedResult): number {
	if (Number.isFinite(r.finishedAt)) return Number(r.finishedAt);
	if (Number.isFinite(r.startedAt)) return Number(r.startedAt);
	return 0;
}

/** 列出最近 `days` 天（默认 7）的归档，按时间倒序 */
export function listArchivedResults(days?: number): ArchivedResult[] {
	const n = Number.isFinite(days) ? Math.max(1, Math.floor(Number(days))) : 7;
	const cutoff = shiftDays(todayStartMs(), -(n - 1));
	const out: ArchivedResult[] = [];
	for (const { dir, name } of dateDirs()) {
		if (dayStartMs(name) < cutoff) continue; // 太老，跳过（目录已经倒序，可以直接 break，但保留 dayStart 更稳）
		for (const f of filesIn(dir, name)) {
			const r = parseArchive(readFileSync(f.file, "utf8"), f.file.split(/[\\/]/).pop() ?? "");
			if (r) out.push(r);
		}
	}
	out.sort((a, b) => stampOf(b) - stampOf(a));
	return out;
}

/**
 * 清理超过 `keepDays` 的日期目录（默认 30 天；启动时调一次）。
 *
 * `keepDays` 不给就走配置项；配置给了 `0` = **不清理**（返回 0，一个也不删）。
 * 返回删掉的天数。任何一次删除失败都跳过，不抛。
 */
export function pruneArchivedResults(keepDays?: number): number {
	const keep = Number.isFinite(keepDays) ? Number(keepDays) : resultsKeepDays();
	if (!(keep > 0)) return 0; // 0 / 负数 = 用户不想清理
	const cutoff = shiftDays(todayStartMs(), -(keep - 1));
	let removed = 0;
	for (const { dir, name } of dateDirs()) {
		if (!(dayStartMs(name) < cutoff)) continue;
		try {
			rmSync(dir, { recursive: true, force: true });
			removed += 1;
		} catch {
			/* 删不掉就留着，下次再说 */
		}
	}
	return removed;
}

/** 从配置读保留天数：`superagent.resultsKeepDays`，默认 30，0 = 不清理 */
export function resultsKeepDays(): number {
	try {
		const raw = readExtCfg().superagent;
		const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const v = Number(obj.resultsKeepDays);
		if (!Number.isFinite(v)) return DEFAULT_KEEP_DAYS;
		return Math.max(0, Math.floor(v));
	} catch {
		return DEFAULT_KEEP_DAYS;
	}
}

/** 生成回投里那行路径提示（纯函数，便于单测）：`结果：<path>` */
export function resultPathLine(path: string): string {
	return `结果：${String(path ?? "").trim()}`;
}
