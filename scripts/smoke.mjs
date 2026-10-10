#!/usr/bin/env node
/**
 * 冒烟测试：让 pi 真的把这个扩展加载一遍（RPC 模式、无会话），断言命令都注册上了。
 * 不需要 API key、不需要网络 —— 只加载扩展、列命令。
 *
 * 用法：node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "ai-configure", "pi-extensions.ts");

// 静态守卫：同一批资源只能声明一遍。
// package.json 的 pi.prompts 与入口的 resources_discover 都往 pi 的 promptPaths 里塞；
// 两者指向同一目录 = 同一个模板注册两遍 → TUI 报
//   [Prompt conflicts] name "/ai-delegate" collision（✓ 采用 / ✗ (skipped)）
// 设计：包通道靠清单、拷贝通道靠 <agentDir>/prompts 约定目录，各管一边，不重复。
{
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const declared = [...(pkg.pi?.prompts ?? []), ...(pkg.pi?.skills ?? [])];
	const src = readFileSync(entry, "utf8");
	if (declared.length > 0 && /(?:api|pi)\.on\(\s*["']resources_discover["']/.test(src)) {
		console.error(
			"❌ package.json 已声明 pi.prompts/pi.skills，入口又用了 resources_discover → 同一资源注册两遍（Prompt conflicts）。二选一。",
		);
		process.exit(1);
	}
}

/** 扩展应当注册的全部命令 */
const EXPECT = [
	"ai",
	"aihelp",
	"aidoctor",
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
