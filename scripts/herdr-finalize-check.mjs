#!/usr/bin/env node
/**
 * 真机自检：pane 模式收尾的**两条路径**都必须写出 `.bg` 终态。
 *
 * 回归背景：pane 跑完但 `.bg` 永远 `status: "running"`、回执永远不投（rpc 那条路正常）。
 * 根因是「解析 <result> → markEnd → 写 `.bg` 终态 → 投递」只写在 rpc 分支里。
 *
 * 这里不碰真实 `~/.pi/agent/assistant-sessions/.bg`：
 * 用 `PI_CODING_AGENT_DIR` 指到临时目录，走**真实的** bg-store 读写。
 *
 * 用法：node scripts/herdr-finalize-check.mjs
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	const tryResolve = (from) => {
		try {
			return require.resolve("esbuild/bin/esbuild", { paths: [from] });
		} catch {
			return undefined;
		}
	};
	const hit =
		(piDir && tryResolve(piDir)) ||
		tryResolve(root) ||
		(() => {
			try {
				return join(execSync("npm root -g", { encoding: "utf8" }).trim(), "esbuild", "bin", "esbuild");
			} catch {
				return undefined;
			}
		})();
	return hit && existsSync(hit) ? hit : undefined;
}

const piDir = findPiDir();
const esbuild = findEsbuild(piDir);
if (!esbuild) {
	console.error("❌ 找不到 esbuild（npm i -g esbuild，或设 PI_PACKAGE_DIR）");
	process.exit(2);
}

function runner(p) {
	const head = readFileSync(p).subarray(0, 2);
	const native = head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a; // MZ
	const elf = head.length >= 2 && head[0] === 0x7f && head[1] === 0x45; // ELF
	return native || elf ? { cmd: p, pre: [] } : { cmd: process.execPath, pre: [p] };
}
const r = runner(esbuild);

const tmp = mkdtempSync(join(tmpdir(), "herdr-finalize-"));
const agentDir = join(tmp, "agent");
const stubs = join(root, "scripts", "stubs");
const out = join(tmp, "delegate.mjs");

try {
	execFileSync(
		r.cmd,
		[
			...r.pre,
			join(ext, "delegate.ts"),
			"--bundle",
			"--format=esm",
			"--platform=node",
			"--external:node:*",
			`--alias:@earendil-works/pi-coding-agent=${join(stubs, "pi-coding-agent.ts")}`,
			`--alias:@earendil-works/pi-tui=${join(stubs, "pi-tui.ts")}`,
			`--alias:typebox=${join(stubs, "typebox.ts")}`,
			`--outfile=${out}`,
			"--log-level=error",
		],
		{ cwd: root, encoding: "utf8" },
	);
} catch (e) {
	console.error("❌ esbuild 打包失败");
	console.error(String(e.stderr || e.stdout || e.message).slice(0, 2000));
	process.exit(3);
}

// 追加断言：跑在同一个模块作用域里 → 能直接用内部函数（writeBgTask / readBgTask 等）
const receipt = ["干完了", "<result>", JSON.stringify({ ok: true, verdict: "pass", changed: ["a.ts"], ran: ["npm test → 12 passed"], blocked: [], notes: "ok" }), "</result>"].join("");
const asserts = [
	`const R = [];`,
	`const ok = (n, c) => R.push((c ? "PASS" : "FAIL") + "  " + n);`,
	`const mk = (id) => writeBgTask({ id, key: "k", name: "n", task: "t", sessionId: "s-" + id, startedAt: Date.now(), status: "running" });`,
	`const bgDir = () => bgRoot();`,
	`// ---- 路径 1：pane 结束 + 没有 receipt → 必须落 status:"empty" ----`,
	`const idNo = "check-no-receipt-" + Math.random().toString(36).slice(2, 8);`,
	`mk(idNo);`,
	`writeHerdrBgTerminal(idNo, finalizeHerdrRun({ outcome: "done", text: "任务跑完了，但没交卡" }));`,
	`const no = readBgTask(idNo);`,
	`ok("路径1（无 receipt）：.bg status=empty（不卡 running）", no && no.status === "empty");`,
	`ok("路径1（无 receipt）：delivered=false 且 finishedAt 有值", !!no && no.delivered === false && !!no.finishedAt);`,
	`// ---- 路径 2：pane 结束 + 有 receipt → 必须落 status:"done" ----`,
	`const idYes = "check-receipt-" + Math.random().toString(36).slice(2, 8);`,
	`mk(idYes);`,
	`writeHerdrBgTerminal(idYes, finalizeHerdrRun({ outcome: "done", text: ${JSON.stringify(receipt)} }));`,
	`const yes = readBgTask(idYes);`,
	`ok("路径2（有 receipt）：.bg status=done", yes && yes.status === "done");`,
	`ok("路径2（有 receipt）：resultText 带结论正文", !!yes && String(yes.resultText || "").includes("干完了"));`,
	`ok("路径2（有 receipt）：delivered=false（等轮询回投）", !!yes && yes.delivered === false);`,
	`// ---- 两条路径都必须真的写到磁盘上（存在 .json 文件，且内容解析得到 status）----`,
	`const files = listBgTasks().map((t) => t.id);`,
	`ok("落盘：两条都在 .bg 目录里（临时目录）", files.includes(idNo) && files.includes(idYes));`,
	`ok("落盘：目录是临时目录，不是真实 .bg", bgDir().startsWith(process.env.PI_CODING_AGENT_DIR));`,
	`const bad = R.filter((x) => x.startsWith("FAIL"));`,
	`console.log(R.join("\\n"));`,
	`console.log("\\n" + (R.length - bad.length) + "/" + R.length + " 通过");`,
	`console.log("临时 .bg 目录：" + bgDir());`,
	`process.exit(bad.length ? 1 : 0);`,
];

writeFileSync(out, readFileSync(out, "utf8") + "\n" + asserts.join("\n") + "\n", "utf8");
try {
	const stdout = execFileSync(process.execPath, [out], {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		encoding: "utf8",
	});
	process.stdout.write(stdout);
} catch (e) {
	process.stdout.write(String(e.stdout ?? ""));
	process.stderr.write(String(e.stderr ?? ""));
	console.error("\n❌ pane 收尾真机自检失败");
	process.exitCode = 1;
} finally {
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}
