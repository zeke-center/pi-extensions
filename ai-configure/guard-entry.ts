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
import { appendFileSync, readFileSync } from "node:fs";
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

export default function (pi: ExtensionAPI) {
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
	const opts = {
		cwd: str(cfg.cwd) || process.cwd(),
		// 插件源码目录 = 硬保护（Worker 改不到「改自己的守卫」）
		protectedPaths: pluginDir ? [pluginDir, ...extra] : extra,
	};
	const logFile = join(root, "guard.log");

	const logLine = (line: string): void => {
		try {
			appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, "utf8");
		} catch {
			/* 记不上就记不上，不因为这个拦活 */
		}
	};

	pi.on("tool_call", async (event) => {
		const d = decideToolCall(perms, opts, event.toolName, event.input);
		if (!d.block) return undefined;
		if (d.logOnly) {
			// 观察期：只记录，不真拦（先量一下误拦率，再决定切不切硬拦）
			logLine(`WOULD_BLOCK ${d.kind ?? "?"} ${event.toolName} ${summarizeCall(event.toolName, event.input)}`);
			return undefined;
		}
		return {
			block: true,
			reason: d.reason ?? `EPERM[${d.kind ?? "policy"}] 这个动作超出当前 Worker 的权限。`,
		};
	});
}
