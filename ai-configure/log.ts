/**
 * 插件运行时事件日志（v2.10.0）
 *
 * 为什么要有它：插件出问题（分屏降级、Worker 起不来、MCP 挂不上、回投失败）时，
 * 以前只在零散的地方留痕（guard.log 只记拒绝、herdr.log 只有几行、.bg 没有失败原因），
 * 事后根本没法定性。这里给一个**小、便宜、会自己清理**的埋点通道：
 *
 * - 一行一个 JSON（JSONL），按天滚：`<agentDir>/logs/events-YYYY-MM-DD.jsonl`
 * - 保留 3 天；单文件 4MB、总目录 20MB 上限；超了删最旧的
 * - 内存缓冲 50 条 / 1 秒 flush 一次，`appendFileSync` 批量落盘（不阻塞主流程）
 * - **写日志失败一律静默**：日志绝不能把插件拖垮（fail-open）
 * - 所有值走 redactDeep（和自检报告同一套打码规则）
 * - 限流：同 ev + 同 key 10 秒内只记第一条 + 累计次数（防每秒轮询刷爆）
 *
 * 用法：
 *   logEvent("herdr.split.fail", { where: "w2", err: msg });
 *   logError("worker.spawn.fail", e, { assistant: "db" });
 *   logTimed("mcp.attach", ms, { server: "dbx" });   // >1000ms 自动升 warn
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { redactDeep } from "./redact";

export type LogLevel = "info" | "warn" | "error";

/** 保留天数（默认 3）—— 出问题会立刻导报告，不需要留很久 */
export const LOG_RETAIN_DAYS = 3;
/** 单文件上限 4MB，超了换一个新文件 */
export const LOG_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** 总目录上限 20MB */
export const LOG_DIR_MAX_BYTES = 20 * 1024 * 1024;
/** 缓冲满多少条就 flush */
export const LOG_FLUSH_ROWS = 50;
/** 最多隔多久 flush（毫秒） */
export const LOG_FLUSH_MS = 1000;
/** 限流窗口：同事件同 key 在这个窗口内只记一条 */
export const LOG_DEDUPE_MS = 10_000;
/** 慢操作阈值：超过就自动升 warn */
export const LOG_SLOW_MS = 1000;

const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

let buf: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let rowsSinceClean = 0;
/** 限流表：key → { at, n } */
const dedupe = new Map<string, { at: number; n: number }>();
/** 当前会话短 id（由 delegate 在 session_start 时设置） */
let sessionTag: string | undefined;
let cwdTag: string | undefined;
let minLevel: LogLevel = "info";
let enabled = true;

export function logsDir(): string {
	return join(getAgentDir(), "logs");
}

export function logFileFor(d = new Date()): string {
	const day = d.toISOString().slice(0, 10);
	return join(logsDir(), `events-${day}.jsonl`);
}

/** 会话标记（只留前 22 字，够对上 /resume-agent，又不至于把整行撑长） */
export function setLogSession(sid: string | undefined, cwd?: string): void {
	sessionTag = sid ? String(sid).slice(0, 22) : undefined;
	if (cwd) cwdTag = cwd;
}

export function configureLog(cfg: { enabled?: boolean; level?: LogLevel }): void {
	if (typeof cfg.enabled === "boolean") enabled = cfg.enabled;
	if (cfg.level && cfg.level in LEVEL_RANK) minLevel = cfg.level;
}

export function logConfigNow(): { enabled: boolean; level: LogLevel; days: number } {
	return { enabled, level: minLevel, days: LOG_RETAIN_DAYS };
}

function nextFlushTimer(): void {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = undefined;
		flushLog();
	}, LOG_FLUSH_MS);
	// 别把进程钉住（pi 要能正常退出）
	(flushTimer as unknown as { unref?: () => void }).unref?.();
}

/** 真正落盘。任何异常都吞掉 —— 日志写不进去也不许影响功能。 */
export function flushLog(): void {
	if (!buf.length) return;
	const rows = buf;
	buf = [];
	try {
		const f = logFileFor();
		mkdirSync(logsDir(), { recursive: true });
		// 单文件超上限就滚到另一个文件（一天之内写爆才会发生）
		let target = f;
		if (existsSync(f)) {
			try {
				if (statSync(f).size > LOG_FILE_MAX_BYTES) target = f.replace(/\.jsonl$/, `.${Math.floor(Date.now() / 1000) % 1000}.jsonl`);
			} catch {
				/* 忽略 */
			}
		}
		appendFileSync(target, rows.join("\n") + "\n", "utf8");
		rowsSinceClean += rows.length;
		if (rowsSinceClean >= 200) {
			rowsSinceClean = 0;
			cleanLogs();
		}
	} catch {
		/* fail-open：日志失败绝不影响插件 */
	}
}

/**
 * 清理：删掉超期的（> LOG_RETAIN_DAYS 天）；再按总大小从旧到新删到 20MB 以下。
 * 返回删掉的文件名（测试用）。
 */
export function cleanLogs(now = Date.now()): string[] {
	const removed: string[] = [];
	const dir = logsDir();
	let entries: { f: string; size: number; mtime: number }[] = [];
	try {
		entries = readdirSync(dir)
			.filter((x) => x.startsWith("events-") && x.endsWith(".jsonl"))
			.map((x) => {
				const p = join(dir, x);
				try {
					const st = statSync(p);
					return { f: p, size: st.size, mtime: st.mtimeMs };
				} catch {
					return { f: p, size: 0, mtime: 0 };
				}
			});
	} catch {
		return removed;
	}
	const cutoff = now - LOG_RETAIN_DAYS * 24 * 60 * 60 * 1000;
	// 文件名里的日期也要看：只信 mtime 的话，「被拷贝/改过时间」的旧文件永远删不掉
	const fileDay = (f: string): number => {
		const m = /events-(\d{4})-(\d{2})-(\d{2})/.exec(f);
		if (!m) return NaN;
		return Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
	};
	const keep = entries.filter((e) => {
		const byName = fileDay(e.f);
		if (e.mtime < cutoff || (Number.isFinite(byName) && byName + 24 * 60 * 60 * 1000 < cutoff)) {
			try {
				rmSync(e.f, { force: true });
				removed.push(e.f);
				return false;
			} catch {
				return true;
			}
		}
		return true;
	});
	let total = keep.reduce((a, b) => a + b.size, 0);
	keep.sort((a, b) => a.mtime - b.mtime);
	for (const e of keep) {
		if (total <= LOG_DIR_MAX_BYTES) break;
		try {
			rmSync(e.f, { force: true });
			removed.push(e.f);
			total -= e.size;
		} catch {
			/* 忽略 */
		}
	}
	return removed;
}

/** 脱敏 + 序列化一行。导出出来是为了单测能直接验格式。 */
export function formatLogRow(
	ev: string,
	lvl: LogLevel,
	d: Record<string, unknown> | undefined,
	now = new Date(),
): string {
	const row: Record<string, unknown> = {
		t: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
		lvl,
		ev,
		pid: process.pid,
	};
	if (sessionTag) row.sid = sessionTag;
	if (cwdTag) row.cwd = cwdTag;
	if (d && Object.keys(d).length) {
		let dd: unknown;
		try {
			dd = redactDeep(d);
		} catch {
			dd = { note: "(脱敏失败，已丢弃明细)" };
		}
		row.d = dd;
	}
	try {
		return JSON.stringify(row);
	} catch {
		return JSON.stringify({ t: row.t, lvl, ev, note: "(明细无法序列化)" });
	}
}

/** 记一条事件。d 里的值会自动脱敏。 */
export function logEvent(ev: string, d?: Record<string, unknown>, lvl: LogLevel = "info"): void {
	if (!enabled) return;
	if (LEVEL_RANK[lvl] < LEVEL_RANK[minLevel]) return;
	// 限流：同一事件同一「指纹」在窗口内只记一次，后面只累加计数
	const fp = ev + "|" + String((d && (d.where ?? d.assistant ?? d.server ?? d.tool ?? d.kind)) ?? "");
	const nowMs = Date.now();
	const hit = dedupe.get(fp);
	if (hit && nowMs - hit.at < LOG_DEDUPE_MS) {
		hit.n += 1;
		return;
	}
	if (hit && hit.n > 1) d = { ...(d ?? {}), repeated: hit.n };
	dedupe.set(fp, { at: nowMs, n: 1 });
	if (dedupe.size > 500) dedupe.clear();
	try {
		buf.push(formatLogRow(ev, lvl, d));
	} catch {
		return;
	}
	if (buf.length >= LOG_FLUSH_ROWS) flushLog();
	else nextFlushTimer();
}

/** 记一个异常：自动带 message + 栈前 5 行（栈是定位问题的关键，别只留 message） */
export function logError(ev: string, e: unknown, d?: Record<string, unknown>): void {
	const err = e instanceof Error ? e.message : String(e ?? "");
	let stack = "";
	if (e instanceof Error && e.stack) {
		stack = e.stack
			.split(/\r?\n/)
			.slice(1, 6)
			.map((x) => x.trim())
			.join(" <- ");
	}
	logEvent(ev, { ...(d ?? {}), err, stack: stack || undefined }, "error");
}

/** 记一次耗时：超过 LOG_SLOW_MS 自动升成 warn（慢操作自己冒出来，不用手写阈值） */
export function logTimed(ev: string, ms: number, d?: Record<string, unknown>): void {
	const lvl: LogLevel = ms >= LOG_SLOW_MS ? "warn" : "info";
	logEvent(ev, { ...(d ?? {}), ms: Math.round(ms) }, lvl);
}

/**
 * 读最近日志（给 `/aidoctor log` 和自检报告用）。
 * 按文件从新到旧读，凑够 limit 条就停；lvl 过滤在解析后做。
 */
export function readRecentLogs(
	limit = 50,
	filter?: { lvl?: LogLevel; ev?: string; days?: number },
	now = Date.now(),
): { rows: Record<string, unknown>[]; files: string[] } {
	const dir = logsDir();
	const cutoff = now - (filter?.days ?? LOG_RETAIN_DAYS) * 24 * 60 * 60 * 1000;
	let names: string[] = [];
	try {
		names = readdirSync(dir)
			.filter((x) => x.startsWith("events-") && x.endsWith(".jsonl"))
			.map((x) => join(dir, x))
			.sort()
			.reverse();
	} catch {
		return { rows: [], files: [] };
	}
	const rows: Record<string, unknown>[] = [];
	const used: string[] = [];
	for (const f of names) {
		let txt = "";
		try {
			txt = readFileSync(f, "utf8");
		} catch {
			continue;
		}
		const lines = txt.split(/\r?\n/);
		const picked: Record<string, unknown>[] = [];
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			let o: Record<string, unknown>;
			try {
				o = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const ts = Date.parse(String(o.t ?? ""));
			if (Number.isFinite(ts) && ts < cutoff) continue;
			if (filter?.lvl && LEVEL_RANK[(o.lvl as LogLevel) ?? "info"] < LEVEL_RANK[filter.lvl]) continue;
			if (filter?.ev && !String(o.ev ?? "").includes(filter.ev)) continue;
			picked.push(o);
			if (picked.length + rows.length >= limit) break;
		}
		if (picked.length) {
			used.push(f);
			rows.push(...picked);
		}
		if (rows.length >= limit) break;
	}
	return { rows: rows.slice(0, limit), files: used };
}

/** 按事件聚合计数（报告里的「哪些事件一直在出问题」就靠它） */
export function summarizeLogs(
	days = LOG_RETAIN_DAYS,
	now = Date.now(),
): { ev: string; lvl: LogLevel; count: number; last: string; sample?: string }[] {
	const { rows } = readRecentLogs(100_000, { days }, now);
	const map = new Map<string, { ev: string; lvl: LogLevel; count: number; last: string; sample?: string }>();
	for (const r of rows) {
		const ev = String(r.ev ?? "(未知)");
		const lvl = ((r.lvl as LogLevel) ?? "info") as LogLevel;
		const key = ev + "|" + lvl;
		const t = String(r.t ?? "");
		const cur = map.get(key);
		if (cur) {
			cur.count += 1;
			if (t > cur.last) cur.last = t;
		} else {
			const d = r.d as Record<string, unknown> | undefined;
			map.set(key, { ev, lvl, count: 1, last: t, sample: d ? String(d.err ?? d.why ?? d.note ?? "") || undefined : undefined });
		}
	}
	return [...map.values()].sort((a, b) => b.count - a.count);
}

/** 单行摘要（状态栏 / 报告用） */
export function logSummaryLine(days = LOG_RETAIN_DAYS, now = Date.now()): string {
	const sum = summarizeLogs(days, now);
	if (!sum.length) return `最近 ${days} 天没有事件日志`;
	const errs = sum.filter((x) => x.lvl === "error").reduce((a, b) => a + b.count, 0);
	const warns = sum.filter((x) => x.lvl === "warn").reduce((a, b) => a + b.count, 0);
	return `最近 ${days} 天：${sum.length} 种事件 / error ${errs} 条 / warn ${warns} 条`;
}
