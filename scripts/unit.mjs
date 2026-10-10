#!/usr/bin/env node
/**
 * 无头单元测试。
 *
 * 关键点：**不复制算法**。用 pi 自带的 esbuild 把真实源码打成单文件，
 * 再把断言代码追加到同一个模块里 —— 这样能直接调用那些没 export 的内部函数
 * （会话锁 / 结果归属 / env 过滤 / 并发信号量 / 影子目录）。
 *
 * 用法：node scripts/unit.mjs
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ext = join(root, "ai-configure");

// ---------- 找到 pi 包目录 / esbuild ----------
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

/** esbuild 的 `bin/esbuild` 在不同平台是两种东西：
 *   - Windows / 本仓库（npm 装出来）：JS 垫片（首行 `#!`）→ 必须用 node 跑
 *   - Linux（npm 装 esbuild 时会用原生二进制把它覆盖掉）：ELF → 必须直接执行
 * 拿 node 去跑 ELF 会报 “SyntaxError: Invalid or unexpected token”（CI 上就是这么挂的）。
 * 所以先嗅探前几字节，再决定怎么执行。 */
function esbuildRunner(p) {
	let head = Buffer.alloc(0);
	try {
		head = readFileSync(p).subarray(0, 4);
	} catch {
		/* ignore */
	}
	const elf = head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
	const pe = head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
	if (elf || pe) return { cmd: p, pre: [] };
	return { cmd: process.execPath, pre: [p] };
}

/** 找 esbuild。esbuild 不是 pi 的声明依赖（是被传递依赖顺带装进来的），位置不可预测：
 *  可能是 <pi>/node_modules/esbuild、被 npm 提升到同级、或全局 node_modules。
 *  所以用 require.resolve 从多个根去解析，并把试过的路径记下来（失败时好排查）。 */
function findEsbuild(piDir) {
	const tried = [];
	const cands = [];
	if (piDir) {
		try {
			cands.push(createRequire(join(piDir, "package.json")).resolve("esbuild/bin/esbuild"));
		} catch {
			/* ignore */
		}
	}
	try {
		cands.push(createRequire(import.meta.url).resolve("esbuild/bin/esbuild"));
	} catch {
		/* ignore */
	}
	if (piDir) {
		const up = join(piDir, "..");
		const up2 = join(piDir, "..", "..");
		cands.push(join(piDir, "node_modules", "esbuild", "bin", "esbuild"));
		cands.push(join(up, "esbuild", "bin", "esbuild"));
		cands.push(join(up2, "esbuild", "bin", "esbuild"));
		const bin = process.platform === "win32" ? "esbuild.cmd" : "esbuild";
		cands.push(join(piDir, "node_modules", ".bin", bin));
	}
	try {
		const g = execSync("npm root -g", { encoding: "utf8" }).trim();
		cands.push(join(g, "esbuild", "bin", "esbuild"));
	} catch {
		/* ignore */
	}
	for (const p of cands) {
		tried.push(p);
		if (!p || !existsSync(p)) continue;
		// Windows 的 .cmd/.bat 垫片必须走 shell
		if (p.endsWith(".cmd") || p.endsWith(".bat")) return { cmd: p, pre: [], shell: true, tried };
		return { ...esbuildRunner(p), tried };
	}
	return { tried };
}

const piDir = findPiDir();
const esbuild = findEsbuild(piDir);
if (!esbuild.cmd) {
	console.error("❌ 找不到 esbuild。试过这些路径：");
	for (const p of esbuild.tried) console.error("   " + p);
	console.error("→ 修法：npm i -g esbuild（或设 PI_PACKAGE_DIR 指向装着 esbuild 的 pi 包）");
	process.exit(2);
}

// 先自报家门：失败时能从日志一眼看出用的是哪个 esbuild
console.log(`pi 目录: ${piDir}`);
console.log(`esbuild: ${esbuild.pre.join(" ") || esbuild.cmd}`);
try {
	const v = execFileSync(esbuild.cmd, [...esbuild.pre, "--version"], { encoding: "utf8" }).trim();
	console.log(`esbuild 版本: ${v}`);
} catch (e) {
	console.error("⚠️ esbuild --version 就失败了（多半是平台原生二进制没装对）：");
	console.error(String(e.stderr || e.stdout || e.message).slice(0, 1500));
}

const tmp = mkdtempSync(join(tmpdir(), "pi-ext-unit-"));
const stubs = join(root, "scripts", "stubs");

function bundle(entryName, outName) {
	const args = [
		...esbuild.pre,
		join(ext, entryName),
		"--bundle",
		"--format=esm",
		"--platform=node",
		"--external:node:*",
		`--alias:@earendil-works/pi-coding-agent=${join(stubs, "pi-coding-agent.ts")}`,
		`--alias:@earendil-works/pi-tui=${join(stubs, "pi-tui.ts")}`,
		`--alias:typebox=${join(stubs, "typebox.ts")}`,
		`--outfile=${join(tmp, outName)}`,
		"--log-level=error",
	];
	try {
		// 不要 stdio:"inherit" —— 自己接住输出，失败时才能把它打印出来
		execFileSync(esbuild.cmd, args, { cwd: root, encoding: "utf8", shell: esbuild.shell === true });
	} catch (e) {
		console.error(`❌ esbuild 打包失败：${entryName}`);
		console.error(`命令：${esbuild.cmd} ${args.join(" ")}`);
		if (e.stdout) console.error(`--- esbuild stdout ---\n${e.stdout}`);
		if (e.stderr) console.error(`--- esbuild stderr ---\n${e.stderr}`);
		if (!e.stdout && !e.stderr) console.error(`--- 无输出 ---\n${e.message}`);
		process.exit(3);
	}
}

/** 把断言代码追加到 bundle 尾部并执行；返回 true = 全过 */
function runSuite(name, bundleFile, bodyLines, env = {}) {
	const harness = [
		"const __R = [];",
		'const ok = (n, c) => __R.push((c ? "PASS" : "FAIL") + "  " + n);',
	];
	const report = [
		'const __bad = __R.filter((x) => x.startsWith("FAIL"));',
		'console.log(__R.join("\\n"));',
		'console.log("\\n" + (__R.length - __bad.length) + "/" + __R.length + " 通过");',
		"if (__bad.length) process.exit(1);",
	];
	const src = readFileSync(bundleFile, "utf8") + "\n" + [...harness, ...bodyLines, ...report].join("\n") + "\n";
	writeFileSync(bundleFile, src, "utf8");
	console.log(`\n─── ${name} ───`);
	try {
		const out = execFileSync(process.execPath, [bundleFile], {
			env: { ...process.env, ...env },
			encoding: "utf8",
		});
		process.stdout.write(out);
		return true;
	} catch (e) {
		process.stdout.write(String(e.stdout ?? ""));
		process.stderr.write(String(e.stderr ?? ""));
		return false;
	}
}

// ---------- 准备一个假项目（给模板解析用） ----------
const proj = join(tmp, "proj");
const asstDir = join(proj, ".pi", "assistants");
mkdirSync(asstDir, { recursive: true });
writeFileSync(
	join(asstDir, "child.md"),
	[
		"---",
		"name: 测试助理",
		"desc: 测试用",
		"tools: read, mcp__test-db__query",
		"deny_tools: write, edit",
		"isolate_env: true",
		"env_passthrough: ANTHROPIC_API_KEY",
		"---",
		"正文",
		"",
	].join("\n"),
	"utf8",
);
writeFileSync(join(asstDir, "plain.md"), ["---", "name: 普通", "desc: x", "---", "body", ""].join("\n"), "utf8");
// 底座 + 基于它派生的子模板（测 extends 继承 + 底座只读）
writeFileSync(
	join(asstDir, "role-ops.md"),
	["---", "name: 查询运维助理（底座）", "desc: 只读底座", "base: true", "timeout: 5m", "---", "只读。给证据。", ""].join("\n"),
	"utf8",
);
writeFileSync(
	join(asstDir, "kid.md"),
	["---", "name: 小子", "extends: role-ops", "---", "我是子模板。", ""].join("\n"),
	"utf8",
);

let allOk = true;

// ---------- 套件 3：board（MCP 栏的表头 / 三态标记） ----------
bundle("board.ts", "board.mjs");
allOk =
	runSuite("board：MCP 栏表头与连接标记", join(tmp, "board.mjs"), [
		'ok("表头：没全连上时补 ●n", JSON.stringify(mcpHeaderParts(7, 2)) === JSON.stringify([" MCP 7", " ●2"]));',
		'ok("表头：全连上就不补", JSON.stringify(mcpHeaderParts(3, 3)) === JSON.stringify([" MCP 3", ""]));',
		'ok("表头：0 个也不补", JSON.stringify(mcpHeaderParts(0, 0)) === JSON.stringify([" MCP 0", ""]));',
		'ok("表头：一个都没连上 → ●0", JSON.stringify(mcpHeaderParts(4, 0)) === JSON.stringify([" MCP 4", " ●0"]));',
		'ok("标记：连上 = ●", mcpMark(true) === "●");',
		'ok("标记：没见到工具 = ◌（不是 ○，避免读成挂了）", mcpMark(false) === "◌");',
		'ok("标记：两个不一样", mcpMark(true) !== mcpMark(false));',
		'// ---- computeMcp：“已连上”到底怎么判的 ----',
		'const bdir = getAgentDir();',
		'mkdirSync(bdir, { recursive: true });',
		'writeFileSync(join(bdir, "mcp.json"), JSON.stringify({ mcpServers: { "my-db": { command: "x" }, "some-server": { command: "y" }, "my.db": { command: "z" } } }), "utf8");',
		'const bproj = join(bdir, "proj");',
		'mkdirSync(join(bproj, ".pi"), { recursive: true });',
		'writeFileSync(join(bproj, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { "proj-srv": { command: "p" } } }), "utf8");',
		'// 只有 my-db 和 my.db 的工具出现了（= 这两个连上了）',
		'pi = { getAllTools: () => [{ name: "read" }, { name: "mcp__my-db__query" }, { name: "mcp__my_db__exec" }], getMcpServers: () => [] };',
		'const e1 = computeMcp(bproj, false);',
		'const byName = (n) => e1.find((x) => x.name === n);',
		'ok("computeMcp：用户级算「全局」", byName("my-db").level === "global");',
		'ok("computeMcp：见到工具 = 已连上", byName("my-db").connected === true);',
		'ok("computeMcp：没见到工具 = 未连（不是挂了）", byName("some-server").connected === false);',
		'ok("computeMcp：工具名归一化后能对上（my.db → mcp__my_db__*）", byName("my.db").connected === true);',
		'ok("computeMcp：归一化撞车时两个都标（不张冠李戴）", byName("my-db").connected === true && byName("my.db").connected === true);',
		'ok("computeMcp：未信任 → 不读项目级", byName("proj-srv") === undefined);',
		'const e2 = computeMcp(bproj, true);',
		'ok("computeMcp：信任后读项目级", e2.find((x) => x.name === "proj-srv").level === "project");',
		'ok("computeMcp：已连上的排前面", e2[0].connected === true);',
		'pi = { getAllTools: () => [], getMcpServers: () => [{ name: "sess-srv" }] };',
		'const e3 = computeMcp(bproj, false);',
		'ok("computeMcp：getMcpServers 算「会话级」", e3.find((x) => x.name === "sess-srv").level === "session");',
		'ok("computeMcp：总数变了 → 表头也跟着变", mcpHeaderParts(e3.length, 0)[1] === ` ●0`);',
	], { PI_CODING_AGENT_DIR: join(tmp, "agent-board") }) && allOk;

// ---------- 套件 1：delegate（锁 / 归属 / env / 信号量 / 模板） ----------
bundle("delegate.ts", "delegate.mjs");
allOk =
	runSuite(
		"delegate：会话锁 / 结果归属 / env 过滤 / 并发 / 模板",
		join(tmp, "delegate.mjs"),
		[
			'// 会话锁',
			'const idA = "t-A";',
			'const a1 = acquireSessionLock(idA, "r1");',
			'const a2 = acquireSessionLock(idA, "r2");',
			'ok("锁：二次抢被拒", a1.ok === true && a2.ok === false);',
			'ok("锁：被拒时带持有者", a2.ok === false && String(a2.holder).includes("r1"));',
			"releaseSessionLock(idA);",
			'ok("锁：释放后可再抢", acquireSessionLock(idA, "r3").ok === true);',
			"releaseSessionLock(idA);",
			'const idB = "t-B";',
			'writeFileSync(lockFile(idB), JSON.stringify({ pid: 999999, sessionId: idB, label: "dead", startedAt: Date.now() }), "utf8");',
			'ok("锁：死 pid 被接管", acquireSessionLock(idB, "rb").ok === true);',
			"releaseSessionLock(idB);",
			'const idC = "t-C";',
			'writeFileSync(lockFile(idC), JSON.stringify({ pid: process.pid, sessionId: idC, label: "live", startedAt: Date.now() }), "utf8");',
			'ok("锁：活 pid 被拒", acquireSessionLock(idC, "rc").ok === false);',
			"releaseSessionLock(idC);",
			'const idD = "t-D";',
			'writeFileSync(lockFile(idD), JSON.stringify({ pid: process.pid, sessionId: idD, label: "old", startedAt: Date.now() - 20 * 60 * 1000 }), "utf8");',
			'ok("锁：超时被接管", acquireSessionLock(idD, "rd").ok === true);',
			"releaseSessionLock(idD);",
			'const idE = "t-E";',
			'writeFileSync(lockFile(idE), JSON.stringify({ pid: 999999, sessionId: idE, label: "dead", startedAt: Date.now() }), "utf8");',
			"reapStaleLocks();",
			'ok("锁：reap 清死锁后可抢", acquireSessionLock(idE, "re").ok === true);',
			"releaseSessionLock(idE);",
			'// 结果归属',
			'const mk = (o) => ({ id: "x", key: "k", name: "n", task: "t", sessionId: "s", startedAt: 0, status: "done", ...o });',
			'currentSessionFile = "F1"; currentSessionId = "S1";',
			'ok("归属：无 owner（老记录）→投", isOwnBgTask(mk({})) === true);',
			'ok("归属：文件匹配→投", isOwnBgTask(mk({ ownerSessionFile: "F1" })) === true);',
			'ok("归属：文件不匹配→不投", isOwnBgTask(mk({ ownerSessionFile: "F2" })) === false);',
			'ok("归属：id 匹配→投", isOwnBgTask(mk({ ownerSessionId: "S1" })) === true);',
			'ok("归属：id 不匹配→不投", isOwnBgTask(mk({ ownerSessionId: "S2" })) === false);',
			"currentSessionFile = undefined; currentSessionId = undefined;",
			'ok("归属：身份未知→不投", isOwnBgTask(mk({ ownerSessionFile: "F1" })) === false);',
			'// env 过滤',
			'process.env.SECRET_TOKEN = "leak"; process.env.ANTHROPIC_API_KEY = "keep";',
			'const ef = filteredEnv(["ANTHROPIC_API_KEY"]);',
			'ok("env：掐掉未声明的密钥", !("SECRET_TOKEN" in ef));',
			'ok("env：passthrough 保留", ef.ANTHROPIC_API_KEY === "keep");',
			'ok("env：保留 PATH", "PATH" in ef || "Path" in ef);',
			'// 并发信号量',
			"let peak = 0, running = 0, finished = 0;",
			"async function job() {",
			"  await acquireRunSlot();",
			"  running++; peak = Math.max(peak, running);",
			"  await new Promise((r) => setTimeout(r, 10));",
			"  running--; finished++; releaseRunSlot();",
			"}",
			"await Promise.all([0, 1, 2, 3, 4, 5, 6].map(() => job()));",
			'ok("并发：峰值不超上限", peak === MAX_CONCURRENT_RUNS);',
			'ok("并发：7 个全部完成", finished === 7);',
			'// 模板解析',
			"const tpls = loadTemplates(process.env.TPROJ);",
			'const ch = tpls.find((t) => t.key === "child");',
			'ok("模板：解析 tools", JSON.stringify(ch.tools) === JSON.stringify(["read", "mcp__test-db__query"]));',
			'ok("模板：解析 deny_tools", JSON.stringify(ch.denyTools) === JSON.stringify(["write", "edit"]));',
			'ok("模板：解析 isolate_env", ch.isolateEnv === true);',
			'ok("模板：解析 env_passthrough", JSON.stringify(ch.envPassthrough) === JSON.stringify(["ANTHROPIC_API_KEY"]));',
			'ok("模板：没写 tools 的模板是 undefined", tpls.find((t) => t.key === "plain").tools === undefined);',
			'// ---- 底座（base）：只读 + 不可派 + 能从它派生 ----',
			'const __zb = tpls.find((t) => t.key === "role-ops");',
			'ok("底座：base 标记为 true", __zb.base === true);',
			'ok("底座：不在可派清单里", tpls.filter((t) => t.base !== true && t.demo !== true).every((t) => t.key !== "role-ops"));',
			'const __zb0 = availableBases(process.env.TPROJ);',
			'ok("底座：availableBases 只返回 base:true", __zb0.length === 1 && __zb0[0].key === "role-ops");',
			'ok("底座：shortBaseName 去掉（底座）", shortBaseName("查询运维助理（底座）") === "查询运维助理");',
			'const __zkid = tpls.find((t) => t.key === "kid");',
			'ok("子模板：extends 保留 key", __zkid.extends === "role-ops");',
			'ok("子模板：继承底座正文", __zkid.body.includes("只读。给证据。"));',
			'ok("子模板：继承底座 timeout", __zkid.timeoutMs === 5 * 60 * 1000);',
			'const __zargs = { key: "k", name: "n", desc: "", cwd: process.env.TPROJ, model: "", timeout: "", agentsMd: true, dispatchable: true, scope: SCOPE_GLOBAL, bodyChars: 0, keyEditable: true, bases: __zb0.map((b) => ({ key: b.key, name: b.name })) };',
			'const __zef = buildFields({ ...__zargs, extendsKey: "" }).find((f) => f.key === "extends");',
			'ok("表单：有「基础模板」字段且是 enum", !!__zef && __zef.kind === "enum");',
			'ok("表单：选项含底座 + 不用", __zef.options.includes("role-ops") && __zef.options.includes(BASE_NONE));',
			'ok("表单：hint 列出底座", __zef.hint.includes("role-ops"));',
			'const __zef2 = buildFields({ ...__zargs, extendsKey: "role-ops" }).find((f) => f.key === "extends");',
			'ok("表单：已挂底座时回填 key", __zef2.value === "role-ops");',
			'const __zef3 = buildFields({ ...__zargs, extendsKey: "hand-written" }).find((f) => f.key === "extends");',
			'ok("表单：手写的非底座 extends 不被吃掉", __zef3.options.includes("hand-written") && __zef3.value === "hand-written");',
			'// 底座只读：commitForm 必须拒（防绕过 /assistants edit）',
			'const __znotes = [];',
			'await commitForm({ ui: { notify: (m) => __znotes.push(String(m)) } }, { form: { values: { key: "hacked" } }, cwd: process.env.TPROJ, original: { base: true, key: "role-ops" } });',
			'ok("底座：commitForm 拒绝保存", __znotes.length === 1 && __znotes[0].includes("底座"));',
			'ok("底座：没写出文件", !existsSync(join(globalAssistantDir(), "hacked.md")));',
			'// ---- 后台回投：发失败不能假成功、退避、成功才标 delivered ----',
			'const bgt = { id: "dtest-1", key: "k", name: "n", task: "t", sessionId: "s", startedAt: Date.now(), status: "done", resultText: "R", delivered: false };',
			"writeBgTask(bgt);",
			"currentSessionFile = undefined; currentSessionId = undefined; // 无 owner → 视为本会话",
			'apiRef = { sendUserMessage: async () => { throw new Error("boom"); } };',
			"await pollBgTasks();",
			"let bga = readBgTask(\"dtest-1\");",
			'ok("回投失败：不标 delivered", bga.delivered === false);',
			'ok("回投失败：记下 lastError", String(bga.lastError).includes("boom"));',
			'ok("回投失败：attempts=1", bga.attempts === 1);',
			"await pollBgTasks();",
			'ok("退避：立刻重跑不重复试", readBgTask("dtest-1").attempts === 1);',
			'apiRef = { sendUserMessage: async () => {} };',
			'writeBgTask({ ...readBgTask("dtest-1"), lastAttemptAt: 0 });',
			"await pollBgTasks();",
			'bga = readBgTask("dtest-1");',
			'ok("回投成功：标 delivered", bga.delivered === true);',
			'ok("回投成功：清掉 lastError", bga.lastError === undefined);',
			'ok("未投递计数归零", undeliveredBgCount() === 0);',
			'// 超时未投 → 标 undelivered，且不再自动重试',
			'writeBgTask({ ...bgt, id: "dtest-2", delivered: false, attempts: 1, firstFailAt: Date.now() - 11 * 60 * 1000, lastAttemptAt: 0 });',
			'apiRef = { sendUserMessage: async () => { throw new Error("still-broken"); } };',
			"await pollBgTasks();",
			'bga = readBgTask("dtest-2");',
			'ok("超 10 分钟未投 → 标 undelivered", bga.undelivered === true);',
			'ok("未投递计数=1", undeliveredBgCount() === 1);',
			"const tried = bga.attempts;",
			"await pollBgTasks();",
			'ok("undelivered 后不再自动重试", readBgTask("dtest-2").attempts === tried);',
		],
		{ TPROJ: proj, PI_CODING_AGENT_DIR: join(tmp, "agent-delegate") },
	) && allOk;

// ---------- 套件 1.5：rpc 通道（子助理双向通信的地基）----------
// 这一层错了不会“报错”，只会“安静地派活全挂”（老版本 pi、dialog 不应答挂死）—— 所以必须钉住。
bundle("rpc.ts", "rpc.mjs");
allOk =
	runSuite(
		"rpc：分发 / U+2028 不当行界 / dialog 应答",
		join(tmp, "rpc.mjs"),
		[
			"// 假 child：stdin 只记录，stdout 由 feed() 手推",
			"const mkChild = () => {",
			"  const written = []; const sinks = []; let closed = false;",
			"  const child = {",
			"    stdin: { write: (s) => { written.push(s); return true; }, end: () => { closed = true; } },",
			"    stdout: { on: (_e, fn) => sinks.push(fn) },",
			"  };",
			"  return { child, written, feed: (s) => sinks.forEach((fn) => fn(s)), isClosed: () => closed };",
			"};",
			"const { child, written, feed, isClosed } = mkChild();",
			"const ch = new RpcChannel(child);",
			"const ev = []; const rs = []; const ui = [];",
			"ch.onEvent((r) => ev.push(r)).onResponse((r) => rs.push(r)).onUi((r) => ui.push(r));",
			"const U = '\\u2028';",
			"feed(JSON.stringify({ id: 'r1', type: 'response', command: 'prompt', success: true }) + '\\n');",
			"feed(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' + U + 'b' } }) + '\\n');",
			"feed(JSON.stringify({ type: 'extension_ui_request', id: 'u1', method: 'confirm' }) + '\\n');",
			"feed(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
			`ok("response 单独分发", rs.length === 1 && rs[0].command === "prompt");`,
			'ok("responseCount 计数", ch.responseCount === 1);',
			`ok("U+2028 不当行界（一条记录不被劈开）", ev.length === 2 && ev[0].assistantMessageEvent.delta === "a" + U + "b");`,
			`ok("agent_settled 走事件分支", ev[1].type === "agent_settled");`,
			'ok("ui 请求单独分发", ui.length === 1 && ui[0].method === "confirm");',
			"feed('\\r\\nnot json\\n');",
			`feed(JSON.stringify({ type: "agent_settled" }) + "\\r\\n");`,
			'ok("CRLF / 垃圾行不炸", ev.length === 3);',
			`ch.send({ type: "steer", message: "收尾" });`,
			'const sent = JSON.parse(written[0]);',
			`ok("send 自动带 id", sent.type === "steer" && sent.id === "c1");`,
			`ok("send 以 LF 结尾", written[0].endsWith("\\n"));`,
			`rejectDialog(ch, { type: "extension_ui_request", id: "u1", method: "confirm" });`,
			'const ans = JSON.parse(written[1]);',
			`ok("dialog → cancelled 且复用原 id", ans.type === "extension_ui_response" && ans.id === "u1" && ans.cancelled === true);`,
			'const before = written.length;',
			`rejectDialog(ch, { type: "extension_ui_request", method: "notify" });`,
			`ok("fire-and-forget 不应答", written.length === before);`,
			`ok("isDialogRequest 只看 select/confirm/input/editor", isDialogRequest({ type: "extension_ui_request", method: "editor" }) === true && isDialogRequest({ type: "extension_ui_request", method: "notify" }) === false);`,
			"ch.closeStdin();",
			'ok("关 stdin 真的关了", isClosed() === true);',
			`ok("关闭后 send=false（不再往里写）", ch.send({ type: "steer", message: "x" }) === false);`,
		],
		{},
	) && allOk;

// ---------- 套件 2：mcp-pool（影子目录） ----------
bundle("mcp-pool.ts", "mcp-pool.mjs");
allOk =
	runSuite("mcp-pool：影子目录（剔 packages / 唯一 / 回收 / 错误收集）", join(tmp, "mcp-pool.mjs"), [
		"const dir = getAgentDir();",
		"mkdirSync(dir, { recursive: true });",
		'writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", packages: ["git:x"] }), "utf8");',
		'writeFileSync(join(dir, "auth.json"), "{}", "utf8");',
		'const pool = { servers: { "test-db": { command: "x" } }, origin: {} };',
		'const s1 = buildShadow("测试助理", ["test-db"], pool, { runSuffix: "aaa" });',
		'const s2 = buildShadow("测试助理", ["test-db"], pool, { runSuffix: "bbb" });',
		'ok("影子：每次派发目录唯一", s1.dir !== s2.dir);',
		'ok("影子：目录带后缀", s1.dir.endsWith("-aaa"));',
		'const st = JSON.parse(readFileSync(join(s1.dir, "settings.json"), "utf8"));',
		'ok("影子：settings 剔掉 packages", st.packages === undefined);',
		'ok("影子：settings 保留其它字段", st.theme === "dark");',
		'ok("影子：auth.json 照常复制", existsSync(join(s1.dir, "auth.json")));',
		'const mj = JSON.parse(readFileSync(join(s1.dir, "mcp.json"), "utf8"));',
		'ok("影子：只写选中的 MCP", Object.keys(mj.mcpServers).join(",") === "test-db");',
		'ok("影子：errors 为空", s1.errors.length === 0);',
		'const s3 = buildShadow("测试助理2", [], pool, { runSuffix: "ccc" });',
		'ok("影子：cutoff 极大时不误删", reapStaleShadowDirs(365 * 24 * 60 * 60 * 1000) === 0 && existsSync(s3.dir));',
		"const removed = reapStaleShadowDirs(-1);",
		'ok("影子：cutoff 为负时全部回收", removed >= 3 && !existsSync(s1.dir) && !existsSync(s2.dir));',
	], { PI_CODING_AGENT_DIR: join(tmp, "agent-mcp") }) && allOk;

rmSync(tmp, { recursive: true, force: true });

if (allOk) {
	console.log("\n✅ 单元测试全部通过");
	process.exit(0);
}
console.error("\n❌ 有测试失败");
process.exit(1);
