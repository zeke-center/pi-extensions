/**
 * guard-entry.ts —— L3 兜底的**极薄入口**（会被复制进影子目录，Worker 侧生效）。
 *
 * 为什么单独一个文件、而且这么薄
 * ----------------------------
 * 这个文件是「装进 Worker 进程里的那个东西」，它只做三件事：
 *   1. 从**自己所在目录的上一级**（= 影子目录根）读 `permissions.json` + `guard-config.json`
 *   2. 把每次 tool_call 交给 `perm-guard.ts` 的纯函数判
 *   3. 该拒的拒、该记的往 `guard.log` 记一行
 *
 * 判定逻辑一律不写这儿 —— 写这儿就没法单测了（这个文件依赖 pi 运行时）。
 *
 * **fail-open**：读不到配置（还没接线 / 配置坏了）→ 一个都不拦。
 * 保险丝不该在"自己出故障"的时候把 Worker 整个锁死。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// 纯函数放在子目录里：pi 会把 `extensions/*.ts` 逐个当扩展加载，
// 而 `extensions/guard/perm-guard.ts` 不在自动发现范围内（只认 `*/index.ts`），不会被误当成扩展。
import { decideToolCall, summarizeCall } from "./guard/perm-guard";

type Perms = Parameters<typeof decideToolCall>[0];

/** 影子目录根：优先用 pi 传进来的 agentDir（Worker 进程一定有），否则按本文件位置推 */
function shadowRoot(): string {
	const env = (process.env.PI_CODING_AGENT_DIR ?? "").trim();
	if (env) return env;
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 加载期致命错误 → 主进程日志。影子目录 2h 就被回收，只写影子等于没写。
 * 这里**故意不复用 evLog**：那个在 initGuard 里，此刻还没跑起来。
 */
function logFatalToMain(e: unknown): void {
	try {
		const cfg = readJson(join(shadowRoot(), "guard-config.json"));
		const dir = typeof cfg?.logDir === "string" ? cfg.logDir : "";
		if (!dir) return;
		mkdirSync(dir, { recursive: true });
		const day = new Date().toISOString().slice(0, 10);
		const row = JSON.stringify({
			t: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
			lvl: "error",
			ev: "worker.ext-load.fail",
			pid: process.pid,
			who: "worker",
			d: { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? (e.stack ?? "").split("\n").slice(1, 4).join(" <- ").trim() : undefined },
		});
		appendFileSync(join(dir, `events-${day}.jsonl`), row + "\n", "utf8");
	} catch {
		/* 忽略 */
	}
}

export default function (pi: ExtensionAPI) {	// 最外层兜底：**守卫坏了也不能让 Worker 起不来**（fail-open 的最后一道）
	try {
		initGuard(pi);
	} catch (e) {
		try {
			appendFileSync(join(shadowRoot(), "guard.log"), `${new Date().toISOString()} GUARD_INIT_FAIL ${e instanceof Error ? e.message : String(e)}\n`, "utf8");
			// 这一条最值钱：扩展加载失败 = Worker 进程直接起不来（v2.8.0 就是这么整批崩的）。
			// 影子目录 2h 就被回收，所以必须同时写进**主进程**的 logs/。
			logFatalToMain(e);
		} catch {
			/* 连日志都写不了就只能放弃 */
			/* 连日志都写不了就只能放弃 */
		}
	}
}

export function initGuard(pi: ExtensionAPI): void {
	const root = shadowRoot();
	const cfg = readJson(join(root, "guard-config.json"));
	const perms = readJson(join(root, "permissions.json")) as Perms | undefined;
	// fail-open：缺一份就不拦（配置没接线 / 坏掉时不该把 Worker 锁死）
	if (!cfg || !perms) return;

	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	const extra = Array.isArray(cfg.protectedPaths)
		? cfg.protectedPaths.filter((x): x is string => typeof x === "string" && x.trim() !== "")
		: [];
	const pluginDir = str(cfg.pluginDir);
	// exec 硬拦开关：默认 false（保持现状，只记 WOULD_BLOCK）；
	// 要真拦就在 guard-config.json 里写 `"execHardBlock": true`。
	const execHardBlock = cfg.execHardBlock === true;
	const opts = {
		cwd: str(cfg.cwd) || process.cwd(),
		// 插件源码目录 = 硬保护（Worker 改不到「改自己的守卫」）
		protectedPaths: pluginDir ? [pluginDir, ...extra] : extra,
		execHardBlock,
	};
	const logFile = join(root, "guard.log");

	/**
	 * 结构化事件 → **主进程**的 logs/events-*.jsonl（和主进程同一份，按 pid 区分）。
	 *
	 * 为什么不用 `./log`：Worker 的影子目录里只有 guard-entry.ts + guard/perm-guard.ts，
	 * 插件其它模块不存在，import 会直接把扩展加载搞崩（v2.8.0 已经踩过一次）。
	 * 所以这里自带十几行写入器；失败一律静默。
	 */
	const mainLogDir = typeof cfg.logDir === "string" && cfg.logDir ? cfg.logDir : "";
	const evLog = (ev: string, d: Record<string, unknown>, lvl: "info" | "warn" | "error" = "info"): void => {
		if (!mainLogDir) return;
		try {
			mkdirSync(mainLogDir, { recursive: true });
			const day = new Date().toISOString().slice(0, 10);
			const row = JSON.stringify({
				t: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
				lvl,
				ev,
				pid: process.pid,
				who: "worker",
				d,
			});
			appendFileSync(join(mainLogDir, `events-${day}.jsonl`), row + "\n", "utf8");
		} catch {
			/* 记不上就记不上 */
		}
	};

	const logLine = (line: string): void => {
		try {
			appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, "utf8");
		} catch {
			/* 记不上就记不上，不因为这个拦活 */
		}
	};

	// ---------- L1：按权限**摘工具**（v2.8.0）----------
	// 以前只做 L3（调用时才拒）：模型看到 bash 就会调、被拒、再换个写法试 —— 白烧 token，
	// 观感也差（"明明写着不执行，为什么还给我 bash"）。这里在工具注册完后直接把不该有的摘掉。
	const applyPermTools = (): void => {
		const api = pi as unknown as {
			setActiveTools?: (names: string[]) => void;
			getAllTools?: () => { name: string }[];
			getActiveTools?: () => string[];
		};
		if (!api?.setActiveTools) return;
		const all =
			typeof api.getAllTools === "function"
				? api.getAllTools().map((t) => t.name)
				: ((api.getActiveTools?.() ?? []) as string[]);
		if (all.length < 3) return; // 工具还没注册完，等下一轮
		const drop = new Set<string>();
		// fs=read → 不能写文件
		if (perms.fs !== "write") for (const n of ["write", "edit", "multi_edit", "apply_patch", "notebook_edit"]) drop.add(n);
		// exec=none → 不能跑命令（safe/any 都保留 bash，靠 L3 白名单拦）
		if (perms.exec === "none") for (const n of ["bash", "shell", "exec", "run_command"]) drop.add(n);
		// net=none → 去掉明显的联网工具（bash 里的联网靠 L3 的命令级拦截）
		if (perms.net === "none") for (const n of all) if (/fetch|http_request|web_|browser|download/i.test(n)) drop.add(n);
		const keep = all.filter((n) => !drop.has(n));
		if (keep.length && keep.length !== all.length) {
			try {
				api.setActiveTools(keep);
				const removed = [...drop].filter((n) => all.includes(n));
				logLine(`L1_MASK removed=${removed.join(",") || "(none)"}`);
				evLog("perm.mask", { before: all.length, after: keep.length, removed });
			} catch {
				/* 摘不掉就算了，L3 还在 */
			}
		}
	};
	/**
	 * ⚠️ **绝对不能在工厂函数里直接调 `setActiveTools`**：
	 * pi 的"动作类"API 在扩展**加载期**会抛
	 * `Extension runtime not initialized. Action methods cannot be called during extension loading.`
	 * —— 扩展加载一失败，整个 Worker 进程就起不来（v2.8.0 真踩过，别人的机器全崩）。
	 * 所以只在**事件回调**里调（那时运行时已就绪），并且整段包 try/catch：
	 * 守卫自己出问题也绝不能把 worker 弄死（fail-open）。
	 */
	const safeApplyPermTools = (): void => {
		try {
			applyPermTools();
		} catch (e) {
			logLine(`L1_MASK_FAIL ${e instanceof Error ? e.message : String(e)}`);
		}
	};
	// 每轮开始前重放（幂等）：工具注册晚于扩展加载，这里是最稳的时机
	pi.on("before_agent_start" as never, (() => {
		safeApplyPermTools();
		return undefined;
	}) as never);
	// 会话开始也补一次（不同版本的 pi 触发顺序不一样）
	pi.on("session_start" as never, (() => {
		safeApplyPermTools();
		return undefined;
	}) as never);

	pi.on("tool_call", async (event) => {
		const d = decideToolCall(perms, opts, event.toolName, event.input);
		if (!d.block) return undefined;
		if (d.logOnly) {
			// 观察期：只记录，不真拦（先量一下误拦率，再决定切不切硬拦）
			logLine(`WOULD_BLOCK ${d.kind ?? "?"} ${event.toolName} ${summarizeCall(event.toolName, event.input)}`);
			evLog("perm.observe", { tool: event.toolName, kind: d.kind }, "warn");
			return undefined;
		}
		evLog("perm.deny", { tool: event.toolName, kind: d.kind, call: summarizeCall(event.toolName, event.input).slice(0, 200) }, "warn");
		return {
			block: true,
			reason: d.reason ?? `EPERM[${d.kind ?? "policy"}] 这个动作超出当前 Worker 的权限。`,
		};
	});
}
