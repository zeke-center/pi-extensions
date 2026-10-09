#!/usr/bin/env node
/**
 * 冒烟测试：让 pi 真的把这个扩展加载一遍（RPC 模式、无会话），断言命令都注册上了。
 * 不需要 API key、不需要网络 —— 只加载扩展、列命令。
 *
 * 用法：node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "ai-configure", "pi-extensions.ts");

/** 扩展应当注册的全部命令 */
const EXPECT = [
	"ai",
	"aihelp",
	"board",
	"assistants",
	"agents",
	"resume-agent",
	"agent-resume-back",
	"delegate-mode",
];

const isWin = process.platform === "win32";
const child = spawn(isWin ? "pi.cmd" : "pi", ["--mode", "rpc", "--no-session", "-ne", "-e", entry], {
	stdio: ["pipe", "pipe", "pipe"],
	shell: isWin,
});

let out = "";
let err = "";
child.stdout.on("data", (d) => {
	out += d.toString();
});
child.stderr.on("data", (d) => {
	err += d.toString();
});
try {
	child.stdin.write(`${JSON.stringify({ id: "1", type: "get_commands" })}\n`);
} catch {
	/* ignore */
}

const found = () => EXPECT.every((n) => out.includes(`"name":"${n}"`));

await new Promise((resolve) => {
	const t = setTimeout(resolve, 60000);
	const tick = setInterval(() => {
		if (found()) {
			clearInterval(tick);
			clearTimeout(t);
			resolve();
		}
	}, 100);
	child.on("close", () => {
		clearInterval(tick);
		clearTimeout(t);
		resolve();
	});
});
try {
	child.kill();
} catch {
	/* ignore */
}

const missing = EXPECT.filter((n) => !out.includes(`"name":"${n}"`));
if (missing.length) {
	console.error(`❌ 扩展没注册这些命令：${missing.join(", ")}`);
	if (err.trim()) console.error(`stderr:\n${err.trim().slice(0, 2000)}`);
	process.exit(1);
}
console.log(`✅ 冒烟通过：${EXPECT.length} 个命令全部注册`);
