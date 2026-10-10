/**
 * 子代理实时视图 —— 把子进程 `--mode json` 的事件流，翻译成「可以画出来的行」。
 *
 * 数据源：delegate.ts 的 handleLine() 已经解析出来的 JSON 事件
 * （事件规范见 pi 自带的 docs/json.md）。这里刻意 **不依赖 pi 的 theme / TUI**，
 * 只产出带语义色调的行，由 panel.ts 决定怎么上色、放哪、多宽。
 * 好处：这份逻辑能在无终端环境下被测试（喂一段录好的事件流进去就能看输出）。
 *
 * 一个必须记住的事实（实测得出，别想当然）：
 *   `tool_execution_update.partialResult` 对 bash **不是**实时输出流 ——
 *   只有「开始时一条空的」+「结束时一条完整的」。
 *   所以长命令跑着的时候，事件流是静默的；面板必须自己按秒 tick
 *   去更新「已跑多久 / 最后事件距今多少秒」，否则用户会以为死机了。
 */

// ======================= 类型 =======================

/** 语义色调。live.ts 不碰具体颜色，由 panel.ts 映射到主题。 */
export type Tone = "default" | "accent" | "muted" | "ok" | "warn" | "err" | "bold";

export interface Seg {
	text: string;
	tone?: Tone;
}

export interface LiveLine {
	segs: Seg[];
}

export type JobStatus = "running" | "done" | "failed" | "timeout";

/** 终态（markEnd 只接受这几个，杜绝把 "running" 传进去） */
export type EndStatus = Exclude<JobStatus, "running">;
/** 一次工具调用（含正在跑的那一次）。 */
export interface ToolRun {
	id: string;
	name: string;
	brief: string;
	/** preparing = 模型还在吐参数；running = 真的在执行了 */
	phase: "preparing" | "running";
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
	/** 执行中的最新输出（bash 通常拿不到；别的工具可能有） */
	liveOutput?: string;
	/** 结束后的结果摘要，如 `240 行` / `A` */
	resultBrief?: string;
	exitCode?: number;
	wallSec?: number;
}

/** 一个子代理的完整实时状态。 */
export interface LiveJob {
	/** 模板 key（如 `我的数据库助理`），仅作标识 */
	key: string;
	/** 显示名，如 `我的数据库助理` */
	name: string;
	/** 任务首行，给面板当副标题 */
	taskBrief: string;
	sessionId: string;
	startedAt: number;
	status: JobStatus;
	/** 按时间顺序；最后一条通常是「正在跑」的那个 */
	tools: ToolRun[];
	/** 实时正文（只留尾部，防内存膨胀） */
	text: string;
	/** 实时思考（同样只留尾部） */
	thinking: string;
	/** 最近一次收到事件的时刻——「它是不是还活着」的唯一硬证据 */
	lastEventAt: number;
	tokens?: { input: number; output: number; total: number };
	/** 结束原因/错误 */
	note?: string;
}

const TEXT_LIMIT = 2000;
const THINKING_LIMIT = 1200;
const MAX_TOOLS_KEPT = 40;

/** 量显示宽度（CJK 占两列）。live.ts 故意不 import pi-tui，所以自己带一个极简版。 */
function widthOf(s: string): number {
	let w = 0;
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		w += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)) ? 2 : 1;
	}
	return w;
}

// ======================= 注册表（面板订阅用） =======================

const jobs: LiveJob[] = [];
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | undefined;

/** 订阅变化（面板用）。返回退订函数。 */
export function onLiveChange(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/**
 * 通知订阅者重画。
 * 事件流很密（实测 40 秒 429 条 message_update ≈ 10 条/秒），
 * 所以这里做个 100ms 的合并节流 —— 面板本来就是按秒刷的，不需要每条事件都重画。
 */
export function notifyLive(): void {
	if (notifyTimer) return;
	notifyTimer = setTimeout(() => {
		notifyTimer = undefined;
		for (const fn of [...listeners]) {
			try {
				fn();
			} catch {
				// 订阅者自己出错不能连累派活
			}
		}
	}, 100);
}

/** 注册表里的 job（含刚跑完、还没被清掉的）。 */
export function liveJobs(): readonly LiveJob[] {
	return jobs;
}

/** 有没有还在跑的。 */
export function hasRunningJob(): boolean {
	return jobs.some((j) => j.status === "running");
}

/** 收进一个 job（runAssistant 起进程前调）。 */
export function addJob(job: LiveJob): void {
	jobs.push(job);
	notifyLive();
}

/**
 * 每次开始派活前调：清掉上一轮的旧账，只留还在跑的（并行/续跑场景）。
 * 这样面板上不会越堆越多。
 */
export function beginRun(): void {
	for (let i = jobs.length - 1; i >= 0; i--) {
		if (jobs[i].status !== "running") jobs.splice(i, 1);
	}
	notifyLive();
}

/** 全清（面板关掉时调）。 */
export function clearJobs(): void {
	jobs.length = 0;
	notifyLive();
}

// ======================= 工具函数 =======================

/** 毫秒 → `12s` / `1:23` / `1:02:03` */
export function fmtDur(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rs = s % 60;
	if (m < 60) return `${m}:${String(rs).padStart(2, "0")}`;
	const h = Math.floor(m / 60);
	return `${h}:${String(m % 60).padStart(2, "0")}:${String(rs).padStart(2, "0")}`;
}

/** 把任意多行文本压成一行并截断。 */
export function oneLine(s: string, max: number): string {
	const flat = String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (widthOf(flat) <= max) return flat;
	// 按显示宽度截（CJK 占两列，不能按字符数切）
	let out = "";
	for (const ch of flat) {
		if (widthOf(out + ch) > max - 1) break;
		out += ch;
	}
	return max <= 1 ? "" : `${out}…`;
}

function clampTail(s: string, limit: number): string {
	return s.length > limit ? s.slice(-limit) : s;
}

function asRecord(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function firstString(v: unknown): string | undefined {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		for (const item of v) {
			const s = firstString(item);
			if (s) return s;
		}
		return undefined;
	}
	const r = asRecord(v);
	if (typeof r.text === "string") return r.text;
	if (typeof r.thinking === "string") return r.thinking;
	if (r.content !== undefined) return firstString(r.content);
	return undefined;
}

/**
 * 从工具 result 里抽一句人话摘要。
 * bash 拿 exit_code + 输出首行；read/ls 之类拿「N 行」；拿不到就空着。
 */
export function resultBrief(result: unknown, isError?: boolean): string {
	const r = asRecord(result);
	const sc = asRecord(r.structuredContent);
	const text = firstString(r.content) ?? (typeof sc.output === "string" ? sc.output : "");
	const trimmed = String(text ?? "").trim();
	if (isError) {
		const first = trimmed.split("\n").find((l) => l.trim()) ?? "";
		return first ? oneLine(first, 60) : "报错";
	}
	if (sc.exit_code !== undefined && Number(sc.exit_code) !== 0) {
		return `exit ${String(sc.exit_code)}`;
	}
	if (!trimmed) return "";
	const lines = trimmed.split("\n").filter((l) => l.trim());
	if (lines.length === 1) return oneLine(lines[0], 60);
	return `${oneLine(lines[0], 46)}  …（共 ${lines.length} 行）`;
}

/**
 * 从工具 args 里抽「一眼能看出它在干嘛」的摘要。
 * 这是面板最有价值的一行 —— 用户要的就是「它现在到底在干什么」。
 */
export function toolBrief(name: string, args: unknown): string {
	const a = asRecord(args);
	const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
	// MCP 工具名形如 mcp__<server>__<tool>：拆开来比整串好读，也省得把参数挤掉
	if (name.startsWith("mcp__")) {
		const parts = name.split("__");
		const server = parts[1] ?? "";
		const tool = parts.slice(2).join("__");
		const keys = ["cmdString", "command", "cmd", "sql", "query", "path", "file_path", "url", "pattern"];
		const k = keys.find((x) => typeof a[x] === "string");
		return oneLine([`${server}/${tool}`, k ? String(a[k]) : ""].filter(Boolean).join("  "), 200);
	}
	switch (name) {
		case "bash":
		case "shell":
			return oneLine(str("command") || str("cmd"), 200);
		case "read":
		case "write":
		case "edit":
			return oneLine(str("path") || str("file_path") || str("filePath"), 200);
		case "grep":
			return oneLine([str("pattern"), str("path")].filter(Boolean).join("  "), 200);
		case "find":
		case "ls":
			return oneLine(str("pattern") || str("path") || str("dir"), 200);
		case "codemode": {
			const server = str("server") || str("toolName");
			const tool = str("tool") || str("name");
			return oneLine([server, tool].filter(Boolean).join(" / "), 200);
		}
		case "delegate": {
			const who = str("assistant");
			const n = Array.isArray(a.tasks) ? a.tasks.length : a.task ? 1 : 0;
			return oneLine([who, n > 1 ? `×${n}` : ""].filter(Boolean).join(" "), 200);
		}
		default: {
			const keys = Object.keys(a);
			if (!keys.length) return "";
			return oneLine(keys.map((k) => `${k}=${oneLine(String(a[k]), 40)}`).join(" "), 200);
		}
	}
}

// ======================= 事件消费 =======================

/** 造一个新的 job（派活时调用）。 */
export function newJob(init: {
	key: string;
	name: string;
	task: string;
	sessionId: string;
	startedAt?: number;
}): LiveJob {
	const now = init.startedAt ?? Date.now();
	return {
		key: init.key,
		name: init.name,
		taskBrief: oneLine(init.task, 120),
		sessionId: init.sessionId,
		startedAt: now,
		status: "running",
		tools: [],
		text: "",
		thinking: "",
		lastEventAt: now,
	};
}

function currentTool(job: LiveJob): ToolRun | undefined {
	const last = job.tools[job.tools.length - 1];
	return last && !last.endedAt ? last : undefined;
}

/** 喂一个已解析的 JSON 事件，并通知面板重画。 */
export function consume(job: LiveJob, ev: unknown): void {
	applyEvent(job, ev);
	notifyLive();
}

/**
 * 喂一个已解析的 JSON 事件。
 * 事件形状见 pi 的 docs/json.md —— 这里只认需要的字段，其余忽略。
 */
function applyEvent(job: LiveJob, ev: unknown): void {
	const o = asRecord(ev);
	const type = typeof o.type === "string" ? o.type : "";
	if (!type) return;
	const now = Date.now();

	// 任何事件都算「它还活着」。这条是判断「卡没卡」的唯一依据。
	job.lastEventAt = now;

	const ame = asRecord(o.assistantMessageEvent);
	switch (type) {
		case "agent_start":
			job.status = "running";
			return;

		case "message_update": {
			const sub = typeof ame.type === "string" ? ame.type : "";
			if (sub === "text_delta" && typeof ame.delta === "string") {
				job.text = clampTail(job.text + ame.delta, TEXT_LIMIT);
			} else if (sub === "thinking_delta" && typeof ame.delta === "string") {
				job.thinking = clampTail(job.thinking + ame.delta, THINKING_LIMIT);
			} else if (sub === "text_end" && typeof ame.content === "string") {
				// 权威正文到达 → 用最后一次 text_end 覆盖尾部，避免增量漂移
				job.text = clampTail(ame.content, TEXT_LIMIT);
			} else if (sub === "toolcall_start" && typeof ame.toolName === "string") {
				// 模型刚开始吐参数 → 先占个位，让用户看到「准备调用 X」
				const running = currentTool(job);
				if (!running || running.name !== ame.toolName) {
					job.tools.push({
						id: typeof ame.id === "string" ? ame.id : `prep-${now}`,
						name: ame.toolName,
						brief: "",
						phase: "preparing",
						startedAt: now,
					});
				}
			} else if (sub === "toolcall_end") {
				const tc = asRecord(ame.toolCall);
				const running = currentTool(job);
				if (running) {
					if (typeof tc.name === "string") running.name = tc.name;
					running.brief = toolBrief(running.name, tc.arguments ?? tc.args ?? tc.input);
				}
			}
			const usage = asRecord(o.usage);
			if (typeof usage.totalTokens === "number") {
				job.tokens = {
					input: Number(usage.input ?? 0),
					output: Number(usage.output ?? 0),
					total: usage.totalTokens,
				};
			}
			return;
		}

		case "tool_execution_start": {
			const id = typeof o.toolCallId === "string" ? o.toolCallId : `call-${now}`;
			const name = typeof o.toolName === "string" ? o.toolName : "tool";
			const brief = toolBrief(name, o.args);
			// 把「准备中」的那个占位升级成真家伙（id 通常对不上，取最后一条未结束的）
			const running = currentTool(job);
			if (running && running.phase === "preparing") {
				running.id = id;
				running.name = name;
				running.brief = brief || running.brief;
				running.phase = "running";
				running.startedAt = now;
			} else {
				job.tools.push({ id, name, brief, phase: "running", startedAt: now });
			}
			if (job.tools.length > MAX_TOOLS_KEPT) job.tools.splice(0, job.tools.length - MAX_TOOLS_KEPT);
			return;
		}

		case "tool_execution_update": {
			const id = typeof o.toolCallId === "string" ? o.toolCallId : "";
			const t = job.tools.find((x) => x.id === id && !x.endedAt);
			const text = firstString(asRecord(o.partialResult).content);
			if (t && text) t.liveOutput = clampTail(text, TEXT_LIMIT);
			return;
		}

		case "tool_execution_end": {
			const id = typeof o.toolCallId === "string" ? o.toolCallId : "";
			const isError = o.isError === true;
			let t = job.tools.find((x) => x.id === id && !x.endedAt);
			if (!t) t = currentTool(job);
			if (!t) return;
			const sc = asRecord(asRecord(o.result).structuredContent);
			t.endedAt = now;
			t.phase = "running";
			t.isError = isError;
			t.resultBrief = resultBrief(o.result, isError);
			if (sc.exit_code !== undefined) t.exitCode = Number(sc.exit_code);
			if (sc.wall_time_seconds !== undefined) t.wallSec = Number(sc.wall_time_seconds);
			return;
		}

		case "tool_result":
		case "turn_end":
		case "turn_start":
		case "message_start":
		case "session":
		case "session_info_changed":
		case "thinking_level_changed":
		case "queue_update":
			return;

		default:
			// agent_end / agent_settled 只代表「这一轮 agent 循环结束」。
			// 子进程可能还会续跑/重试，所以**不在这里改 status** ——
			// 最终状态由 runAssistant() 拿到退出码后写（见 markEnd）。
			return;
	}
}

/** 子进程退出后写终态。 */
export function markEnd(
	job: LiveJob,
	outcome: EndStatus,
	note?: string,
): void {
	job.status = outcome;
	if (note) job.note = note;
	const now = Date.now();
	job.lastEventAt = now;
	for (const t of job.tools) {
		if (!t.endedAt && t.phase === "running") t.endedAt = now;
	}
	notifyLive();
}

// ======================= 渲染 =======================

export interface RenderOpts {
	/** 可用宽度（不含边框） */
	width: number;
	/** 当前时刻，由调用方按秒 tick 传入（这样渲染是纯函数、可测） */
	now: number;
	/** 是否展开思考过程 */
	detail?: boolean;
	/** 最多画几行；超出优先保「状态 + 当前动作」 */
	maxLines?: number;
}

/** 静默多久就提醒「可能卡住」。 */
export const STALE_MS = 25_000;

function statusIcon(job: LiveJob): { text: string; tone: Tone } {
	switch (job.status) {
		case "done":
			return { text: "✓", tone: "ok" };
		case "failed":
			return { text: "✗", tone: "err" };
		case "timeout":
			return { text: "⏸", tone: "warn" };
		default:
			return { text: "●", tone: "accent" };
	}
}

/** 工具名太长会把参数挤掉，显示用短名（MCP 工具去掉 `mcp__<server>__` 前缀）。 */
export function shortToolName(name: string): string {
	if (!name.startsWith("mcp__")) return name;
	const parts = name.split("__");
	return parts.slice(2).join("__") || name;
}

function toolLine(t: ToolRun, width: number, now: number): LiveLine {
	const shown = shortToolName(t.name);
	if (t.phase === "preparing") {
		return {
			segs: [
				{ text: "  ⋯ 准备调用 ", tone: "muted" },
				{ text: shown, tone: "default" },
			],
		};
	}
	if (!t.endedAt) {
		// 正在跑 —— 单独占一行，因为「已跑 Xs」要看得见、而且每秒在走。
		// 注意它排在行尾，按宽度算不准会被截掉，而它恰恰是最重要的信息；
		// 所以先把前后缀占的列数扣掉，剩下的才给参数摘要。
		const tail = `  已跑 ${fmtDur(now - t.startedAt)}`;
		const lead = `  ⚙ ${shown}  `;
		const room = Math.max(6, width - widthOf(lead) - widthOf(tail));
		return {
			segs: [
				{ text: "  ⚙ ", tone: "accent" },
				{ text: shown, tone: "bold" },
				{ text: t.brief ? `  ${oneLine(t.brief, room)}` : "", tone: "default" },
				{ text: tail, tone: "muted" },
			],
		};
	}

	// 已结束的工具**压成一行**「干了什么 → 结果 + 耗时」。
	// 为什么不也占两行：三个工具就六行，面板会胖得把对话挤没。
	// 宽度按比例分：参数摘要 ~35%，结果 ~40%，剩下的给名字和分隔符。
	const briefBudget = Math.max(8, Math.floor(width * 0.35));
	const tailBudget = Math.max(10, Math.floor(width * 0.4));
	const marker = t.isError ? "  ✗ " : "  ⚙ ";
	const brief = t.brief ? oneLine(t.brief, briefBudget) : "";
	const tailText = [
		t.resultBrief ? oneLine(t.resultBrief, tailBudget) : "",
		t.wallSec !== undefined ? `${t.wallSec}s` : "",
	]
		.filter(Boolean)
		.join(" · ");
	const segs: Seg[] = [
		{ text: marker, tone: t.isError ? "err" : "muted" },
		{ text: shown, tone: t.isError ? "err" : "muted" },
	];
	if (brief) segs.push({ text: `  ${brief}`, tone: "muted" });
	if (tailText) segs.push({ text: `  → ${tailText}`, tone: t.isError ? "err" : "default" });
	return { segs };
}

/** 把一个 job 渲染成若干行。 */
export function renderJob(job: LiveJob, opts: RenderOpts): LiveLine[] {
	const { width, now, detail } = opts;
	const out: LiveLine[] = [];
	const icon = statusIcon(job);
	const elapsed = fmtDur((job.status === "running" ? now : job.lastEventAt) - job.startedAt);
	const quiet = now - job.lastEventAt;

	const head: Seg[] = [
		{ text: `${icon.text} `, tone: icon.tone },
		{ text: oneLine(job.name, Math.max(6, width - 10)), tone: "bold" },
	];
	if (job.status === "running") {
		head.push({ text: `  ${elapsed}`, tone: "muted" });
		if (quiet > STALE_MS) head.push({ text: `  ⚠ ${fmtDur(quiet)}无动静`, tone: "warn" });
	} else {
		head.push({ text: `  ${elapsed}`, tone: "muted" });
		head.push({
			text: job.status === "done" ? "  完成" : job.status === "timeout" ? "  超时" : "  失败",
			tone: icon.tone,
		});
	}
	out.push({ segs: head });

	// 任务原文（第二行，短）—— 多个任务并行时用来区分
	if (job.taskBrief) out.push({ segs: [{ text: `  ${oneLine(job.taskBrief, width - 4)}`, tone: "muted" }] });

	// 最近的动作：只画最后 4 个工具，最新的在最下（已结束的压成一行，所以 4 个也不胖）
	const tools = job.tools.slice(-4);
	for (const t of tools) out.push(toolLine(t, width, now));

	// 执行中的输出（只在这个工具**还在跑**时显示；跑完的结果由上一条 ↳ 行代表，别重复）
	const running = job.tools[job.tools.length - 1];
	if (running && !running.endedAt && running.liveOutput) {
		const tail = running.liveOutput.trim().split("\n").filter((l) => l.trim()).slice(-3);
		for (const l of tail) out.push({ segs: [{ text: `      ${oneLine(l, width - 8)}`, tone: "muted" }] });
	}

	// 正文尾（正在写的话）
	if (job.text.trim()) {
		const tail = job.text.trim().split("\n").filter((l) => l.trim()).slice(-3);
		for (const l of tail) out.push({ segs: [{ text: `  ${oneLine(l, width - 4)}`, tone: "default" }] });
	}

	// 思考（要 detail 才给）
	if (detail && job.thinking.trim()) {
		const tail = job.thinking.trim().split("\n").filter((l) => l.trim()).slice(-4);
		for (const l of tail) out.push({ segs: [{ text: `  ◦ ${oneLine(l, width - 6)}`, tone: "muted" }] });
	}

	if (job.note) out.push({ segs: [{ text: `  ${oneLine(job.note, width - 4)}`, tone: "warn" }] });
	if (job.tokens) out.push({ segs: [{ text: `  ${job.tokens.total} tok`, tone: "muted" }] });

	return out;
}

/** 画多个 job（并行派活时）。 */
export function renderJobs(jobs: LiveJob[], opts: RenderOpts): LiveLine[] {
	const out: LiveLine[] = [];
	jobs.forEach((j, i) => {
		if (i > 0) out.push({ segs: [{ text: "  " + "·".repeat(Math.max(1, opts.width - 2)), tone: "muted" }] });
		out.push(...renderJob(j, opts));
	});
	const max = opts.maxLines ?? 999;
	if (out.length <= max) return out;
	// 超长：保头（状态）和尾（最新动作）
	const head = out.slice(0, 3);
	const tail = out.slice(-(max - 3));
	return [...head, { segs: [{ text: "  …", tone: "muted" }] }, ...tail].slice(0, max);
}

/** 按显示宽度截一个 seg 的文本（保留颜色，尾部加 …）。 */
function clipText(s: string, maxW: number): string {
	if (widthOf(s) <= maxW) return s;
	let out = "";
	for (const ch of s) {
		if (widthOf(out + ch) > maxW - 1) break;
		out += ch;
	}
	return out + "…";
}

/** 按显示宽度截断一段 segs（保头、保留颜色），超出部分丢弃。 */
function clipSegs(segs: Seg[], maxW: number): Seg[] {
	const out: Seg[] = [];
	let used = 0;
	for (const s of segs) {
		const w = widthOf(s.text);
		if (used + w <= maxW) {
			out.push(s);
			used += w;
			continue;
		}
		const room = maxW - used;
		if (room > 1) out.push({ text: clipText(s.text, room), tone: s.tone });
		break;
	}
	return out;
}

/**
 * 分栏渲染：最多 columns 列（默认 3），每列一个 job，列间竖虚线「┆」分隔。
 * 多助理同时跑时并排看，不再竖着堆、被省略号截断。短的列补空行对齐；
 * 每列内容按列宽严格截断（renderJob 的标题行会带耗时/状态，可能溢出，这里统一剪）。
 */
export function renderJobsColumns(jobs: LiveJob[], opts: RenderOpts & { columns?: number }): LiveLine[] {
	const cols = Math.max(1, opts.columns ?? 3);
	const n = Math.min(jobs.length, cols);
	if (n <= 1) return renderJobs(jobs, opts); // 单个 job 并排没意义，退化成竖排

	const max = opts.maxLines ?? 8;
	const sep = "┆";
	// 每列内容宽：总宽减去 (n-1) 个分隔符（每个「 ┆ 」占 3 列）
	const colW = Math.max(12, Math.floor((opts.width - (n - 1) * 3) / n));

	// 每列渲染成行、按列宽剪、截到 max 行
	const columns: LiveLine[][] = jobs
		.slice(0, n)
		.map((j) => renderJob(j, { ...opts, width: colW }).slice(0, max).map((l) => ({ segs: clipSegs(l.segs, colW) })));
	const rows = Math.max(...columns.map((c) => c.length), 1);

	// 短的列补空行对齐
	const empty: LiveLine = { segs: [] };
	const padded = columns.map((c) => (c.length < rows ? [...c, ...Array.from({ length: rows - c.length }, () => empty)] : c));

	// 横向拼接：第 r 行 = col0[r] ┆ col1[r] ┆ col2[r]
	const out: LiveLine[] = [];
	for (let r = 0; r < rows; r++) {
		const segs: Seg[] = [];
		for (let c = 0; c < n; c++) {
			if (c > 0) segs.push({ text: ` ${sep} `, tone: "muted" });
			segs.push(...padded[c][r].segs);
		}
		out.push({ segs });
	}
	return out;
}

/** 一行摘要（窄屏降级用）。 */
export function renderCompact(jobs: LiveJob[], width: number, now: number): LiveLine {
	if (!jobs.length) return { segs: [{ text: "🤖 没有在跑的助理", tone: "muted" }] };
	const segs: Seg[] = [];
	for (const j of jobs.slice(0, 2)) {
		const icon = statusIcon(j);
		const running = j.tools[j.tools.length - 1];
		const act = running
			? `${running.phase === "preparing" ? "⋯" : "⚙"}${running.name}`
			: "";
		segs.push({ text: `${icon.text} `, tone: icon.tone });
		segs.push({ text: oneLine(j.name, 12), tone: "bold" });
		segs.push({ text: ` ${fmtDur(now - j.startedAt)}`, tone: "muted" });
		if (act) segs.push({ text: ` ${act}`, tone: "default" });
		segs.push({ text: "   ", tone: "muted" });
	}
	return { segs };
}

/** 把带色调的行拍平成纯文本（无终端环境 / widget 降级用）。 */
export function plainLines(lines: LiveLine[]): string[] {
	return lines.map((l) => l.segs.map((s) => s.text).join(""));
}
