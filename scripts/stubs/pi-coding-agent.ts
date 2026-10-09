/**
 * 测试用桩：把 `@earendil-works/pi-coding-agent` 换成本文件（esbuild --alias）。
 *
 * 扩展真正用到宿主的只有 `getAgentDir()`；类型 import 会被 esbuild 抹掉。
 * 这样无头测试就不需要真的装 pi、也不需要连任何东西。
 */
import { join } from "node:path";
import { homedir } from "node:os";

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export type ExtensionAPI = any;
export type ExtensionContext = any;
export type ExtensionCommandContext = any;
