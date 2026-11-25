/**
 * herdr.ts —— Herdr 分屏的**薄封装**（Super Agent 的 split / tab UI 模式用）。
 *
 * 为什么要单独一层：
 *   ① 只有这一层碰 `herdr` 命令行；delegate / live / panel 只吃结构化结果。
 *   ② **绝不抛异常** —— 非 Herdr 环境、herdr 挂了、JSON 变形，统统返回 undefined / false。
 *      上层据此降级回 panel 模式（需求：不许崩）。
 *
 * 实测过的 Herdr 0.9.5 事实（别按直觉改）：
 *   - `herdr pane split <PANE_ID> --direction right|down --ratio <f> --no-focus --cwd <p>` → JSON
 *   - `--ratio` 是**原 pane** 的占比（0.6 = 原 pane 留 60%）
 *   - **没有** `--label`，标题要单独 `herdr pane rename <PANE_ID> "<label>"`
 *   - `herdr pane run <PANE_ID> "<命令>"`：在任意 pane 里后台执行，不抢焦点
 *   - `herdr tab create --workspace <ws> --cwd <p> --label <名> --no-focus` → JSON 含 tab + root_pane
 *   - 环境标识：TERM_PROGRAM=herdr、HERDR_WORKSPACE_ID、HERDR_PANE_ID（本会话自己的 pane）
 *
 * 本文件里还放了三个**纯函数**（不碰命令行，可单测）：
 *   paneLabel / tabLabel —— 命名规则
 *   resolveUiMode       —— auto 到底走 split 还是 tab
 *   planSlot            —— 第 N 个子助理放哪一格
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readExtCfg } from "./shared";

/** 一条 herdr 命令最多等这么久（卡住的 herdr 不该把派活拖死） */
const TIMEOUT_MS = 10_000;
/** 可执行名（Windows 下 node 会自动补 .exe；不拼 shell，避免注入与转义） */
const BIN = "herdr";

// ======================= 底层：跑命令 + 解析 JSON =======================

function run(args: string[]): string | undefined {
	try {
		const out = execFileSync(BIN, args, {
			encoding: "utf8",
			timeout: TIMEOUT_MS,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 8 * 1024 * 1024,
		});
		return typeof out === "string" ? out : String(out ?? "");
	} catch {
		return undefined; // 非 0 退出 / 超时 / 找不到 herdr —— 一律当失败
	}
}

function runJson(args: string[]): unknown | undefined {
	const out = run(args);
	if (!out || !out.trim()) return undefined;
	return parseJsonLoose(out);
}

/**
 * 容错解析：真实输出可能是
 *   ① 裸对象 `{"panes":[...]}`
 *   ② 包一层 `{"id":"cli:pane:list","result":{...},"type":"..."}`
 *   ③ 前面混了日志行（取最后一行能解析的）
 * 全都不行 → undefined（**不抛**）。
 */
export function parseJsonLoose(text: string): unknown | undefined {
	const t = String(text ?? "").trim();
	if (!t) return undefined;
	try {
		return JSON.parse(t);
	} catch {
		/* 继续尝试 */
	}
	// 多行输出：从后往前找第一行能整行解析的 JSON
	const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]!;
		if (!(l.startsWith("{") || l.startsWith("["))) continue;
		try {
			return JSON.parse(l);
		} catch {
			/* 下一行 */
		}
	}
	// 单行里混了别的字符：截第一个 { 到最后一个 }
	const a = t.indexOf("{");
	const b = t.lastIndexOf("}");
	if (a >= 0 && b > a) {
		try {
			return JSON.parse(t.slice(a, b + 1));
		} catch {
			/* 放弃 */
		}
	}
	return undefined;
}

function asRec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 拆掉外面的 `{result:{...}}` 包装 */
export function unwrapResult(v: unknown): Record<string, unknown> {
	const r = asRec(v);
	const inner = asRec(r.result);
	return Object.keys(inner).length ? inner : r;
}

/** 递归找第一个出现的键（herdr 不同子命令的嵌套层数不一样，硬编码路径太脆） */
function findKey(v: unknown, key: string, depth = 0): unknown {
	if (depth > 6 || !v || typeof v !== "object") return undefined;
	const r = v as Record<string, unknown>;
	if (key in r) return r[key];
	for (const val of Object.values(r)) {
		if (val && typeof val === "object") {
			const hit = findKey(val, key, depth + 1);
			if (hit !== undefined) return hit;
		}
	}
	return undefined;
}

function findString(v: unknown, key: string): string | undefined {
	const x = findKey(v, key);
	return typeof x === "string" && x ? x : undefined;
}

// ======================= 环境判定 =======================

/**
 * 探测结论（**带原因**）。
 * 为什么不能只返回 boolean：`resolveUiMode` 掉回 panel 时用户看不到任何解释 ——
 * 「卡片照出、不分屏、一句为什么都没有」。reason 就是给卡片 / `/aidoctor` 直接显示的。
 */
export interface HerdrStatus {
	ok: boolean;
	/** 空字符串 = 正常；否则是给人看的原因（卡片/doctor 直接显示） */
	reason: string;
	/** `process.env.TERM_PROGRAM`（"" = 没设） */
	term: string;
	/** pane list 拿到的 pane 数，失败为 0 */
	panes: number;
}

/** 切 pane / pane run 失败的冷却：30 秒内不再尝试，过期自动重试（别永久锁死一个会话） */
export const BROKEN_COOLDOWN_MS = 30_000;
/** 负面结论（ok:false）的缓存寿命：过了就重探（一次 CLI 超时/失败不该钉死整个会话） */
export const STATUS_NEG_TTL_MS = 5_000;

/** 判定结果 + 原因一起缓存（同一次会话里反复派活不必每次跑 CLI） */
let statusCache: HerdrStatus | undefined;
/** 上面那份缓存的写入时刻（负面结论要按它算 TTL；正面结论长期复用） */
let statusCachedAt = 0;
/** 「切 pane 真失败」的原因 —— 配合 brokenAt 做冷却，**不再是永久锁** */
let brokenReason = "";
/** 上次判定坏掉的时刻（毫秒） */
let brokenAt = 0;

/** 坏锁在 now 这一刻是否还在冷却中（纯函数，便于单测注入时间） */
export function brokenActiveAt(now: number): boolean {
	if (!brokenReason) return false;
	return now - brokenAt < BROKEN_COOLDOWN_MS;
}

/** 负面缓存是否已过期（纯函数，便于单测注入时间） */
export function negativeExpiredAt(now: number): boolean {
	if (!statusCache || statusCache.ok !== false) return false;
	return now - statusCachedAt > STATUS_NEG_TTL_MS;
}

/**
 * 坏锁 / 恢复写一行日志（`<agentDir>/herdr.log`）。
 * 为什么不用 cwd 下的 guard.log：那是**项目目录**，用户的项目里不该长出调试文件；
 * 而 agentDir 本来就是 pi 自己的状态目录。写不进就算了 —— 日志不许反过来影响派活。
 */
export function herdrLog(line: string): void {
	try {
		const dir = getAgentDir();
		if (!dir) return;
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "herdr.log"), `${new Date().toISOString()} ${String(line ?? "")}\n`, "utf8");
	} catch {
		/* ignore：写不进日志不影响判定 */
	}
}

function cacheStatus(s: HerdrStatus): HerdrStatus {
	statusCache = s;
	statusCachedAt = Date.now();
	return s;
}

/**
 * herdr 现在到底能不能用 + 不能用的原因。
 *
 * 判定顺序（**先看 CLI 通不通，再看终端是不是 herdr**）：
 *   ① 本会话已判定坏了 → 直接失败（不再试）
 *   ② `pane list` 拿不到 JSON → CLI 调不通（没装 / 不在 PATH / 超时）
 *   ③ 拿到 JSON 但 0 个 pane → 没有可用 pane
 *   ④ `pane list` 正常，但拿不到本会话的 pane → false（**不看 TERM_PROGRAM**）
 *   ⑤ 其余 → ok（放宽：Windows Terminal / VS Code / tmux / SSH 里，只要装了 herdr
 *      且在跑、又知道往哪个 pane 切，就能用）
 *
 * 为什么 TERM_PROGRAM=herdr 不再「直接 ok」：此时如果缺 HERDR_PANE_ID，后面切 pane 必失败，
 * 结果就是 delegate 里「先判 ok → 再 markHerdrBroken 永久锁」。早判早降级，好过「先 ok 再锁」。
 *
 * at 可注入（单测用），默认当前时间。
 */
export function herdrStatus(at: number = Date.now()): HerdrStatus {
	const term = String(process.env.TERM_PROGRAM ?? "");
	// ① 冷却期内不再试（**有超时**：过期就自动重探，别把会话永久钉死）
	if (brokenActiveAt(at)) {
		return cacheStatus({ ok: false, reason: `最近失败过，30 秒内不再试：${brokenReason}`, term, panes: 0 });
	}
	// 冷却过期 → 清掉坏锁、丢掉旧结论，正常重探
	if (brokenReason) {
		brokenReason = "";
		brokenAt = 0;
		statusCache = undefined;
		herdrLog("HERDR_RECOVERED 冷却过期，重新探测");
	}
	// ② 缓存：正面结论长期复用；负面结论只在 TTL 内复用（过期就重探）
	if (statusCache && !negativeExpiredAt(at)) return statusCache;
	statusCache = undefined;
	// 能拿到可解析的 JSON 才算「真的能用」——只看环境变量会被「herdr 没装/服务没起」骗过去
	const raw = runJson(["pane", "list"]);
	if (raw === undefined) {
		return cacheStatus({ ok: false, reason: "herdr CLI 调不通（不在 PATH 或超时）", term, panes: 0 });
	}
	const panes = parsePaneList(raw).length;
	if (panes === 0) {
		return cacheStatus({ ok: false, reason: "herdr 里没有可用 pane", term, panes: 0 });
	}
	// 不管 TERM_PROGRAM 是什么都查：没有本会话的 pane 就切不了，早判早降级
	if (!mainPaneId()) {
		return cacheStatus({
			ok: false,
			reason: `拿不到本会话的 pane（HERDR_PANE_ID 未设，TERM_PROGRAM=${term}）`,
			term,
			panes,
		});
	}
	return cacheStatus({ ok: true, reason: "", term, panes });
}

/**
 * 切 pane / pane run 真失败 → 冷却 30 秒（到期自动重试）。
 * 曾经这里是「永久 ok:false」，一次 10s 超时就能把整个会话钉死在 panel 上，所以改成冷却。
 */
export function markHerdrBroken(reason: string, at: number = Date.now()): void {
	brokenReason = String(reason ?? "").trim() || "未知原因";
	brokenAt = at;
	statusCache = undefined; // 让下一次 herdrStatus() 立刻反映
	statusCachedAt = 0;
	herdrLog(`HERDR_BROKEN ${brokenReason}`);
}

/** 当前的「坏了」原因；空字符串 = 没坏 / 冷却已过期（过期顺手清掉，别留残渣） */
export function herdrBrokenReason(): string {
	if (brokenActiveAt(Date.now())) return brokenReason;
	brokenReason = "";
	brokenAt = 0;
	// 冷却期间缓存的「最近失败过」也一起丢掉，否则过期后还会多骗最多一个 TTL
	if (statusCache && statusCache.ok === false) {
		statusCache = undefined;
		statusCachedAt = 0;
	}
	return "";
}

/** 坏锁是否还在冷却中（对外只暴露布尔，不泄漏时间戳） */
export function herdrBrokenActive(): boolean {
	return brokenActiveAt(Date.now());
}

/** 终端能不能用 herdr 分屏（旧签名保留；判定逻辑见 herdrStatus） */
export function herdrAvailable(): boolean {
	return herdrStatus().ok;
}

/** 单测 / 换环境 / 新会话时清缓存（连坏锁一起清） */
export function resetHerdrCache(): void {
	statusCache = undefined;
	statusCachedAt = 0;
	brokenReason = "";
	brokenAt = 0;
}

/** 降级卡片备注的前缀：delegate 靠它认出「这是降级说明」，不让终态备注把它抹掉 */
export const HERDR_DOWN_PREFIX = "Herdr 不可用";

/**
 * 用户配了 auto/split/tab 却掉回 panel 时的说明（纯函数，卡片 / doctor 共用）。
 * 带上 ui=，让人一眼看出「你想要的模式没生效」以及为什么。
 */
export function herdrDownNote(reason: string, ui?: string): string {
	const why = String(reason ?? "").trim() || "未知原因";
	const want = String(ui ?? "").trim();
	return want
		? `${HERDR_DOWN_PREFIX}：${why}（本次走面板卡片，ui=${want} 没生效）`
		: `${HERDR_DOWN_PREFIX}：${why}（本次走面板卡片）`;
}

/** `/aidoctor` 的取值（拿不到的都留 undefined，格式化时写「(取不到)」） */
export interface HerdrDiagInput {
	term?: string;
	panes?: number;
	ok?: boolean;
	reason?: string;
	/** 配置里写的 ui */
	ui?: string;
	/** resolveUiMode 实际算出来的 */
	actual?: string;
	routerSource?: string;
	routerBytes?: number;
	routerFile?: string;
	routerExtraFile?: string;
}

const MISSING = "(取不到)";

/**
 * `/aidoctor` 的 Herdr + Router 诊断行（**纯函数**，不读环境不跑命令，坏输入也不抛）。
 * 一次摊开：终端类型 / pane 数 / 可用性 / 原因 / 配置的 ui 和实际生效的 ui / Router 提示词来源。
 */
export function formatHerdrDiagnostic(input: HerdrDiagInput | undefined): string[] {
	const d = input ?? {};
	const has = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === "string" && v === "");
	const str = (v: unknown, dflt = MISSING): string => {
		try {
			return has(v) ? String(v) : dflt;
		} catch {
			return MISSING;
		}
	};
	const num = (v: unknown): number | undefined => {
		try {
			const n = Number(v);
			return v !== undefined && v !== null && Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
		} catch {
			return undefined;
		}
	};

	const panes = num(d.panes);
	const ok = typeof d.ok === "boolean" ? d.ok : undefined;
	const mark = ok === undefined ? "" : ok ? "✓" : "✗";
	const paneTxt = panes === undefined ? MISSING : `${mark ? `${mark} ` : ""}${panes} 个`;
	const reason = str(d.reason, ok === true ? "(正常)" : MISSING);
	const bytes = num(d.routerBytes);
	const file = has(d.routerFile) ? ` ${str(d.routerFile)}` : "";
	const extra = has(d.routerExtraFile) ? `（+ 追加 ${str(d.routerExtraFile)}）` : "";

	return [
		`- Herdr：TERM_PROGRAM=${str(d.term)} · pane list ${paneTxt} · 可用=${ok === undefined ? MISSING : String(ok)}`,
		`       原因：${reason}`,
		`       结论：ui=${str(d.ui)} → 实际 ${str(d.actual)}`,
		`- Router 提示词：${str(d.routerSource)} · ${bytes === undefined ? MISSING : String(bytes)} 字节${file}${extra}`,
	];
}

/** 本会话自己的 pane（HERDR_PANE_ID）；没有就 undefined */
export function mainPaneId(): string | undefined {
	const v = process.env.HERDR_PANE_ID;
	return v && v.trim() ? v.trim() : undefined;
}

/** 本会话所在 workspace（HERDR_WORKSPACE_ID） */
export function workspaceId(): string | undefined {
	const v = process.env.HERDR_WORKSPACE_ID;
	return v && v.trim() ? v.trim() : undefined;
}

// ======================= pane / tab 操作 =======================

export interface PaneInfo {
	paneId: string;
	cwd?: string;
	label?: string;
	tabId?: string;
	focused?: boolean;
	agentStatus?: string;
}

export function paneList(): PaneInfo[] {
	const raw = runJson(["pane", "list"]);
	if (raw === undefined) return [];
	return parsePaneList(raw);
}

/** 把 `pane list` 的原始 JSON 解成 PaneInfo[]（不碰命令行，纯函数） */
function parsePaneList(raw: unknown): PaneInfo[] {
	const res = unwrapResult(raw);
	const arr = Array.isArray(res.panes) ? res.panes : Array.isArray(findKey(raw, "panes")) ? (findKey(raw, "panes") as unknown[]) : [];
	const out: PaneInfo[] = [];
	for (const item of arr) {
		const p = asRec(item);
		const id = typeof p.pane_id === "string" ? p.pane_id : typeof p.paneId === "string" ? p.paneId : "";
		if (!id) continue;
		out.push({
			paneId: id,
			cwd: typeof p.cwd === "string" ? p.cwd : undefined,
			label: typeof p.label === "string" ? p.label : undefined,
			tabId: typeof p.tab_id === "string" ? p.tab_id : undefined,
			focused: p.focused === true,
			agentStatus: typeof p.agent_status === "string" ? p.agent_status : undefined,
		});
	}
	return out;
}

/** 切一格。成功返回新 paneId，失败 undefined。 */
export function paneSplit(target: string, dir: "right" | "down", ratio: number, cwd: string): string | undefined {
	if (!target) return undefined;
	const r = Number.isFinite(ratio) ? Math.min(0.95, Math.max(0.05, ratio)) : 0.5;
	const raw = runJson([
		"pane",
		"split",
		target,
		"--direction",
		dir,
		"--ratio",
		String(r),
		"--no-focus",
		"--cwd",
		cwd || process.cwd(),
	]);
	if (raw === undefined) return undefined;
	const id = findString(raw, "pane_id");
	return id || undefined;
}

/** 在 pane 里跑一条命令（不抢焦点）。 */
export function paneRun(paneId: string, cmd: string): boolean {
	if (!paneId || !cmd) return false;
	return run(["pane", "run", paneId, cmd]) !== undefined;
}

export function paneRename(paneId: string, label: string): boolean {
	if (!paneId || !label) return false;
	return run(["pane", "rename", paneId, label]) !== undefined;
}

/**
 * 给 pane 发按键：`herdr pane send-keys <PANE_ID> <KEY>...`（失败返回 false，**绝不抛**）。
 *
 * 实测（herdr 0.9.5，Windows PowerShell pane）：`send-keys <id> ctrl+c` 可用 ——
 * pane 里打出 `Control-C`、前台命令被中断、回到提示符；成功时 CLI 输出为空。
 *
 * 用途：失败 / 超时**保留 pane** 时先给里面那个交互式 pi 发 Ctrl+C 停掉。
 * 交互式 pi 答完**不会退出**（停在输入框等下一句），不清掉就等于留一个活进程白占 pane，
 * 用户切过去看到的是「卡住不动」，而不是「失败了、内容留着」。
 */
export function paneSendKeys(paneId: string, keys: string | string[]): boolean {
	const list = Array.isArray(keys) ? keys : [keys];
	if (!paneId || !list.length || list.some((k) => !k)) return false;
	return run(["pane", "send-keys", paneId, ...list]) !== undefined;
}

export function paneClose(paneId: string): boolean {
	if (!paneId) return false;
	return run(["pane", "close", paneId]) !== undefined;
}

/** 读 pane 屏幕内容（失败给空串，方便上层当「没有」） */
export function paneRead(paneId: string): string {
	return paneReadEx(paneId).text;
}

/**
 * 读 pane 屏幕内容，**并且告诉调用方这次读成没读成**。
 *
 * 为什么要多一个 `ok`：卡死看门狗靠「屏幕内容长时间不变」来判定，
 * 而 `paneRead` 把「herdr read 失败」也压成空串 —— 两者混在一起就成了
 * 「读不到」被当成「没变化」，会把活着的 pane 误杀。这里把两种情况分开。
 */
export function paneReadEx(paneId: string): { ok: boolean; text: string } {
	if (!paneId) return { ok: false, text: "" };
	const out = run(["pane", "read", paneId]);
	if (out === undefined) return { ok: false, text: "" };
	return { ok: true, text: out };
}

export interface TabInfo {
	tabId: string;
	label?: string;
	focused?: boolean;
}

export function tabList(): TabInfo[] {
	const raw = runJson(["tab", "list"]);
	if (raw === undefined) return [];
	const res = unwrapResult(raw);
	const arr = Array.isArray(res.tabs) ? res.tabs : [];
	const out: TabInfo[] = [];
	for (const item of arr) {
		const t = asRec(item);
		const id = typeof t.tab_id === "string" ? t.tab_id : typeof t.tabId === "string" ? t.tabId : "";
		if (!id) continue;
		out.push({
			tabId: id,
			label: typeof t.label === "string" ? t.label : undefined,
			focused: t.focused === true,
		});
	}
	return out;
}

/** 新开一个 tab（自带一个 pane）。成功返回 {tabId, paneId}。 */
export function tabCreate(workspace: string, label: string, cwd: string): { tabId: string; paneId: string } | undefined {
	if (!workspace) return undefined;
	const args = ["tab", "create", "--workspace", workspace, "--cwd", cwd || process.cwd(), "--no-focus"];
	if (label) args.push("--label", label);
	const raw = runJson(args);
	if (raw === undefined) return undefined;
	const tabId = findString(raw, "tab_id");
	const paneId = findString(raw, "pane_id");
	if (!tabId || !paneId) return undefined;
	return { tabId, paneId };
}

export function tabRename(tabId: string, label: string): boolean {
	if (!tabId || !label) return false;
	return run(["tab", "rename", tabId, label]) !== undefined;
}

export function tabClose(tabId: string): boolean {
	if (!tabId) return false;
	return run(["tab", "close", tabId]) !== undefined;
}

// ======================= 命名（纯函数）=======================

export type PaneKind = "run" | "ok" | "err" | "stalled" | "stopped";

/**
 * pane 标题。三个状态各打一个记号 —— 用户在 tab 栏扫一眼就知道哪个跑完了、哪个挂了。
 *   run → `▶ sa:<name>#<idx>`
 *   ok  → `✅ sa:<name>#<idx>`
 *   err → `❌ sa:<name>#<idx>（失败·保留）` —— 失败也把 pane 留着，方便回头看输出
 *   stopped → `⏹ sa:<name>#<idx>（已停·保留）` —— 失败的 pane 被保留了，但里面的 pi 已经 Ctrl+C 停掉
 *   stalled → `❌ sa:<name>#<idx>（卡死已降级）` —— 看门狗收掉的 pane（马上要关，所以不写「保留」）
 *
 * 为什么不再写「按回车关闭」：回车关闭从没实现过，写出来就是骗人 —— 文案只说事实。
 */
export function paneLabel(kind: PaneKind, name: string, idx: number): string {
	const who = `sa:${name || "worker"}#${idx}`;
	if (kind === "ok") return `✅ ${who}`;
	if (kind === "err") return `❌ ${who}（失败·保留）`;
	if (kind === "stopped") return `⏹ ${who}（已停·保留）`;
	if (kind === "stalled") return `❌ ${who}（卡死已降级）`;
	return `▶ ${who}`;
}

/** 溢出 tab 的标题：`sa:extra#<n>` */
export function tabLabel(n: number): string {
	return `sa:extra#${n}`;
}

/**
 * **tab 模式**（显式 ui=tab：每个子助理一个标签）的标题：`sa:tab#<n>`。
 * 故意跟溢出用的 `sa:extra#<n>` 分开前缀 —— 共用前缀会让「4 并发开了 4 个标签」
 * 看起来像溢出规划器（planSlot）坏了。两边都以 `sa:` 开头，/panes、pane-close、
 * 自动回收的前缀过滤照样认。
 */
export function tabLabelMode(n: number): string {
	return `sa:tab#${n}`;
}

// ======================= 配置（纯函数 + 读文件）=======================

export type UiMode = "panel" | "split" | "tab";

export interface UiConfig {
	/** "panel" | "split" | "tab" | "auto" */
	ui: string;
	/** 主窗口右侧最多放几个 */
	mainSlots: number;
	/** 溢出 tab 里最多放几个（2×2 四宫格 = 4） */
	overflowSlots: number;
	/** 主会话保留比例（0.6 = 主 pane 留 60%） */
	splitRatio: number;
	/** 失败保留 pane（默认 true） */
	paneKeepOnError: boolean;
}

export const UI_DEFAULTS: UiConfig = {
	// 默认 auto：本机有 herdr 就自动分屏（≤mainSlots 用 split，更多进 tab），
	// 没有 herdr / 分屏链路失败 → 自动降级回 panel。用户明确要求默认 auto。
	// 注意 auto 也依赖 herdr 探测，所以 resolveUiMode 里 herdrOk=false 必须回 panel。
	ui: "auto",
	mainSlots: 2,
	overflowSlots: 4,
	splitRatio: 0.6,
	paneKeepOnError: true,
};

function intIn(v: unknown, def: number, min: number, max: number): number {
	const n = Number(v);
	if (!Number.isFinite(n)) return def;
	return Math.min(max, Math.max(min, Math.round(n)));
}

/** 从 `ai-extensions.json` 的 superagent 块读 UI 配置（读不到/坏了 = 默认值） */
export function readUiConfig(): UiConfig {
	const raw = readExtCfg().superagent;
	const b = asRec(raw);
	// Super Agent 整个关掉（enabled === false）→ 强制 panel：
	// 分屏/tab 是 Super Agent 的功能，模式关了就不该让子助理往 pane 里跑。
	const disabled = b.enabled === false;
	const ui = disabled
		? "panel"
		: typeof b.ui === "string" && ["panel", "split", "tab", "auto"].includes(b.ui)
			? b.ui
			: UI_DEFAULTS.ui;
	const ratio = Number(b.splitRatio);
	const base: UiConfig = {
		ui,
		mainSlots: intIn(b.mainSlots, UI_DEFAULTS.mainSlots, 0, 2),
		overflowSlots: intIn(b.overflowSlots, UI_DEFAULTS.overflowSlots, 0, 4),
		splitRatio: Number.isFinite(ratio) ? Math.min(0.95, Math.max(0.05, ratio)) : UI_DEFAULTS.splitRatio,
		paneKeepOnError: typeof b.paneKeepOnError === "boolean" ? b.paneKeepOnError : UI_DEFAULTS.paneKeepOnError,
	};
	// 测试 / 脚本逃生口：环境变量强制指定 UI 模式，优先级最高。
	// 为什么需要：默认 auto 后，任何"跑一次派活"的脚本都会真去开 Herdr pane，
	// 压测会挂住 + 留一堆残留 pane。压测脚本必须能钉死 panel。
	// 例外：enabled === false（全局关）时环境变量也不能绕过，仍然 panel。
	const forced = String(process.env.PI_SA_UI ?? "").trim().toLowerCase();
	if (!disabled && (forced === "panel" || forced === "split" || forced === "tab" || forced === "auto")) {
		return { ...base, ui: forced };
	}
	return base;
}

/**
 * 这一刻该用哪种 UI。
 *   auto（默认）        → 有 Herdr 就 split，没有就降级 panel（溢出交给 planSlot + overflow tab）
 *   panel               → 永远只画卡片
 *   split / tab         → 要 Herdr；没有就**降级 panel**（不报错、不崩）
 *
 * 缺省 / 认不出来的值都按 UI_DEFAULTS.ui（= auto）算，auto 仍然被 herdrOk 兜住。
 */
export function resolveUiMode(
	cfg: Partial<UiConfig> | undefined,
	/** 目前仅 tab 相关判断保留，不要用它决定 auto（见下面 auto 分支的注释） */
	runningCount: number,
	herdrOk: boolean,
): UiMode {
	const ui = String(cfg?.ui ?? UI_DEFAULTS.ui);
	if (ui === "panel") return "panel";
	if (ui === "split" || ui === "tab") return herdrOk ? ui : "panel";
	// 只有显式写了 auto 才走自动判定；缺省 / 拼错 / 旧配置残留一律 panel（安全默认）
	if (ui !== "auto") return "panel";
	void runningCount;
	// auto = 「有 Herdr 就分屏」：溢出交给 planSlot + overflow tab 去排，
	// **不要**用全局 runningCount 判 split/tab —— 那会把"溢出"错误升级成
	// "每个任务一个标签"（实测 4 并发 → 4 个 extra tab）。
	return herdrOk ? "split" : "panel";
}

// ======================= 槽位规划（纯函数）=======================

export type SlotWhere = "main" | "overflow" | "queue";

export interface SlotPlan {
	/** 第几个子助理（1-based，一次派活内部计数） */
	index: number;
	where: SlotWhere;
	/** 怎么切（tab 自带的 pane 不用切 → 没有这个字段） */
	split?: "right" | "down";
	/**
	 * 在谁的 pane 上切：
	 *  - "root" = 主会话自己的 pane（main）/ 溢出 tab 自带的 pane（overflow）
	 *  - 数字   = 第 N 个槽位的 pane（跨 tab 的全局编号）
	 */
	anchor?: "root" | number;
	ratio?: number;
	/** 溢出 tab 编号（1-based）：第 n 个溢出 tab */
	tab: number;
}

/**
 * 第 n 个溢出 tab 的第一格是全局第几号（1-based）。
 * 主窗口占 1..mainSlots，之后每个溢出 tab 依次占 overflowSlots 个编号 ——
 * 所以「tab n 的第 m 格」= tabBaseIndex(n) + m - 1，两边（规划 / 记账）用同一个公式才不会错位。
 */
export function tabBaseIndex(tab: number, cfg: Partial<UiConfig> | undefined): number {
	const mainSlots = intIn(cfg?.mainSlots, UI_DEFAULTS.mainSlots, 0, 2);
	const overflowSlots = Math.max(1, Math.min(intIn(cfg?.overflowSlots, UI_DEFAULTS.overflowSlots, 0, 4), 4));
	const n = Math.max(1, Math.round(Number(tab) || 1));
	return mainSlots + (n - 1) * overflowSlots + 1;
}

/**
 * 第 N 个子助理放哪一格：
 *   主窗口（右侧竖切两格）：1 = 右边切一刀；2 = 在第 1 个下面再切一刀
 *   溢出 tab（每个 tab 2×2，最多 4 个）：tab 1 是 3/4/5/6，tab 2 是 7/8/9/10 ……
 *     tab 的第一格 = tab 自带的 pane；第 2 格 = 切右；第 3 格 = 切下；第 4 格 = 第 2 格下面
 *   溢出 tab 满了就开下一个 `sa:extra#<n>`，**不再排队等槽位**
 *   overflowSlots = 0（用户显式关掉溢出）→ 主窗口满了才排队
 */
export function planSlot(index: number, cfg: Partial<UiConfig> | undefined): SlotPlan {
	const mainSlots = intIn(cfg?.mainSlots, UI_DEFAULTS.mainSlots, 0, 2);
	const overflowSlots = intIn(cfg?.overflowSlots, UI_DEFAULTS.overflowSlots, 0, 4);
	const ratio = Number(cfg?.splitRatio);
	const splitRatio = Number.isFinite(ratio) ? Math.min(0.95, Math.max(0.05, ratio)) : UI_DEFAULTS.splitRatio;

	if (index < 1) return { index, where: "queue", tab: 0 };

	// ---- 主窗口 ----
	if (index <= mainSlots) {
		if (index === 1) return { index, where: "main", split: "right", anchor: "root", ratio: splitRatio, tab: 0 };
		return { index, where: "main", split: "down", anchor: index - 1, ratio: 0.5, tab: 0 };
	}

	// ---- 溢出 tab（每个 tab 2×2 四格；满了开下一个 tab）----
	if (overflowSlots < 1) return { index, where: "queue", tab: 0 };
	const offset = index - mainSlots - 1; // 0-based：第几个溢出格
	const tab = Math.floor(offset / overflowSlots) + 1;
	const pos = (offset % overflowSlots) + 1; // 1..overflowSlots
	const base = tabBaseIndex(tab, cfg); // 该 tab 的第一格（全局编号）
	if (pos === 1) return { index, where: "overflow", tab }; // tab 自带 pane，不切
	if (pos === 2) return { index, where: "overflow", split: "right", anchor: base, ratio: 0.5, tab };
	if (pos === 3) return { index, where: "overflow", split: "down", anchor: base, ratio: 0.5, tab };
	return { index, where: "overflow", split: "down", anchor: base + 1, ratio: 0.5, tab };
}

/**
 * 一个主窗口 + 一个溢出 tab 能放几个（= 第一个溢出 tab 的容量）。
 * ⚠️ 这**不是**总上限了：溢出 tab 会接着开（sa:extra#2/#3…），只是用来算「第一屏放几个」。
 */
export function slotCapacity(cfg: Partial<UiConfig> | undefined): number {
	const mainSlots = intIn(cfg?.mainSlots, UI_DEFAULTS.mainSlots, 0, 2);
	const overflowSlots = intIn(cfg?.overflowSlots, UI_DEFAULTS.overflowSlots, 0, 4);
	return mainSlots + Math.min(overflowSlots, 4);
}
