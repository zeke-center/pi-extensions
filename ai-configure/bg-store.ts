/**
 * 后台任务记账（`.bg/<id>.json`）的**纯逻辑**：合并写 + 过期判定。
 *
 * 为什么要单独一个文件：
 *   `writeBgTask()` 原来是**整对象覆盖写**，而同一条任务会被好几条路径先后写
 *   （任务结束写 `{status:failed, delivered:false}` → 投递成功写 `{...旧快照, delivered:true}`
 *    → 看门狗/超时/退出钩子再写一次，把 `delivered:true` 又冲回 `false`）。
 *   结果 `/reload` 扫 `.bg/` 看到 `delivered !== true` 就再投一遍 —— 用户收到重复卡片。
 *   修法：写之前先读旧值、按「单向字段」合并。合并规则是纯函数，放这里可以单独单测。
 */

/** 一条后台任务的记账内容（`.bg/<id>.json` 的结构） */
export interface BgTaskFile {
	id: string;
	key: string;
	name: string;
	task: string;
	sessionId: string;
	startedAt: number;
	status: "running" | "done" | "timeout" | "failed" | "empty";
	resultText?: string;
	finishedAt?: number;
	delivered?: boolean;
	/** 派发它的「主会话」文件路径 —— 结果只投回这个会话，别的会话扫到也不投（防串台） */
	ownerSessionFile?: string;
	/** 派发它的主会话 ID（file 拿不到时的退路，也方便排查） */
	ownerSessionId?: string;
	/** 投递失败重试次数 */
	attempts?: number;
	/** 上次尝试投递的时间（算退避用） */
	lastAttemptAt?: number;
	/** 第一次投递失败的时间（算“多久还没发出去”用） */
	firstFailAt?: number;
	/** 最后一次投递失败的原因（排查用） */
	lastError?: string;
	/** 自动重试已放弃（超时），等 /agents bg redeliver 手动投 */
	undelivered?: boolean;
	/**
	 * 这是**一批**任务的汇总卡（同一次 delegate(tasks) 只落这一条）。
	 * 投递时直接用 resultText（卡里已经带了每个任务的一行 + 找回方式），
	 * 不再套「子Agent「x」回来了」的壳。
	 */
	batch?: boolean;
	/**
	 * 归档后的**结果文件路径**（`<agentDir>/results/<日期>/task-<id>.md`）。
	 * 有它就不用 `/resume-agent` 重载上下文：直接看文件（或 `/batch <id>`）就是完整正文。
	 * 归档失败时没有这个字段 —— 回投卡照旧，只是没有「结果：」那行。
	 */
	resultPath?: string;
	/**
	 * 这个任务最晚该什么时候有动静（= startedAt + timeoutMs + 余量）。
	 * `reapStaleBgTasks()` 按它判“是不是真孤儿”，**不能写死 10 分钟** ——
	 * timeoutMs 最大能到 30 分钟，写死就会把还在正常跑的活在第 10 分钟误判失败
	 * （实测后果：先投一张假失败卡，真跑完后再投一张）。
	 * 老文件没这个字段 → 回退到原来的 10 分钟兑底。
	 */
	deadlineAt?: number;
}

/**
 * 写一版新内容时可以只给一部分字段（`writeBgTask` 会跟磁盘上的旧值合并）。
 *
 * `reset` = **显式清除**：只有用户主动点「重投」这种场景才该把 `attempts` /
 * `firstFailAt` / `undelivered` 归零，普通写不许倒退（否则又是重复投递的老毛病）。
 */
export type BgTaskNext = Partial<BgTaskFile> & {
	id: string;
	reset?: (keyof BgTaskFile)[];
};

/** 只增不减的字段（取两者较大值） */
const MAX_KEYS = ["attempts", "lastAttemptAt"] as const;
/** 只取最早值的字段 */
const MIN_KEYS = ["firstFailAt"] as const;

function maxNum(a?: number, b?: number): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.max(a, b);
}
function minNum(a?: number, b?: number): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.min(a, b);
}

/**
 * 合并「磁盘上已有的旧值」和「这次要写的新值」。
 *
 * 规则（顺序即优先级）：
 * 1. 旧值打底；`next` 里**显式给了**的字段覆盖旧值（`status`/`resultText`/`finishedAt` 等允许覆盖）。
 * 2. `delivered`：**单向** —— 旧值 true 就永远 true，绝不 true→false（这就是重复投递的根因）。
 * 3. `undelivered`：一旦 true 就保持 true，除非 `reset` 里点了名。
 * 4. `attempts` 取 max、`lastAttemptAt` 取最新、`firstFailAt` 取最早（`reset` 点名的除外）。
 * 5. `lastError`：新值非空就用新的；显式给 `undefined`/`""` 表示清掉；否则保留旧的。
 * 6. `reset` 里点名的字段强制清零/清空。
 *
 * 纯函数：不读盘、不看时钟、不改入参。
 */
export function mergeBgTask(old: BgTaskFile | undefined, next: BgTaskNext): BgTaskFile {
	const reset = new Set<string>(next.reset ?? []);
	const merged: Record<string, unknown> = { ...(old ?? {}) };

	for (const [k, v] of Object.entries(next)) {
		if (k === "reset") continue;
		if (v === undefined) {
			// 显式给 undefined 一般不覆盖旧值（调用方常只关心少数字段）；
			// 但 lastError 例外：清空失败原因是常见意图（投递成功后就这么写）。
			if (k === "lastError") merged[k] = undefined;
			continue;
		}
		merged[k] = v;
	}
	merged.id = next.id;

	// delivered：单向 false → true
	if (old?.delivered === true) merged.delivered = true;

	// undelivered：单向（除非显式 reset）
	if (reset.has("undelivered")) merged.undelivered = false;
	else if (old?.undelivered === true) merged.undelivered = true;

	for (const k of MAX_KEYS) {
		if (reset.has(k)) continue;
		const v = maxNum(old?.[k] as number | undefined, next[k] as number | undefined);
		if (v === undefined) delete merged[k];
		else merged[k] = v;
	}
	for (const k of MIN_KEYS) {
		if (reset.has(k)) continue;
		const v = minNum(old?.[k] as number | undefined, next[k] as number | undefined);
		if (v === undefined) delete merged[k];
		else merged[k] = v;
	}

	// lastError：取新非空值；显式 undefined/"" = 清掉；否则留旧
	const nl = typeof next.lastError === "string" ? next.lastError.trim() : "";
	if (reset.has("lastError")) merged.lastError = undefined;
	else if (nl) merged.lastError = next.lastError;
	else if ("lastError" in next) merged.lastError = undefined;

	// reset 点名的其余字段：直接抹掉（id / delivered 不许 reset：delivered 是单向的）
	for (const k of reset) {
		if (k === "attempts") merged.attempts = 0;
		else if (k === "undelivered") merged.undelivered = false;
		else if (k === "id" || k === "delivered") continue;
		else merged[k] = undefined;
	}

	// 值仍是 undefined 的键删掉：别把 `"lastError": undefined` 写进 JSON，也别让
	// 单测里的深比较因为多了个 undefined 键而失败
	for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];

	return merged as unknown as BgTaskFile;
}

/**
 * 只自动投递「最近」的结果（10 分钟）。
 *
 * 为什么必须有这一条：`armBgTimer()` 在扩展 **load 时**就挂 1 秒轮询，`/reload` 会重新 load 一次；
 * 只要某条记录没能落到 `delivered: true`（投递失败 / 字段被别的写入冲掉 / 老记录），
 * 每次 reload 都会再投一遍 —— 用户被同一张老卡反复打扰。
 * 超过窗口的老记录**留在 `.bg` 里**（面板 / `/agents bg` 还能看到），只允许手动
 * `/agents bg redeliver` 补投。
 */
export const AUTO_DELIVER_WINDOW_MS = 10 * 60 * 1000;
/**
 * 每条记录**最多自动尝试几次**（跨 reload 累计，`attempts` 是只增不减的）。
 * 到顶就不再自动投，留给手动 —— 防止「一直在失败、一直重试」把主会话反复唤醒。
 */
export const AUTO_DELIVER_MAX_ATTEMPTS = 3;

/**
 * 这条记录现在**该不该被自动投递**？返回原因，该投就返回 undefined。
 *
 * 纯函数（时钟可注入），`pollBgTasks()` 只用它一个判据。
 * 命中任何一条 → **不投、也不删**（面板上还能看到「未投递」，可手动补）。
 */
export function autoDeliverSkipReason(t: BgTaskFile, now: number = Date.now()): "old" | "attempts" | undefined {
	// 太老（含完全没有时间戳的老记录）：ref 缺失按 0 算 → 必然超窗口
	const ref = t.finishedAt ?? t.startedAt ?? 0;
	if (now - ref > AUTO_DELIVER_WINDOW_MS) return "old";
	if ((t.attempts ?? 0) >= AUTO_DELIVER_MAX_ATTEMPTS) return "attempts";
	return undefined;
}

/** 投递成功的记账小票保留多久（超过就回收） */
export const BG_KEEP_DELIVERED_MS = 24 * 60 * 60 * 1000;
/** 任何记录（含没投出去的）最多留多久 */
export const BG_KEEP_ANY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 这条记账该不该回收？返回原因，留着就返回 undefined。
 *
 * ⚠️ `status === "running"` 的**一律不动**（任务还在跑，删了就没法回投了）。
 */
export function bgPruneReason(t: BgTaskFile, now: number = Date.now()): "delivered" | "expired" | undefined {
	if (t.status === "running") return undefined;
	const started = t.startedAt ?? 0;
	const done = t.finishedAt ?? started;
	if (t.delivered === true && now - done > BG_KEEP_DELIVERED_MS) return "delivered";
	if (now - started > BG_KEEP_ANY_MS) return "expired";
	return undefined;
}
