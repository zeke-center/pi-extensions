// 类型检查闸门：只抓「引用了不存在的东西」这类运行时才炸的 bug（TS18004/TS2304）。
// 背景：v2.6.0/2.6.1 因为 pane 分支引用未定义的 maxTurns，派活 1 秒全崩，
// 而单元测试全绿（测试没走那条分支）。tsc 能静态抓到，代价是一次 npx 下载。
import { execFileSync } from "node:child_process";
const FILES = ["ai-configure/delegate.ts", "ai-configure/superagent.ts", "ai-configure/live.ts", "ai-configure/herdr.ts", "ai-configure/mcp-pool.ts", "ai-configure/results.ts", "ai-configure/board.ts", "ai-configure/settings.ts", "ai-configure/form.ts"];
const ARGS = ["-y", "-p", "typescript@5.6.3", "tsc", "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler"];
// 只关心这几种：未定义的标识符（运行时 ReferenceError 的源头）
const WANT = /error TS(18004|2304|2552|2448)/;
let out = "";
try {
	out = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [...ARGS, ...FILES], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
	out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}
const hits = out.split(/\r?\n/).filter((l) => WANT.test(l));
if (hits.length) {
	console.log(`❌ 类型检查：${hits.length} 处未定义标识符（运行时会 ReferenceError）`);
	for (const h of hits.slice(0, 20)) console.log(`   ${h}`);
	process.exit(1);
}
console.log("✅ 类型检查通过：没有未定义标识符（TS18004/TS2304）");
