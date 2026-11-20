#!/usr/bin/env node
/**
 * 并发回归：槽位（MAX_CONCURRENT_RUNS）释放**不泄漏**。
 *
 * 为什么单独一个脚本
 * ----------------
 * v2.4.1 把 `releaseRunSlot()` 从「finish 里」提前到「子进程 close/exit 那一刻」，
 * 风险是三条路径（正常 / 超时 / 手动中断）上可能**漏放**或**重复放**：
 *   - 漏放  → 以后永远只剩 3 个并发
 *   - 重复放 → activeRuns 被减亏，并发上限失效
 *
 * 做法（和 scripts/unit.mjs 同一套路，不复制算法）：用 esbuild 把真实的 delegate.ts 打包，
 * 把断言代码追加到同一个模块里 —— 这样能直接读 `activeRuns` / `runSlotWaiters`，
 * 并且真的 spawn 一个**假 pi CLI**（PI_CLI）把 正常 / 超时 / 中断 三条路径各跑一遍。
 *
 * 用法：node scripts/concurrency-regress.mjs
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ext = join(root, "ai-configure");

function findPiDir() {
	const cands = [];
	if (process.env.PI_PACKAGE_DIR) cands.push(process.env.PI_PACKAGE_DIR);
	try {
		cands.push(dirname(require.resolve("@earendil-works/pi-coding-agent")));
	} catch {
		/* ignore */
	}
	try {
		const g = execSync("npm root -g", { encoding: "utf8" }).trim();
		cands.push(join(g, "@earendil-works", "pi-coding-agent"));
	} catch {
		/* ignore */
	}
	return cands.find((c) => c && existsSync(c));
}

function findEsbuild(piDir) {
	const cands = [];
	const push = (p) => p && cands.push(p);
	if (piDir) {
		try {
			push(createRequire(join(piDir, "package.json")).resolve("esbuild/bin/esbuild"));
		} catch {
			/* ignore */
		}
		try {
			push(join(piDir, "node_modules", "esbuild", "bin", "esbuild"));
		} catch {
			/* ignore */
		}
	}
	try {
		push(createRequire(import.meta.url).resolve("esbuild/bin/esbuild"));
	} catch {
		/* ignore */
	}
	try {
		const g = execSync("npm root -g", { encoding: "utf8" }).trim();
		push(join(g, "esbuild", "bin", "esbuild"));
	} catch {
		/* ignore */
	}
	const p = cands.find((c) => existsSync(c));
	if (!p) return undefined;
	const head = readFileSync(p).subarray(0, 4);
	const native = (head[0] === 0x7f && head[1] === 0x45) || (head[0] === 0x4d && head[1] === 0x5a);
	// JS 垫片必须用 node 跑（和 unit.mjs 的 esbuildRunner 一致）
	return { cmd: native ? p : process.execPath, pre: native ? [] : [p] };
}

const piDir = findPiDir();
const esbuild = findEsbuild(piDir);
if (!esbuild) {
	console.error("❌ 找不到 esbuild（npm i -g esbuild 或设 PI_PACKAGE_DIR）");
	process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), "pi-conf-regress-"));
const stubs = join(root, "scripts", "stubs");

const bundleOut = join(tmp, "delegate-bundle.mjs");
try {
	execFileSync(
		esbuild.cmd,
		[
			...esbuild.pre,
			join(ext, "delegate.ts"),
			"--bundle",
			"--format=esm",
			"--platform=node",
			"--external:node:*",
			`--alias:@earendil-works/pi-coding-agent=${join(stubs, "pi-coding-agent.ts")}`,
			`--alias:@earendil-works/pi-tui=${join(stubs, "pi-tui.ts")}`,
			`--alias:typebox=${join(stubs, "typebox.ts")}`,
			`--outfile=${bundleOut}`,
			"--log-level=error",
		],
		{ cwd: root, encoding: "utf8" },
	);
} catch (e) {
	console.error("❌ esbuild 打包失败");
	console.error(String(e.stderr || e.stdout || e.message).slice(0, 2000));
	process.exit(3);
}

// ---------- 假 pi CLI ----------
const fakeCli = join(tmp, "fake-pi-cli.js");
writeFileSync(
	fakeCli,
	`const mode = process.env.FAKE_MODE || "ok";
const args = process.argv.slice(2);
if (args.includes("--help")) {
	process.stdout.write("  --mode <mode>  Output mode: text (default), json, or rpc\\n");
	process.exit(0);
}
if (mode === "hang") {
	// 故意不退出、也不理 stdin 关闭 —— 模拟卡死在长命令里（超时 / 中断路径靠它）
	setInterval(() => {}, 1000);
} else {
	let buf = "";
	const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			let rec;
			try { rec = JSON.parse(line); } catch { continue; }
			if (rec.type === "prompt") {
				send({ type: "agent_start" });
				setTimeout(() => {
					send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "干完了" } });
					send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "干完了" }] } });
					send({ type: "agent_settled" });
				}, 30);
			}
		}
	});
	process.stdin.on("end", () => process.exit(0));
}
`,
	"utf8",
);

// ---------- 断言代码（追加在真实模块末尾 → 用内部名）----------
const testBody = `
// ======= 并发回归断言（同一个模块作用域，能读内部状态）=======
const __fs = await import("node:fs");
const __path = await import("node:path");
const WORK = process.env.REGRESS_CWD;
let ok = 0;
let bad = 0;
const check = (name, cond) => {
	if (cond) { ok++; console.log("PASS  " + name); }
	else { bad++; console.log("✗ FAIL  " + name); }
};

const tpl = () => ({
	key: "regress",
	name: "并发回归",
	desc: "d",
	cwd: WORK,
	mcp: [],
	perms: { fs: "write", paths: ["\${cwd}"], exec: "any", cmds: [], net: "allow" },
	body: "x",
	env: {},
	file: "regress.md",
});
const nm = (i) => ({ id: "regress-20260101-00000" + i + "-" + i, display: "回归" + i });
const opt = (i, extra) => ({
	sessionDir: __path.join(WORK, "sessions"),
	shadowDir: __path.join(WORK, "shadow"),
	names: nm(i),
	timeoutMs: 30_000,
	...extra,
});

// 打点：谁在什么时候放的槽位 / 什么时候 markEnd（验证「先释放，后收尾」）
const origRelease = releaseRunSlot;
let releaseCount = 0;
let lastReleaseAt = 0;
releaseRunSlot = () => {
	releaseCount++;
	lastReleaseAt = Date.now();
	origRelease();
};
const origAcquire = acquireRunSlot;
let maxActive = 0;
let acquireCount = 0;
acquireRunSlot = async () => {
	acquireCount++;
	await origAcquire();
	if (activeRuns > maxActive) maxActive = activeRuns;
};
const origMarkEnd = markEnd;
let lastMarkEndAt = 0;
markEnd = (job, st, note) => {
	lastMarkEndAt = Date.now();
	return origMarkEnd(job, st, note);
};
const origAddJob = addJob;
const seenQueued = new Set();
addJob = (job) => {
	if (job.status === "queued") seenQueued.add(job.sessionId);
	return origAddJob(job);
};

// ---- 路径 A：6 个并发（上限 4）→ 必定排队，全部 done，最后槽位全归还 ----
process.env.FAKE_MODE = "ok";
const many = await Promise.all(
	Array.from({ length: 6 }, (_, i) => runAssistant(tpl(), "任务 " + i, opt(i + 1))),
);
check("A 正常路径：6 个全部 done", many.every((r) => r.outcome === "done"));
check("A 并发峰值 = 4（上限生效）", maxActive === 4);
check("A 有任务被排过队（面板能显示「⏳ 排队中」）", seenQueued.size === 2);
check("A 全部结束后 activeRuns = 0（没泄漏）", activeRuns === 0);
check("A 等待队列清空", runSlotWaiters.length === 0);
check("A 释放次数 = 拿槽位次数（单次释放，没重复放）", releaseCount === acquireCount);
check("A 槽位在面板收尾之前就还了（release 早于 markEnd）", lastReleaseAt > 0 && lastReleaseAt <= lastMarkEndAt);

// ---- 路径 B：超时（假 CLI 卡死，到点被 kill）→ 槽位必须回来 ----
process.env.FAKE_MODE = "hang";
const beforeRel = releaseCount;
const tB = await runAssistant(tpl(), "卡死任务", opt(11, { timeoutMs: 1_500 }));
check("B 超时路径：报 timeout", tB.outcome === "timeout");
check("B 超时路径：槽位释放了一次", releaseCount === beforeRel + 1);
check("B 超时路径：activeRuns 回到 0", activeRuns === 0 && runSlotWaiters.length === 0);

// ---- 路径 C：手动中断（AbortController）→ 槽位必须回来 ----
const ac = new AbortController();
setTimeout(() => ac.abort(), 600);
const beforeRelC = releaseCount;
const tC = await runAssistant(tpl(), "被中断的任务", opt(12, { signal: ac.signal }));
check("C 中断路径：报 failed", tC.outcome === "failed");
check("C 中断路径：槽位释放了一次", releaseCount === beforeRelC + 1);
check("C 中断路径：activeRuns 回到 0", activeRuns === 0 && runSlotWaiters.length === 0);

// ---- 路径 D：连续跑 8 个（串行）→ 槽位计数不能漂 ----
process.env.FAKE_MODE = "ok";
for (let i = 0; i < 8; i++) await runAssistant(tpl(), "轮次 " + i, opt(20 + i));
check("D 串行 8 轮后 activeRuns 仍 = 0（不累积漂移）", activeRuns === 0);
check("D 槽位仍能全开 4 个（上限没缩水）", (await Promise.all(Array.from({ length: 4 }, (_, i) => runAssistant(tpl(), "复查 " + i, opt(40 + i))))).every((r) => r.outcome === "done") && activeRuns === 0);

console.log("\\n" + ok + " 通过 / " + bad + " 失败");
process.exit(bad ? 1 : 0);
`;

writeFileSync(join(tmp, "regress.mjs"), `${readFileSync(bundleOut, "utf8")}\n${testBody}`, "utf8");
mkdirSync(join(tmp, "work"), { recursive: true });
mkdirSync(join(tmp, "work", "sessions"), { recursive: true });

console.log(`假 CLI: ${fakeCli}`);
console.log(`临时目录: ${tmp}\n`);
try {
	execFileSync(process.execPath, [join(tmp, "regress.mjs")], {
		stdio: "inherit",
		cwd: join(tmp, "work"),
		env: {
			...process.env,
			PI_CLI: fakeCli,
			PI_DELEGATE_RPC: "1",
			PI_CODING_AGENT_DIR: join(tmp, "agent"),
			REGRESS_CWD: join(tmp, "work"),
			PI_SKIP_VERSION_CHECK: "1",
		},
		timeout: 180_000,
	});
} catch {
	console.error("\n❌ 并发回归失败");
	process.exit(1);
}
