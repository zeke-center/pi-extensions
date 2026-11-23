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

let availableCache: boolean | undefined;

/** 终端是不是 Herdr（`TERM_PROGRAM=herdr`）+ herdr 真的能回 JSON */
export function herdrAvailable(): boolean {
	if (availableCache !== undefined) return availableCache;
	if (process.env.TERM_PROGRAM !== "herdr") {
		availableCache = false; // 环境变量不会中途变，可以放心缓存
		return false;
	}
	// 能拿到可解析的 JSON 才算「真的能用」——只看环境变量会被「herdr 没装/服务没起」骗过去
	availableCache = runJson(["pane", "list"]) !== undefined;
	return availableCache;
}

/** 单测 / 换环境时清缓存 */
export function resetHerdrCache(): void {
	availableCache = undefined;
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
 *   err → `❌ sa:<name>#<idx>（按回车关闭）`
 *   stopped → `❌ sa:<name>#<idx>（已停，回车关闭）` —— 失败的 pane 被保留了，但里面的 pi 已经 Ctrl+C 停掉
 *   stalled → `❌ sa:<name>#<idx>（卡死已降级）` —— 看门狗收掉的 pane（马上要关，所以不写「按回车关闭」）
 */
export function paneLabel(kind: PaneKind, name: string, idx: number): string {
	const who = `sa:${name || "worker"}#${idx}`;
	if (kind === "ok") return `✅ ${who}`;
	if (kind === "err") return `❌ ${who}（按回车关闭）`;
	if (kind === "stopped") return `❌ ${who}（已停，回车关闭）`;
	if (kind === "stalled") return `❌ ${who}（卡死已降级）`;
	return `▶ ${who}`;
}

/** 溢出 tab 的标题：`sa:extra#<n>` */
export function tabLabel(n: number): string {
	return `sa:extra#${n}`;
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
 *   auto（默认）        → 没有 Herdr → panel；≤ mainSlots 个 → split；更多 → tab（溢出到 tab）
 *   panel               → 永远只画卡片
 *   split / tab         → 要 Herdr；没有就**降级 panel**（不报错、不崩）
 *
 * 缺省 / 认不出来的值都按 UI_DEFAULTS.ui（= auto）算，auto 仍然被 herdrOk 兜住。
 */
export function resolveUiMode(
	cfg: Partial<UiConfig> | undefined,
	runningCount: number,
	herdrOk: boolean,
): UiMode {
	const ui = String(cfg?.ui ?? UI_DEFAULTS.ui);
	if (ui === "panel") return "panel";
	if (ui === "split" || ui === "tab") return herdrOk ? ui : "panel";
	// 只有显式写了 auto 才走自动判定；缺省 / 拼错 / 旧配置残留一律 panel（安全默认）
	if (ui !== "auto") return "panel";
	if (!herdrOk) return "panel";
	const mainSlots = intIn(cfg?.mainSlots, UI_DEFAULTS.mainSlots, 0, 2);
	return runningCount <= mainSlots ? "split" : "tab";
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
