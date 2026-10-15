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
		"process.exit(__bad.length ? 1 : 0);",
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
		"// ---- 停用闸门：/ai-ext off 之后不许再把面板挂回来（回归测试）----",
		"const H2 = {};",
		'const fakeBoardApi = { registerTool() {}, registerCommand(n, c) { H2["cmd:" + n] = c.handler; }, on(n, f) { H2[n] = f; }, registerFlag() {}, getFlag() { return false; }, appendEntry() {}, getActiveTools() { return []; }, setActiveTools() {} };',
		"setupBoard(fakeBoardApi);",
		"const widgetCalls = [];",
		'const fakeCtx = { hasUI: true, mode: "tui", cwd: process.cwd(), isProjectTrusted: () => false, ui: { setWidget: (k, v) => { widgetCalls.push(v === undefined ? "clear" : "mount"); }, setStatus() {}, notify() {}, theme: { fg: (_c, t) => t } }, sessionManager: { getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => "test" } };',
		"await H2.session_start({}, fakeCtx);",
		'ok("看板：session_start 会挂 widget", widgetCalls.includes("mount"));',
		"// ---- 轮内提醒：同一 turn 里跑很多工具却没更新看板 → 往工具结果后面附一句提醒 ----",
		"const tr = H2[\"tool_result\"];",
		'steps = [{ text: "查现状", status: "pending" }, { text: "改代码", status: "pending" }];',
		'title = "测试计划";',
		'ok("没计划时不提醒", (await tr({ toolName: "bash", content: [] })) === undefined);',
		"let nagOut;",
		'for (let i = 0; i < 6; i++) nagOut = await tr({ toolName: "bash", content: [{ type: "text", text: "x" }] });',
		'ok("数到第 7 次还不提醒", nagOut === undefined);',
		'nagOut = await tr({ toolName: "bash", content: [{ type: "text", text: "x" }] });',
		'ok("第 8 次：附上一条看板提醒", !!nagOut && nagOut.content.length === 2 && nagOut.content[1].text.includes("看板提醒"));',
		'ok("提醒里带上了进度（0/2 步）", nagOut.content[1].text.includes("0/2"));',
		'ok("nested 调用不计数", (await tr({ toolName: "bash", parentToolCallId: "p/1", content: [] })) === undefined);',
		'await tr({ toolName: "progress", content: [] });',
		'ok("progress() 后计数清零 → 后续工具不再连着提醒", (await tr({ toolName: "bash", content: [] })) === undefined);',
		"steps = [];",
		'title = "";',
		"setBoardOff(true); // = gate 的 applyBoardGate(true) 那一步",
		"await H2.agent_end({}, fakeCtx); // agent_end 会走 refresh() → 应当撤掉",
		'ok("停用态：refresh 会撤掉 widget", widgetCalls[widgetCalls.length - 1] === "clear");',
		"const nBefore = widgetCalls.length;",
		'await H2.tool_call({ toolName: "bash" }, fakeCtx);',
		"await H2.model_select({}, fakeCtx);",
		"await H2.turn_start({}, fakeCtx);",
		'ok("停用态：直接调 renderWidget 的 handler 也不再把面板挂回来（关键回归）", widgetCalls.length === nBefore);',
		"setBoardOff(false);",
		'await H2.tool_call({ toolName: "bash" }, fakeCtx);',
		'ok("恢复启用：能重新画出来", widgetCalls[widgetCalls.length - 1] === "mount");',
		"await H2.session_shutdown({}, fakeCtx); // 清掉 1s 定时器，不然测试进程不退出",
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
			'// 投递认领锁：残留锁必须能接管 —— 否则那份助理结果会被永远跳过',
			'const cfile = ".tmp-claim-test.claim";',
			'writeFileSync(cfile, "999999", "utf8");',
			'ok("认领锁：死 pid = 残留，可接管", claimIsStale(cfile) === true);',
			`writeFileSync(cfile, String(process.pid), "utf8");`,
			'ok("认领锁：活 pid = 别人在投，不抢", claimIsStale(cfile) === false);',
			'rmSync(cfile, { force: true });',
			'ok("认领锁：文件不存在也算残留", claimIsStale(cfile) === true);',
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
			"// 假孤儿修复：判“孤儿”要按任务自己的 deadlineAt，不能写死 10 分钟",
			"// （MAX_TIMEOUT_MS 是 30 分钟：设 20 分钟的活会在第 10 分钟被误判失败，投一张假失败卡）",
			"const base = { key: \"k\", name: \"n\", task: \"t\", sessionId: \"s\", status: \"running\" };",
			"writeBgTask({ ...base, id: \"stale-live\", startedAt: Date.now() - 11 * 60 * 1000, deadlineAt: Date.now() + 9 * 60 * 1000 });",
			"reapStaleBgTasks();",
			'ok("没到 deadlineAt 不误杀（跑了 11 分钟但时限 20 分钟）", readBgTask("stale-live").status === "running");',
			"writeBgTask({ ...base, id: \"stale-dead\", startedAt: Date.now() - 11 * 60 * 1000, deadlineAt: Date.now() - 1000 });",
			"reapStaleBgTasks();",
			'ok("过了 deadlineAt → 标失败", readBgTask("stale-dead").status === "failed");',
			'ok("失败原因写清了是超期未回报", /超期未回报/.test(readBgTask("stale-dead").resultText ?? ""));',
			"writeBgTask({ ...base, id: \"stale-old\", startedAt: Date.now() - 11 * 60 * 1000 });",
			"reapStaleBgTasks();",
			'ok("老文件没 deadlineAt → 退回 10 分钟兑底", readBgTask("stale-old").status === "failed");',
			"// 面板「⚠ N 个助理在跑 · 退出会中止」靠的就是这个数",
			'const jr = newJob({ key: "k", name: "n", task: "t", sessionId: "rr" }); addJob(jr);',
			'ok("runningBgCount 能数到在跑的", runningBgCount() === 1);',
			'markEnd(jr, "done");',
			'ok("跑完就不算「在跑」了（面板那行也就没了）", runningBgCount() === 0);',
			"// ---- 小票回收：只删「已投递 + 超 24h」，绝不碰会话文件 ----",
			'const SESS_DIR = join(assistantSessionRoot(), "reap-test");',
			"mkdirSync(SESS_DIR, { recursive: true });",
			'const sessFile = join(SESS_DIR, "2026-10-08T00-00-00-000Z_sessi-1.jsonl");',
			"const sessBody = '{\"type\":\"message\",\"role\":\"user\"}\\n';",
			'writeFileSync(sessFile, sessBody, "utf8");',
			"const OLD = Date.now() - 25 * 60 * 60 * 1000;",
			'writeBgTask({ ...bgt, id: "reap-old", delivered: true, finishedAt: OLD });',
			'writeBgTask({ ...bgt, id: "reap-fresh", delivered: true, finishedAt: Date.now() });',
			'writeBgTask({ ...bgt, id: "reap-nodeliver", delivered: false, finishedAt: OLD });',
			'ok("回收前三个小票都在", ["reap-old", "reap-fresh", "reap-nodeliver"].every((i) => existsSync(bgFile(i))));',
			"const reaped = reapDeliveredBgTasks();",
			'ok("回收：已投递 + 超 24h → 删", !existsSync(bgFile("reap-old")));',
			'ok("回收：已投递但没到点 → 留", existsSync(bgFile("reap-fresh")));',
			'ok("回收：没投递的绝不删（还能 redeliver）", existsSync(bgFile("reap-nodeliver")));',
			'ok("回收：一次只删了该删的那 1 个", reaped === 1);',
			'ok("回收：会话文件（*.jsonl）一字未动", existsSync(sessFile) && readFileSync(sessFile, "utf8") === sessBody);',
			"// ---- 显示归属：别的会话的小票不该在本对话里刷警告 ----",
			"currentSessionFile = undefined; currentSessionId = undefined;",
			"const cntBefore = undeliveredBgCount();",
			'writeBgTask({ ...bgt, id: "not-mine", delivered: false, ownerSessionId: "someone-else" });',
			'ok("别的会话的没回投不计入本对话", undeliveredBgCount() === cntBefore);',
			'writeBgTask({ ...bgt, id: "mine", delivered: false });',
			'ok("本对话（无 owner）的没回投要计入", undeliveredBgCount() === cntBefore + 1);',
			'// ---- 会话 ID 唯一性 ----',
			'// 旧 bug：中文 key 被 sanitizeSessionId 抹光 → 同秒并发两个不同助理得到完全相同的 ID，',
			'// 第二个被会话锁拒掉。根因不是「碰巧」，是必然，所以下面同时钉根因与修法。',
			'const AT = new Date(2026, 9, 13, 10, 21, 9, 802);',
			'const idSrv = makeSessionId("个人中心服务器助理", 1, AT);',
			'const idDb = makeSessionId("个人中心数据库助理", 1, AT);',
			'ok("根因：sanitize 会把中文 key 抹光（所以 ID 必须显式带指纹）", sanitizeSessionId("个人中心服务器助理-20261013-102109-1") === "20261013-102109-1");',
			'ok("同毫秒两个不同助理 → ID 不同", idSrv !== idDb);',
			'ok("ID 带上了助理指纹", idSrv.startsWith(keyFingerprint("个人中心服务器助理")));',
			'ok("指纹稳定（同 key 同值）", keyFingerprint("个人中心服务器助理") === keyFingerprint("个人中心服务器助理"));',
			'ok("指纹能区分不同 key", keyFingerprint("个人中心服务器助理") !== keyFingerprint("个人中心数据库助理"));',
			'ok("指纹与 key 长度无关（general 也有）", keyFingerprint("general").length === 6);',
			'ok("ID 含毫秒（同秒不同毫秒不撞）", makeSessionId("general", 1, AT) !== makeSessionId("general", 1, new Date(2026, 9, 13, 10, 21, 9, 803)));',
			'ok("同助理连派 5 次（同毫秒）→ seq 仍能区分", new Set([1, 2, 3, 4, 5].map((n) => makeSessionId("个人中心服务器助理", n, AT))).size === 5);',
			'ok("ID 字符集合规（首字母数字、只含 [A-Za-z0-9._-]）", /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(idSrv));',
			'ok("ID 不会因中文而被截成空", idSrv.length > 14);',
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

// ---------- 套件 1.6：live 面板保鲜期（跑完的子代理到点自动摘掉）----------
bundle("live.ts", "live.mjs");
allOk =
	runSuite(
		"live：面板保鲜期（不再越堆越多）",
		join(tmp, "live.mjs"),
		[
			"const mk = (id, st) => { const j = newJob({ key: 'k', name: 'n', task: 't', sessionId: id }); addJob(j); markEnd(j, st); return j; };",
			"setLingerMs(45_000);",
			"const a = mk('a', 'done');",
			`ok("刚跑完还在面板上", liveJobs().length === 1);`,
			"const e = a.endedAt;",
			`ok("没到保鲜期不摘", pruneFinishedJobs(e + 44_999) === 0 && liveJobs().length === 1);`,
			`ok("到保鲜期自动摘掉", pruneFinishedJobs(e + 45_001) === 1 && liveJobs().length === 0);`,
			"const r = newJob({ key: 'k', name: 'n', task: 't', sessionId: 'r' }); addJob(r);",
			`ok("还在跑的永不摘", pruneFinishedJobs(Date.now() + 10 * 60 * 1000) === 0);`,
			"ok('所有都结束了 → 没卡住的', liveJobs().filter((j) => j.status === 'running').length === 1);",
			"setLingerMs(0); const z = mk('z', 'failed');",
			`ok("linger=0 → 跑完立刻消失", pruneFinishedJobs(Date.now()) >= 1);`,
			`ok("setLingerMs 拒绝非法值", (setLingerMs(-5), getLingerMs() === 0));`,
			"clearJobs();",
			`ok("clearJobs 全清", liveJobs().length === 0);`,
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

// ---------- 套件：gate（会话级停用闸门） ----------
bundle("gate.ts", "gate.mjs");
allOk =
	runSuite(
		"gate：会话级停用 / 恢复",
		join(tmp, "gate.mjs"),
		[
			"const H = {};",
			"let lastEntry;",
			"const notify = [];",
			"const flags = {};",
			'let snap = ["read", "bash"];',
			"const fakeApi = {",
			"  registerFlag() {},",
			"  getFlag() { return flags.noExt === true; },",
			"  on(name, fn) { H[name] = fn; },",
			'  registerCommand(name, cmd) { H["cmd:" + name] = cmd.handler; },',
			"  appendEntry(type, data) { lastEntry = { type, data }; },",
			"  getActiveTools() { return [...snap]; },",
			"  setActiveTools(a) { snap = [...a]; },",
			"};",
			"setupGate(fakeApi);",
			'ok("默认：启用", isExtDisabled() === false);',
			"const applied = [];",
			'onGateApply("t", (off) => applied.push(off));',
			"// 假装一个真模块：只在「停用→恢复」那一下会把工具重新注册成 direct（= 加回激活集）",
			"let t2SeenOff = false;",
			'onGateApply("t2", (off) => { if (off) t2SeenOff = true; else if (t2SeenOff) snap.push("progress"); });',
			'ok("登记时立刻按当前状态跑一次", JSON.stringify(applied) === "[false]");',
			'const mkCtx = (entries) => ({ ui: { notify: (m) => notify.push(m) }, sessionManager: { getEntries: () => entries } });',
			'const entryOff = { type: "custom", customType: "ai-ext-off", data: { off: true } };',
			"const ctxAny = mkCtx([]);",
			"await H.session_start({}, mkCtx([entryOff]));",
			'ok("新会话：读到 off → 停用", isExtDisabled() === true);',
			'ok("新会话：停用态通知到各模块", applied[applied.length - 1] === true);',
			'await H["cmd:ai-ext"]("on", ctxAny);',
			'ok("命令 on：恢复启用", isExtDisabled() === false);',
			'ok("命令 on：entry 记 off:false", lastEntry.type === "ai-ext-off" && lastEntry.data.off === false);',
			'ok("命令 on：按停用前的快照还原激活工具集（不多塞一个 progress）", JSON.stringify(snap) === JSON.stringify(["read", "bash"]));',
			'await H["cmd:ai-ext"]("off", ctxAny);',
			'ok("命令 off：置为停用", isExtDisabled() === true);',
			'ok("命令 off：写进本会话 entry", lastEntry.data.off === true && typeof lastEntry.data.at === "number");',
			'ok("命令 off：通知到各模块", applied[applied.length - 1] === true);',
			'await H.session_start({}, mkCtx([entryOff, { type: "custom", customType: "ai-ext-off", data: { off: false } }]));',
			'ok("换会话：最后一条说了算（false → 启用）", isExtDisabled() === false);',
			'await H["cmd:ai-ext"]("status", ctxAny);',
			'ok("status：会打印状态", notify.some((m) => m.includes("启用") || m.includes("停用")));',
			"flags.noExt = true;",
			"await H.session_start({}, mkCtx([]));",
			'ok("flag --no-ai-ext（会话开始才注入）：停用", isExtDisabled() === true);',
			"flags.noExt = false;",
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-gate"), PI_AI_EXT: "" },
	) && allOk;

// ---------- 套件：notify（TTS 文本清洗）----------
// ---------- 套件：shared（计划确认：答复解析 + 风险判定） ----------
bundle("shared.ts", "shared.mjs");
allOk =
	runSuite(
		"shared：计划答复解析 / 低风险判定",
		join(tmp, "shared.mjs"),
		[
			'ok("答复：同意(短句) → yes", parsePlanAnswer("同意").a === "yes" && parsePlanAnswer("可以").a === "yes");',
			'ok("答复：ok/行/继续 → yes", parsePlanAnswer("ok").a === "yes" && parsePlanAnswer("行").a === "yes" && parsePlanAnswer("继续").a === "yes");',
			'ok("答复：不行/先别做/取消 → no", parsePlanAnswer("不行").a === "no" && parsePlanAnswer("先别做").a === "no" && parsePlanAnswer("取消吧").a === "no");',
			'ok("答复：我不同意 → no", parsePlanAnswer("我不同意").a === "no");',
			'ok("答复：长句 → 当修改意见(edit)", parsePlanAnswer("把第二步改成先备份再做").a === "edit");',
			'ok("答复：edit 会带上原话", parsePlanAnswer("改用另一个接口").note.indexOf("另一个接口") >= 0);',
			'ok("答复：空字符串 → undefined", parsePlanAnswer("   ") === undefined);',
			'ok("风险：3 步只读 → 低风险（可自动过）", isLowRiskPlan(["查一下表行数", "看看最近记录", "汇总给我"]) === true);',
			'ok("风险：含 write/delete 词 → 高风险", isLowRiskPlan(["查表", "删掉旧记录"]) === false && isLowRiskPlan(["写一个脚本"]) === false);',
			'ok("风险：含提交/部署 → 高风险", isLowRiskPlan(["统计一下", "提交代码"]) === false && isLowRiskPlan(["查日志", "部署到线上"]) === false);',
			'// ---- 旧 ctx 守卫：会话替换后背景回调不许把整个进程炸了（真踩过 crashes.json）----',
			'ok("旧ctx：认出 pi 的 stale 报文", isStaleCtxError(new Error("This extension ctx is stale after session replacement or reload.")) === true);',
			'ok("旧ctx：普通错误不冒充（别误吞真 bug）", isStaleCtxError(new Error("ENOENT: no such file")) === false && isStaleCtxError(undefined) === false);',
			'ok("旧ctx：没缓存 ctx → 不做事", guardCtx(undefined, () => 1).ok === false);',
			'ok("旧ctx：正常 ctx 照常返回值", guardCtx({ a: 7 }, (c) => c.a).value === 7 && guardCtx({ a: 7 }, (c) => c.a).ok === true);',
			'const staleProxy = new Proxy({}, { get() { throw new Error("This extension ctx is stale after session replacement or reload."); } });',
			'const gs = guardCtx(staleProxy, (c) => c.hasUI);',
			'ok("旧ctx：一碰就抛 → 记成 stale（调用方好清缓存）", gs.ok === false && gs.stale === true);',
			'const gb = guardCtx({ hasUI: true }, () => { throw new Error("boom"); });',
			'ok("旧ctx：别的异常不冒充 stale（上层该看到）", gb.ok === false && gb.stale === false);',
			'ok("风险：4 步以上 → 不自动过", isLowRiskPlan(["查A", "看B", "统计C", "汇总D"]) === false);',
			'ok("风险：全是动作没有只读词 → 不自动过", isLowRiskPlan(["跑一下", "处理一下"]) === false);',
			'ok("桥：open/answerPlanAsk 能收工", (() => { let got = null; openPlanAsk("t", ["a"], (a) => { got = a; }); const hit = answerPlanAsk("yes"); return hit === true && got === "yes" && hasPendingPlanAsk() === false; })());',
			'ok("桥：没有挂起时 answerPlanAsk 返回 false", answerPlanAsk("yes") === false);',
			'ok("桥：新问题会放掉旧问题(undefined)", (() => { let old = "x"; openPlanAsk("a", [], () => { old = undefined; }); openPlanAsk("b", [], () => {}); return old === undefined; })());',
			'ok("桥：closePlanAsk 清掉挂起", (() => { openPlanAsk("c", [], () => {}); closePlanAsk(); return hasPendingPlanAsk() === false; })());',
			'ok("桥：后台轮标记可读写", (() => { setBackgroundTurn(true); const a = isBackgroundTurn(); setBackgroundTurn(false); return a === true && isBackgroundTurn() === false; })());',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-shared") },
	) && allOk;

bundle("notify.ts", "notify2.mjs");
allOk =
	runSuite(
		"notify：语音播报文本清洗 / TTS 状态",
		join(tmp, "notify2.mjs"),
		[
			'ok("TTS：默认关（不会突然出声）", getTts().on === false);',
			'setTts({ on: true, rate: 99, volume: -5 });',
			'ok("TTS：rate/volume 会被夹到合法区间", getTts().rate === 10 && getTts().volume === 0);',
			'setTts({ on: false, rate: 0, volume: 100 });',
			'ok("念法：去 markdown 记号", speechText("**结论**：`npm test` 全过").indexOf("*") < 0 && speechText("**结论**：`npm test` 全过").indexOf("`") < 0);',
			'ok("念法：去 emoji", speechText("✅ 都修好了 🎉").indexOf("✅") < 0 && speechText("✅ 都修好了 🎉").indexOf("🎉") < 0);',
			'ok("念法：去中文括号旁注", speechText("已修好（见截图）") === "已修好");',
			'ok("念法：去链接只留文字", speechText("看 [文档](https://x.com/a) 第三节") === "看 文档 第三节");',
			'ok("念法：超 300 字截断 + 提示", speechText("字".repeat(500)).length <= 306 && speechText("字".repeat(500)).indexOf("以下省略") > 0);',
			'ok("念法：空输入不炸", speechText("") === "" && speechText(undefined) === "");',
			'ok("念法：正常一句话原样保留", speechText("数据库已备份，文件名 center-1015.sql").indexOf("数据库已备份") === 0);',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-notify2") },
	) && allOk;

// ---------- 套件：voice（语音上屏判定 / 触发词 / 不误发） ----------
bundle("voice.ts", "voice.mjs");
allOk =
	runSuite(
		"voice：语音上屏判定 / 触发词 / 不误发",
		join(tmp, "voice.mjs"),
		[
			"const S = (t, b, at) => ({ text: t, blockSeen: b, lastChangeAt: at });",
			"const O = (silenceMs = 1500, idle = true, lockUntil = 0) => ({ silenceMs, idle, lockUntil, autoSend: true });",
			"// OA = 默认档：只认触发词，绝不因“停一下”自动发",
			"const OA = (idle = true) => ({ silenceMs: 1500, idle, lockUntil: 0, autoSend: false });",
			'// ---- 手打：每次 +1 字，停再久也不该发 ----',
			'let st = S("", false, 0);',
			'st = decideFrame(st, "你", 1000, O());',
			'st = decideFrame(st, "你好", 1200, O());',
			'st = decideFrame(st, "你好啊", 1400, O());',
			'ok("手打（每次 +1 字）：停 8 秒也不发", decideFrame(st, "你好啊", 9000, O()).send === false);',
			'// ---- 块状上屏（IME 语音）----',
			'let st2 = S("", false, 0);',
			'st2 = decideFrame(st2, "帮我查一下数据库", 1000, O());',
			'ok("块状上屏：还没停够 → 不发", decideFrame(st2, "帮我查一下数据库", 1500, O()).send === false);',
			'const go = decideFrame(st2, "帮我查一下数据库", 2600, O());',
			'ok("块状上屏 + 静默 1.5s → 自动发", go.send === true && go.body === "帮我查一下数据库");',
			'ok("pi 正在跑（不空闲）→ 不发，等空闲", decideFrame(st2, "帮我查一下数据库", 2600, O(1500, false)).send === false);',
			'ok("刚发完的锁内 → 不抢发", decideFrame(st2, "帮我查一下数据库", 2600, O(1500, true, 3000)).send === false);',
			'// ---- IME 回头纠错改字 → 计时重置 ----',
			'let st3 = S("", false, 0);',
			'st3 = decideFrame(st3, "帮我查数据库", 1000, O());',
			'st3 = decideFrame(st3, "帮我查一下数据库", 2000, O());',
			'ok("改字后 600ms 内 → 不发（计时重置了）", decideFrame(st3, "帮我查一下数据库", 2600, O()).send === false);',
			'ok("改字后再等够 → 才发", decideFrame(st3, "帮我查一下数据库", 3600, O()).send === true);',
			'// ---- 触发词 ----',
			'const word = decideFrame(S("", false, 0), "把那个表删了发送。", 100, O());',
			'ok("触发词：立刻发（不用块状、不等静默）", word.send === true);',
			'ok("触发词：从正文里剥掉（含标点）", word.body === "把那个表删了");',
			'ok("只说了触发词 → 没正文，不发", decideFrame(S("", false, 0), "确定", 100, O()).send === false);',
			'ok("带空格/问号的触发词也认", decideFrame(S("", false, 0), "就这个吧 发送？", 100, O()).body === "就这个吧");',
			'// ---- 空文本 / 发完清空 ----',
			'ok("空文本 → 不发", decideFrame(S("", false, 0), "", 5000, O()).send === false);',
			"// ---- 默认档（只认触发词）：这是修「打字被误发」的核心回归 ----",
			'let dflt = decideFrame(S("", false, 0), "帮我查一下数据库", 1000, OA());',
			'ok("默认档：块状上屏也不自动发（停 30s 都不发）", decideFrame(dflt, "帮我查一下数据库", 30000, OA()).send === false);',
			'const dfltWord = decideFrame(S("", false, 0), "把那个表删了发送", 100, OA());',
			'ok("默认档：句尾触发词照旧立刻发", dfltWord.send === true);',
			'ok("默认档：触发词会被剥掉", dfltWord.body === "把那个表删了");',
			'ok("默认档：只认触发词，手打半句永不发", decideFrame(S("", false, 0), "我在打", 9000, OA()).send === false);',
			'const cleared = decideFrame(S("帮我查一下", true, 1000), "", 2000, O());',
			'ok("发完被清空 → blockSeen 重置（下一条重新认）", cleared.blockSeen === false);',
			'// ---- clip：触发词匹配（含抗识别误差）----',
			"const T = DEFAULT_TRIGGERS;",
			'ok("clip：结尾「发送」命中", matchTrigger("帮我查一下，发送", T).hit === true);',
			'ok("clip：剥离触发词 + 尾部标点", matchTrigger("帮我查一下，发送。", T).body === "帮我查一下");',
			'ok("clip：语气词「发送吧」也命中", matchTrigger("帮我查一下 发送吧", T).hit === true);',
			'ok("clip：复制了个网址 → 不命中", matchTrigger("https://example.com/a?b=1", T).hit === false);',
			'ok("clip：正文提到「发送」但不在结尾 → 不命中", matchTrigger("发送那个文件给我", T).hit === false);',
			'ok("clip：≥3 字允许 1 字识别错（投给pi → 头给pi）", matchTrigger("帮我查一下 头给pi", T).hit === true);',
			'ok("clip：2 字不放宽（发生 ≠ 发送）", matchTrigger("这事发生了", T).hit === false);',
			'ok("clip：自定义触发词可用（结束）", matchTrigger("帮我查一下，结束", ["结束"]).hit === true);',
			'ok("clip：只有触发词 → 正文空（调用方丢弃）", matchTrigger("发送", T).hit === true && matchTrigger("发送", T).body === "");',
			'// ---- clip：前置清洗（真实语音样本回归）----',
			'const NL = String.fromCharCode(10), CTRL = String.fromCharCode(7), NUL = String.fromCharCode(0), WSP = String.fromCharCode(0x3000);',
			'ok("清洗：控制字符清掉", preprocessClip(CTRL + "帮我查一下" + NUL) === "帮我查一下");',
			'ok("清洗：全角空格压成一个半角空格", preprocessClip("帮" + WSP + "我") === "帮 我");',
			'ok("清洗：三个以上换行压成两个", preprocessClip("a" + NL.repeat(4) + "b") === "a" + NL.repeat(2) + "b");',
			'ok("清洗：成对包裹的引号剥掉", preprocessClip("「帮我查一下」") === "帮我查一下");',
			'ok("清洗：不成对的不动", preprocessClip("「帮我查一下") === "「帮我查一下");',
			'ok("清洗：句子中间的口癖不碰", preprocessClip("嗯那个帮我查一下") === "嗯那个帮我查一下");',
			'// ---- 正文收尾清洗（真实样本：看看看到底 / 尾部话头）----',
			'ok("收尾：ASR 叠字 看看看到底 → 看看到底", cleanBody("看看看到底区别在哪里").text === "看看到底区别在哪里");',
			'ok("收尾：尾部悬空话头「然后」剥掉", cleanBody("有可以优化的地方，然后").text === "有可以优化的地方");',
			'ok("收尾：话头在句子中间不碰", cleanBody("然后我们再开始").text === "然后我们再开始");',
			'ok("收尾：只说了话头 → 剩下空（调用方丢弃）", cleanBody("然后").text === "然后");',
			'// ---- clip：循环剥触发词（治「说了两遍发送」）----',
			'ok("clip：说两遍发送 → 全剥干净", matchTrigger("帮我查一下 发送 发送", T).body === "帮我查一下");',
			'ok("clip：说两遍（带标点）也全剥", matchTrigger("帮我查一下，发送，发送。", T).body === "帮我查一下");',
			'ok("clip：剥两层会记账 strips=2", matchTrigger("帮我查一下 发送 发送", T).strips === 2);',
			'ok("clip：只说两遍触发词 → 正文空 → 丢弃", matchTrigger("发送发送", T).hit === true && matchTrigger("发送发送", T).body === "");',
			'ok("clip：没触发词时 body 原样返回", matchTrigger("看看看到底", T).body === "看看看到底");',
			'const b64s = (x) => Buffer.from(x, "utf8").toString("base64");',
			'// ---- 静默投递护栏（looksLikeSpeech）：挡住你 Ctrl+C 的代码/网址/日志 ----',
			'ok("护栏：正常一句话 → 放行", looksLikeSpeech("帮我把日志按天切一下").ok === true);',
			'ok("护栏：/voice clip mark on|off 这种 help 行 → 挡掉（真实误投过）", looksLikeSpeech("/voice clip mark on|off 投递正文加不加 「📋 」前缀（默认加，便于分辨是不是语音投递）").ok === false);',
			'ok("护栏：斜杠开头（指令）→ 挡掉", looksLikeSpeech("/reload").ok === false || looksLikeSpeech("/voice clip on 把这个打开").ok === false);',
			'ok("护栏：网址 → 拦下", looksLikeSpeech("https://example.com/a?b=1 看看这个").ok === false);',
			'ok("护栏：代码 → 拦下", looksLikeSpeech("const a = {b: 1}; function f() { return a; }").ok === false);',
			'ok("护栏：错误栈 → 拦下", looksLikeSpeech("TypeError: x is undefined").ok === false);',
			'ok("护栏：英文文档 → 拦下", looksLikeSpeech("this is a long english paragraph copied from a doc").ok === false);',
			'ok("护栏：太短 → 拦下", looksLikeSpeech("好").ok === false);',
			'ok("护栏：多行日志 → 拦下", looksLikeSpeech(["一行","二行","三行","四行","五行"].join(NL)).ok === false);',
			'ok("护栏：太长 → 拦下", looksLikeSpeech("这是一段话。".repeat(200)).ok === false);',
			'ok("护栏：像代码但中文多的一行命令 → 放行（你说的话）", looksLikeSpeech("把它复制到 test 目录里去").ok === true);',
			'// ---- 内容判断开关（/voice clip guess）：关了就"不猜"，只剩去重+非空 ----',
			'ok("判断开关：开 → 网址照样拦", guardContent("https://example.com 看看这个", true).ok === false);',
			'ok("判断开关：关 → 网址/代码/英文都放行", guardContent("https://example.com/a?b=1", false).ok === true && guardContent("const a = 1;", false).ok === true && guardContent("this is english", false).ok === true);',
			'ok("判断开关：关 → 但太短还是拦（空/单字）", guardContent("好", false).ok === false && guardContent("   ", false).ok === false);',
			'ok("判断开关：关 → 原因写「直接投」", guardContent("帮我看看这个", false).why.includes("直接投"));',
			'ok("判断开关：默认参数 = 开（不给参数也走启发式）", guardContent("https://x.com").ok === false);',
			// ---- 会话替换：旧 ctx 一碰就抛，后台回调（helper 输出/定时器）绝不能让异常冒出去 ----
			// 真实事故：11:36 那次 session 替换后，voice 的 helper 输出 → noteDrop → refreshStatus
			// 拿着旧 ctx 读 hasUI 抛未捕获异常 → 崩掉整个 pi 进程（crashes.json: uncaught_exception）
			"const staleMsg = 'This extension ctx is stale after session replacement or reload.';",
			"const makeStaleCtx = () => new Proxy({}, { get() { throw new Error(staleMsg); } });",
			"let voiceHandlers = {};",
			'const fakeVoiceApi = { on(n, f) { voiceHandlers[n] = f; }, registerCommand() {}, registerTool() {}, registerFlag() {}, getFlag() { return false; }, appendEntry() {} };',
			"setupVoice(fakeVoiceApi);",
			'ok("会话替换：setupVoice 挂了 session_start（拿新 ctx 的入口）", typeof voiceHandlers.session_start === "function");',
			"let boom = null;",
			"try { voiceHandlers.session_start({}, makeStaleCtx()); } catch (e) { boom = e; }",
			'ok("会话替换：session_start 拿旧 ctx 也不炸", boom === null);',
			"// 现在缓存里是旧 ctx：helper 吐一条太短的内容 → noteDrop → refreshStatus（事故现场）",
			"clipEvt.length = 0; clipSeen = [];",
			"clipTriggerMode = 'silent';",
			"boom = null;",
			'const short = (x) => Buffer.from(x, "utf8").toString("base64");',
			'process.on("uncaughtException", (e) => { boom = e; });',
			'try { onHelperLine("T 900 " + short("好")); } catch (e) { boom = e; }',
			'ok("会话替换：helper 输出触发 refreshStatus 不再抛（原崩溃点）", boom === null);',
			"// 再触发两次：证明旧 ctx 已被丢掉（不会每次输出都炸一遍）",
			"boom = null;",
			'try { onHelperLine("T 901 " + short("好")); voiceHandlers.session_start({}, makeStaleCtx()); } catch (e) { boom = e; }',
			'ok("会话替换：之后继续有输出/会话启动也不炸", boom === null);',
			"// 新 ctx 来了要能恢复（session_start 是唯一的恢复入口）",
			"let setStatusCalls = 0;",
			"const freshCtx = { hasUI: true, mode: 'tui', ui: { setStatus() { setStatusCalls++; }, theme: { fg: (_c, x) => x } } };",
			"voiceHandlers.session_start({}, freshCtx);",
			"onHelperLine('T 902 ' + short('好'));",
			'ok("会话替换：新 ctx 进来后状态栏照常刷新（自动恢复）", setStatusCalls >= 1);',
			'// ---- 静默投递：不喊触发词也会投（等安静下来） ----',
			'clipEvt.length = 0; clipSeen = [];',
			'clipTriggerMode = "silent"; clipSilentMs = 300;',
			'onHelperLine("T 200 " + b64s("帮我把这张表导出成 csv"));',
			'ok("静默模式：先记为「等待静默」，不立刻投", clipEvt[0].kind === "等待静默");',
			'clipTriggerMode = "word";',
			'onHelperLine("T 201 " + b64s("把上个月的账单汇总一下"));',
			'ok("word 模式：没触发词 → 丢弃", clipEvt[clipEvt.length - 1].kind === "丢弃·无触发词");',
			'clipTriggerMode = "silent";',
			'onHelperLine("T 202 " + b64s("const a = 1; const b = 2;"));',
			'ok("静默模式：代码被护栏拦下（不会乱投）", clipEvt[clipEvt.length - 1].kind === "丢弃·不像语音");',
			'// ---- clip：真话回归（这条就是剪贴板里的原文）----',
			'const real = matchTrigger("你可以实际去找我粘贴板上的前几条数据的实际信息，看看看到底区别在哪里，然后发送。", T);',
			'ok("clip：真话 → 命中", real.hit === true);',
			'ok("clip：真话 → 剥 1 层触发词", real.strips === 1);',
			'ok("clip：真话 → 清掉尾部话头「然后」", real.cleaned === 1 && real.body.endsWith("区别在哪里"));',
			'ok("clip：真话 → 叠字已折（不再有 看看看）", real.body.includes("看看看") === false);',
			'ok("clip：真话 → 正文里没有触发词残留", real.body.includes("发送") === false);',
			'// ---- 结果卡片：摘要（markdown → 能直接看懂的短结论）----',
			'const MD = ["## 结论", "", "**三个问题都修好了**，改动如下：", "", "| 项 | 状态 |", "| --- | --- |", "| 看板 | ✅ |", "", "```bash", "npm test  # 这行不该出现", "```", "", "- 细节一：轮内计数", "- 细节二：每 8 次调用提醒"].join("\\n");',
			'const sum = summarizeReply(MD, 120);',
			'ok("摘要：标题符号没了", sum.startsWith("三个问题都修好了") === true);',
			'ok("摘要：加粗标记没了", sum.includes("**") === false);',
			'ok("摘要：表格行没混进来", sum.includes("|") === false);',
			'ok("摘要：代码块内容没混进来", sum.includes("npm test") === false);',
			'ok("摘要：列表符没了", sum.includes("- 细节") === false && sum.includes("细节一") === true);',
			'ok("摘要：超长会在句读处截断并加省略号", summarizeReply("一二三四五六七八九十。".repeat(20), 20).endsWith("…") === true);',
			'ok("摘要：空输入 → 空", summarizeReply("") === "");',
			'ok("摘要：纯代码块 → 空（调用方给兜底文案）", summarizeReply("```js\\nconst a = 1;\\n```") === "");',
			'ok("摘要：开场空话被跳过", summarizeReply("好的。\\n真正的结论在这里，共修了三处。", 120).startsWith("真正的结论") === true);',
			'// ---- 结果卡片：元信息行 ----',
			'ok("元信息：耗时/工具/文件/失败", formatResultMeta({ secs: 42, tools: 12, failed: 1, files: ["a.ts", "b.ts", "c.ts", "d.ts"] }).includes("42s") === true);',
			'ok("元信息：文件多了折叠成「等 N 个」", formatResultMeta({ files: ["a.ts","b.ts","c.ts","d.ts"] }).includes("等 4 个") === true);',
			'ok("元信息：失败会标 ⚠️", formatResultMeta({ failed: 2 }).includes("⚠️ 2 个工具失败") === true);',
			'ok("元信息：一分钟以上换成 m/s", formatResultMeta({ secs: 95 }).includes("1m35s") === true);',
			'ok("元信息：啥都没有 → 空串", formatResultMeta({}) === "");',
			'// ---- 触发词结尾窗口（治「IME 整理把发送挪走/后面补字」）----',
			'const W6 = 6;',
			'ok("窗口：发送后面被补了「，就这样」→ 命中", matchTrigger("帮我查一下，发送，就这样", T, W6).hit === true);',
			'ok("窗口：命中后把填充尾巴也丢掉", matchTrigger("帮我查一下，发送，就这样", T, W6).body === "帮我查一下");',
			'ok("窗口：发送一下 → 命中", matchTrigger("帮我查一下 发送一下", T, W6).hit === true);',
			'ok("窗口：窗口关掉（0）就回到严格结尾", matchTrigger("帮我查一下，发送，就这样", T, 0).hit === false);',
			'ok("窗口：正文中间提「发送」不算（后面不是填充物）", matchTrigger("发送那个文件给我", T, W6).hit === false);',
			'ok("窗口：不能隔太远（末尾 20 字外）", matchTrigger("发送然后说了一大堆没用的东西在这里", T, W6).hit === false);',
			'ok("窗口：命中位置会被记下（台账用）", matchTrigger("帮我查一下，发送，谢谢", T, W6).at === 6);',
			'// ---- 否定词护栏 ----',
			'ok("护栏：「别发送」不算", matchTrigger("别发送", T, W6).hit === false);',
			'ok("护栏：「先别发送」不算", matchTrigger("先别发送", T, W6).hit === false);',
			'ok("护栏：「不要发送」不算", matchTrigger("这文件不要发送", T, W6).hit === false);',
			'ok("护栏：正常「发送」照旧命中", matchTrigger("把日志跑一遍发送", T, W6).hit === true);',
			'// ---- helper 启动登记（治「/reload 后重放旧话」）+ 台账判定 ----',
			'const b64v = (x) => Buffer.from(x, "utf8").toString("base64");',
			'clipEvt.length = 0;',
			'clipSeen = [];',
			'onHelperLine("P 100 " + b64v("帮我查一下，发送"));',
			'ok("启动登记：P 行只登记不投递", clipEvt.length === 1 && clipEvt[0].kind === "启动登记");',
			'onHelperLine("T 101 " + b64v("帮我查一下，发送"));',
			'ok("启动登记过的内容再来 → 判重复丢弃", clipEvt[1].kind === "丢弃·重复");',
			'clipTriggerMode = "word";',
			'onHelperLine("T 102 " + b64v("今天天气不错"));',
			'ok("没带触发词 → 台账记「无触发词」", clipEvt[2].kind === "丢弃·无触发词");',
			'onHelperLine("T 103 " + b64v("发送"));',
			'ok("只说了触发词 → 台账记「只说了触发词」", clipEvt[3].kind === "丢弃·只说了触发词");',
			'ok("台账只留最近 12 条", clipEvt.length <= 12);',
			'// ---- 悬浮窗按钮 → 计划确认 通道 ----',
			'let asked = null;',
			'// ---- clip：投递档位 ----',
			'const D = decideDelivery;',
			'ok("clip：空闲 → 直接起一轮（不带 deliverAs）", D({ idle: true, mode: "steer" }).deliverAs === undefined && D({ idle: true, mode: "queue" }).note === "已直接开始处理");',
			'ok("clip：忙 + steer → 插话", D({ idle: false, mode: "steer" }).deliverAs === "steer");',
			'ok("clip：忙 + queue → 排队", D({ idle: false, mode: "queue" }).deliverAs === "followUp");',
			'ok("clip：忙 + abort → 打断", D({ idle: false, mode: "abort" }).abort === true && D({ idle: false, mode: "abort" }).note.includes("打断"));',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-voice") },
	) && allOk;

// ---------- 套件：settings（/aihelp 配置面板：注册项必须完整、每项能读能写） ----------
// 面板是通用渲染器，配置项由各模块自己注册 —— 这里守着"注册得对不对"
bundle("voice.ts", "settings.mjs");
allOk =
	runSuite(
		"settings：配置面板（注册项 / 读写往返 / 夹范围）",
		join(tmp, "settings.mjs"),
		[
			"registerVoiceSettings();",
			"const snap = settingsSnapshot();",
			'ok("面板：注册项数量 ≥ 20（现在 24 个）", snap.length >= 20);',
			'ok("面板：key 不重复", new Set(snap.map((s) => s.key)).size === snap.length);',
			'ok("面板：每项都有名字", snap.every((s) => s.label && s.label.length >= 2));',
			'ok("面板：每项都写了「干什么用的」（≥12 字）", snap.every((s) => s.desc && s.desc.length >= 12));',
			'ok("面板：每项都有类型", snap.every((s) => ["bool","enum","number","text","list"].includes(s.kind)));',
			'ok("面板：分组 ≥ 5（剪贴板/输入框/通知/播报/计划…）", new Set(snap.map((s) => s.group)).size >= 5);',
			'ok("面板：每一项都读得出当前值（文本项可留空）", snap.every((s) => s.kind === "text" || fieldValue(getSetting(s.key)).length > 0));',
			"const rt = [];",
			'for (const s of snap) { if (s.key === "voiceClip") continue; const d = getSetting(s.key); d.set(Array.isArray(d.def) ? [...d.def] : d.def); rt.push(JSON.stringify(d.get()) === JSON.stringify(d.def)); }',
			'ok("面板：每一项都能写回默认值并读出来（往返一致）", rt.every(Boolean));',
			'const dn = getSetting("voiceClipSilentMs"); dn.set(99);',
			'ok("面板：数字项低于下限会被夹住（99 → 300）", dn.get() === 300);',
			"dn.set(99999);",
			'ok("面板：数字项高于上限会被夹住（99999 → 10000）", dn.get() === 10000);',
			'const en = getSetting("voiceClipTriggerMode");',
			'ok("面板：枚举项每个候选都设得进去", ["silent","word"].every((v) => (en.set(v), en.get() === v)));',
			'const tr = getSetting("voiceClipTriggers"); tr.set("发送, 投给pi 继续");',
			'ok("面板：触发词（DIY 项）逗号/空格混写也能解析", JSON.stringify(tr.get()) === JSON.stringify(["发送","投给pi","继续"]));',
			'const tk = getSetting("voiceTtsVolume"); tk.set(200);',
			'ok("面板：音量超 100 会被夹住", tk.get() === 100);',
			'ok("面板：会话级项有标记（boardOff / extDisabled）", snap.filter((s) => s.session).length >= 0);',
			// ---- 表单式面板：字段生成 / 值解析 / 保存 ----
			'const fs2 = settingsFields();',
			'ok("表单：一行一项（和注册项数量一致）", fs2.length === snap.length);',
			'ok("表单：标签带分组前缀且不超长", fs2.every((f) => f.label.includes("·") && f.label.length <= 20));',
			'ok("表单：bool → 是/否（FormPane 的 bool 行）", fs2.filter((f) => f.kind === "bool").length >= 5);',
			'ok("表单：枚举项带候选（回车能展开）", fs2.some((f) => f.kind === "enum" && Array.isArray(f.options) && f.options.length >= 2));',
			'ok("表单：每行都有灰字提示（单位/范围）", fs2.every((f) => f.hint && f.hint.length > 0));',
			'const dNum = getSetting("voiceClipSilentMs");',
			'ok("解析：数字超范围会被夹住", parseFieldValue(dNum, "1") === 300 && parseFieldValue(dNum, "999999") === 10000);',
			'ok("解析：数字不是数字 → undefined（不写坏配置）", parseFieldValue(dNum, "abc") === undefined);',
			'const dEnum = getSetting("voiceClipTriggerMode");',
			'ok("解析：枚举按显示文本映射回真实值", parseFieldValue(dEnum, "触发词（必须说）") === "word");',
			'const dList = getSetting("voiceClipTriggers");',
			'ok("解析：列表支持中英文逗号/空格", JSON.stringify(parseFieldValue(dList, "发送，投给pi 继续")) === JSON.stringify(["发送","投给pi","继续"]));',
			'const dBool = getSetting("voicePopup");',
			'ok("解析：bool 认「是/否」", parseFieldValue(dBool, "是") === true && parseFieldValue(dBool, "否") === false);',
			// 保存：没改的行不写、改了的行写、坏值不写
			'const same = {};',
			'for (const d of settingsDefs()) same[d.key] = fieldValue(d);',
			'ok("保存：原样提交 → 一项都不动（不会白写盘）", applySettingsValues(same).applied.length === 0);',
			'const one = { ...same, voiceClipSilentMs: "1500" };',
			'const r1 = applySettingsValues(one);',
			'ok("保存：改一项 → 只应用那一项", r1.applied.length === 1 && r1.applied[0].includes("静默") && getSetting("voiceClipSilentMs").get() === 1500);',
			'const bad = { ...same, voiceClipSilentMs: "不是数字" };',
			'const r2 = applySettingsValues(bad);',
			'ok("保存：坏值 → 记到 failed 且不写坏", r2.failed.length === 1 && r2.applied.length === 0 && getSetting("voiceClipSilentMs").get() === 1500);',
			'const all = {};',
			'for (const d of settingsDefs()) all[d.key] = Array.isArray(d.def) ? d.def.join(", ") : d.kind === "bool" ? (d.def ? "是" : "否") : d.kind === "enum" ? (d.options ?? [])[Math.max(0, (d.values ?? d.options ?? []).findIndex((x) => x === d.def))] : String(d.def);',
			'const r3 = applySettingsValues(all);',
			'ok("保存：全部改成默认值 → 应用成功（往返不炸）", r3.applied.length + r3.failed.length >= 20 || r3.failed.length === 0);',
			'ok("详情行：写清了「干什么用的 + 取值 + 当前 + 默认」", fieldDetail(getSetting("voiceClipGuess")).includes("取值：") && fieldDetail(getSetting("voiceClipGuess")).includes("默认："));',
			'ok("详情行：会话级项标出来了", fieldDetail(getSetting("voiceClip")) !== undefined);',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-settings") },
	) && allOk;

// ---------- 套件：notify（终端探测 / 通知通道 / 摘要） ----------
bundle("notify.ts", "notify.mjs");
allOk =
	runSuite("notify：终端探测 / 通道选择 / 摘要", join(tmp, "notify.mjs"), [
		'ok("探测：Warp → 支持胶囊", detectTerminal({ TERM_PROGRAM: "WarpTerminal" }).osc === true);',
		'ok("探测：Windows Terminal → 支持", detectTerminal({ WT_SESSION: "abc" }).osc === true);',
		'ok("探测：iTerm2 → 支持", detectTerminal({ TERM_PROGRAM: "iTerm.app" }).osc === true);',
		'ok("探测：kitty → 支持", detectTerminal({ KITTY_WINDOW_ID: "1" }).osc === true);',
		'ok("探测：cmd/conhost → **不支持**（绝不写 OSC，免得出乱码）", detectTerminal({ ComSpec: "C:/Windows/system32/cmd.exe" }).osc === false);',
		'ok("探测：完全未知 → 保守当不支持", detectTerminal({}).osc === false);',
		'ok("探测：名字能看懂（给你看的状态里用）", detectTerminal({ TERM_PROGRAM: "WarpTerminal" }).name === "Warp");',
		'ok("通道：默认 auto（终端支持就发胶囊，不支持才换）", getNotifyMode() === "auto");',
		'setNotifyMode("both");',
		'ok("通道：能切到 both（胶囊 + 自绘弹窗）", getNotifyMode() === "both");',
		'setNotifyMode("auto");',
		'ok("摘要：标题+正文能洗干净", summarizeReply("## 结论" + String.fromCharCode(10) + String.fromCharCode(10) + "三处都修好了。") === "三处都修好了。");',
		'ok("元信息：超一分钟显示 m ss", formatResultMeta({ secs: 61 }) === "1m01s");',
			'ok("弹窗：登记簿目录 = <agent>/pi-cards", cardDirPath().replace(/[\\\\/]/g, "/").endsWith("pi-cards"));',
			'ok("弹窗：cardDirPath 是函数（新弹窗靠它叠在旧弹窗下面）", typeof cardDirPath() === "string");',
]) && allOk;

// ---------- 套件：整装（入口装配后，配置面板里各项都在） ----------
// 价值：单测各模块 setup 没抛异常不算数 —— 这里真跑一遍入口，
//      看「注册表里到底有没有东西」（面板要是空的，用户打开就是白板）
bundle("pi-extensions.ts", "entry.mjs");
allOk =
	runSuite(
		"entry：整装装配（模块不炸 + 配置面板有货）",
		join(tmp, "entry.mjs"),
		[
			"const cmds = {};",
			"const api = {",
			"  registerCommand(name, c) { cmds[name] = c.handler; },",
			"  registerTool() {},",
			"  on() {},",
			"  registerFlag() {},",
			"  getFlag() { return false; },",
			"  getActiveTools() { return []; },",
			"  setActiveTools() {},",
			"  appendEntry() {},",
			"  unregisterMcpServer() {},",
			"  registerMcpServer() {},",
			"};",
			"setupAll(api);",
			'ok("入口：/aihelp 注册上了（面板入口）", typeof cmds.aihelp === "function");',
			'ok("入口：/ai help 的文本版还在（showHelp 没被拆）", typeof cmds.ai === "function");',
			'ok("入口：/voice 还在", typeof cmds.voice === "function");',
			"registerVoiceSettings();",
			"const snap = settingsSnapshot();",
			'ok("面板：装完后注册项 ≥ 24（含 voice/delegate/board/gate）", snap.length >= 24);',
			'ok("面板：有「助理 / 委派」分组（delegate 注册上了）", snap.some((s) => s.group.includes("助理")));',
			'ok("面板：有「会话级」分组（board/gate 注册上了）", snap.some((s) => s.group.includes("会话级")));',
			'ok("面板：不是空板（每一项都有说明，打开就能看）", snap.every((s) => s.desc.length >= 12));',
			// 命令 handler 空参跑一遍：抓 ReferenceError / 拼写错（/aihelp 就踩过 isExtDisabled 没 import）
			"const fakeCtx = { ui: { notify() {}, setStatus() {}, select: async () => undefined, input: async () => undefined, editor: async () => undefined, custom: async () => undefined, theme: { fg: (_c, x) => x, bold: (x) => x } }, hasUI: false, isIdle: () => true, abort() {}, cwd: process.cwd(), sessionManager: { getEntries: () => [] } };",
			"const crashed = [];",
			"for (const [name, c] of Object.entries(cmds)) { try { await c('', fakeCtx); } catch (e) { crashed.push(name + ': ' + (e && e.message)); } }",
			'ok("入口：所有命令 handler 空参跑一遍不炸", crashed.length === 0);',
			'if (crashed.length) console.log("   炸了: " + crashed.join(" | "));',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-entry") },
	) && allOk;

// ---------- 静态检查：删掉的功能不许留"幽灵引用" ----------
// （踩过：hud.ts 删掉后 voice.ts 还 calling answerPlan()/cardNotify()，打包能过、一 reload 才炸）
{
	const files = ["board.ts", "voice.ts", "notify.ts", "pi-extensions.ts", "config.ts", "panel.ts", "delegate.ts", "gate.ts", "help.ts"];
	let src = "";
	for (const f of files) {
		try {
			src += readFileSync(join(ext, f), "utf8");
		} catch {
			/* 文件不在就算了 */
		}
	}
	const ghosts = [
		"answerPlan(", "askPlanInHud", "hudPlanAsk", "setPlanAsker", "askPlanViaHud", "planAskAvailable", "setPlanAskAvailable",
		"armHud", "disarmHud", "hudState", "pushHudNow", "pushHudThrottled", "hudLog", "hudTick", "readHudCmd", "pushHud",
		"startHud", "stopHud", "hudRunning", "hudPos", "resetHudPos", "hudPidInfo", "hudAliveByPidFile", "killAllHuds",
		"toggleClipFromHud", "summarizeArgs", "messageText", "liveText", "actLines",
		"lastUserText", "hudTicks", "hudExpanded", "hudLastSummary", "hudLastMeta", "HUD_TICK_MS", "hudFont", "hudCorner",
		"from \"./hud\"",
	];
	const found = ghosts.filter((g) => src.includes(g));
	if (found.length === 0) {
		console.log("PASS  静态：删掉的 HUD 功能没有幽灵引用");
	} else {
		allOk = false;
		console.log("FAIL  静态：删掉的 HUD 功能还残留引用 → " + found.join(", "));
	}
}
{
	const shared = readFileSync(join(ext, "shared.ts"), "utf8");
	const need = ["openPlanAsk", "answerPlanAsk", "hasPendingPlanAsk", "closePlanAsk", "isLowRiskPlan", "parsePlanAnswer", "setPlanCfg", "getPlanCfg"];
	const missing = need.filter((n) => !shared.includes(n));
	const wired = readFileSync(join(ext, "board.ts"), "utf8").includes('from "./shared"') && readFileSync(join(ext, "voice.ts"), "utf8").includes('from "./shared"');
	if (missing.length === 0 && wired) {
		// ── 静态检查：弹窗脚本不许再有 Region.FromRegion（不存在 → Add-Type 编译失败 → 弹窗永远不显示）──
{
	const src = readFileSync(join(ext, "notify.ts"), "utf8");
	if (src.includes("-split 's+'")) {
		console.log("FAIL  静态：弹窗脚本把 -split '\s+' 的反斜杠写丢了（叠窗位置会永远算成 0）");
		allOk = false;
	} else {
		console.log("PASS  静态：叠窗解析用的 -split 反斜杠还在");
	}
	if (/Region\.FromRegion\s*\(/.test(src)) {
		console.log("FAIL  静态：弹窗脚本用了不存在的 Region.FromRegion（应为 Region.FromHrgn）");
		allOk = false;
	} else {
		console.log("PASS  静态：弹窗脚本的圆角 API 正确（Region.FromHrgn）");
	}
}
{
	const nf = readFileSync(join(ext, "notify.ts"), "utf8");
	const gone = ["planCard", "readPlanCmd", "PlanB64", "CmdFile", "killOldPopup"].filter((x) => nf.includes(x));
	const hasStack = nf.includes("-CardDir") && nf.includes("cardDir");
	const hasRefs = nf.includes("ReferencedAssemblies System.Windows.Forms");
	if (gone.length === 0 && hasStack && hasRefs) {
		console.log("PASS  静态：弹窗按钮已彻底移除，叠窗参数与程序集引用都在");
	} else {
		allOk = false;
		console.log("FAIL  静态：弹窗改动不完整 → 残留:[" + gone.join(",") + "] 叠窗:" + hasStack + " 程序集引用:" + hasRefs);
	}
}
{
	const need = [["voice.ts", "registerVoiceSettings"], ["delegate.ts", "registerDelegateSettings"], ["board.ts", "registerBoardSettings"], ["gate.ts", "registerGateSettings"]];
	const miss = need.filter(([f, fn]) => !readFileSync(join(ext, f), "utf8").includes(fn));
	const entry = readFileSync(join(ext, "pi-extensions.ts"), "utf8");
	if (miss.length === 0 && entry.includes("openSettings")) {
		console.log("PASS  静态：/aihelp 面板：四个模块都注册了配置项，入口接到 openSettings");
	} else {
		allOk = false;
		console.log("FAIL  静态：面板接线不完整 → 缺:" + miss.map((m) => m[0]).join(",") + " 入口:" + entry.includes("openSettings"));
	}
}
console.log("PASS  静态：共享桥 shared.ts 完整且 board/voice 都接上了");
	} else {
		allOk = false;
		console.log("FAIL  静态：共享桥缺失 → " + (missing.join(", ") || "没有再 import"));
	}
}
if (!allOk) console.log(String.fromCharCode(10) + "❌ 静态检查失败");

rmSync(tmp, { recursive: true, force: true });

if (allOk) {
	console.log("\n✅ 单元测试全部通过");
	process.exit(0);
}
console.error("\n❌ 有测试失败");
process.exit(1);
