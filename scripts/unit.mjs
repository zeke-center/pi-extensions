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
		const inherited = { ...process.env };
		// 隔离：外层 shell 里的 PI_SA_UI（压测要 export 它）不许污染断言。
		// 套件要测环境变量就在断言里自己设 + try/finally 恢复。
		delete inherited.PI_SA_UI;
		const out = execFileSync(process.execPath, [bundleFile], {
			env: { ...inherited, ...env },
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
			'// 退避计时归零要走显式 reset（lastAttemptAt 是「只增」字段，直接写 0 会被合并规则挡掉）',
			'writeBgTask({ ...readBgTask("dtest-1"), reset: ["lastAttemptAt"] });',
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
			'// ---- Herdr 分屏：参数改造 / 启动脚本 / 回壳判定 ----',
			'const rpcArgv = ["/p/cli.js", "--mode", "rpc", "-xt", "delegate,progress", "-na", "--session-dir", "D:/s"];',
			'ok("交互式参数：去掉 --mode rpc，其余不动", JSON.stringify(stripHeadlessArgs(rpcArgv)) === JSON.stringify(["/p/cli.js", "-xt", "delegate,progress", "-na", "--session-dir", "D:/s"]));',
			'const jsonArgv = ["/p/cli.js", "-p", "--mode", "json", "-xt", "a"];',
			'ok("交互式参数：去掉 -p --mode json", JSON.stringify(stripHeadlessArgs(jsonArgv)) === JSON.stringify(["/p/cli.js", "-xt", "a"]));',
			'ok("交互式参数：带值的 --mode 只吃一个值", !stripHeadlessArgs(["c", "--mode", "rpc"]).includes("rpc"));',
			'// ---- 碎片事故防回归（worker 收到碎片 = 同一次运行被投了多次 prompt）----',
			'// 1) 任务正文必须**逐字节**在 cardPrompt 里（不许被截 / 被切）',
			'const longTask = ["第一行：中文任务 请把单引号与双引号都保住", "第二行 → 结束 " + "x".repeat(2000)].join(String.fromCharCode(13, 10));',
			'ok("cardPrompt：任务原文逐字节在里面（中文/换行/引号/2KB）", Buffer.from(cardPrompt(longTask), "utf8").includes(Buffer.from(longTask, "utf8")));',
			'ok("cardPrompt：单行任务以模板头开始（不夹带前缀）", cardPrompt("T").startsWith("【任务】\\nT\\n"));',
			'ok("cardPrompt：模板里只出现一次任务正文", cardPrompt("UNIQUETASK").split("UNIQUETASK").length === 2);',
			'// 2) 一次运行只允许 1 条 type=prompt（硬收尾追问是唯一例外，且只准一次）',
			'const gate = makePromptGate();',
			'ok("prompt 闸门：第一次任务 prompt 放行", gate.task(cardPrompt("任务")) === true && gate.count === 1);',
			'ok("prompt 闸门：第二次任务 prompt 被拒（不许把碎片再投一遍）", gate.task("碎片") === false && gate.count === 1);',
			'ok("prompt 闸门：没开硬收尾 → 追问被拒", gate.wrapUp(wrapUpText()) === false && gate.count === 1);',
			'gate.allowWrapUp();',
			'ok("prompt 闸门：硬收尾后追问只放行一次", gate.wrapUp(wrapUpText()) === true && gate.wrapUp("再追一次") === false && gate.count === 2);',
			'const gate2 = makePromptGate();',
			'gate2.allowWrapUp();',
			'ok("prompt 闸门：没发过任务 prompt 时追问也不放行（防漏发任务）", gate2.wrapUp(wrapUpText()) === false && gate2.count === 0);',
			'// 3) stripHeadlessArgs 必须是纯函数（返回新数组、入参一个字节都不动）',
			'const pureArgv = ["/p/cli.js", "--mode", "rpc", "-na", "任务正文"];',
			'const pureSnap = JSON.stringify(pureArgv);',
			'const pureOut = stripHeadlessArgs(pureArgv);',
			'ok("stripHeadlessArgs：返回新数组（不是入参本身）", pureOut !== pureArgv);',
			'ok("stripHeadlessArgs：入参长度/内容一个字节不动", JSON.stringify(pureArgv) === pureSnap && pureArgv.length === 5);',
			'ok("stripHeadlessArgs：任务正文原样留在输出末尾", pureOut[pureOut.length - 1] === "任务正文" && pureOut.length === 3);',
			'const fakeTpl = { key: "general", env: { FOO: "bar" } };',
			'const fakeOpt = { shadowDir: "C:\\\\shadow\\\\abc", sessionDir: "D:/s", timeoutMs: 1000, names: { id: "sid-1", display: "n" }, resumed: false };',
			'const script = writePaneLauncher(fakeTpl, ["/p/cli.js", "-na", "--session-id", "sid-1"], fakeOpt, "unit-1");',
			'const scriptSrc = script ? readFileSync(script, "utf8") : "";',
			'const jsonFile = script ? script.replace(/\.mjs$/, ".json") : "";',
			'ok("启动脚本：以 .mjs 结尾（Node 启动器，不是 PowerShell）", !!script && script.endsWith(".mjs"));',
			'ok("启动脚本：脚本里不写死路径（路径由 pane run 的命令串传）", !scriptSrc.includes("sa-pane-unit-1"));',
			'ok("启动脚本：JSON 侧文件真的写出来了", !!jsonFile && existsSync(jsonFile));',
			'ok("启动脚本：.mjs 内容必须是纯 ASCII（不经 shell 猜编码）", /^[\\x00-\\x7F]*$/.test(scriptSrc));',
			'ok("启动脚本：读 JSON 用 process.argv[2]、spawn 用 inherit", scriptSrc.includes("process.argv[2]") && scriptSrc.includes("inherit"));',
			'ok("启动脚本：不再调用 powershell / bash", !/powershell|bash/i.test(scriptSrc));',
			'const launchedSrc = paneLaunchCommand(script);',
			'ok("启动命令：形如 node \\"<mjs>\\" \\"<json>\\"", /^node "[^"]+\\.mjs" "[^"]+\\.json"$/.test(launchedSrc));',
			'ok("启动命令：纯 ASCII", /^[\\x00-\\x7F]*$/.test(launchedSrc));',
			'ok("启动命令：正斜杠（反斜杠会被 pane run 吃掉）", !launchedSrc.includes("\\\\"));',
			'ok("启动命令：mjs/json 同一个 stem", launchedSrc.includes("sa-pane-unit-1.mjs") && launchedSrc.includes("sa-pane-unit-1.json"));',
			'ok("启动脚本：JSON 无 BOM（首字节不是 FEFF）", !!jsonFile && readFileSync(jsonFile, "utf8").charCodeAt(0) !== 0xfeff);',
			'const cfg1 = JSON.parse(readFileSync(jsonFile, "utf8"));',
			'ok("JSON：node = 当前 node", cfg1.node === process.execPath);',
			'ok("JSON：args 原样", JSON.stringify(cfg1.args) === JSON.stringify(["/p/cli.js", "-na", "--session-id", "sid-1"]));',
			'ok("JSON：env 带影子目录", cfg1.env.PI_CODING_AGENT_DIR === "C:\\\\shadow\\\\abc");',
			'ok("JSON：env 带模板 env", cfg1.env.FOO === "bar");',
			'// ---- 中文 / 换行 / 各类引号的任务文本必须原样到达（编码事故的防回归） ----',
			'const nasty = "\\u7b2c\\u4e00\\u884c\\uff1a\\u4e2d\\u6587\\u4efb\\u52a1 \\u8bf7\\u628a\\u0027\\u5355\\u5f15\\u53f7\\u0027 \\u4e0e \\u0022\\u53cc\\u5f15\\u53f7\\u0022 \\u90fd\\u4fdd\\u4f4f\\r\\n\\u7b2c\\u4e8c\\u884c \\u2192 \\u7ed3\\u675f";',
			'const script2 = writePaneLauncher(fakeTpl, ["/p/cli.js", "-na", nasty], fakeOpt, "unit-2");',
			'const jsonFile2 = script2 ? script2.replace(/\.mjs$/, ".json") : "";',
			'const cfg2 = jsonFile2 ? JSON.parse(readFileSync(jsonFile2, "utf8")) : {};',
			'ok("JSON：含中文/换行/引号的任务文本 JSON.parse 后完全相等", cfg2.args[cfg2.args.length - 1] === nasty);',
			'ok("JSON：.mjs 里一个中文字都没有（不用靠编码猜）", !/[^\\x00-\\x7F]/.test(script2 ? readFileSync(script2, "utf8") : "中"));',
			'if (script2) { rmSync(script2, { force: true }); if (jsonFile2) rmSync(jsonFile2, { force: true }); }',
			'// ---- 「任务真的送到了」的断言：读会话 jsonl 的第一条 user 消息 ----',
			'const ddir = join(tmpdir(), "sa-unit-sess");',
			'mkdirSync(ddir, { recursive: true });',
			'const dfile = join(ddir, "20260101-000000-1_sid-v1.jsonl");',
			'writeFileSync(dfile, [JSON.stringify({ type: "message", message: { role: "user", content: "任务原文\\n第二行" } }), JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好" }] } })].join("\\n") + "\\n", "utf8");',
			'ok("送达判定：第一条 user 消息读得出来", firstUserTextIn(dfile) === "任务原文\\n第二行");',
			'ok("送达判定：相等 → true", (await waitTaskDelivered(ddir, "sid-v1", "任务原文\\n第二行", false, 2000)) === true);',
			'ok("送达判定：任务被吃（只有碎片）→ false（不进降级循环）", (await waitTaskDelivered(ddir, "sid-v1", "test", false, 2000)) === false);',
			'ok("送达判定：文件没出现 → 超时 false", (await waitTaskDelivered(ddir, "sid-none", "任务原文", false, 300)) === false);',
			'ok("回壳判定：PowerShell 提示符 = 跑完了", paneAtShell("PS F:\\\\AI\\\\My_Center> ") === true);',
			'ok("回壳判定：pi 正在画界面 = 没跑完", paneAtShell("⠋ thinking... 正在改 delegate.ts") === false);',
			'ok("回壳判定：空屏 = 没跑完", paneAtShell("") === false);',
			'// ---- 卡死看门狗：无输出多久算卡死（纯函数，阈值可改常量）----',
			'ok("看门狗：阈值是 90s 且集中在一个常量", PANE_IDLE_MS === 90_000);',
			'const stallNow = 1_000_000_000;',
			'const stallCtx = (o) => Object.assign({ alive: true, readable: true, output: "⏳ 等 fd 下载 0/3（停在65%）" }, o || {});',
			'ok("看门狗：90s 无变化 + 已送达 → 判卡死", isPaneStalled(stallNow - 90_000, stallNow, true, stallCtx()) === true);',
			'ok("看门狗：89s 还没到阈值 → 不判", isPaneStalled(stallNow - 89_000, stallNow, true, stallCtx()) === false);',
			'ok("看门狗：未送达 → 不判（交给送达校验）", isPaneStalled(stallNow - 300_000, stallNow, false, stallCtx()) === false);',
			'ok("看门狗：pane 已消失 → 不判（走结束路径）", isPaneStalled(stallNow - 300_000, stallNow, true, stallCtx({ alive: false })) === false);',
			'ok("看门狗：拿不到输出（read 失败）→ 不判，只记日志", isPaneStalled(stallNow - 300_000, stallNow, true, stallCtx({ readable: false, output: "" })) === false);',
			'ok("看门狗：空屏 → 没有判断依据 → 不判", isPaneStalled(stallNow - 300_000, stallNow, true, stallCtx({ output: "  \\n " })) === false);',
			'ok("看门狗：屏幕上有执行迹象 → 不判（不误杀长命令）", isPaneStalled(stallNow - 300_000, stallNow, true, stallCtx({ output: "⠋ running npm install --production" })) === false);',
			'ok("看门狗：中文执行迹象也不判", paneShowsActivity("正在执行：pip install") === true && isPaneStalled(stallNow - 300_000, stallNow, true, stallCtx({ output: "正在执行：pip install" })) === false);',
			'ok("看门狗：没迹象 → paneShowsActivity=false", paneShowsActivity("Error: something failed\\n> ") === false);',
			'ok("看门狗：不杀原因可归因（no-read）", paneStallReason(stallNow - 300_000, stallNow, true, stallCtx({ readable: false })) === "no-read");',
			'ok("看门狗：不杀原因可归因（busy / gone / undelivered）", paneStallReason(stallNow - 300_000, stallNow, true, stallCtx({ output: "thinking..." })) === "busy" && paneStallReason(stallNow - 300_000, stallNow, true, stallCtx({ alive: false })) === "gone" && paneStallReason(stallNow - 300_000, stallNow, false, stallCtx()) === "undelivered");',
			'ok("看门狗：三参调用（不传 ctx）默认按「活着且可读」算", isPaneStalled(stallNow - 120_000, stallNow, true) === false);',
			'// ---- Bug2：槽位互斥（并发派发不许两个任务抢同一个 pane → 撞车降级）----',
			'const madePanes = [];',
			'const splitSeen = new Set();',
			'const fakeOps = {',
			'  mainPaneId: () => "w1:p1",',
			'  workspaceId: () => "w1",',
			'  paneList: () => [{ paneId: "w1:p1" }, ...madePanes.map((id) => ({ paneId: id }))],',
			'  // 真 herdr 上「同一格再切同一刀」是撞车：桩子也这么模拟，才测得出互斥',
			'  paneSplit: (target, dir) => { const k = target + "|" + dir; if (splitSeen.has(k)) return undefined; splitSeen.add(k); const id = "w1:p" + (madePanes.length + 2); madePanes.push(id); return id; },',
			'  tabCreate: () => { const id = "w2:p" + (madePanes.length + 2); madePanes.push(id); return { tabId: "w2:t1", paneId: id }; },',
			'  tabClose: () => true,',
			'};',
			'setHerdrSlotOps(fakeOps);',
			'const slotCfg = { ui: "split", mainSlots: 2, overflowSlots: 2, splitRatio: 0.5, paneKeepOnError: false };',
			'const three = await Promise.all([0, 1, 2].map(() => allocHerdrSlot("F:/tmp/x", slotCfg, "split")));',
			'const threeIds = three.map((s) => (s ? s.paneId : ""));',
			'ok("槽位互斥：3 个并发全拿到格（没一个因撞车降级）", three.every((s) => !!s));',
			'ok("槽位互斥：3 个 paneId 互不相同", new Set(threeIds).size === 3 && !threeIds.includes(""));',
			'ok("槽位互斥：账上 3 格、引用的 paneId 也唯一", herdrSlots.size === 3 && new Set([...herdrSlots.values()].map((s) => s.paneId)).size === 3);',
			'// 假桩故意把同一个 paneId 返回两次 → 第二笔必须被拒（绝不两个任务共用一个 pane）',
			'herdrSlots.clear(); herdrExtraTabs.clear();',
			'setHerdrSlotOps({ ...fakeOps, paneList: () => [{ paneId: "w1:p1" }, { paneId: "w1:pDUP" }], paneSplit: () => "w1:pDUP" });',
			'const dup1 = await allocHerdrSlot("F:/tmp/x", slotCfg, "split");',
			'const dup2 = await allocHerdrSlot("F:/tmp/x", slotCfg, "split");',
			'ok("槽位互斥：同一 paneId 不许被两格同时引用", !!dup1 && dup2 === undefined && herdrSlots.size === 1);',
			'// 切 pane 第一次失败（真机上「刚切出来的 pane 立刻再切」会这样）→ 必须重试一次，不是直接降级',
			'herdrSlots.clear(); herdrExtraTabs.clear();',
			'let flaky = 0;',
			'const rebuilt = [];',
			'setHerdrSlotOps({ mainPaneId: () => "w9:p1", workspaceId: () => "w9", paneList: () => [{ paneId: "w9:p1" }, ...rebuilt.map((id) => ({ paneId: id }))], paneSplit: () => { flaky += 1; if (flaky === 1) return undefined; const id = "w9:p" + (rebuilt.length + 2); rebuilt.push(id); return id; }, tabCreate: () => undefined, tabClose: () => true });',
			'const flakySlot = await allocHerdrSlot("F:/tmp/x", { ui: "split", mainSlots: 1, overflowSlots: 0, splitRatio: 0.5, paneKeepOnError: false }, "split");',
			'ok("槽位重试：切 pane 失败一次后自动重试成功（不再因一次失败就降级 rpc）", !!flakySlot && flaky >= 2);',
			'herdrSlots.clear(); herdrExtraTabs.clear(); setHerdrSlotOps(undefined);',
			'if (script) { rmSync(script, { force: true }); if (jsonFile) rmSync(jsonFile, { force: true }); }',
		],
		{ TPROJ: proj, PI_CODING_AGENT_DIR: join(tmp, "agent-delegate") },
	) && allOk;

// ---------- 套件 1.5：pane 模式的收尾必须和 rpc 对等（回归）----------
// 踩过的真 bug：pane 模式的收尾（解析 <result> → markEnd → 写 .bg 终态 → 投递）只写在 rpc 分支里，
// pane 跑完直接 return makeResult() → .bg 永远 status:"running" → 回执永远不投。
// 这里钉死：任何一条结束路径都必须留下**终态**（而且绝不能是 running）。
bundle("delegate.ts", "delegate-pane.mjs");
allOk =
	runSuite(
		"delegate：pane 收尾对等（终态永不丢）",
		join(tmp, "delegate-pane.mjs"),
		[
			'const paneBgId = (n) => "pane-regress-" + n + "-" + Math.random().toString(36).slice(2, 8);',
			'const newRunningBg = (id) => writeBgTask({ id, key: "k", name: "n", task: "t", sessionId: "s-" + id, startedAt: Date.now(), status: "running" });',
			'const receiptText = "干完了" + String.fromCharCode(10) + "<result>" + JSON.stringify({ ok: true, verdict: "pass", changed: ["a.ts"], ran: ["npm test → 12 passed"], blocked: [], notes: "ok" }) + "</result>";',
			'// ---- ① pane 正常结束 + 有回执 → done（且这时候一定还没投）----',
			'const bg1 = paneBgId(1);',
			'newRunningBg(bg1);',
			'const f1 = finalizeHerdrRun({ outcome: "done", text: receiptText, now: 123456 });',
			'writeHerdrBgTerminal(bg1, f1);',
			'const t1 = readBgTask(bg1);',
			'ok("回归：pane 正常结束 + 有 <result> → .bg status=done（不再卡 running）", t1 && t1.status === "done");',
			'ok("回归：写完终态 delivered=false（投递由 pollBgTasks 做，不能假成功）", t1 && t1.delivered === false);',
			'ok("回归：终态带 finishedAt + 卡片正文", !!t1 && t1.finishedAt === 123456 && String(t1.resultText || "").includes("干完了"));',
			'// ---- ② pane 结束但没交 <result> → empty（不是 running，也不是假 done）----',
			'const bg2 = paneBgId(2);',
			'newRunningBg(bg2);',
			'writeHerdrBgTerminal(bg2, finalizeHerdrRun({ outcome: "done", text: "跑完了但忘了交卡" }));',
			'const t2 = readBgTask(bg2);',
			'ok("回归：没交 <result> → status=empty（绝不留在 running）", t2 && t2.status === "empty");',
			'ok("回归：没交回执时留下排查线索（lastError）", !!t2 && /回执/.test(String(t2.lastError || "")));',
			'// ---- ③ 收尾过程中抛异常 → .bg 仍被写终态（failed）----',
			'const bg3 = paneBgId(3);',
			'newRunningBg(bg3);',
			'try { throw new Error("解析回执时炸了"); } catch (e) { writeHerdrBgTerminal(bg3, finalizeHerdrRun({ outcome: "failed", error: e.message })); }',
			'const t3 = readBgTask(bg3);',
			'ok("回归：收尾抛异常 → status=failed（仍写终态）", t3 && t3.status === "failed");',
			'ok("回归：异常也写进 lastError", !!t3 && String(t3.lastError || "").includes("炸了"));',
			'// ---- ④ 终态写不许冲掉已投标记 / 已有卡片 ----',
			'const bg4 = paneBgId(4);',
			'newRunningBg(bg4);',
			'writeBgTask({ ...readBgTask(bg4), status: "done", delivered: true, resultText: "好看的卡片" });',
			'writeHerdrBgTerminal(bg4, finalizeHerdrRun({ outcome: "timeout" }));',
			'const t4 = readBgTask(bg4);',
			'ok("回归：终态写不会把 delivered:true 冲回 false（防重复投递）", t4 && t4.delivered === true);',
			'ok("回归：终态写不覆盖已有卡片正文", t4 && t4.resultText === "好看的卡片");',
			'// ---- ⑤ waitPaneDone 返回 gone → 必然能算出终态 ----',
			'const pd = join(tmpdir(), "pane-gone-sess");',
			'mkdirSync(pd, { recursive: true });',
			'const pf = join(pd, "20260101-000000-1_sid-gone.jsonl");',
			'writeFileSync(pf, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: receiptText }] } }) + "\\n", "utf8");',
			'const goneRes = await waitPaneDone({ index: 1, paneId: "w9:p1", where: "main" }, pd, "sid-gone", 5000, undefined, true, { read: () => ({ ok: true, text: "" }), alive: () => false });',
			'ok("回归：waitPaneDone 见 pane 已关 + 有正文 → outcome=done", goneRes.outcome === "done");',
			'const bg5 = paneBgId(5);',
			'newRunningBg(bg5);',
			'writeHerdrBgTerminal(bg5, finalizeHerdrRun({ outcome: goneRes.outcome, text: goneRes.text }));',
			'ok("回归：gone 路径必然产生终态（status !== running）", readBgTask(bg5).status === "done");',
			'// ---- ⑥ 采集 pane 一直抛错 → promise 也不许 reject（以前就是静默 reject → 永不 settle）----',
			'const boomKeepAlive = setInterval(() => {}, 50); // sleep() 内部 unref 了，测试里得自己撑着事件循环',
			'const boomRes = await waitPaneDone({ index: 1, paneId: "w9:p2", where: "main" }, pd, "sid-boom", 30000, undefined, true, { read: () => { throw new Error("pane 已关闭"); }, alive: () => true, sampleMs: 20, slowSampleMs: 20 });',
			'ok("回归：采集抛错不 reject，返回 failed + error", boomRes.outcome === "failed" && !!boomRes.error);',
			'ok("回归：采集抛错也归因到日志（便于排查）", boomRes.stallLog.join(" ").includes("pane 已关闭"));',
			'clearInterval(boomKeepAlive);',
			'// ---- ⑦ 兜底计时器到点 → 必然产生终态 ----',
			'const bg7 = paneBgId(7);',
			'newRunningBg(bg7);',
			'let fired = 0;',
			'armHerdrFinalizeGuard(10, () => { fired += 1; writeHerdrBgTerminal(bg7, finalizeHerdrRun({ outcome: "timeout", forced: true })); });',
			'await new Promise((r) => setTimeout(r, 120));',
			'ok("回归：兜底计时器到点 → 回调真的开火", fired === 1);',
			'ok("回归：兜底计时器到点 → .bg status=timeout（不再 running）", readBgTask(bg7).status === "timeout");',
			'ok("回归：兜底计时器 lastError 说明是强制收尾", /强制收尾|兜底/.test(String(readBgTask(bg7).lastError || "")));',
			'// 到点前取消 → 不许开火（正常收尾后不能再补一张 timeout 卡）',
			'let fired2 = 0;',
			'armHerdrFinalizeGuard(30, () => { fired2 += 1; }).clear();',
			'await new Promise((r) => setTimeout(r, 80));',
			'ok("回归：正常收尾后取消计时器 → 不会补写一张假 timeout", fired2 === 0);',
		],
		{ TPROJ: proj, PI_CODING_AGENT_DIR: join(tmp, "agent-pane") },
	) && allOk;

// ---------- 套件 1.6：pane 模式的**完成信号**（收尾误判回归）----------
// 踩过的真 bug：worker 跑完了、git commit 5adc34b 已双推、工作区干净，但回执只写了人话
// （`状态: 完成` / `结论: ...`）、没写 `<result>{...}</result>` → 旧逻辑永远等不到完成信号
// → 判「失败（146s，退出码 1）」+ 把 pane 留着，里面交互式 pi 还停在输入框。
// 这里钉死：回执正文也算完成（但要稳定 2s）；采集抛错不许早早判失败。
bundle("delegate.ts", "delegate-receipt.mjs");
allOk =
	runSuite(
		"delegate：pane 完成信号（回执正文 / 采集抛错）",
		join(tmp, "delegate-receipt.mjs"),
		[
			// ---- ① 纯函数 paneHasReceiptText ----
			'const rcpKeepAlive = setInterval(() => {}, 50); // sleep() 内部 unref 了，测试里得自己撑着事件循环',
			'ok("回执文本：状态: 完成 → 命中", paneHasReceiptText("状态: 完成") === true);',
			'ok("回执文本：状态：卡住（全角冒号）→ 命中", paneHasReceiptText("状态：卡住") === true);',
			'ok("回执文本：状态: 需要信息 → 命中", paneHasReceiptText("状态: 需要信息") === true);',
			'ok("回执文本：结论: xxx → 命中", paneHasReceiptText("结论: README 发版清单已提交并推送双远端") === true);',
			'ok("回执文本：多行回执里的 证据: → 命中", paneHasReceiptText(["干完了", "证据: git commit 5adc34b 已双推", ""].join(String.fromCharCode(10))) === true);',
			'ok("回执文本：状态: 完成中 → 不命中（模型还在写，早判会截正文）", paneHasReceiptText("状态: 完成中") === false);',
			'ok("回执文本：空串 / 全空白 → 不命中", paneHasReceiptText("") === false && paneHasReceiptText("   " + String.fromCharCode(10)) === false);',
			'ok("回执文本：普通正文（没回执形状）→ 不命中", paneHasReceiptText("thinking... 正在处理" + String.fromCharCode(10) + "> ") === false);',
			'ok("回执文本：稳定窗口常量是 800ms", PANE_RECEIPT_STABLE_MS === 800);',
			'ok("回执文本：采集抛错阈值是 12 次 + 采样 800ms", PANE_READ_FAIL_LIMIT === 12 && PANE_SAMPLE_MS === 800);',
			// ---- ② 回执正文 + 稳定窗口 → done（这就是本次修的那条路）----
			'const rcpDir = join(tmpdir(), "receipt-sess-" + Math.random().toString(36).slice(2, 8));',
			'mkdirSync(rcpDir, { recursive: true });',
			'const receiptOnly = ["状态: 完成", "结论: README 发版清单已提交并推送双远端（github + gitee）。", "证据: git commit 5adc34b 已双推"].join(String.fromCharCode(10));',
			'const putSess = (sid, body) => writeFileSync(join(rcpDir, "20260101-000000-1_" + sid + ".jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: body }] } }) + String.fromCharCode(10), "utf8");',
			'putSess("sid-rcp", receiptOnly);',
			'ok("完成信号：回执正文里没有 </result>（这就是当初被误判的那种回执）", !/<\\/result>/.test(receiptOnly) && paneHasReceiptText(receiptOnly));',
			'const rcpStable = await waitPaneDone({ index: 1, paneId: "w9:pr", where: "main" }, rcpDir, "sid-rcp", 20000, undefined, true, { read: () => ({ ok: true, text: "π 输入框" }), alive: () => true, sampleMs: 30, receiptStableMs: 120 });',
			'ok("完成信号：只有人话回执（无 <result>）+ 稳定窗口 → outcome=done（不再超时判失败）", rcpStable.outcome === "done");',
			'ok("完成信号：done 时正文档被带出（卡片不空）", /README 发版清单/.test(rcpStable.text));',
			// ---- ③ 回执文本但还在变（没稳定到窗口）→ 不许判 done ----
			'let rcpN = 0;',
			'const rcpChanging = await waitPaneDone({ index: 1, paneId: "w9:pc", where: "main" }, join(tmpdir(), "no-such-sess-x"), "sid-none", 400, undefined, true, { read: () => { rcpN += 1; return { ok: true, text: ["状态: 完成", "证据: 第" + rcpN + "版"].join(String.fromCharCode(10)) }; }, alive: () => true, sampleMs: 20, receiptStableMs: 120 });',
			'ok("完成信号：回执文本一直在变（<稳定窗口）→ 不判 done", rcpChanging.outcome === "timeout");',
			// ---- ④ 既没 <result> 也没回执 → 继续等（不提前判失败）----
			'const rcpNone = await waitPaneDone({ index: 1, paneId: "w9:pn", where: "main" }, join(tmpdir(), "no-such-sess-y"), "sid-none", 400, undefined, true, { read: () => ({ ok: true, text: "正在执行..." }), alive: () => true, sampleMs: 20, receiptStableMs: 120 });',
			'ok("完成信号：既没 <result> 也没回执 → 继续等（结果是 timeout，不是 failed）", rcpNone.outcome === "timeout");',
			// ---- ⑤ 采集连续抛错 3 次 → 不判失败 ----------
			'putSess("sid-three", receiptOnly);',
			'let threeThrows = 0;',
			'const rcpThree = await waitPaneDone({ index: 1, paneId: "w9:p3", where: "main" }, rcpDir, "sid-three", 20000, undefined, true, { read: () => { threeThrows += 1; if (threeThrows <= 3) throw new Error("pane 读不到"); return { ok: true, text: "π 输入框" }; }, alive: () => true, sampleMs: 20, slowSampleMs: 20, receiptStableMs: 120 });',
			'ok("采集抛错：连续 3 次 → 不判失败（继续采样）", rcpThree.outcome !== "failed" && threeThrows >= 4);',
			'ok("采集抛错：3 次之后读到回执 → 照样判 done", rcpThree.outcome === "done");',
			// ---- ⑥ 采集连续抛错 12 次 → 才放弃（有正文 done / 没正文 failed）----
			'const rcpTwelve = await waitPaneDone({ index: 1, paneId: "w9:p12", where: "main" }, rcpDir, "sid-three", 30000, undefined, true, { read: () => { throw new Error("pane 已关闭"); }, alive: () => true, sampleMs: 5, slowSampleMs: 5 });',
			'ok("采集抛错：12 次才放弃，且能读到正文 → outcome=done", rcpTwelve.outcome === "done" && !!rcpTwelve.error && rcpTwelve.stallLog.length >= 12);',
			'ok("采集抛错：放弃时 error 说明是采集问题（不是任务失败）", /连续抛错 12 次/.test(String(rcpTwelve.error)));',
			'const rcpEmpty = await waitPaneDone({ index: 1, paneId: "w9:p13", where: "main" }, join(tmpdir(), "no-such-sess-z"), "sid-none", 30000, undefined, true, { read: () => { throw new Error("pane 已关闭"); }, alive: () => true, sampleMs: 5, slowSampleMs: 5 });',
			'ok("采集抛错：真读不到任何正文 → 才 failed", rcpEmpty.outcome === "failed" && !!rcpEmpty.error);',
			// ---- ⑦ 失败保留 pane → 先停掉里面的 pi（两次 ctrl+c），标签写「已停」----------
			'const skCalls = [];',
			'let skLabel = "";',
			'const sk = await stopKeptPane("w9:pk", "general", 2, { sendKeys: (p, k) => { skCalls.push(p + "|" + k); return true; }, rename: (p, l) => { skLabel = l; return true; }, read: () => "PS F:\\\\AI\\\\My_Center> ", sleep: async () => {} });',
			'ok("保留 pane：发两次 ctrl+c（第一次只清输入框）", skCalls.length === 2 && skCalls[0] === "w9:pk|ctrl+c" && skCalls[1] === "w9:pk|ctrl+c");',
			'ok("保留 pane：已回到 shell → 不再补 exit", !skCalls.includes("w9:pk|exit") && sk.escalated === false);',
			'ok("保留 pane：标签含「已停」且是 ⏹（用户一眼看出没活进程了）", sk.stopped === true && skLabel.includes("已停") && skLabel.startsWith("⏹") && skLabel.includes("sa:general#2"));',
			'ok("保留 pane：send-keys 抛错也不抛出去，标签照样改", await (async () => { let l2 = ""; const r2 = await stopKeptPane("w9:pk", "x", 1, { sendKeys: () => { throw new Error("herdr 挂了"); }, rename: (p, l) => { l2 = l; return true; }, read: () => "", sleep: async () => {} }); return r2.stopped === false && l2.includes("已停"); })());',
			'clearInterval(rcpKeepAlive);',
		],
		{ TPROJ: proj, PI_CODING_AGENT_DIR: join(tmp, "agent-receipt") },
	) && allOk;

// ---------- 套件 1.7：保留 pane 的处置（停 / 列出 / 关闭 / 回收 / TTL）----------
// 踩过的真 bug：子助理停下来后**关不掉 pane** ——
//   ① 「已停」是假的：只发一次 ctrl+c，而 pi 里第一次 ctrl+c 只清输入框，进程没退；
//   ② ESC 中止只让 waitPaneDone 返回 failed，没停 pane 里的进程；
//   ③ 用户侧零入口：paneClose 只有 run 自己收尾会调，人想关只能自己去关标签；
//   ④ 保留的 pane 永久占槽 → 每个新任务干等 60s。
// 这里钉死：两次 ctrl+c / 跳过自己与主 pane / 回收 / TTL。
bundle("delegate.ts", "delegate-panes.mjs");
allOk =
	runSuite(
		"delegate：保留 pane 的处置（停 / /panes / /pane-close / 回收 / TTL）",
		join(tmp, "delegate-panes.mjs"),
		[
			// ---- ① stopKeptPane：两次 ctrl+c（第一次只清输入框）----
			'const napMs = [];',
			'const kc = [];',
			'const r1 = await stopKeptPane("w2:pA", "general", 1, { sendKeys: (p, k) => { kc.push(k); return true; }, rename: () => true, read: () => "PS C:> ", sleep: async (ms) => { napMs.push(ms); } });',
			'ok("停 pane：真正发的调用序列是 [ctrl+c, ctrl+c]（第一次只清输入框）", JSON.stringify(kc) === JSON.stringify(["ctrl+c", "ctrl+c"]));',
			'ok("停 pane：两下之间等 300ms（可注入假 sleep，不真等）", PANE_STOP_GAP_MS === 300 && napMs.length === 1 && napMs[0] === 300);',
			// ---- ② 第二次之后还在 pi 界面 → 补 exit + return ----
			'const kc2 = [];',
			'const r2 = await stopKeptPane("w2:pB", "db", 2, { sendKeys: (p, k) => { kc2.push(k); return true; }, rename: () => true, read: () => "⏵ 请输入你的指令...", sleep: async () => {} });',
			'ok("停 pane：还在 pi 界面（没回 shell）→ 追加 exit + return 兜底", JSON.stringify(kc2) === JSON.stringify(["ctrl+c", "ctrl+c", "exit", "return"]));',
			'ok("停 pane：补了 exit 才算升级（escalated）", r2.escalated === true);',
			'ok("停 pane：已回 shell 时不乱发 exit", r1.escalated === false && !kc.includes("exit"));',
			// ---- ③ 收尾计划：ESC 中止和超时一样，必须停进程 ----
			'ok("计划：失败/超时 + paneKeepOnError → 停进程+保留", planPaneFinish({ outcome: "failed", keepOnError: true }) === "stop-keep" && planPaneFinish({ outcome: "timeout", keepOnError: true }) === "stop-keep");',
			'ok("计划：ESC 中止（aborted）→ 也是停进程+保留（不是直接撒手）", planPaneFinish({ outcome: "failed", aborted: true, keepOnError: true }) === "stop-keep");',
			'ok("计划：ESC 中止 + 不保留 → 直接关", planPaneFinish({ outcome: "failed", aborted: true, keepOnError: false }) === "close");',
			'ok("计划：成功 / 空回执 → 关", planPaneFinish({ outcome: "done", keepOnError: true }) === "close" && planPaneFinish({ outcome: "empty", keepOnError: true }) === "close");',
			// ---- ④ /pane-close 参数解析 ----
			'ok("/pane-close 空参 → 只关已停/失败", parsePaneCloseArg("").mode === "kept" && parsePaneCloseArg("  ").mode === "kept");',
			'ok("/pane-close all → 全关", parsePaneCloseArg("all").mode === "all" && parsePaneCloseArg("ALL").mode === "all");',
			'ok("/pane-close 2 → 只关第 2 个（#2 也认）", parsePaneCloseArg("2").mode === "index" && parsePaneCloseArg("2").index === 2 && parsePaneCloseArg("#2").index === 2);',
			'ok("/pane-close abc / 0 → 报错提示（不乱关）", parsePaneCloseArg("abc").mode === "bad" && parsePaneCloseArg("0").mode === "bad");',
			// ---- ⑤ /panes 文案 ----
			'ok("pane 状态记号：四种状态看得懂", paneStateText("▶ sa:a#1") === "🟢跑" && paneStateText("⏹ sa:a#1（已停·保留）") === "⏹已停" && paneStateText("❌ sa:a#1（失败·保留）") === "❌失败" && paneStateText("✅ sa:a#1") === "✅跑完");',
			'ok("可回收判定：只有 ⏹ / ❌ 算", paneIsKept("⏹ sa:a#1") && paneIsKept("❌ sa:a#1") && !paneIsKept("▶ sa:a#1") && !paneIsKept("✅ sa:a#1"));',
			'const repRows = buildPaneRows([{ paneId: "w2:p58", label: "▶ sa:general#1" }, { paneId: "w2:p59", label: "⏹ sa:db#1（已停·保留）" }, { paneId: "w2:pG", label: "主会话" }], [{ index: 1, paneId: "w2:p58" }, { index: 2, paneId: "w2:p59" }]);',
			'const rep = formatPaneReport(repRows, "w2:p58", "w2:pG");',
			'ok("/panes：账上的格子按编号列出（不用 sa: 前缀也一样）", rep[0].includes("子助理 pane") && rep[1].includes("#1") && rep[1].includes("🟢跑") && rep[2].includes("#2") && rep[2].includes("⏹已停"));',
			'ok("/panes：写清楚「自己不会被关」+「主 pane 永不动」", rep.join(" ").includes("w2:p58") && rep.join(" ").includes("不会被关") && rep.join(" ").includes("w2:pG") && rep.join(" ").includes("永不动"));',
			'ok("/panes：没有 pane 时说人话", formatPaneReport([], "w2:p58", "w2:pG").join(" ").includes("当前没有子助理 pane"));',
			// ---- ⑥ 关闭：桩（paneClose 记账）+ 账上的槽位 ----
			'let pcCalls = [];',
			'const closeLabel = (id) => ({ "w2:p58": "▶ sa:general#1", "w2:p59": "⏹ sa:db#1（已停·保留）", "w2:p60": "❌ sa:x#1（失败·保留）" })[id] || "";',
			'const closeStub = { mainPaneId: () => "w2:pG", workspaceId: () => "w2", paneList: () => [{ paneId: "w2:pG", label: "主会话" }, ...[...herdrSlots.values()].map((s) => ({ paneId: s.paneId, label: closeLabel(s.paneId) }))], paneSplit: () => undefined, tabCreate: () => undefined, tabClose: () => true, paneClose: (id) => { pcCalls.push(id); return true; } };',
			'const resetSlots = () => { herdrSlots.clear(); herdrExtraTabs.clear(); keptPaneAt.clear(); pcCalls = []; process.env.HERDR_PANE_ID = "w2:pSELF"; setHerdrSlotOps(closeStub); herdrSlots.set(1, { index: 1, paneId: "w2:p58", where: "main" }); herdrSlots.set(2, { index: 2, paneId: "w2:p59", where: "main" }); herdrSlots.set(3, { index: 3, paneId: "w2:p60", where: "main" }); };',
			'resetSlots();',
			'const cKept = closePanesByTarget({ mode: "kept" });',
			'ok("/pane-close 空参：只关 ⏹ 和 ❌ 两个", cKept.closed === 2 && pcCalls.includes("w2:p59") && pcCalls.includes("w2:p60") && !pcCalls.includes("w2:p58"));',
			'ok("/pane-close：关掉后账上也销了", herdrSlots.size === 1 && herdrSlots.get(1) && herdrSlots.get(1).paneId === "w2:p58");',
			// ---- ⑦ 跳过自己（踩过的真事故：助理把自己关了）----
			'resetSlots();',
			'process.env.HERDR_PANE_ID = "w2:p58";',
						'herdrSlots.clear(); herdrSlots.set(1, { index: 1, paneId: "w2:p58", where: "main" }); herdrSlots.set(2, { index: 2, paneId: "w2:p59", where: "main" });',
			'const cSelf = closePanesByTarget({ mode: "all" });',
			'ok("/pane-close：永远跳过自己（HERDR_PANE_ID）", cSelf.closed === 1 && !pcCalls.includes("w2:p58") && cSelf.skippedSelf === 1);',
			// ---- ⑧ 跳过主 pane（纯函数钉死）----
			'const mainRows = [{ index: 1, paneId: "w2:pG", label: "⏹ sa:main#1（已停·保留）" }, { index: 2, paneId: "w2:p59", label: "⏹ sa:db#1（已停·保留）" }];',
			'const selMain = selectPanesToClose(mainRows, { mode: "all" }, "w2:pSELF", "w2:pG");',
			'ok("/pane-close：永远跳过主 pane", selMain.close.length === 1 && selMain.close[0].paneId === "w2:p59" && selMain.skippedMain === 1);',
			// ---- ⑨ all 模式的关闭数量（3 个 sa: 里有 1 个是自己 → 关 2）----
			'resetSlots();',
			'process.env.HERDR_PANE_ID = "w2:p58";',
			'herdrSlots.clear(); herdrSlots.set(1, { index: 1, paneId: "w2:p58", where: "main" }); herdrSlots.set(2, { index: 2, paneId: "w2:p59", where: "main" }); herdrSlots.set(3, { index: 3, paneId: "w2:p60", where: "main" });',
			'const cAll = closePanesByTarget({ mode: "all" });',
			'ok("/pane-close all：3 个 sa: 里有 1 个是自己 → 关 2 个", cAll.closed === 2 && cAll.skippedSelf === 1 && pcCalls.length === 2);',
			// ---- ⑩ 按编号关（#2）----
			'resetSlots();',
			'const cIdx = closePanesByTarget({ mode: "index", index: 2 });',
			'ok("/pane-close 2：只关第 2 格", cIdx.closed === 1 && pcCalls.length === 1 && pcCalls[0] === "w2:p59");',
			// ---- ⑪ 槽位回收：满了 + 有一个 ⏹ → 先关它再分配，不进排队 ----
			'herdrSlots.clear(); herdrExtraTabs.clear(); keptPaneAt.clear(); pcCalls = [];',
			'process.env.HERDR_PANE_ID = "w1:p1";',
			'let splitted = 0;',
			'const reclaimPanes = () => [{ paneId: "w1:p1", label: "主会话" }, ...[...herdrSlots.values()].map((s) => ({ paneId: s.paneId, label: s.paneId === "w1:pK" ? "⏹ sa:db#1（已停·保留）" : "▶ sa:general#1" }))];',
			'setHerdrSlotOps({ mainPaneId: () => "w1:p1", workspaceId: () => "w1", paneList: reclaimPanes, paneSplit: () => { splitted += 1; return "w1:pNEW"; }, tabCreate: () => undefined, tabClose: () => true, paneClose: (id) => { pcCalls.push(id); return true; } });',
			'herdrSlots.set(1, { index: 1, paneId: "w1:pK", where: "main" });',
			'markKept("w1:pK", 1000);',
			'const sleptReclaim = [];',
			'const reclaimed = await allocHerdrSlot("F:/tmp/x", { ui: "split", mainSlots: 1, overflowSlots: 0, splitRatio: 0.5, paneKeepOnError: true }, "split", { now: () => 0, sleep: async (ms) => { sleptReclaim.push(ms); }, waitMs: 60000 });',
			'ok("槽位回收：满了先关最旧的 ⏹ pane，同一个调用里就拿到新槽", !!reclaimed && reclaimed.paneId === "w1:pNEW" && pcCalls.includes("w1:pK"));',
			'ok("槽位回收：没进排队（一次也没睡/轮询）", sleptReclaim.length === 0 && splitted === 1);',
			// ---- ⑫ 回收绝不关自己 / 主 pane ----
			'herdrSlots.clear(); herdrExtraTabs.clear(); keptPaneAt.clear(); pcCalls = [];',
			'process.env.HERDR_PANE_ID = "w1:pSELF";',
			'setHerdrSlotOps({ mainPaneId: () => "w1:pSELF", workspaceId: () => "w1", paneList: () => [{ paneId: "w1:pSELF", label: "⏹ sa:self#1（已停·保留）" }], paneSplit: () => undefined, tabCreate: () => undefined, tabClose: () => true, paneClose: (id) => { pcCalls.push(id); return true; } });',
			'herdrSlots.set(1, { index: 1, paneId: "w1:pSELF", where: "main" });',
			'ok("槽位回收：自己和主 pane 永不关（没槽就老实排队）", reclaimOneKeptPane() === false && pcCalls.length === 0);',
			// ---- ⑬ TTL ----
			'keptPaneAt.clear(); pcCalls = [];',
			'process.env.HERDR_PANE_ID = "w9:pSELF";',
			'setHerdrSlotOps({ mainPaneId: () => "w9:pSELF", workspaceId: () => "w9", paneList: () => [], paneSplit: () => undefined, tabCreate: () => undefined, tabClose: () => true, paneClose: (id) => { pcCalls.push(id); return true; } });',
			'ok("TTL：默认 10 分钟，常量也是 10", PANE_KEEP_MINUTES_DEFAULT === 10 && readPaneKeepMinutes() === 10);',
			'ok("TTL 纯函数：不到 10 分钟 / 到了 / 0=永不关", paneKeepExpired(1000, 1000 + 9 * 60000, 10) === false && paneKeepExpired(1000, 1000 + 11 * 60000, 10) === true && paneKeepExpired(0, 99999999, 0) === false);',
			'markKept("w9:pT", 1000000);',
			'ok("TTL：未到点 → 不关", sweepKeptPaneTtl(1000000 + 9 * 60000, 10) === 0 && pcCalls.length === 0 && keptPaneAt.has("w9:pT"));',
			'ok("TTL：超过 10 分钟 → 关掉并销账", sweepKeptPaneTtl(1000000 + 11 * 60000, 10) === 1 && pcCalls.includes("w9:pT") && !keptPaneAt.has("w9:pT"));',
			'markKept("w9:pU", 0);',
			'ok("TTL：paneKeepMinutes=0 → 永不自动关", sweepKeptPaneTtl(Date.now(), 0) === 0 && !pcCalls.includes("w9:pU") && keptPaneAt.has("w9:pU"));',
			'keptPaneAt.clear(); herdrSlots.clear(); herdrExtraTabs.clear(); setHerdrSlotOps(undefined);',
		],
		{ TPROJ: proj, PI_CODING_AGENT_DIR: join(tmp, "agent-panes") },
	) && allOk;

// ---------- 套件 1.8：文案不许再骗人（「按回车关闭」从没实现过）----------
{
	const dSrc = readFileSync(join(ext, "delegate.ts"), "utf8");
	const sSrc = readFileSync(join(ext, "superagent.ts"), "utf8");
	const noEnter = !dSrc.includes("回车关闭") && !sSrc.includes("回车关闭");
	const pointsToCmd = noEnter && dSrc.includes("用 /pane-close 关闭") && /pane-close/.test(sSrc);
	if (pointsToCmd) {
		console.log("PASS  文案：delegate/superagent 不再说「按回车关闭」，改成指向 /pane-close");
	} else {
		allOk = false;
		console.log("FAIL  文案：仍有「回车关闭」或没指向 /pane-close → " + JSON.stringify({ noEnter }));
	}
}

// ---------- 套件 1.4：后台任务记账（合并写 = 不重复投递的地基）----------
// 踩过的真 bug：writeBgTask 整对象覆盖写，后写的旧快照把 delivered:true 冲回 false
// → 每次 /reload 都把已经投过的卡片再投一遍。合并规则必须钉死。
bundle("bg-store.ts", "bg-store.mjs");
allOk =
	runSuite(
		"bg-store：合并写单向字段 / 过期回收判定",
		join(tmp, "bg-store.mjs"),
		[
			'const base = { id: "x-1", key: "k", name: "n", task: "t", sessionId: "s", startedAt: 1000, status: "failed" };',
			'const oldFull = { ...base, delivered: true, attempts: 4, firstFailAt: 2000, lastAttemptAt: 9000, lastError: "旧错误", undelivered: true, resultText: "旧卡", finishedAt: 5000 };',
			'// 1) delivered 单向：true 不许回退成 false（这就是重复投递的根因）',
			'const m1 = mergeBgTask(oldFull, { ...base, delivered: false });',
			'ok("合并：旧 delivered:true + 新 delivered:false → 仍为 true", m1.delivered === true);',
			'ok("合并：首次写（无旧值）原样使用新值", JSON.stringify(mergeBgTask(undefined, { ...base, delivered: false })) === JSON.stringify({ ...base, delivered: false }));',
			'ok("合并：首次写无旧值时不塞 attempts/lastError 等空字段", !("attempts" in mergeBgTask(undefined, base)) && !("lastError" in mergeBgTask(undefined, base)));',
			'// 2) attempts 取 max（旧 4 新 2 → 4）',
			'ok("合并：attempts 取 max（旧4 新2 → 4）", mergeBgTask(oldFull, { ...base, attempts: 2 }).attempts === 4);',
			'ok("合并：attempts 取 max（旧4 新7 → 7）", mergeBgTask(oldFull, { ...base, attempts: 7 }).attempts === 7);',
			'// 3) 时间戳：firstFailAt 保留最早、lastAttemptAt 取最新',
			'const m3 = mergeBgTask(oldFull, { ...base, firstFailAt: 3000, lastAttemptAt: 12000 });',
			'ok("合并：firstFailAt 保留最早（旧2000 新3000 → 2000）", m3.firstFailAt === 2000);',
			'ok("合并：firstFailAt 新更早时取新的（旧3000 新1000 → 1000）", mergeBgTask({ ...base, firstFailAt: 3000 }, { ...base, firstFailAt: 1000 }).firstFailAt === 1000);',
			'ok("合并：lastAttemptAt 取最新（旧9000 新12000 → 12000）", m3.lastAttemptAt === 12000);',
			'ok("合并：lastAttemptAt 新更旧时保留新的（旧9000 新100 → 9000）", mergeBgTask(oldFull, { ...base, lastAttemptAt: 100 }).lastAttemptAt === 9000);',
			'// 4) status / resultText / finishedAt 允许覆盖（新值优先）',
			'const m4 = mergeBgTask(oldFull, { ...base, status: "done", resultText: "新卡", finishedAt: 20000 });',
			'ok("合并：status 用新值（failed → done）", m4.status === "done");',
			'ok("合并：resultText 用新值", m4.resultText === "新卡");',
			'ok("合并：finishedAt 用新值", m4.finishedAt === 20000);',
			'// 5) undelivered 不倒退；显式 reset 才清',
			'ok("合并：旧 undelivered:true + 新 false → 仍为 true（不倒退）", mergeBgTask(oldFull, { ...base, undelivered: false }).undelivered === true);',
			'const m5 = mergeBgTask(oldFull, { ...base, reset: ["undelivered", "attempts", "firstFailAt", "lastAttemptAt"] });',
			'ok("合并：reset 显式清除 undelivered/attempts/firstFailAt/lastAttemptAt", m5.undelivered === false && m5.attempts === 0 && !("firstFailAt" in m5) && !("lastAttemptAt" in m5));',
			'// 6) lastError：新非空覆盖；显式 undefined 清掉；不给就留旧的',
			'ok("合并：lastError 取新非空值", mergeBgTask(oldFull, { ...base, lastError: "新错误" }).lastError === "新错误");',
			'ok("合并：lastError 显式 undefined 被清掉（投递成功后的写法）", !("lastError" in mergeBgTask(oldFull, { ...base, lastError: undefined })));',
			'ok("合并：lastError 没给就保留旧的（别丢排查线索）", mergeBgTask(oldFull, { ...base, status: "timeout" }).lastError === "旧错误");',
			'// 7) 纯函数：不改入参',
			'ok("合并：不改动入参对象", oldFull.delivered === true && oldFull.attempts === 4 && oldFull.lastError === "旧错误");',
			'// 8) 过期回收判定：delivered+24h / 任何记录 7 天 / running 绝不删',
			'const now = 1_000_000_000_000;',
			'const H = 3600_000, D = 24 * H;',
			'const mkT = (o) => ({ id: "p", key: "k", name: "n", task: "t", sessionId: "s", startedAt: now, status: "failed", ...o });',
			'ok("回收：delivered + 3 天前 → 删", bgPruneReason(mkT({ delivered: true, finishedAt: now - 3 * D }), now) === "delivered");',
			'ok("回收：delivered + 1 小时前 → 留", bgPruneReason(mkT({ delivered: true, finishedAt: now - 1 * H }), now) === undefined);',
			'ok("回收：running 哪怕 30 天前也绝不删", bgPruneReason(mkT({ status: "running", startedAt: now - 30 * D, finishedAt: now - 30 * D }), now) === undefined);',
			'ok("回收：没投出去的超 7 天 → 删（兜底）", bgPruneReason(mkT({ delivered: false, startedAt: now - 8 * D }), now) === "expired");',
			'ok("回收：没投出去的 3 天前 → 留（还能手动重投）", bgPruneReason(mkT({ delivered: false, startedAt: now - 3 * D }), now) === undefined);',
			'// 9) 自动投递闸门：太老 / 试太多次 → 不自动投（这就是「每次 reload 老卡重投」的根治）',
			'const M = 60_000;',
			'ok("常量：自动投递窗口 10 分钟、最多自动试 3 次", AUTO_DELIVER_WINDOW_MS === 600_000 && AUTO_DELIVER_MAX_ATTEMPTS === 3);',
			'ok("自动投递：finishedAt 15 分钟前 → 不投（old）", autoDeliverSkipReason(mkT({ finishedAt: now - 15 * M }), now) === "old");',
			'ok("自动投递：finishedAt 5 分钟前 → 投（undefined）", autoDeliverSkipReason(mkT({ finishedAt: now - 5 * M }), now) === undefined);',
			'ok("自动投递：没有 finishedAt 时按 startedAt 算（startedAt 6 分钟前 → 投）", autoDeliverSkipReason(mkT({ startedAt: now - 6 * M }), now) === undefined);',
			'ok("自动投递：startedAt 30 分钟前且没 finishedAt → 不投（old）", autoDeliverSkipReason(mkT({ startedAt: now - 30 * M }), now) === "old");',
			'ok("自动投递：attempts=3（刚结束）→ 不投（attempts）", autoDeliverSkipReason(mkT({ finishedAt: now - 1000, attempts: 3 }), now) === "attempts");',
			'ok("自动投递：attempts=4（超过上限）→ 不投", autoDeliverSkipReason(mkT({ finishedAt: now - 1000, attempts: 4 }), now) === "attempts");',
			'ok("自动投递：attempts=2 且刚结束 → 还投", autoDeliverSkipReason(mkT({ finishedAt: now - 1000, attempts: 2 }), now) === undefined);',
			'ok("自动投递：完全没有 finishedAt/startedAt 的老记录 → 按太老处理（old）", autoDeliverSkipReason({ id: "z", key: "k", name: "n", task: "t", sessionId: "s", status: "failed" }, now) === "old");',
			'const pure = mkT({ finishedAt: now - 15 * M, attempts: 2 });',
			'const pureSnap = JSON.stringify(pure);',
			'autoDeliverSkipReason(pure, now);',
			'ok("自动投递：判据是纯函数（不改记录）", JSON.stringify(pure) === pureSnap);',
			'ok("自动投递：被跳过 ≠ 被回收（老记录仍在，可手动补投）", bgPruneReason(mkT({ finishedAt: now - 15 * M, delivered: false }), now) === undefined);',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-bgstore") },
	) && allOk;

// ---------- 套件 1.45：真机验证回收（临时目录，绝不碰真实 .bg）----------
// 造 3 条：delivered+3天前（该删）/ running（绝不删）/ delivered+1小时前（该留）
bundle("delegate.ts", "delegate-bg.mjs");
allOk =
	runSuite(
		"delegate：回收逻辑（临时目录 / running 不动 / 保留鲜活小票）",
		join(tmp, "delegate-bg.mjs"),
		[
			'const H = 3600_000, D = 24 * H, now = Date.now();',
			'const bgDir = join(process.env.PI_CODING_AGENT_DIR, "bg-prune-test");',
			'mkdirSync(bgDir, { recursive: true });',
			'const mkT = (o) => ({ id: "p", key: "k", name: "n", task: "t", sessionId: "s", startedAt: now, status: "failed", ...o });',
			'const w = (t) => writeFileSync(join(bgDir, t.id + ".json"), JSON.stringify(t), "utf8");',
			'w(mkT({ id: "p-delivered-old", delivered: true, startedAt: now - 3 * D, finishedAt: now - 3 * D }));',
			'w(mkT({ id: "p-running", status: "running", startedAt: now - 3 * D }));',
			'w(mkT({ id: "p-delivered-recent", delivered: true, startedAt: now - 1 * H, finishedAt: now - 1 * H }));',
			'const removed = reapDeliveredBgTasks(now, bgDir);',
			'const leftIds = readdirSync(bgDir).sort().join(",");',
			'ok("回收（临时目录）：删掉的条数 = 1", removed === 1);',
			'ok("回收（临时目录）：只剩 running 和 1 小时前那条", leftIds === "p-delivered-recent.json,p-running.json");',
			'ok("回收：测试用的是临时目录，不是真实 .bg（不碰真文件）", bgDir !== bgRoot() && bgDir.startsWith(process.env.PI_CODING_AGENT_DIR));',
			'rmSync(bgDir, { recursive: true, force: true });',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-bgstore") },
	) && allOk;

// ---------- 套件 1.46：自动投递闸门（真机跑 pollBgTasks，临时 .bg 目录）----------
// 现象：`/reload` 会重新 load 扩展 → armBgTimer 又挂 1 秒轮询 → 上次没投成的老卡被再投一遍。
// 这里真跑一次 pollBgTasks，确认「只投最近的那条 + 被跳过的记录一条都不少」。
// ⚠️ 重新打一份 bundle：runSuite 是往同一个文件尾部追代码，复用上套的 bundle 会重复声明 const。
bundle("delegate.ts", "delegate-auto.mjs");
allOk =
	runSuite(
		"delegate：自动投递闸门（太老 / 试够次数 → 不投、不删）",
		join(tmp, "delegate-auto.mjs"),
		[
			'const MIN = 60_000, t0 = Date.now();',
			'const bgDir = bgRoot(); // = <临时 agent dir>/assistant-sessions/.bg',
			'const mk = (o) => ({ id: "a", key: "k", name: "n", task: "t", sessionId: "s", startedAt: t0, status: "failed", ...o });',
			'const w = (t) => writeFileSync(join(bgDir, t.id + ".json"), JSON.stringify(t), "utf8");',
			'const ids = () => readdirSync(bgDir).filter((f) => f.endsWith(".json")).sort().join(",");',
			'w(mk({ id: "a-recent-5m", finishedAt: t0 - 5 * MIN, resultText: "新鲜结果" }));',
			'w(mk({ id: "b-old-15m", finishedAt: t0 - 15 * MIN, resultText: "老结果" }));',
			'w(mk({ id: "c-tried-3", finishedAt: t0 - 1000, attempts: 3, resultText: "试够次数了" }));',
			'const sent = [];',
			'apiRef = { sendUserMessage: async (s) => { sent.push(s); } };',
			'bgCtx = { isIdle: () => true };',
			'const before = ids();',
			'await pollBgTasks();',
			'ok("真机：3 条里只投了 1 条（就那条 5 分钟前的）", sent.length === 1);',
			'ok("真机：投的确实是 5 分钟前那条", sent.length === 1 && sent[0].includes("新鲜结果"));',
			'ok("真机：5 分钟前那条落盘 delivered:true", readBgTask("a-recent-5m").delivered === true);',
			'ok("真机：15 分钟前那条没投（delivered 仍非 true）", readBgTask("b-old-15m").delivered !== true);',
			'ok("真机：attempts=3 那条没投（delivered 仍非 true）", readBgTask("c-tried-3").delivered !== true);',
			'ok("真机：被跳过的记录不被删（3 个 .json 一个不少）", ids() === before && ids().split(",").length === 3);',
			'ok("真机：被跳过的记录 attempts 没被加（不算一次尝试）", readBgTask("b-old-15m").attempts === undefined && readBgTask("c-tried-3").attempts === 3);',
			'// 第二轮：投递必然失败 → 必须写 firstFailAt（缺了它「多久没发出去」永远算不出来）',
			'apiRef = { sendUserMessage: async () => { throw new Error("主会话忙"); } };',
			'w(mk({ id: "d-will-fail", finishedAt: Date.now() - MIN, resultText: "会失败" }));',
			'await pollBgTasks();',
			'const failedRec = readBgTask("d-will-fail");',
			'ok("真机：投递失败 → firstFailAt 被写入", typeof failedRec.firstFailAt === "number" && failedRec.firstFailAt > 0);',
			'ok("真机：投递失败 → attempts=1 且 lastError 记下原因", failedRec.attempts === 1 && /主会话忙/.test(String(failedRec.lastError)));',
			'ok("真机：投递失败 → 不标 delivered", failedRec.delivered !== true);',
			'ok("真机：本轮没投老卡（sent 只有 1 条）", sent.length === 1);',
			'// 手动 `/agents bg redeliver`：用户自己拍板要补 → 绕过「太老不自动投」的闸门（只免一次）',
			'apiRef = { sendUserMessage: async (s) => { sent.push(s); } };',
			'forcedDeliver.add("b-old-15m");',
			'await pollBgTasks();',
			'ok("真机：手动 redeliver → 15 分钟前那条也能投", readBgTask("b-old-15m").delivered === true && sent.length === 2);',
			'ok("真机：手动意图只免一次（forcedDeliver 已划掉）", !forcedDeliver.has("b-old-15m"));',
			'ok("真机：手动那一轮没顺带把 attempts=3 那条也投出去", readBgTask("c-tried-3").delivered !== true && sent.length === 2);',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-autopoll") },
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
			"const q = newJob({ key: 'k', name: 'n', task: 't', sessionId: 'q', status: 'queued' }); addJob(q);",
			`ok("排队中的小票：保鲜期不会摘掉它（queued 也是在活）", pruneFinishedJobs(Date.now() + 10 * 60 * 1000) === 0 && liveJobs().some((j) => j.status === 'queued'));`,
			`ok("queued 渲染成「⏳ 排队中」而不是空白", plainLines(renderJob(q, { width: 80, now: Date.now() }))[0].includes("⏳") && plainLines(renderJob(q, { width: 80, now: Date.now() }))[0].includes("排队中"));`,
			"ok('beginRun 也保留排队中的', (beginRun(), liveJobs().some((j) => j.status === 'queued')));",
			"clearJobs();",
			`ok("clearJobs 全清", liveJobs().length === 0);`,
			"// ---- pane 卡片（分屏一行）补「最近一个工具名」----",
			`const mkPane = (withTool) => {
				const j = newJob({ key: "general", name: "general", task: "改 README 版式", sessionId: "s1", startedAt: 1_000_000 });
				j.uiMode = "split";
				j.paneId = "w2:pQ";
				j.slotIndex = 1;
				if (withTool) j.tools.push({ id: "t1", name: "bash", brief: "npm test", phase: "running", startedAt: 1_000_000 });
				return j;
			};`,
			`const paneTxt = (j, width) => plainLines(renderJob(j, { width, now: 1_012_000 })).join("\\n");`,
			`const pj = mkPane(true);`,
			`ok("pane 卡片：时间后面追加最近一个工具名", /12s · bash/.test(paneTxt(pj, 100)));`,
			`ok("pane 卡片：工具名在时间后面、去向前面（顺序对）", (() => { const s = paneTxt(pj, 100); return s.indexOf("12s") < s.indexOf("bash") && s.indexOf("bash") < s.indexOf("pane w2:pQ"); })());`,
			`ok("pane 卡片：宽度 30 仍保留工具名（先砍摘要，不砍工具名）", paneTxt(pj, 30).includes("bash"));`,
			`ok("pane 卡片：宽度 30 时先砍掉任务摘要", !paneTxt(pj, 30).includes("改 README"));`,
			`ok("pane 卡片：宽裕时任务摘要照旧", paneTxt(pj, 100).includes("改 README 版式"));`,
			`const noToolTxt = paneTxt(mkPane(false), 100);`,
			`ok("pane 卡片：没有工具就不加分隔符（不出现 · bash）", !noToolTxt.includes("· bash") && !noToolTxt.includes("·"));`,
			`ok("pane 卡片：没有工具时这一行还是完整的（时间 + 去向）", noToolTxt.includes("12s") && noToolTxt.includes("pane w2:pQ"));`,
			`// ---- panel 卡片：标一个 🖥 panel（分屏卡片行尾已有 → pane xxx，不重复标）----`,
			`const panelJob = newJob({ key: "general", name: "general", task: "改 README 版式", sessionId: "p1" });`,
			`const panelFirst = plainLines(renderJob(panelJob, { width: 80, now: Date.now() }))[0];`,
			`ok("panel 卡片：头部带 🖥 panel（一眼分清在面板里看）", panelFirst.includes("🖥 panel"));`,
			`const panelDoneJob = newJob({ key: "general", name: "general", task: "改 README 版式", sessionId: "p3" }); markEnd(panelDoneJob, "done");`,
			`ok("panel 卡片：结束态（✅ 完成）也标 🖥 panel", plainLines(renderJob(panelDoneJob, { width: 80, now: Date.now() }))[0].includes("🖥 panel"));`,
			`let __narrowOk = true; let __narrowTxt = "";`,
			`try { __narrowTxt = plainLines(renderJob(panelJob, { width: 30, now: Date.now() })).join("\\n"); } catch { __narrowOk = false; }`,
			`ok("panel 卡片：宽 30 不抛错且内容非空", __narrowOk && __narrowTxt.trim().length > 0);`,
			`ok("panel 卡片：宽 30 时任务摘要仍在（省标记可以，摘要不许丢）", __narrowOk && __narrowTxt.includes("改 README 版式"));`,
			`// ---- 降级原因（note）照旧显示，别被新标记挤掉 ----`,
			`const panelNoteJob = newJob({ key: "general", name: "general", task: "改 README 版式", sessionId: "p2" });`,
			`panelNoteJob.note = "Herdr 不可用（pane list 为空）→ 面板模式";`,
			`const panelNoteTxt = plainLines(renderJob(panelNoteJob, { width: 80, now: Date.now() })).join("\\n");`,
			`ok("panel 卡片：有 note（降级原因）时照旧显示", panelNoteTxt.includes("Herdr 不可用") && panelNoteTxt.includes("🖥 panel"));`,
			`let __noteNarrowOk = true;`,
			`try { __noteNarrowOk = plainLines(renderJob(panelNoteJob, { width: 30, now: Date.now() })).join("\\n").includes("Herdr"); } catch { __noteNarrowOk = false; }`,
			`ok("panel 卡片：宽 30 + note 不抛错，note 仍显示", __noteNarrowOk);`,
			`ok("pane 卡片：不额外标 🖥（行尾 → pane 已足够）", !paneTxt(pj, 80).includes("🖥"));`,
			`clearJobs();`,
		],
		{},
	) && allOk;

// ---------- 套件：herdr（分屏封装 / 命名 / UI 模式 / 槽位） ----------
bundle("herdr.ts", "herdr.mjs");
allOk =
	runSuite(
		"herdr：命名 / UI 模式解析 / JSON 容错 / 槽位规划",
		join(tmp, "herdr.mjs"),
		[
			'ok("paneLabel run", paneLabel("run", "general", 1) === "▶ sa:general#1");',
			'ok("paneLabel ok", paneLabel("ok", "db", 2) === "✅ sa:db#2");',
			'ok("paneLabel err 写「失败·保留」（不再骗人「按回车关闭」）", paneLabel("err", "db", 3) === "❌ sa:db#3（失败·保留）");',
			'ok("paneLabel stopped 写「已停·保留」", paneLabel("stopped", "db", 3) === "⏹ sa:db#3（已停·保留）");',
			'ok("paneLabel err/stopped 都不提「回车关闭」", !paneLabel("err", "db", 3).includes("回车关闭") && !paneLabel("stopped", "db", 3).includes("回车关闭"));',
			'ok("paneLabel err/stopped 都写「保留」（不模拟回车也能看懂）", paneLabel("err", "db", 3).includes("保留") && paneLabel("stopped", "db", 3).includes("保留"));',
			'ok("paneLabel stalled 标出「卡死已降级」", paneLabel("stalled", "x", 1) === "❌ sa:x#1（卡死已降级）");',
			'ok("paneLabel 三种状态都不同（不会看混）", new Set([paneLabel("run", "a", 1), paneLabel("ok", "a", 1), paneLabel("err", "a", 1), paneLabel("stalled", "a", 1)]).size === 4);',
			'ok("paneLabel 名字空时兜底", paneLabel("run", "", 1) === "▶ sa:worker#1");',
			'ok("tabLabel", tabLabel(2) === "sa:extra#2");',
			'ok("默认 UI_DEFAULTS.ui === auto", UI_DEFAULTS.ui === "auto");',
			'ok("ui 缺省（无配置）= auto + herdr → split", resolveUiMode(undefined, 1, true) === "split");',
			'ok("ui 缺省（无配置）+ 3 个并发 → tab（超过 mainSlots=2）", resolveUiMode(undefined, 3, true) === "tab");',
			'ok("ui 缺省 + 没 herdr → 降级 panel", resolveUiMode(undefined, 1, false) === "panel");',
			'ok("ui 缺省（老配置只剩 mainSlots）也是 auto", resolveUiMode({ mainSlots: 2 }, 5, true) === "tab");',
			'ok("显式 auto + 没 herdr → panel", resolveUiMode({ ui: "auto" }, 1, false) === "panel");',
			'ok("显式 auto + 1 个并发 + herdrOk → split", resolveUiMode({ ui: "auto", mainSlots: 2 }, 1, true) === "split");',
			'ok("auto + 2 个 → split", resolveUiMode({ ui: "auto", mainSlots: 2 }, 2, true) === "split");',
			'ok("auto + 3 个 → tab", resolveUiMode({ ui: "auto", mainSlots: 2 }, 3, true) === "tab");',
			'ok("auto + 3 个但 herdr 不可用 → panel", resolveUiMode({ ui: "auto" }, 3, false) === "panel");',
			'ok("显式 split 但 herdrOk=false → 降级 panel", resolveUiMode({ ui: "split" }, 1, false) === "panel");',
			'ok("显式 split + herdrOk=true → split", resolveUiMode({ ui: "split" }, 9, true) === "split");',
			'ok("panel 不依赖 herdr", resolveUiMode({ ui: "panel" }, 1, true) === "panel");',
			'ok("认不出来的 ui → panel（只有显式 auto 才自动）", resolveUiMode({ ui: "xxx" }, 1, true) === "panel");',
			'const wrapped = parseJsonLoose(JSON.stringify({ id: "cli:pane:list", result: { panes: [{ pane_id: "w2:p1" }] }, type: "pane_list" }));',
			'ok("容错：包一层 result 能拆开", JSON.stringify(unwrapResult(wrapped).panes) === JSON.stringify([{ pane_id: "w2:p1" }]));',
			'ok("容错：裸对象直接用", JSON.stringify(unwrapResult(parseJsonLoose(JSON.stringify({ panes: [] }))).panes) === "[]");',
			'ok("容错：非法 JSON → undefined（不抛）", parseJsonLoose("这不是 JSON") === undefined);',
			'ok("容错：空串 → undefined", parseJsonLoose("   ") === undefined);',
			'ok("容错：前面混日志也能捞到最后一行", JSON.stringify(parseJsonLoose("warn: xxx\\n{\\"a\\":1}")) === JSON.stringify({ a: 1 }));',
			'const cfg = { mainSlots: 2, overflowSlots: 4, splitRatio: 0.6 };',
			'const s1 = planSlot(1, cfg), s2 = planSlot(2, cfg), s3 = planSlot(3, cfg), s4 = planSlot(4, cfg), s5 = planSlot(5, cfg), s6 = planSlot(6, cfg), s7 = planSlot(7, cfg);',
			'ok("第 1 个：主窗口右边切", s1.where === "main" && s1.split === "right" && s1.anchor === "root" && s1.ratio === 0.6);',
			'ok("第 2 个：主窗口在 #1 下面切", s2.where === "main" && s2.split === "down" && s2.anchor === 1 && s2.ratio === 0.5);',
			'ok("第 3 个：溢出到 tab 自带 pane", s3.where === "overflow" && s3.tab === 1 && s3.split === undefined);',
			'ok("第 4 个：3 的右边", s4.where === "overflow" && s4.split === "right" && s4.anchor === 3);',
			'ok("第 5 个：3 的下面", s5.where === "overflow" && s5.split === "down" && s5.anchor === 3);',
			'ok("第 6 个：4 的下面（第一个溢出 tab 的 2×2 满了）", s6.where === "overflow" && s6.tab === 1 && s6.split === "down" && s6.anchor === 4);',
			'ok("第 7 个：进 sa:extra#2 的第一格（不再排队降级）", s7.where === "overflow" && s7.tab === 2 && s7.split === undefined);',
			'const s8 = planSlot(8, cfg);',
			'ok("第 8 个：sa:extra#2 第一格右边", s8.where === "overflow" && s8.tab === 2 && s8.split === "right" && s8.anchor === 7);',
			'ok("第 9/10 个：sa:extra#2 的下/右下", planSlot(9, cfg).split === "down" && planSlot(9, cfg).anchor === 7 && planSlot(10, cfg).split === "down" && planSlot(10, cfg).anchor === 8);',
			'ok("第 11 个：进 sa:extra#3", planSlot(11, cfg).tab === 3 && planSlot(11, cfg).split === undefined);',
			'ok("tab 首格编号：tab1=3 / tab2=7 / tab3=11", tabBaseIndex(1, cfg) === 3 && tabBaseIndex(2, cfg) === 7 && tabBaseIndex(3, cfg) === 11);',
			'ok("槽位表：overflowSlots=0 → 主窗口满了才排队", planSlot(3, { mainSlots: 2, overflowSlots: 0 }).where === "queue");',
			'ok("容量 = 2 + 4 = 6（只是第一屏，不再当总上限）", slotCapacity(cfg) === 6 && slotCapacity({ mainSlots: 2, overflowSlots: 0 }) === 2);',
			'const c0 = readUiConfig();',
			'ok("配置：没写就是 auto + 2 + 4 + 0.6", c0.ui === "auto" && c0.mainSlots === 2 && c0.overflowSlots === 4 && c0.splitRatio === 0.6 && c0.paneKeepOnError === true);',
			'// 直接写配置文件（bundle 里没导入 patchExtCfg）',
			'const cfgFile = join(getAgentDir(), "ai-extensions.json");',
			'mkdirSync(getAgentDir(), { recursive: true });',
			'writeFileSync(cfgFile, JSON.stringify({ superagent: { ui: "split", mainSlots: 9, overflowSlots: -3, splitRatio: 5, paneKeepOnError: false } }), "utf8");',
			'const c1 = readUiConfig();',
			'ok("配置：能读出来", c1.ui === "split" && c1.paneKeepOnError === false);',
			'ok("配置：越界值被夹住", c1.mainSlots === 2 && c1.overflowSlots === 0 && c1.splitRatio === 0.95);',
			'writeFileSync(cfgFile, JSON.stringify({ superagent: { ui: "胡说" } }), "utf8");',
			'ok("配置：非法 ui 回落默认值 auto", readUiConfig().ui === "auto");',
			'writeFileSync(cfgFile, JSON.stringify({ superagent: { enabled: false, ui: "auto" } }), "utf8");',
			'ok("superagent.enabled=false → 强制 panel（连显式 auto 也不开分屏）", readUiConfig().ui === "panel");',
			'writeFileSync(cfgFile, JSON.stringify({ superagent: { enabled: false, ui: "split" } }), "utf8");',
			'ok("superagent.enabled=false → 显式 split 也压回 panel", readUiConfig().ui === "panel");',
			// 环境变量强制覆写（PI_SA_UI）：压测/脚本逃生口，优先级高于配置文件。
			'writeFileSync(cfgFile, JSON.stringify({ superagent: { ui: "auto" } }), "utf8");',
			'const savedEnv = process.env.PI_SA_UI;',
			'try {',
			'  process.env.PI_SA_UI = "panel";',
			'  ok("PI_SA_UI=panel → 即使配置写 auto 也是 panel", readUiConfig().ui === "panel");',
			'  process.env.PI_SA_UI = "split";',
			'  ok("PI_SA_UI=split → split", readUiConfig().ui === "split");',
			'  process.env.PI_SA_UI = "  TAB  ";',
			'  ok("PI_SA_UI 宽松解析：首尾空格 + 大写也认", readUiConfig().ui === "tab");',
			'  process.env.PI_SA_UI = "bogus";',
			'  ok("PI_SA_UI=bogus → 按原配置算（不被污染）", readUiConfig().ui === "auto");',
			'  process.env.PI_SA_UI = "auto";',
			'  ok("PI_SA_UI=auto → auto（显式钉回自动判定）", readUiConfig().ui === "auto");',
			'} finally {',
			'  if (savedEnv === undefined) delete process.env.PI_SA_UI; else process.env.PI_SA_UI = savedEnv;',
			'}',
			// 全局关（enabled=false）时环境变量也不能绕过：仍然 panel。
			'writeFileSync(cfgFile, JSON.stringify({ superagent: { enabled: false, ui: "auto" } }), "utf8");',
			'const savedEnv2 = process.env.PI_SA_UI;',
			'try {',
			'  process.env.PI_SA_UI = "split";',
			'  ok("enabled=false + PI_SA_UI=split → 仍然 panel（全局关不可绕过）", readUiConfig().ui === "panel");',
			'} finally {',
			'  if (savedEnv2 === undefined) delete process.env.PI_SA_UI; else process.env.PI_SA_UI = savedEnv2;',
			'}',
			'writeFileSync(cfgFile, JSON.stringify({ superagent: { enabled: true, ui: "auto" } }), "utf8");',
			'const savedEnv3 = process.env.PI_SA_UI;',
			'try {',
			'  delete process.env.PI_SA_UI;',
			'  ok("不设 PI_SA_UI + 配置 enabled:true/auto → auto", readUiConfig().ui === "auto");',
			'} finally {',
			'  if (savedEnv3 !== undefined) process.env.PI_SA_UI = savedEnv3;',
			'}',
			'writeFileSync(cfgFile, JSON.stringify({ superagent: { enabled: false } }), "utf8");',
			'const savedEnv4 = process.env.PI_SA_UI;',
			'try {',
			'  delete process.env.PI_SA_UI;',
			'  ok("不设 PI_SA_UI 且配置 enabled:false → panel", readUiConfig().ui === "panel");',
			'} finally {',
			'  if (savedEnv4 !== undefined) process.env.PI_SA_UI = savedEnv4;',
			'}',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-herdr") },
	) && allOk;

// ---------- 套件：Herdr 降级可见（探测放宽 / 带原因 / 坏一次就不反复试）----------
// 踩过的痛点：`herdrAvailable()` 精确判 `TERM_PROGRAM === "herdr"`，别人（Windows Terminal /
// VS Code / tmux / SSH）一律 false，而 delegate 静默降级回 panel —— 卡片照出、不分屏、一句解释都没有。
// 这里钉死两件事：探测结果必须带原因；放宽后能用就不能再误判。
bundle("herdr.ts", "herdr-status.mjs");
allOk =
	runSuite(
		"herdr：降级可见（herdrStatus 判定 / 坏锁 / 降级文案 / doctor 诊断行）",
		join(tmp, "herdr-status.mjs"),
		[
			'// 桩：把跑 CLI 的那一层换掉（纯逻辑测，不真调 herdr）',
			'const __realRunJson = runJson;',
			'const __env = { TERM_PROGRAM: process.env.TERM_PROGRAM, HERDR_PANE_ID: process.env.HERDR_PANE_ID };',
			'let __clicks = 0;',
			'try {',
			'  // ---- ① CLI 调不通 ----',
			'  resetHerdrCache();',
			'  runJson = () => undefined;',
			'  let s = herdrStatus();',
			'  ok("1 CLI 调不通 → ok=false 且 reason 含「调不通」", s.ok === false && s.reason.includes("调不通") && s.panes === 0);',
			'  ok("1b 调不通时把 TERM_PROGRAM 带出来（给人看）", s.term === (process.env.TERM_PROGRAM ?? ""));',
			'  // ---- ② 拿到 JSON 但 0 个 pane ----',
			'  resetHerdrCache();',
			'  runJson = () => ({ result: { panes: [] } });',
			'  s = herdrStatus();',
			'  ok("2 pane list 成功但 0 个 pane → 含「没有可用 pane」", s.ok === false && s.reason.includes("没有可用 pane") && s.panes === 0);',
			'  // ---- ③ 正宗 herdr 终端 ----',
			'  resetHerdrCache();',
			'  runJson = () => ({ result: { panes: [{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }] } });',
			'  process.env.TERM_PROGRAM = "herdr";',
			'  process.env.HERDR_PANE_ID = "w1:p1";',
			'  s = herdrStatus();',
			'  ok("3 TERM_PROGRAM=herdr + pane list 正常 → ok 且 reason 为空", s.ok === true && s.reason === "" && s.panes === 2);',
			'  ok("12 herdrAvailable() 与 herdrStatus().ok 一致", herdrAvailable() === herdrStatus().ok && herdrAvailable() === true);',
			'  // ---- ④ 放宽：非 herdr 终端也能用（附加保护：要拿得到本会话 pane）----',
			'  resetHerdrCache();',
			'  process.env.TERM_PROGRAM = "Windows_Terminal";',
			'  delete process.env.HERDR_PANE_ID;',
			'  s = herdrStatus();',
			'  ok("4a 非 herdr 终端 + 拿不到主 pane → ok=false（附加保护）", s.ok === false && s.reason.includes("本会话的 pane"));',
			'  resetHerdrCache();',
			'  process.env.HERDR_PANE_ID = "w1:p1";',
			'  s = herdrStatus();',
			'  ok("4b 非 herdr 终端（Windows Terminal）但 herdr 在跑 → ok（放宽生效）", s.ok === true && s.reason === "" && s.term === "Windows_Terminal" && s.panes === 2);',
			'  delete process.env.TERM_PROGRAM;',
			'  resetHerdrCache();',
			'  ok("4c TERM_PROGRAM 没设也能用（tmux / SSH 场景）", herdrStatus().ok === true);',
			'  // ---- ⑤ 坏锁：放宽后切 pane 真失败 → 本次会话别再试 ----',
			'  resetHerdrCache();',
			'  __clicks = 0;',
			'  runJson = () => { __clicks += 1; return { result: { panes: [{ pane_id: "w1:p1" }] } }; };',
			'  herdrStatus();',
			'  const __first = __clicks;',
			'  herdrStatus();',
			'  ok("5 判定结果被缓存（不反复跑 CLI）", __first === 1 && __clicks === 1);',
			'  markHerdrBroken("切 pane 失败");',
			'  ok("5b herdrBrokenReason 记下了原因", herdrBrokenReason().includes("切 pane 失败"));',
			'  s = herdrStatus();',
			'  ok("5c markHerdrBroken 后 ok=false 且 reason 含原因", s.ok === false && s.reason.includes("切 pane 失败"));',
			'  ok("5d 坏锁生效后不再调 CLI", __clicks === 1);',
			'  // ---- ⑥ reset 清掉坏锁 ----',
			'  resetHerdrCache();',
			'  s = herdrStatus();',
			'  ok("6 resetHerdrCache 清掉标记（ok 恢复 / 原因清空）", herdrBrokenReason() === "" && s.ok === true);',
			'  // ---- ⑦ / ⑧ resolveUiMode（降级的两个方向）----',
			'  ok("7 resolveUiMode(auto,1,false) → panel", resolveUiMode({ ui: "auto" }, 1, false) === "panel");',
			'  ok("8 resolveUiMode(auto,1,true) → split", resolveUiMode({ ui: "auto" }, 1, true) === "split");',
			'  // ---- ⑨ 降级文案（纯函数）----',
			'  const dn = herdrDownNote("herdr CLI 调不通（不在 PATH 或超时）", "auto");',
			'  ok("9 降级 note 含「Herdr 不可用」+ 原因 + 想要的 ui", dn.includes("Herdr 不可用") && dn.includes("调不通") && dn.includes("auto"));',
			'  ok("9b 没传 ui 也要有话说", herdrDownNote("x").includes("本次走面板卡片"));',
			'  ok("9c 原因为空不写出空字符串", herdrDownNote("", "split").includes("未知原因"));',
			'  // ---- ⑩ / ⑪ doctor 诊断行（纯函数，坏输入不抛）----',
			'  const dl = formatHerdrDiagnostic({ term: "Windows_Terminal", panes: 3, ok: true, reason: "", ui: "auto", actual: "split", routerSource: "内置", routerBytes: 1234 }).join("\\n");',
			'  ok("10 诊断行含 TERM_PROGRAM / 可用= / 结论：ui=", dl.includes("TERM_PROGRAM") && dl.includes("可用=") && dl.includes("结论：ui="));',
			'  ok("10b 正常时原因写 (正常)、pane 数带 ✓", dl.includes("(正常)") && dl.includes("✓ 3 个"));',
			'  ok("10c Router 行带来源 + 字节", dl.includes("Router 提示词：内置") && dl.includes("1234 字节"));',
			'  let __missOk = true;',
			'  let miss = "";',
			'  try { miss = formatHerdrDiagnostic(undefined).join("\\n"); } catch { __missOk = false; }',
			'  ok("11 取不到值时写 (取不到)，不抛错", __missOk && miss.includes("(取不到)") && !miss.includes("undefined") && !miss.includes("NaN"));',
			'  let __badOk = true;',
			'  try { formatHerdrDiagnostic({ term: null, panes: NaN, ok: null, reason: undefined }); } catch { __badOk = false; }',
			'  ok("11b 脏值（null/NaN）也不抛", __badOk === true);',
			'} finally {',
			'  runJson = __realRunJson;',
			'  if (__env.TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM = __env.TERM_PROGRAM;',
			'  if (__env.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = __env.HERDR_PANE_ID;',
			'  resetHerdrCache();',
			'}',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-herdr-status") },
	) && allOk;

// ---------- 套件：Herdr 坏锁改冷却 + 负面缓存 TTL + 坏锁日志 ----------
// 踩过的痛点：`markHerdrBroken()` 一旦设了就是**永久** ok:false，且 `herdrStatus()` 把负面结论也无限期缓存 ——
// 一次 `pane list` 超时（10s）就能把整个会话钉死在 panel，直到重启。
// 这里钉死：坏锁只冷却 30s（过期自动重探）、负面结论只缓存 5s、TERM_PROGRAM 不再绕过 pane 检查。
bundle("herdr.ts", "herdr-cooldown.mjs");
allOk =
	runSuite(
		"herdr：坏锁冷却 / 负面缓存 TTL / 坏锁日志",
		join(tmp, "herdr-cooldown.mjs"),
		[
			'const __realRunJson3 = runJson;',
			'const __env3 = { TERM_PROGRAM: process.env.TERM_PROGRAM, HERDR_PANE_ID: process.env.HERDR_PANE_ID };',
			'const fsx = await import("node:fs");',
			'let clicks = 0;',
			'const okJson = () => { clicks += 1; return { result: { panes: [{ pane_id: "w1:p1" }] } }; };',
			'try {',
			'  process.env.TERM_PROGRAM = "Windows_Terminal";',
			'  process.env.HERDR_PANE_ID = "w1:p1";',
			'  // ---- ① 两个阈值常量导出（单测不真等 30s）----',
			'  ok("C1 常量：坏锁冷却 30s / 负面缓存 5s", BROKEN_COOLDOWN_MS === 30_000 && STATUS_NEG_TTL_MS === 5_000);',
			'  // ---- ② 坏锁生效 → ok=false 且带原因 ----',
			'  resetHerdrCache();',
			'  runJson = okJson;',
			'  markHerdrBroken("x");',
			'  let s = herdrStatus();',
			'  ok("C2 markHerdrBroken 后 ok=false 且 reason 含「x」", s.ok === false && s.reason.includes("x"));',
			'  ok("C2b reason 说清是冷却（30 秒内不再试），不是「永久不可用」", s.reason.includes("30 秒内不再试") && !s.reason.includes("本次会话已判定不可用"));',
			'  ok("C2c 冷却中不白跑 CLI", clicks === 0);',
			'  // ---- ③ 冷却过期（注入过去的时刻，不真等 30s）----',
			'  markHerdrBroken("x", Date.now() - (BROKEN_COOLDOWN_MS + 1000));',
			'  ok("C3 冷却过期后 herdrBrokenActive() === false", herdrBrokenActive() === false);',
			'  ok("C4 冷却过期后 herdrBrokenReason() 返回空", herdrBrokenReason() === "");',
			'  clicks = 0;',
			'  s = herdrStatus();',
			'  ok("C5 冷却过期后自动重探（真的跑了 CLI）且恢复 ok", clicks === 1 && s.ok === true);',
			'  // ---- ④ reset 清坏锁 ----',
			'  markHerdrBroken("y");',
			'  resetHerdrCache();',
			'  ok("C6 resetHerdrCache 清掉坏锁（herdrBrokenActive=false）", herdrBrokenActive() === false && herdrBrokenReason() === "");',
			'  // ---- ⑤ 负面结论：TTL 内复用 / TTL 过后重探 ----',
			'  resetHerdrCache();',
			'  clicks = 0;',
			'  runJson = () => { clicks += 1; return undefined; };',
			'  s = herdrStatus();',
			'  const s2 = herdrStatus();',
			'  ok("C7 负面结论在 TTL 内复用（连调两次只探测一次）", clicks === 1 && s.ok === false && s2.ok === false);',
			'  const s3 = herdrStatus(Date.now() + STATUS_NEG_TTL_MS + 1000);',
			'  ok("C8 负面结论过期后重新探测（第二次真跑了 CLI）", clicks === 2 && s3.ok === false);',
			'  // ---- ⑥ 正面结论：长期复用（不按 TTL 重探）----',
			'  resetHerdrCache();',
			'  clicks = 0;',
			'  runJson = okJson;',
			'  const p1 = herdrStatus();',
			'  const p2 = herdrStatus(Date.now() + 10 * 60 * 1000);',
			'  ok("C9 正面结论长期复用（TTL 过后仍不重探）", clicks === 1 && p1.ok === true && p2.ok === true);',
			'  // ---- ⑦ 统一要求 mainPaneId（TERM_PROGRAM 不再绕过）----',
			'  resetHerdrCache();',
			'  process.env.TERM_PROGRAM = "herdr";',
			'  delete process.env.HERDR_PANE_ID;',
			'  s = herdrStatus();',
			'  ok("C10 TERM_PROGRAM=herdr 但 HERDR_PANE_ID 未设 → ok=false（早判早降级）", s.ok === false);',
			'  ok("C10b 此时 reason 点明 HERDR_PANE_ID 未设 + TERM_PROGRAM", s.reason.includes("HERDR_PANE_ID 未设") && s.reason.includes("TERM_PROGRAM=herdr"));',
			'  resetHerdrCache();',
			'  process.env.HERDR_PANE_ID = "w1:p1";',
			'  process.env.TERM_PROGRAM = "Windows_Terminal";',
			'  ok("C11 HERDR_PANE_ID 有值 + 非 herdr 终端 → ok=true", herdrStatus().ok === true);',
			'  // ---- ⑧ 坏锁写日志（<agentDir>/herdr.log，写不进也不抛）----',
			'  const logFile = join(getAgentDir(), "herdr.log");',
			'  try { fsx.rmSync(logFile, { force: true }); } catch { /* ignore */ }',
			'  markHerdrBroken("日志测试");',
			'  const logTxt = fsx.existsSync(logFile) ? fsx.readFileSync(logFile, "utf8") : "";',
			'  ok("C12 坏锁写日志：ISO 时间 + HERDR_BROKEN + 原因", /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/m.test(logTxt) && logTxt.includes("HERDR_BROKEN") && logTxt.includes("日志测试"));',
			'  herdrStatus(Date.now() + BROKEN_COOLDOWN_MS + 1000);',
			'  const logTxt2 = fsx.existsSync(logFile) ? fsx.readFileSync(logFile, "utf8") : "";',
			'  ok("C13 冷却过期重探成功也记一行 HERDR_RECOVERED", logTxt2.includes("HERDR_RECOVERED"));',
			'  let __logOk = true;',
			'  const __savedDir = process.env.PI_CODING_AGENT_DIR;',
			'  // 把 herdr.log 占成一个目录（appendFileSync 必抛）→ 验证日志失败不会反过来报错',
			'  const __block = join(getAgentDir(), "blocked");',
			'  fsx.rmSync(__block, { recursive: true, force: true });',
			'  fsx.mkdirSync(join(__block, "herdr.log"), { recursive: true });',
			'  try { process.env.PI_CODING_AGENT_DIR = __block; herdrLog("x"); } catch { __logOk = false; }',
			'  if (__savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = __savedDir;',
			'  ok("C14 日志写不进也不抛（日志不许反过来影响派活）", __logOk === true);',
			'} finally {',
			'  runJson = __realRunJson3;',
			'  if (__env3.TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM = __env3.TERM_PROGRAM;',
			'  if (__env3.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = __env3.HERDR_PANE_ID;',
			'  resetHerdrCache();',
			'}',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-herdr-cooldown") },
	) && allOk;

// ---------- 套件：批次汇总卡 / 槽位等待 / 多溢出 tab ----------
// 实测痛点：delegate(tasks:[8]) 全部 10s 内跑完，但卡片一张一张吐了 8 轮对话；
// 其中 2 个因「槽位上限 6 个」被直接降级（真并发上限只有 MAX_CONCURRENT_RUNS=4，6 格根本用不满）。
// 这里钉死三件事：整批只落一条 `.bg` / 满了要排队而不是立刻降级 / 溢出 tab 可以开多个。
bundle("delegate.ts", "delegate-batch.mjs");
allOk =
	runSuite(
		"delegate：批次汇总卡 / 槽位排队等待 / 多溢出 tab",
		join(tmp, "delegate-batch.mjs"),
		[
			'// ---- 1) buildBatchCard（纯函数）----',
			'const mkIt = (o) => ({ name: "general", outcome: "done", elapsedMs: 1000, text: "结论: ok", ...o });',
			'const eight = [',
			'  ...[1,2,3,4,5,6].map((i) => mkIt({ elapsedMs: 12000, text: `干了活\\n结论: 第 ${i} 件完成`, sessionId: "g-" + i })),',
			'  mkIt({ name: "db", elapsedMs: 5000, note: "pane 槽位等待 60s 超时已降级 rpc", sessionId: "db-7" }),',
			'  mkIt({ name: "backend", outcome: "failed", elapsedMs: 3000, text: "", error: "退出码 1", sessionId: "be-8" }),',
			'];',
			'const card = buildBatchCard(eight);',
			'const cardRows = card.split("\\n").filter((l) => /^(✅|⚠️|❌|⏱)/.test(l));',
			'ok("批次卡：表头 8 个 → 6 成功 · 1 降级 · 1 失败（合计取最慢那条 12s）", card.startsWith("【批次 8 个】6 成功 · 1 降级 · 1 失败（合计 12s）"));',
			'ok("批次卡：8 条任务各一行", cardRows.length === 8);',
			'ok("批次卡：记号对（✅ / ⚠️ / ❌）+ 编号 #n", cardRows[0].startsWith("✅ general#1") && cardRows[6].startsWith("⚠️ db#7") && cardRows[7].startsWith("❌ backend#8"));',
			'ok("批次卡：结论取回执的「结论:」行（不是第一行）", cardRows[0].includes("第 1 件完成") && !cardRows[0].includes("干了活"));',
			'ok("批次卡：降级那条写降级原因", cardRows[6].includes("槽位等待 60s 超时"));',
			'ok("批次卡：末尾保留找回方式（会话 ID）", card.includes("general=g-1") && card.includes("backend=be-8") && card.includes("/resume-agent"));',
			'const oneCard = buildBatchCard([mkIt({ name: "db", elapsedMs: 2000, text: "结论: 只有一条", sessionId: "x" })]);',
			'ok("批次卡：单条也能用", oneCard.startsWith("【批次 1 个】1 成功") && oneCard.includes("✅ db#1  只有一条（2s）"));',
			'const longCard = buildBatchCard([mkIt({ text: "结论: " + "啊".repeat(200), elapsedMs: 0 })]);',
			'const longRow = longCard.split("\\n")[1];',
			'ok("批次卡：结论超长截断到 90 字 + …", longRow.includes("…") && (longRow.match(/啊/g) || []).length === 90);',
			'const emptyCard = buildBatchCard([]);',
			'ok("批次卡：空列表不崩", typeof emptyCard === "string" && emptyCard.includes("【批次 0 个】"));',
			'ok("批次卡：空列表也带合计 0s", emptyCard.includes("合计 0s"));',

			'// ---- 2) 槽位等待：满了排队，而不是立刻降级 ----',
			'const cfgWait = { ui: "split", mainSlots: 2, overflowSlots: 4, splitRatio: 0.5, paneKeepOnError: false };',
			'const occOps = (extra) => ({',
			'  mainPaneId: () => "w1:p1",',
			'  workspaceId: () => "w1",',
			'  paneList: () => [{ paneId: "w1:p1" }, ...[...herdrSlots.values()].map((s) => ({ paneId: s.paneId }))],',
			'  paneSplit: () => undefined, // 切不出来',
			'  tabCreate: () => undefined, // 连 tab 都建不出来 → 真·满了',
			'  tabClose: () => true,',
			'  paneClose: () => true,',
			'  ...(extra || {}),',
			'});',
			'let fakeNow = 0;',
			'herdrSlots.clear(); herdrExtraTabs.clear(); setHerdrSlotOps(occOps());',
			'herdrSlots.set(1, { index: 1, paneId: "w1:pA", where: "main" });',
			'herdrSlots.set(2, { index: 2, paneId: "w1:pB", where: "main" });',
			'const slept = [];',
			'const timed = await allocHerdrSlot("F:/tmp/x", cfgWait, "split", { now: () => fakeNow, sleep: async (ms) => { slept.push(ms); fakeNow += ms; } });',
			'ok("槽位等待：0 个空槽 → 轮询到 60s 超时后才返回 undefined", timed === undefined && fakeNow >= HERDR_SLOT_WAIT_MS);',
			'ok("槽位等待：每 300ms 轮询一次（60s 约 200 轮）", HERDR_SLOT_WAIT_MS === 60000 && slept.length >= 199 && slept.every((ms) => ms > 0 && ms <= HERDR_SLOT_POLL_MS));',
			'// 中途有人关掉 pane → 下一轮立刻拿到，不等满 60s',
			'fakeNow = 0;',
			'herdrSlots.clear(); herdrExtraTabs.clear();',
			'herdrSlots.set(1, { index: 1, paneId: "w1:pA", where: "main" });',
			'herdrSlots.set(2, { index: 2, paneId: "w1:pB", where: "main" });',
			'let polls = 0;',
			'setHerdrSlotOps(occOps({ paneSplit: (t, d) => `w1:new-${t}-${d}` }));',
			'const freed = await allocHerdrSlot("F:/tmp/x", cfgWait, "split", { now: () => fakeNow, sleep: async (ms) => { polls += 1; fakeNow += ms; if (polls === 2) herdrSlots.delete(1); } });',
			'ok("槽位等待：中途空出 → 立刻返回槽位（不等满 60s）", !!freed && freed.index === 1 && fakeNow < HERDR_SLOT_WAIT_MS);',

			'// ---- 3) 多溢出 tab ----',
			'herdrSlots.clear(); herdrExtraTabs.clear();',
			'const made = [];',
			'const tabsCreated = [];',
			'const closedTabs = [];',
			'const tabOps = {',
			'  mainPaneId: () => "w1:p1",',
			'  workspaceId: () => "w1",',
			'  paneList: () => [{ paneId: "w1:p1" }, ...made.map((id) => ({ paneId: id }))],',
			'  paneSplit: (t, d) => { const id = "w1:s" + (made.length + 1); made.push(id); return id; },',
			'  tabCreate: (ws, label) => { const id = "w2:p" + (made.length + 1); made.push(id); tabsCreated.push(label); return { tabId: "tab-" + tabsCreated.length, paneId: id }; },',
			'  tabClose: (tabId) => { closedTabs.push(tabId); return true; },',
			'  paneClose: () => true,',
			'};',
			'setHerdrSlotOps(tabOps);',
			'const got8 = [];',
			'for (let i = 0; i < 8; i++) got8.push(await allocHerdrSlot("F:/tmp/x", cfgWait, "split"));',
			'ok("溢出 tab：8 个任务全分到格（没有一个降级）", got8.every((s) => !!s) && got8.length === 8);',
			'ok("溢出 tab：第 6 个还在 sa:extra#1，第 7/8 个进 sa:extra#2", got8[5].tabId === "tab-1" && got8[6].index === 7 && got8[7].index === 8 && got8[6].tabId === "tab-2" && got8[7].tabId === "tab-2");',
			'ok("溢出 tab：标签依次是 sa:extra#1 / sa:extra#2（不复用同一个）", tabsCreated.join(",") === "sa:extra#1,sa:extra#2");',
			'ok("溢出 tab：格号不重复", new Set(got8.map((s) => s.index)).size === 8 && new Set(got8.map((s) => s.paneId)).size === 8);',
			'for (const s of got8) releaseHerdrSlot(s, true);',
			'ok("溢出 tab：pane 全关后两个溢出 tab 都被 close", closedTabs.length === 2 && closedTabs.includes("tab-1") && closedTabs.includes("tab-2"));',
			'ok("溢出 tab：关完后账是空的", herdrSlots.size === 0 && herdrExtraTabs.size === 0);',

			'// ---- 4) 重复 paneId 仍然被拒绝 ----',
			'herdrSlots.clear(); herdrExtraTabs.clear();',
			'setHerdrSlotOps({ ...tabOps, paneList: () => [{ paneId: "w1:p1" }, ...[...herdrSlots.values()].map((s) => ({ paneId: s.paneId }))], paneSplit: () => "w1:DUP" });',
			'const dupCfg = { ui: "split", mainSlots: 2, overflowSlots: 4, splitRatio: 0.5, paneKeepOnError: false };',
			'const dupA = await allocHerdrSlot("F:/tmp/x", dupCfg, "split");',
			'const dupB = await allocHerdrSlot("F:/tmp/x", dupCfg, "split", { waitMs: 0 });',
			'ok("重复 paneId：第二格被拒（绝不两个任务共用一个 pane）", !!dupA && dupB === undefined && herdrSlots.size === 1);',

			'// ---- 5) 真机（临时目录）：8 个任务一批 → 只落 1 条 .bg ----',
			'setHerdrSlotOps(undefined);',
			'const bgBefore = listBgTasks().map((t) => t.id);',
			'const bt = openBatch(8, { key: "batch", task: "8 件事", ownerSessionFile: "F", ownerSessionId: "S", deadlineAt: Date.now() + 600000 });',
			'for (let i = 0; i < 7; i++) noteBatchItem(bt, i, { name: "general", outcome: "done", elapsedMs: 1000 + i, text: "结论: 第 " + (i + 1) + " 件", sessionId: "sess-" + i });',
			'const midNew = listBgTasks().filter((t) => !bgBefore.includes(t.id));',
			'ok("批次（真机）：还没全部 settle → 一条 .bg 都不写（中途不吐卡）", midNew.length === 0);',
			'noteBatchItem(bt, 7, { name: "db", outcome: "failed", elapsedMs: 4000, error: "退出码 1", sessionId: "sess-7" });',
			'const newFiles = listBgTasks().filter((t) => !bgBefore.includes(t.id));',
			'ok("批次（真机）：8 个全 settle → 只生成 1 条 .bg 记录", newFiles.length === 1);',
			'const bRec = newFiles[0] || {};',
			'ok("批次（真机）：记录是汇总卡（batch=true / 7 成功 1 失败）", bRec.batch === true && String(bRec.resultText || "").includes("【批次 8 个】7 成功 · 1 失败"));',
			'ok("批次（真机）：投递文本就是汇总卡（不套「子Agent 回来了」壳）", typeof bgDeliveryText === "function" && bgDeliveryText(bRec).startsWith("【批次 8 个】"));',
			'ok("批次（真机）：单任务的投递文本不变（还带「子Agent」壳）", bgDeliveryText({ ...bRec, batch: false, name: "db", resultText: "卡片" }).includes("子Agent「db」回来了"));',
			'ok("批次（真机）：写在临时目录，不碰真实 .bg", bgRoot().startsWith(process.env.PI_CODING_AGENT_DIR));',
			'// 同一序号重复来（pane 收尾 + 兜底计时器）也不许再写第二条',
			'noteBatchItem(bt, 7, { name: "db", outcome: "done", elapsedMs: 1, text: "结论: 重复", sessionId: "sess-7" });',
			'ok("批次（真机）：重复 settle 同一条不会再写 .bg", listBgTasks().filter((t) => !bgBefore.includes(t.id)).length === 1);',
		],
		{ TPROJ: proj, PI_CODING_AGENT_DIR: join(tmp, "agent-delegate-batch") },
	) && allOk;

// ---------- 套件 1.7：采样提速 + 批量实时短卡 ----------
// C1：PANE_SAMPLE_MS / 回执稳定窗 2000 → 800，读失败连续 3 次降频到 2000（纯函数可测）
// C3：superagent.batchLive（默认关）开着时每件回投一条 ≤ 60 字的极短卡，最多 4 条
bundle("delegate.ts", "delegate-batchlive.mjs");
allOk =
	runSuite(
		"delegate：采样提速 / 批量实时短卡",
		join(tmp, "delegate-batchlive.mjs"),
		[
			'// ---- C1 采样提速 ----',
			'ok("PANE_SAMPLE_MS === 800", PANE_SAMPLE_MS === 800);',
			'ok("PANE_RECEIPT_STABLE_MS === 800", PANE_RECEIPT_STABLE_MS === 800);',
			'ok("读失败 0/1/2 次 → 仍用 800ms", effectiveSampleMs(0) === 800 && effectiveSampleMs(1) === 800 && effectiveSampleMs(2) === 800);',
			'ok("读失败 3 次 → 降频到 2000ms", effectiveSampleMs(3) === 2000 && effectiveSampleMs(9) === 2000);',
			'ok("降频常量：阈值 3 / 慢档 2000", PANE_READ_FAIL_SLOW_AFTER === 3 && PANE_SAMPLE_SLOW_MS === 2000);',
			'const blKeep = setInterval(() => {}, 50); // sleep() unref 了，测试里自己撑事件循环',
			'const slDir = join(tmpdir(), "slow-sess-" + Math.random().toString(36).slice(2, 8));',
			'mkdirSync(slDir, { recursive: true });',
			'const slBody = ["状态: 完成", "结论: 跑完了"].join(String.fromCharCode(10));',
			'writeFileSync(join(slDir, "20260101-000000-1_sid-slow.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: slBody }] } }) + String.fromCharCode(10), "utf8");',
			'let slThrows = 0;',
			'const slRes = await waitPaneDone({ index: 1, paneId: "w9:ps", where: "main" }, slDir, "sid-slow", 20000, undefined, true, { read: () => { slThrows += 1; if (slThrows <= 3) throw new Error("pane 读不到"); return { ok: true, text: "π 输入框" }; }, alive: () => true, sampleMs: 5, slowSampleMs: 5, receiptStableMs: 120 });',
			'ok("降频：连续读失败 3 次 → stallLog 里留一条「[采样] 降频到」", slRes.stallLog.some((l) => l.includes("[采样]") && l.includes("3 次")));',
			'ok("降频：只记一条（不每次抛错都刷屏）", slRes.stallLog.filter((l) => l.includes("[采样]")).length === 1);',
			'ok("降频：只是慢下来，读到成功后照样判 done", slRes.outcome === "done" && slThrows >= 4);',
			'// ---- C3 批量实时开关 ----',
			'ok("batchLiveEnabled() 默认 false（不写配置时）", batchLiveEnabled() === false);',
			'mkdirSync(getAgentDir(), { recursive: true });',
			'writeFileSync(join(getAgentDir(), "ai-extensions.json"), JSON.stringify({ superagent: { batchLive: true } }), "utf8");',
			'ok("写 superagent.batchLive=true → batchLiveEnabled() 返回 true", batchLiveEnabled() === true);',
			'ok("短卡上限常量 === 4", BATCH_LIVE_MAX === 4);',
			'const blOk = batchLiveLiveText(2, { name: "通用助理", outcome: "done", elapsedMs: 7000, text: "结论: 改完了 README 版式" });',
			'ok("短卡文案：成功 ≤ 60 字符（✅ #3 助理 7s · 结论，序号 1 基）", blOk.length <= 60 && blOk === "✅ #3 通用助理 7s · 改完了 README 版式");',
			'const blLong = batchLiveLiveText(11, { name: "通用助理", outcome: "done", elapsedMs: 7000, text: "结论: " + "啊".repeat(300) });',
			'ok("短卡文案：超长 headline 截断后仍 ≤ 60（前缀不丢）", blLong.length <= 60 && blLong.startsWith("✅ #12 通用助理 7s · ") && blLong.endsWith("…"));',
			'const blFail = batchLiveLiveText(4, { name: "db", outcome: "failed", elapsedMs: 3000, error: "退出码 1" });',
			'ok("短卡文案：失败用 ❌ 且 ≤ 60", blFail.startsWith("❌ #5 db 3s · ") && blFail.length <= 60 && blFail.includes("退出码 1"));',
			'// ---- 真机（临时 .bg）：8 个 item → 4 条短卡 + 1 条汇总卡 ----',
			'const blBefore = listBgTasks().map((t) => t.id);',
			'const blBatch = openBatch(8, { key: "batch", task: "8 件事", ownerSessionFile: "F", ownerSessionId: "S", deadlineAt: Date.now() + 600000 });',
			'for (let i = 0; i < 8; i++) noteBatchItem(blBatch, i, { name: "general", outcome: i === 2 ? "failed" : "done", elapsedMs: 1000 + i * 1000, text: "结论: 第 " + (i + 1) + " 件", error: i === 2 ? "退出码 1" : undefined, sessionId: "sess-" + i });',
			'const blNew = listBgTasks().filter((t) => !blBefore.includes(t.id));',
			'ok("短卡：8 个 item 只写 4 条（并发上限 4，防刷屏）", blNew.filter((t) => t.id.includes(":item:")).length === 4);',
			'ok("短卡：id 形如 <batchId>:item:<seq>", blNew.some((t) => t.id === blBatch.id + ":item:3"));',
			'ok("短卡：batch=true / delivered=false（等 pollBgTasks 投一次）", blNew.filter((t) => t.id.includes(":item:")).every((t) => t.batch === true && t.delivered === false));',
			'ok("短卡：每条正文 ≤ 60 字符", blNew.filter((t) => t.id.includes(":item:")).every((t) => String(t.resultText || "").length <= 60));',
			'ok("短卡：失败那条 status=failed 且正文是 ❌", (() => { const f = blNew.find((t) => t.id === blBatch.id + ":item:2"); return !!f && f.status === "failed" && String(f.resultText).startsWith("❌"); })());',
			'ok("汇总卡：凑齐后仍然写 batch.id 那条（不被短卡挤掉）", (() => { const s = blNew.find((t) => t.id === blBatch.id); return !!s && s.batch === true && String(s.resultText || "").startsWith("【批次 8 个】"); })());',
			'ok("短卡与汇总卡不冲突：1 条汇总 + 4 条短卡", blNew.length === 5);',
			'// ---- 开关关掉 → 默认行为（只出 1 张汇总卡） ----',
			'writeFileSync(join(getAgentDir(), "ai-extensions.json"), JSON.stringify({ superagent: { batchLive: false } }), "utf8");',
			'ok("batchLive=false → batchLiveEnabled() 回到 false", batchLiveEnabled() === false);',
			'const offBefore = listBgTasks().map((t) => t.id);',
			'const offBatch = openBatch(2, { key: "batch", task: "2 件事", deadlineAt: Date.now() + 600000 });',
			'noteBatchItem(offBatch, 0, { name: "general", outcome: "done", elapsedMs: 1000, text: "结论: a" });',
			'noteBatchItem(offBatch, 1, { name: "general", outcome: "done", elapsedMs: 1000, text: "结论: b" });',
			'const offNew = listBgTasks().filter((t) => !offBefore.includes(t.id));',
			'ok("开关关掉：只写 1 条汇总卡，没有任何短卡", offNew.length === 1 && offNew[0].id === offBatch.id);',
			'clearInterval(blKeep);',
		],
		{ TPROJ: proj, PI_CODING_AGENT_DIR: join(tmp, "agent-batchlive") },
	) && allOk;

// ---------- 套件 2：mcp-pool（影子目录） ----------
bundle("mcp-pool.ts", "mcp-pool.mjs");
allOk =
	runSuite("mcp-pool：影子目录（剔 packages / 唯一 / 回收 / 错误收集）", join(tmp, "mcp-pool.mjs"), [
		"const dir = getAgentDir();",
		"mkdirSync(dir, { recursive: true });",
		'writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", packages: ["git:x"] }), "utf8");',
		'writeFileSync(join(dir, "auth.json"), "{}", "utf8");',
		'// ---- Bug1：影子目录必须自带 bin，否则每个子助理启动都联网下载 fd/rg ----',
		'mkdirSync(join(dir, "bin"), { recursive: true });',
		'for (const n of SHADOW_BINS) writeFileSync(join(dir, "bin", n), "x".repeat(64), "utf8");',
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
		'ok("影子：bin 里 fd/rg 都能读（junction 或复制）", SHADOW_BINS.every((n) => binFileOk(join(s1.dir, "bin", n))));',
		'ok("影子：bin 接上后不再抱怨缺 fd/rg", !s1.warnings.some((w) => w.includes("缺")));',
		'// 空目录：先得清掉，否则 junction/复制都没法好好建',
		'const emptyDir = join(dir, "shadow", safeName("空bin助理") + "-empty");',
		'mkdirSync(join(emptyDir, "bin"), { recursive: true });',
		'const sEmpty = buildShadow("空bin助理", [], pool, { runSuffix: "empty" });',
		'ok("影子：bin 是空目录 → 清掉重建，fd/rg 都在", sEmpty.dir === emptyDir && SHADOW_BINS.every((n) => binFileOk(join(emptyDir, "bin", n))));',
		'// 残链（junction 指向已被删掉的目录）：existsSync 看不见，lstat 看得见',
		'const goneTarget = join(dir, "shadow", "_gone-target");',
		'mkdirSync(goneTarget, { recursive: true });',
		'const brokenDir = join(dir, "shadow", safeName("残链助理") + "-brk");',
		'mkdirSync(brokenDir, { recursive: true });',
		'symlinkSync(goneTarget, join(brokenDir, "bin"), process.platform === "win32" ? "junction" : "dir");',
		'rmSync(goneTarget, { recursive: true, force: true });',
		'ok("影子：残链真的造出来了（existsSync=false、lstat 看得见）", !existsSync(join(brokenDir, "bin")) && (() => { try { lstatSync(join(brokenDir, "bin")); return true; } catch { return false; } })());',
		'const sBrk = buildShadow("残链助理", [], pool, { runSuffix: "brk" });',
		'ok("影子：残链会被清掉重建（fd/rg 可读）", sBrk.dir === brokenDir && SHADOW_BINS.every((n) => binFileOk(join(brokenDir, "bin", n))));',
		'// 源 bin 不存在：只记 warning，不许抛、不许把派活搞挂',
		'const ghostAgent = join(dir, "no-bin-agent");',
		'mkdirSync(ghostAgent, { recursive: true });',
		'const ghost = join(dir, "shadow", "ghost-1");',
		'const gw = ensureShadowBin(ghost, ghostAgent);',
		'ok("影子：源 bin 不存在 → 只记 warning（含「缺」），不抛", gw.length > 0 && gw.some((w) => w.includes("缺")));',
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

// ---------- 套件：shared（计划确认：答复解析 + 风险判定） ----------
bundle("shared.ts", "shared.mjs");
allOk =
	runSuite(
		"shared：旧 ctx 守卫（stale 识别 / 不误吞真 bug）",
		join(tmp, "shared.mjs"),
		[
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
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-shared") },
	) && allOk;

// ---------- 套件：superagent（Worker 回执解析） ----------
bundle("superagent.ts", "superagent.mjs");
allOk =
	runSuite(
		"superagent：<result> 回执解析（正常 / 夹在正文 / 无 / 坏 JSON）",
		join(tmp, "superagent.mjs"),
		[
			`const r1 = parseReport('干完 <result>{"ok":true,"verdict":"pass","changed":["a.ts"],"ran":["npm test → 3 passed"],"notes":"好了"}</result>');`,
			`ok("回执：正常块解析出 pass", r1 && r1.verdict === "pass" && r1.changed.length === 1 && r1.ran.length === 1);`,
			`ok("回执：notes 原样带出", r1 && r1.notes === "好了");`,
			`const r2 = parseReport('说明<result>{"ok":true,"verdict":"pass","changed":[],"ran":[]}</result>完');`,
			`ok("回执：夹在正文中间也能抓到", r2 && r2.verdict === "pass");`,
			`ok("回执：没有回执 → undefined（别瞎猜）", parseReport("一段话，没有回执") === undefined);`,
			`const r3 = parseReport('<result>{"ok":false,"verdict":"fail","changed":[],"ran":[],"notes":"依赖缺"}</result>');`,
			`ok("回执：fail 不被当成 pass", r3 && r3.verdict === "fail" && r3.ok === false);`,
			`const r4 = parseReport("<result>{ok:true, verdict:'pass', changed:[], ran:['pytest'],}</result>");`,
			`ok("回执：坏 JSON（单引号/尾逗号）也能救回来", r4 && r4.verdict === "pass" && r4.ran.length === 1);`,
			`ok("回执：多个块取最后一个", parseReport('<result>{"verdict":"fail"}</result>x<result>{"verdict":"pass","ran":["x"]}</result>').verdict === "pass");`,
			`ok("回执：pass 但没跑命令 → 严格模式标证据不足", reportHeadline({ ok: true, verdict: "pass", changed: [], ran: [], blocked: [], notes: "" }, "strict").includes("无命令证据"));`,
			`ok("回执：宽松模式不标证据", reportHeadline({ ok: true, verdict: "pass", changed: [], ran: [], blocked: [], notes: "" }, "loose").includes("无命令证据") === false);`,
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-superagent") },
	) && allOk;

// ---------- 套件：superagent Router 档位 + 硬 guard（纯函数判定） ----------
// ⚠️ 重新打一份 bundle：runSuite 是往文件尾追加断言，复用上套会重复声明 const。
const routerAgent = join(tmp, "agent-router");
mkdirSync(routerAgent, { recursive: true });
writeFileSync(join(routerAgent, "ai-extensions.json"), `${JSON.stringify({ superagent: { enabled: true } }, null, 2)}\n`, "utf8");
bundle("superagent.ts", "superagent-router.mjs");
allOk =
	runSuite(
		"superagent：Router 硬件 guard 判定（blind / readonly / off × 工具名）",
		join(tmp, "superagent-router.mjs"),
		[
			'// ---- blind（默认）：只放行 delegate/progress/git_read ----',
			'ok("blind：delegate 放行", decideRouterToolCall("delegate", "blind").allow === true);',
			'ok("blind：progress 放行", decideRouterToolCall("progress", "blind").allow === true);',
			'ok("blind：git_read 放行（要能验收 diff）", decideRouterToolCall("git_read", "blind").allow === true);',
			'const BLIND_DENY = ["read","grep","bash","codemode","write","edit","apply_patch","multiedit","form"];',
			'ok("blind：read/grep/bash/codemode/write/edit/apply_patch/multiedit/form 全 deny", BLIND_DENY.every((t) => decideRouterToolCall(t, "blind").allow === false));',
			'ok("blind：mcp__nas_ubuntu24__ssh_exec deny", decideRouterToolCall("mcp__nas_ubuntu24__ssh_exec", "blind").allow === false);',
			'ok("blind：mcp__center_pg__query deny（无危险词的也拒）", decideRouterToolCall("mcp__center_pg__query", "blind").allow === false);',
			'ok("blind：未知工具名 deny（正向白名单，不猜）", decideRouterToolCall("some_future_tool", "blind").allow === false);',
			'ok("blind：拒绝文案含「不要重试」（防以后改丢）", ROUTER_DENY_TEXT.includes("不要重试"));',
			'ok("blind：deny 的 reason 就是那段文案", (decideRouterToolCall("bash", "blind").reason ?? "").includes("只派活"));',
			'// ---- readonly：只拦能写/能执行/危险 MCP ----',
			'ok("readonly：read / grep 放行", decideRouterToolCall("read", "readonly").allow === true && decideRouterToolCall("grep", "readonly").allow === true);',
			'ok("readonly：bash / write / codemode deny", ["bash","write","codemode"].every((t) => decideRouterToolCall(t, "readonly").allow === false));',
			'ok("readonly：mcp__nas_ubuntu24__ssh_exec deny（变相 bash）", decideRouterToolCall("mcp__nas_ubuntu24__ssh_exec", "readonly").allow === false);',
			'ok("readonly：mcp__center_pg__query 放行（不含危险词）", decideRouterToolCall("mcp__center_pg__query", "readonly").allow === true);',
			'ok("readonly：拒绝文案也含「不要重试」", (decideRouterToolCall("bash", "readonly").reason ?? "").includes("不要重试"));',
			'// ---- off ----',
			'ok("off：bash 放行（就是普通 pi）", decideRouterToolCall("bash", "off").allow === true && decideRouterToolCall("whatever", "off").allow === true);',
			'// ---- 常量 / 选项表 ----',
			'ok("默认档位就是 blind", DEFAULTS.router === "blind");',
			'ok("白名单就是 delegate/progress/git_read", ROUTER_ALLOW.join(",") === "delegate,progress,git_read");',
			'ok("KEEP_BLIND 与 ROUTER_ALLOW 同步（旧名没跑偏）", KEEP_BLIND === ROUTER_ALLOW);',
			'ok("ROUTER_OPTIONS 与 ROUTER_VALUES 长度一致", ROUTER_OPTIONS.length === ROUTER_VALUES.length);',
			'ok("ROUTER 选项顺序对应（blind/readonly/off）", ROUTER_VALUES[0] === "blind" && ROUTER_OPTIONS[0].includes("只派活") && ROUTER_VALUES[1] === "readonly" && ROUTER_OPTIONS[1].includes("只读") && ROUTER_VALUES[2] === "off" && ROUTER_OPTIONS[2].includes("不限制"));',
			'ok("面板默认值 = DEFAULTS.router", ROUTER_VALUES.includes(DEFAULTS.router));',
			'// ---- Worker 进程：必须放行（不拦自己人） ----',
			'ok("配置已开（superagentEnabled 为 true，下面才好比）", superagentEnabled() === true);',
			'process.env.PI_DELEGATE_PPID = "123";',
			'ok("Worker 环境（PI_DELEGATE_PPID）→ guard 不生效", shouldGuardRouter() === false);',
			'delete process.env.PI_DELEGATE_PPID;',
			'ok("去掉 Worker 标记 → 主会话 guard 生效", shouldGuardRouter() === true);',
			'// ---- 接线存在性（幂等安装 / 重放） ----',
			'ok("installRouterGuard / applyRouterTools 都是可调函数", typeof installRouterGuard === "function" && typeof applyRouterTools === "function");',
			'ok("setRouterSession 该导出了", typeof setRouterSession === "function");',
		],
		{ PI_CODING_AGENT_DIR: routerAgent },
	) && allOk;

// ---------- 套件：superagent Router 提示词外部化（resolveRouterPrompt / writeRouterTemplate） ----------
// 造一批临时项目目录 + 用户级目录（agentDir 靠 PI_CODING_AGENT_DIR 指），路径用环境变量递进去。
const rpRoot = mkdtempSync(join(tmpdir(), "pi-ext-router-prompt-"));
const R = {};
try {
	/** 造一个「项目 + 用户级」组合目录；files 里的键写到对应位置 */
	const mkProj = (name, files = {}) => {
		const dir = join(rpRoot, name);
		mkdirSync(join(dir, ".pi", "pi-extensions"), { recursive: true });
		for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, ".pi", "pi-extensions", f), body, "utf8");
		return dir;
	};
	const mkAgent = (name, files = {}) => {
		const dir = join(rpRoot, name);
		mkdirSync(join(dir, "pi-extensions"), { recursive: true });
		for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, "pi-extensions", f), body, "utf8");
		return dir;
	};
	//  ≥200 字符的正文（内置下限），marker 放在开头好断言
	const long = (marker) => `${marker}\n` + "这是一段用来凑长度的规则文字，单纯验证文件级覆盖与追加的优先级顺序。\n".repeat(10);

	R.none = mkProj("p_none");
	R.onlyUser = mkProj("p_onlyuser");
	R.agentOnlyUser = mkAgent("a_onlyuser", { "router.md": long("【用户级】USER-BASE") });
	R.both = mkProj("p_both", { "router.md": long("【项目级】PROJECT-BASE") });
	R.agentBoth = mkAgent("a_both", { "router.md": long("【用户级】USER-BASE") });
	R.extraOnly = mkProj("p_extra", { "router.extra.md": "【追加】EXTRA-BLOCK" });
	R.extraBoth = mkProj("p_extra_both", { "router.md": long("【项目级】PROJECT-BASE"), "router.extra.md": "【追加】EXTRA-BLOCK" });
	R.empty = mkProj("p_empty", { "router.md": "   \n\n \t \n" });
	R.agentEmpty = mkAgent("a_empty", { "router.md": long("【用户级】USER-BASE") });
	R.short = mkProj("p_short", { "router.md": "太短了。" }); // 4 字符 < 200
	R.crlf = mkProj("p_crlf", { "router.md": "\uFEFF# 标题\r\n" + long("CRLF-BASE").replace(/\n/g, "\r\n") });
	R.blank = mkProj("p_blank", { "router.md": "A 段\n\n\n\n\nB 段\n" + long("BLANK-BASE") });
	R.big = mkProj("p_big", { "router.md": "啊".repeat(7000) }); // ≈21KB（多字节）
	R.agentClean = mkAgent("a_clean");
	R.tpl = join(rpRoot, "tpl", "nested", "router.md");
	R.tplAgain = R.tpl;

	bundle("superagent.ts", "superagent-prompt.mjs");
	allOk =
		runSuite(
			"superagent：Router 提示词外部化（替换/追加/清洗/截断/模式关）",
			join(tmp, "superagent-prompt.mjs"),
			[
				`const R = JSON.parse(process.env.PI_UT_ROUTER);`,
				`const B = ROUTER_PROTOCOL;`,
				`const setAgent = (d) => { process.env.PI_CODING_AGENT_DIR = d; };`,
				`const resolve = (cwd, on = true) => resolveRouterPrompt(cwd, { forceEnabled: on });`,
				`setAgent(R.agentClean);`,
				`const i1 = resolve(R.none);`,
				'ok("1. 都没文件 → source=内置，text 含「Router」", i1.source === "内置" && i1.text.includes("Router") && i1.bytes > 0 && !i1.file);',
				`setAgent(R.agentOnlyUser);`,
				`const i2 = resolve(R.onlyUser);`,
				'ok("2. 只有用户级 router.md → source=用户文件", i2.source === "用户文件" && i2.text.includes("USER-BASE") && !!i2.file);',
				`setAgent(R.agentBoth);`,
				`const i3 = resolve(R.both);`,
				'ok("3. 项目 + 用户都有 → 用项目级", i3.source === "项目文件" && i3.text.includes("PROJECT-BASE") && !i3.text.includes("USER-BASE"));',
				`setAgent(R.agentClean);`,
				`const i4 = resolve(R.extraOnly);`,
				'ok("4. 只有 router.extra.md → 内置 + 追加都在", i4.source === "内置" && i4.text.includes("Router") && i4.text.includes("EXTRA-BLOCK") && !!i4.extraFile && !i4.file);',
				`setAgent(R.agentBoth);`,
				`const i5 = resolve(R.extraBoth);`,
				'ok("5. 替换 + 追加同时存在 → 替换内容在前", i5.text.indexOf("PROJECT-BASE") >= 0 && i5.text.indexOf("EXTRA-BLOCK") > i5.text.indexOf("PROJECT-BASE"));',
				`setAgent(R.agentEmpty);`,
				`const i6 = resolve(R.empty);`,
				'ok("6. 空文件视为不存在 → 回落用户级", i6.source === "用户文件" && i6.text.includes("USER-BASE"));',
				`setAgent(R.agentClean);`,
				`const i7 = resolve(R.short);`,
				'ok("7. 文件太短（<200 字符）→ warning 非空且用内置", !!i7.warning && i7.warning.includes("太短") && i7.text === B.trim() && i7.source === "内置");',
				`const i8 = resolve(R.crlf);`,
				'ok("8. BOM 去掉 + CRLF 归一成 LF", i8.text[0] !== "\\uFEFF" && !i8.text.includes("\\r") && i8.text.includes("CRLF-BASE"));',
				`const i9 = resolve(R.blank);`,
				'ok("9. 连续空行压成最多 2 个（无 4+ 连换行）", !/\\n{4,}/.test(i9.text) && i9.text.includes("\\n\\n\\n"));',
				`const i10 = resolve(R.big);`,
				'ok("10. 超大内容 → 截到 ≤12288+尾注 且含「已截断」", i10.bytes <= 12288 + Buffer.byteLength("\\n…（已截断，超过 12KB）", "utf8") && i10.bytes > 12288 && i10.text.includes("已截断") && !i10.text.includes("\\uFFFD"));',
				`const i11 = resolve(R.none, false);`,
				'ok("11. 模式关 → text 空、bytes 0", i11.text === "" && i11.bytes === 0);',
				'ok("12a. 内置含「依赖分析」", B.includes("依赖分析"));',
				'ok("12b. 内置含「并行」", B.includes("并行"));',
				'ok("12c. 内置含「禁止伪串行」", B.includes("禁止伪串行"));',
				'ok("12d. 内置含「tasks=[...]」", B.includes("tasks=[...]"));',
				'ok("12e. 内置含「30 秒」", B.includes("30 秒"));',
				'ok("12f. 内置原有规则没被删（【你是 Router】/ 挑专才 / wait: false）", B.includes("【你是 Router】") && B.includes("挑专才") && B.includes("wait: false"));',
				`const w1 = writeRouterTemplate(R.tpl, B);`,
				'ok("13a. 写模板到空目录 → ok && !existed（自动建目录）", w1.ok === true && w1.existed === false && w1.path === R.tpl);',
				'const w1txt = readFileSync(R.tpl, "utf8");',
				'ok("13b. 模板 = 3 行注释 + 内置原文", w1txt.split("\\n").slice(0, 3).every((l) => l.startsWith("<!--")) && w1txt.includes(B.trim()));',
				`const w2 = writeRouterTemplate(R.tplAgain, B);`,
				'ok("13c. 再调一次 → !ok && existed（不覆盖）", w2.ok === false && w2.existed === true);',
				'ok("14. 面板标签动态算（source · bytes 字节 + 追加 / ⚠）", getRouterPromptLabel({ text: "x", source: "项目文件", bytes: 42, extraFile: "e", warning: "w" }) === "项目文件 · 42 字节 + 追加 ⚠ w");',
			],
			{ PI_CODING_AGENT_DIR: R.agentClean, PI_UT_ROUTER: JSON.stringify(R) },
		) && allOk;
} finally {
	rmSync(rpRoot, { recursive: true, force: true });
}

// ---------- 套件：permissions（Worker 权限：解析 / 摘要 / 声明） ----------
bundle("permissions.ts", "permissions.mjs");
allOk =
	runSuite(
		"permissions：解析 / 摘要 / 注入声明",
		join(tmp, "permissions.mjs"),
		[
			'const p1 = parsePerms({ fs: "write", paths: "src/, tests/", exec: "safe", cmds: "npm test*, npx tsc*", net: "allow", budget: "120k/10m" });',
			'ok("解析：六项都读出来了", p1.fs === "write" && p1.paths.length === 2 && p1.exec === "safe" && p1.cmds.length === 2 && p1.net === "allow" && p1.budget === "120k/10m");',
			'const p2 = parsePerms({});',
			'ok("解析：什么都没写 → 安全默认（只读/不执行/无网）", p2.fs === "read" && p2.exec === "none" && p2.net === "none" && p2.paths.length === 0);',
			'const p3 = parsePerms({ fs: "WRITE", exec: "随便", net: "yes" });',
			'ok("解析：大小写能认", p3.fs === "write");',
			'ok("解析：写错的值回默认（不猜）", p3.exec === "none" && p3.net === "none");',
			'ok("摘要：只读 + 不执行 + 无网", permSummary(p2).includes("只读") && permSummary(p2).includes("不执行") && permSummary(p2).includes("无网"));',
			'ok("摘要：可写目录数 + 白名单条数", permSummary(p1).includes("2 个目录") && permSummary(p1).includes("白名单 2 条"));',
			'const rule = permissionRule(p2, "F:/proj");',
			'ok("声明：写明只读且不许尝试写", rule.includes("只读") && rule.includes("不要尝试写"));',
			'ok("声明：明确越界不会成功、不要绕过", rule.includes("越界不会成功") && rule.includes("不要"));',
			'ok("声明：给了替代方案（找派你的人）", rule.includes("让派你的人决定"));',
			'ok("声明：safe 档把白名单列出来", permissionRule(p1, "F:/proj").includes("npm test*"));',
			'ok("预设：dev 能写能跑能联网", PERM_PRESETS.dev.fs === "write" && PERM_PRESETS.dev.exec === "safe" && PERM_PRESETS.dev.net === "allow");',
			'ok("预设：reader 只读不跑", PERM_PRESETS.reader.fs === "read" && PERM_PRESETS.reader.exec === "none");',
			'ok("声明判定：写了任意一项就算显式", permsDeclared({ fs: "read" }) === true && permsDeclared({}) === false);',
			'ok("枚举互转：中文 ↔ 真实值", fromLabel(FS_KEYS, FS_OPTIONS, toLabel(FS_KEYS, FS_OPTIONS, "write")) === "write");',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-perms") },
	) && allOk;

// ---------- 套件：perm-guard（L3 兜底守卫：protected / fs / exec / net） ----------
// 这一层是「真到落盘/执行那一刻再判一次」的保险丝，它自己必须是纯函数（不吃环境、不写文件）。
bundle("perm-guard.ts", "perm-guard.mjs");
allOk =
	runSuite(
		"perm-guard：守卫判定（硬保护 / 可写范围 / 白名单 / 不误伤）",
		join(tmp, "perm-guard.mjs"),
		[
			`const GC = ${JSON.stringify(join(tmp, "guard-cwd"))};`,
			'const HOME = process.env.USERPROFILE || process.env.HOME || "/tmp";',
			'const O = { cwd: GC, protectedPaths: [] };',
			'const reader = { fs: "read", paths: [], exec: "none", cmds: [], net: "none" };',
			'const writer = { fs: "write", paths: ["${cwd}"], exec: "safe", cmds: ["npm test*"], net: "none" };',
			'const r1 = decideToolCall(reader, O, "write", { path: "a.txt", content: "x" });',
			'ok("fs=read 写文件 → block kind=fs", r1.block === true && r1.kind === "fs" && !r1.logOnly);',
			'ok("拒绝文案：EPERM[kind] + 策略性 + 给替代方案", r1.reason.startsWith("EPERM[fs]") && r1.reason.includes("策略性拒绝") && r1.reason.includes("可继续的动作"));',
			'const r2 = decideToolCall(writer, O, "edit", { path: HOME + "/.pi/agent/extensions/x.ts", edits: [] });',
			'ok("写 ~/.pi/agent/extensions/x.ts → block kind=protected", r2.block === true && r2.kind === "protected");',
			'const r3 = decideToolCall(writer, O, "write", { path: ".git/config", content: "x" });',
			'ok("写 .git/config → block kind=protected", r3.block === true && r3.kind === "protected");',
			'const r3b = decideToolCall(writer, O, "write", { path: GC + "/.git/config", content: "x" });',
			'ok("写 <cwd>/.git/config（绝对路径）→ 也拦", r3b.block === true && r3b.kind === "protected");',
			'const r4 = decideToolCall(writer, O, "write", { path: GC + "/src/a.ts", content: "x" });',
			'ok("fs=write + paths=[${cwd}] 写 <cwd>/src/a.ts → 放行", r4.block === false);',
			'const r5 = decideToolCall(writer, O, "write", { path: "../outside.txt", content: "x" });',
			'ok("fs=write 写 ../outside.txt → block", r5.block === true && r5.kind === "fs");',
			'const r5b = decideToolCall({ ...writer, paths: ["src/"] }, O, "write", { path: "README.md", content: "x" });',
			'ok("paths=[src/] 写 <cwd>/README.md → block", r5b.block === true && r5b.kind === "fs");',
			'const r6 = decideToolCall(reader, O, "bash", { command: "ls" });',
			'ok("exec=none + bash → block kind=exec（硬拦）", r6.block === true && r6.kind === "exec" && !r6.logOnly);',
			'const r7 = decideToolCall(writer, O, "bash", { command: "npm test -- --run" });',
			'ok("exec=safe + `npm test -- --run`（cmds 含 npm test*）→ 放行", r7.block === false);',
			'const r8 = decideToolCall(writer, O, "bash", { command: "rm -rf /" });',
			'ok("exec=safe + `rm -rf /` → logOnly=true（先只记录，不硬拦）", r8.block === true && r8.kind === "exec" && r8.logOnly === true);',
			'const r8b = decideToolCall(writer, { ...O, execHardBlock: false }, "bash", { command: "rm -rf /" });',
			'ok("execHardBlock=false（默认）→ exec 仍只记录：logOnly=true", r8b.block === true && r8b.logOnly === true);',
			'const r8c = decideToolCall(writer, { ...O, execHardBlock: true }, "bash", { command: "rm -rf /" });',
			'ok("execHardBlock=true → 硬拦：block 且 logOnly=false", r8c.block === true && r8c.kind === "exec" && !r8c.logOnly);',
			'ok("cmdMatches：末尾 * = 前缀；无 * = 整条命令（可带参数）", cmdMatches("npm test*", "npm test -- --run") && cmdMatches("git status", "git status -s") && !cmdMatches("git status", "gitk"));',
			'const r9 = decideToolCall(reader, O, "write", { whatever: 1 });',
			'ok("参数是奇怪结构（没路径）→ 不 block（不误伤）", r9.block === false);',
			'const r10 = decideToolCall(reader, O, "mcp__weird__tool", null);',
			'ok("不认识的工具/空参数 → 不 block", r10.block === false);',
			'const r11 = decideToolCall(reader, O, "web_fetch", { url: "https://x" });',
			'ok("net=none + web_fetch → logOnly（只记录）", r11.block === true && r11.kind === "net" && r11.logOnly === true);',
			'const r12 = decideToolCall(reader, { cwd: GC, protectedPaths: ["${cwd}/plug"] }, "write", { path: GC + "/plug/x.ts", content: "x" });',
			'ok("调用方传的 protectedPaths（插件源码目录）也算硬保护", r12.block === true && r12.kind === "protected");',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-guard") },
	) && allOk;

// ---------- 套件：settings（/aihelp 面板通用渲染器：注册项 / 读写往返 / 夹范围） ----------
// 面板是通用渲染器，配置项由各模块自己注册 —— 这里**自己塞一组合成项**，
// 这样不管哪天又删了哪个模块，面板本身的读写/夹范围/解析都still有覆盖。
bundle("settings.ts", "settings.mjs");
allOk =
	runSuite(
		"settings：配置面板（注册项 / 读写往返 / 夹范围 / 解析）",
		join(tmp, "settings.mjs"),
		[
			"const store = { num: 1200, en: 'word', bool: true, list: ['发送'], text: 'abc' };",
			"registerSettings([",
			"  { key: 'tNum', group: '甲组', label: '数字项', desc: '这是一个数字项，用来测夹范围', kind: 'number', min: 300, max: 10000, unit: 'ms', def: 1500, get: () => store.num, set: (v) => { store.num = v; } },",
			"  { key: 'tEnum', group: '甲组', label: '枚举项', desc: '这是一个枚举项，用来测候选映射', kind: 'enum', options: ['触发词（必须说）', '静默即投'], values: ['word', 'silent'], def: 'silent', get: () => store.en, set: (v) => { store.en = v; } },",
			"  { key: 'tBool', group: '乙组', label: '开关项', desc: '这是一个布尔项，用来测是/否解析', kind: 'bool', def: false, get: () => store.bool, set: (v) => { store.bool = v; } },",
			"  { key: 'tList', group: '乙组', label: '列表项', desc: '这是一个列表项，用来测逗号解析', kind: 'list', def: [], get: () => store.list, set: (v) => { store.list = v; } },",
			"  { key: 'tText', group: '乙组', label: '文本项', desc: '这是一个文本项，用来测可留空', kind: 'text', def: '', get: () => store.text, set: (v) => { store.text = v; } },",
			"  { key: 'tSess', group: '丙组', label: '会话级项', desc: '这是一个会话级项，不落盘', kind: 'bool', def: false, session: true, get: () => false, set: () => {} },",
			"]);",
			"const snap = settingsSnapshot();",
			'ok("面板：注册项数量 = 6（自己塞的合成项）", snap.length === 6);',
			'ok("面板：key 不重复", new Set(snap.map((s) => s.key)).size === snap.length);',
			'ok("面板：每项都有名字", snap.every((s) => s.label && s.label.length >= 2));',
			'ok("面板：每项都写了「干什么用的」（≥12 字）", snap.every((s) => s.desc && s.desc.length >= 12));',
			'ok("面板：每项都有类型", snap.every((s) => ["bool","enum","number","text","list"].includes(s.kind)));',
			'ok("面板：分组有 3 组，且按 GROUP_ORDER 之外的顺序稳定排列", new Set(snap.map((s) => s.group)).size === 3);',
			'ok("面板：每一项都读得出当前值（文本项可留空）", snap.every((s) => s.kind === "text" || fieldValue(getSetting(s.key)).length > 0));',
			"const rt = [];",
			'for (const s of snap) { const d = getSetting(s.key); d.set(Array.isArray(d.def) ? [...d.def] : d.def); rt.push(JSON.stringify(d.get()) === JSON.stringify(d.def)); }',
			'ok("面板：每一项都能写回默认值并读出来（往返一致）", rt.every(Boolean));',
			'ok("面板：数字项下/上限写在定义里（min=300 / max=10000）", getSetting("tNum").min === 300 && getSetting("tNum").max === 10000);',
			'const en = getSetting("tEnum");',
			'ok("面板：枚举项每个候选都设得进去", ["word","silent"].every((v) => (en.set(v), en.get() === v)));',
			'ok("面板：会话级项有标记（不落盘）", snap.filter((s) => s.session).length === 1);',
			// ---- 表单式面板：字段生成 / 值解析 / 保存 ----
			'const fs2 = settingsFields();',
			'const rows2 = fs2.filter((f) => f.kind !== "group");',
			'const groups2 = fs2.filter((f) => f.kind === "group");',
			'ok("表单：一行一项（设置行数 = 注册项数，各占一行）", rows2.length === snap.length && new Set(rows2.map((f) => f.key)).size === snap.length);',
			'ok("表单：分组是独立表头行（3 个），设置行不带「·」前缀且不超长", groups2.length === 3 && rows2.every((f) => !f.label.includes("·") && f.label.length <= 20));',
			'ok("表单：每个设置行都落在某个分组表头之后（表头永远可见）", rows2.every((f) => fs2.slice(0, fs2.indexOf(f)).some((x) => x.kind === "group")));',
			'ok("表单：bool → 是/否（FormPane 的 bool 行）", fs2.filter((f) => f.kind === "bool").length === 2);',
			'ok("表单：枚举项带候选（回车能展开）", fs2.some((f) => f.kind === "enum" && Array.isArray(f.options) && f.options.length >= 2));',
			'ok("表单：每个设置行都有灰字提示（单位/范围；表头不需要）", rows2.every((f) => f.hint && f.hint.length > 0));',
			'const dNum = getSetting("tNum");',
			'ok("解析：数字超范围会被夹住", parseFieldValue(dNum, "1") === 300 && parseFieldValue(dNum, "999999") === 10000);',
			'ok("解析：数字不是数字 → undefined（不写坏配置）", parseFieldValue(dNum, "abc") === undefined);',
			'const dEnum = getSetting("tEnum");',
			'ok("解析：枚举按显示文本映射回真实值", parseFieldValue(dEnum, "触发词（必须说）") === "word");',
			// 面板里 UI 模式改了存不进去的回归：长标签会被截断成 "auto"
			'const dUi = { key: "tUi", kind: "enum", options: ["panel", "split", "tab", "auto（默认：有 Herdr 就分屏）"], values: ["panel", "split", "tab", "auto"] };',
			'ok("解析：UI 长标签完整匹配 → auto", parseFieldValue(dUi, "auto（默认：有 Herdr 就分屏）") === "auto");',
			'ok("解析：UI 标签被截断成 auto 也能存", parseFieldValue(dUi, "auto") === "auto");',
			'ok("解析：UI 旧长标签（auto = ≤2 个用 split）也能存", parseFieldValue(dUi, "auto = ≤2 个用 split") === "auto");',
			'ok("解析：UI 普通短值 split → split", parseFieldValue(dUi, "split") === "split");',
			'ok("解析：UI 乱七八糟的值 → undefined（不写坏配置）", parseFieldValue(dUi, "bogus") === undefined);',
			'const storeUi = { v: "panel" };',
			'registerSettings([{ key: "tUiReal", group: "甲组", label: "UI 模式", desc: "这是一个枚举项，用来测面板里改 UI 模式能不能真的存进去", kind: "enum", options: ["panel", "split", "tab", "auto（默认：有 Herdr 就分屏）"], values: ["panel", "split", "tab", "auto"], def: "auto", get: () => storeUi.v, set: (v) => { storeUi.v = v; } }]);',
			'const rUi = applySettingsValues({ tUiReal: "auto" });',
			'ok("保存：截断成 auto 也真的存进去了（不再落 failed）", rUi.applied.length === 1 && rUi.failed.length === 0 && storeUi.v === "auto");',
			'storeUi.v = "panel";', // 回到 panel：否则下面这条会被「解析值 == 当前值 → 不写盘」的保险跳过（不算改动）
			'const rUi2 = applySettingsValues({ tUiReal: "auto = ≤2 个用 split" });',
			'ok("保存：旧长标签也能存", rUi2.applied.length === 1 && rUi2.failed.length === 0 && storeUi.v === "auto");',
			'const dList = getSetting("tList");',
			'ok("解析：列表支持中英文逗号/空格", JSON.stringify(parseFieldValue(dList, "发送，投给pi 继续")) === JSON.stringify(["发送","投给pi","继续"]));',
			'const dBool = getSetting("tBool");',
			'ok("解析：bool 认「是/否」", parseFieldValue(dBool, "是") === true && parseFieldValue(dBool, "否") === false);',
			'const same = {};',
			'for (const d of settingsDefs()) same[d.key] = fieldValue(d);',
			'ok("保存：原样提交 → 一项都不动（不会白写盘）", applySettingsValues(same).applied.length === 0);',
			'applySettingsValues({ ...same, tNum: "800" });',
			'const one = { ...same, tNum: "1500" };',
			'const r1 = applySettingsValues(one);',
			'ok("保存：改一项 → 只应用那一项", r1.applied.length === 1 && getSetting("tNum").get() === 1500);',
			'const bad = { ...same, tNum: "不是数字" };',
			'const r2 = applySettingsValues(bad);',
			'ok("保存：坏值 → 记到 failed 且不写坏", r2.failed.length === 1 && r2.applied.length === 0 && getSetting("tNum").get() === 1500);',
			'ok("详情行：写清了「干什么用的 + 取值 + 当前 + 默认」", fieldDetail(getSetting("tNum")).includes("取值：") && fieldDetail(getSetting("tNum")).includes("默认："));',
			'registerSettings([{ key: "tAct", group: "丙组", label: "动作行", desc: "这是一个动作行，用来测值列摘要", kind: "action", def: "", hint: "可派 · 通用助理", get: () => "", set: () => {} }]);',
			'const actRow = settingsFields().find((f) => f.key === "tAct");',
			'ok("动作行：值列显示摘要（不再重复「→ 回车执行」）", actRow.value === "可派 · 通用助理" && actRow.hint === "回车执行");',
			'ok("动作行：详情说清「选中即执行、不参与保存」", fieldDetail(getSetting("tAct")).includes("立即执行"));',
			// ---- 分页：首页 → 组 → 项 ----
			'const home = settingsHomePage();',
			'ok("分页：首页每组一行，且每行都是「回车进入」", home.fields.length >= 3 && home.fields.every((f) => f.drill === true));',
			'const gp = settingsGroupPage("甲组");',
			'ok("分页：组页第一行是「← 返回」", gp.fields[0].key === "nav.back" && gp.fields[0].drill === true);',
			'ok("分页：组页行数 = 该组项数 + 1（返回行）", gp.fields.length === settingsDefs().filter((d) => d.group === "甲组").length + 1);',
			'ok("分页：配置行回车进编辑页、动作行不翻页", !!gp.enter && gp.enter(gp.fields[1]).fields.length === 2 && gp.enter({ key: "tAct", label: "x", value: "", kind: "action" }) === undefined);',
			'const ip = settingsItemPage(getSetting("tNum"));',
			'ok("分页：项页有「返回 + 该项」两行，且带保存钩子", ip.fields.length === 2 && typeof ip.save === "function");',
			'ok("分页：项页保存会把值写回去", (() => { ip.save({ tNum: "4200" }); return getSetting("tNum").get() === 4200; })());',
			'ok("分页：返回行回车 = 弹回上一层（返回 null）", ip.enter(ip.fields[0]) === null);',
			'ok("分页：总览/组/项三页都带 refresh（页外改过之后能重算显示）", typeof settingsHomePage().refresh === "function" && typeof settingsGroupPage("甲组").refresh === "function" && typeof settingsItemPage(getSetting("tNum")).refresh === "function");',
			// ---- refresh：页外改过的值要同步回显示 ----
			// 这就是「改了没保存」的根因：组页那行是**建页时的快照**，项页 ctrl+s 已经写盘，
			// 组页还显示旧值 → 退出时 applySettingsValues 把旧值当成「用户改了」又写回去。
			'const refStore = { v: "a" };',
			'const refBool = { v: true };',
			'const refCalls = [];',
			'registerSettings([',
			'  { key: "tRef", group: "甲组", label: "刷新项", desc: "这是一个枚举项，用来测页外改值后表单显示能不能同步", kind: "enum", options: ["a（甲）", "b（乙）"], values: ["a", "b"], def: "a", get: () => refStore.v, set: (v) => { refCalls.push(v); refStore.v = v; } },',
			'  { key: "tRefBool", group: "甲组", label: "刷新开关", desc: "这是一个布尔项，用来测刷新后回填 是/否", kind: "bool", def: true, get: () => refBool.v, set: (v) => { refBool.v = v; } },',
			'  { key: "tRefAct", group: "甲组", label: "刷新动作行", desc: "这是一个动作行，刷新时不能被当成配置值重算", kind: "action", def: "", hint: "摘要", get: () => "", set: () => { refCalls.push("ACT"); } },',
			']);',
			'const refFields = [{ key: "tRef", label: "刷新项", value: "a（甲）" }];',
			'refStore.v = "b";',
			'refreshFormFields(refFields, (k) => getSetting(k));',
			'ok("刷新：行值从 a 更新成 b（跟着磁盘走，不再是建页那天的快照）", refFields[0].value === "b（乙）");',
			'const refActFields = [{ key: "tRefAct", label: "刷新动作行", value: "摘要" }];',
			'refreshFormFields(refActFields, (k) => getSetting(k));',
			'ok("刷新：动作行跳过（它的值列是摘要，不是当前值）", refActFields[0].value === "摘要");',
			'const refGhost = [{ key: "nav.back", label: "← 返回", value: "" }];',
			'let refThrew = false;',
			'try { refreshFormFields(refGhost, (k) => getSetting(k)); } catch { refThrew = true; }',
			'ok("刷新：不存在的 key（导航行）不抛错也不乱改", refThrew === false && refGhost[0].value === "");',
			'const boolRows = [{ key: "tRefBool", label: "刷新开关", value: "否" }];',
			'refreshFormFields(boolRows, (k) => getSetting(k));',
			'refBool.v = false;',
			'refreshFormFields(boolRows, (k) => getSetting(k));',
			'ok("刷新：bool 行回填 是/否", boolRows[0].value === "否");',
			'refBool.v = true;',
			'refreshFormFields(boolRows, (k) => getSetting(k));',
			'ok("刷新：bool 行回填 是", boolRows[0].value === "是");',
			'const gpR = settingsGroupPage("甲组");',
			'refStore.v = "a";',
			'gpR.fields.find((f) => f.key === "tRef").value = "b（乙）";', // 模拟旧快照
			'gpR.refresh();',
			'ok("分页：组页 refresh 把行值拉回磁盘值", gpR.fields.find((f) => f.key === "tRef").value === "a（甲）");',
			// 三页的 refresh **真调一遍**（只查 typeof 没用：闭包里的 fields 拼错时 typeof 仍是 function）
			'const ipInv = settingsItemPage(getSetting("tRef"));',
			'ipInv.fields[1].value = "b（乙）";',
			'let invThrew = false;',
			'try { ipInv.refresh(); settingsHomePage().refresh(); settingsGroupPage("甲组").refresh(); } catch { invThrew = true; }',
			'ok("分页：总览/组/项三页的 refresh 真能调（项页把显示拉回磁盘值）", invThrew === false && ipInv.fields[1].value === "a（甲）");',
			// ---- 回归（最重要）：组页旧快照 + 项页写盘 ----
			'const gsnap = [{ key: "tRef", label: "刷新项", value: "a（甲）" }];',
			'refStore.v = "a";',
			'refCalls.length = 0;',
			'const ipRef = settingsItemPage(getSetting("tRef"));',
			'ipRef.save({ tRef: "b（乙）" });', // 项页 ctrl+s：真写盘
			'ok("回归：项页保存真的写盘了（磁盘 = b）", refStore.v === "b" && refCalls.length === 1);',
			'refreshFormFields(gsnap, (k) => getSetting(k));',
			'const rRefresh = applySettingsValues({ tRef: gsnap[0].value }, settingsDefs());',
			'ok("回归：刷新之后退出 → 不再把旧值写回去（set 一次都没多调）", refCalls.length === 1 && rRefresh.applied.length === 0 && refStore.v === "b");',
			// 同一场景**不刷新** = 就是这次的 bug 本身（锁住成因，防以后又把 refresh 去掉）
			'const rNoRefresh = applySettingsValues({ tRef: "a（甲）" }, settingsDefs());',
			'ok("成因：不刷新时退出 → 旧快照被当成改动写回（set(a) 真发生了）", rNoRefresh.applied.length === 1 && refCalls.length === 2 && refStore.v === "a");',
			// enum 兜底：显示的是「值本身」而不是标签时也算没改
			'refStore.v = "b";',
			'refCalls.length = 0;',
			'const rRaw = applySettingsValues({ tRef: "b" }, settingsDefs());',
			'ok("保险：enum 行给的是值本身（不是标签）→ 也算没改，不写盘", rRaw.applied.length === 0 && refCalls.length === 0);',
			'const dAuto = { key: "tAuto", kind: "enum", options: ["panel", "auto（默认：有 Herdr 就分屏）"], values: ["panel", "auto"] };',
			'ok("解析：auto 三种写法（完整标签/截断/旧长标签）都归到 auto", ["auto（默认：有 Herdr 就分屏）", "auto", "auto = xxx"].every((s) => parseFieldValue(dAuto, s) === "auto"));',
			'const dAB = { key: "tAB", kind: "enum", options: ["A", "B"], values: ["a", "b"] };',
			'ok("解析：enum 首尾空格也能兜住（带首尾空格的 b → b）", parseFieldValue(dAB, "  b  ") === "b");',
			'// 回归：动作行的 set 是「跑起来」，绝不能被批量落地当成「改过的配置」（否则一次选中会执行一堆动作）',
			'const fired = [];',
			'registerSettings([{ key: "tAct2", group: "丙组", label: "动作行2", desc: "x", kind: "action", def: "", hint: "可派 · 通用助理", get: () => "", set: () => { fired.push("act"); } }]);',
			'const actVal = settingsFields().find((f) => f.key === "tAct2").value;',
			'applySettingsValues({ tAct2: actVal }, settingsDefs());',
			'ok("回归：动作行在批量保存里不被执行", fired.length === 0);',
			'resetSettings(settingsDefs());',
			'ok("回归：恢复全部默认也不执行动作行", fired.length === 0);',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-settings") },
	) && allOk;

// ---------- 套件：form（页栈刷新：项页 ctrl+s 之后组页那行不能再是旧快照） ----------
// 这是那个 bug 的**整条链**：页栈 + 刷新 + 退出时的批量提交。纯函数测得再好，
// 漏接了 refreshStack 调用点也一样会把旧值写回磁盘，所以这里直接按键盘跑一遍。
bundle("form.ts", "form.mjs");
allOk =
	runSuite(
		"form：页栈刷新（项页存完 → 组页旧快照跟着更新）",
		join(tmp, "form.mjs"),
		[
			'const ESCK = String.fromCharCode(27);',
			'const DOWN = ESCK + "[B";',
			'const CTRL_S = String.fromCharCode(19);',
			'const opts = ["a（甲）", "b（乙）"];',
			'const vals = ["a", "b"];',
			'const store = { v: "a" };',
			'const label = (v) => opts[Math.max(0, vals.indexOf(String(v)))];',
			'const writeBack = (text) => { const i = opts.indexOf(String(text)); store.v = i >= 0 ? vals[i] : String(text); };',
			'const refreshOf = (rows) => () => { for (const r of rows) r.value = label(store.v); };',
			'const P = (fields, extra) => ({ title: "t", fields, ...extra });',
			'// 场景一：项页选 b + ctrl+s → esc 回组页，组页那行必须是 b（不是建页那天的 a）',
			'store.v = "a";',
			'const g1 = [{ key: "k1", label: "项", value: label(store.v), kind: "enum", options: opts }];',
			'const i1 = [{ key: "k1", label: "项", value: label(store.v), kind: "enum", options: opts }];',
			'let closed = "unset";',
			'const pane = new FormPane({}, "t", g1, [], (r) => { closed = r; });',
			'pane.setPages([P(g1, { refresh: refreshOf(g1) }), P(i1, { refresh: refreshOf(i1), save: (v) => { writeBack(v.k1); return true; } })]);',
			'pane.handleInput("\\r"); // 回车 → 展开 enum',
			'pane.handleInput(DOWN); // ↓ 选 b',
			'pane.handleInput("\\r"); // 回车选定',
			'ok("场景一：项页选定 b 后本页显示 b（不被刷新抹回 a）", i1[0].value === "b（乙）");',
			'pane.handleInput(CTRL_S); // ctrl+s 真写盘',
			'ok("场景一：ctrl+s 真写盘了", store.v === "b");',
			'ok("场景一：组页旧快照已跟着更新成 b", g1[0].value === "b（乙）");',
			'pane.handleInput(ESCK); // esc 回组页',
			'ok("场景一：esc 回组页后仍是 b（这就是修的那个 bug）", g1[0].value === "b（乙）");',
			'pane.handleInput(ESCK); // esc 关面板',
			'ok("场景一：最外层 esc 才关面板（能正常退出）", closed === null);',
			'// 场景二：组页里改了 enum（还没 ctrl+s）→ 回车进项页 ctrl+s → esc 回来，改动不能被抹',
			'store.v = "a";',
			'const g2 = [',
			'  { key: "k0", label: "进项页", value: "", kind: "text", drill: true },',
			'  { key: "k1", label: "项", value: label(store.v), kind: "enum", options: opts },',
			'];',
			'const i2 = [{ key: "k1", label: "项", value: label(store.v), kind: "enum", options: opts }];',
			'const pane2 = new FormPane({}, "t", g2, [], () => {});',
			'pane2.setPages([P(g2, { refresh: refreshOf(g2), enter: (f) => (f.key === "k0" ? P(i2, { refresh: refreshOf(i2), save: () => true }) : undefined) })]);',
			'pane2.handleInput(DOWN); // 光标到 enum 行',
			'pane2.handleInput("\\r");',
			'pane2.handleInput(DOWN); // 选 b（本页改了，但还没保存）',
			'pane2.handleInput("\\r");',
			'ok("场景二：组页 enum 已改成 b", g2[1].value === "b（乙）");',
			'pane2.handleInput(ESCK + "[A"); // ↑ 回到「进项页」行',
			'pane2.handleInput("\\r"); // 回车进项页',
			'pane2.handleInput(CTRL_S); // 项页保存（会触发整栈 refresh）',
			'pane2.handleInput(ESCK); // esc 回组页（再触发一次刷新）',
			'ok("场景二：里层保存 + 回退之后，组页没提交的 enum 改动还在", g2[1].value === "b（乙）");',
			'// 场景三：refresh 自己抛错也不能卡住 ctrl+s',
			'const pane3 = new FormPane({}, "t", [], [], () => {});',
			'pane3.setPages([P([], { refresh: () => { throw new Error("boom"); } }), P([], { refresh: () => { throw new Error("boom"); }, save: () => true })]);',
			'let threw3 = false;',
			'try { pane3.handleInput(CTRL_S); } catch { threw3 = true; }',
			'ok("场景三：refresh 抛错不影响 ctrl+s 主流程", threw3 === false);',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-form") },
	) && allOk;

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
			"const snap = settingsSnapshot();",
			'ok("面板：装完后注册项 ≥ 7（新建 1 + 看板 3 + 设置 3）", snap.length >= 7);',
			// 测试用的 agentDir 是空的 → 没有助理模板，但也必须至少有「＋ 新建助理」那一行
			'ok("面板：有「助理」分组（没有模板时也有「＋ 新建助理」）", snap.filter((s) => s.group === "助理").length >= 1);',
			'ok("面板：有「看板」分组（3 个动作行）", snap.filter((s) => s.group === "看板").length === 3);',
			'ok("面板：没有「命令」分组（命令一律走命令行，不塞面板）", snap.filter((s) => s.group === "命令").length === 0);',
			'ok("面板：动作行是 action 类型（选中就跑，不参与保存）", snap.filter((s) => s.kind === "action").length >= 4);',
			'ok("面板：有「助理 / 委派」分组（delegate 注册上了）", snap.some((s) => s.group.includes("助理")));',
			'ok("面板：有「会话级」分组（board/gate 注册上了）", snap.some((s) => s.group.includes("会话级")));',
			'ok("面板：不是空板（每一项都有说明，打开就能看）", snap.every((s) => s.desc.length >= 12));',
			'ok("面板：批量实时开关那一行在（superagent.batchLive / bool / 默认关 = 文案里写了）", (() => { const r = snap.find((s) => s.key === "superagent.batchLive"); return !!r && r.kind === "bool" && r.label === "批量实时进度" && r.desc.includes("默认关"); })());',
			// 命令 handler 空参跑一遍：抓 ReferenceError / 拼写错（/aihelp 就踩过 isExtDisabled 没 import）
			"const fakeCtx = { ui: { notify() {}, setStatus() {}, select: async () => undefined, input: async () => undefined, editor: async () => undefined, custom: async () => undefined, theme: { fg: (_c, x) => x, bold: (x) => x } }, hasUI: false, isIdle: () => true, abort() {}, cwd: process.cwd(), sessionManager: { getEntries: () => [] } };",
			"const crashed = [];",
			"for (const [name, c] of Object.entries(cmds)) { try { await c('', fakeCtx); } catch (e) { crashed.push(name + ': ' + (e && e.message)); } }",
			'ok("入口：所有命令 handler 空参跑一遍不炸", crashed.length === 0);',
			'if (crashed.length) console.log("   炸了: " + crashed.join(" | "));',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-entry") },
	) && allOk;

// ---------- 套件：config（拉取连接的重试 / 错误分类） ----------
// 场景：后端冷启动第一次 ~10s 超时，用户点「从配置中心拉取连接」看到 timeout 报错。
// 这里用假 sleep（不真等）验重试编排；不连真实网络。
bundle("config.ts", "config.mjs");
allOk =
	runSuite(
		"config：拉取重试 / 错误分类",
		join(tmp, "config.mjs"),
		[
			'// ---- 错误分类：只有超时/网络类可重试 ----',
			'ok("分类：timeout 文案 → 可重试", isRetriableFetchError(new Error("The operation was aborted due to timeout")) === true);',
			'ok("分类：{name:TimeoutError} 对象 → 可重试（DOMException 不是 Error 子类）", isRetriableFetchError({ name: "TimeoutError" }) === true);',
			'ok("分类：真 DOMException(TimeoutError) → 可重试", isRetriableFetchError(new DOMException("The operation was aborted due to timeout", "TimeoutError")) === true);',
			'ok("分类：fetch failed（断网/连接重置）→ 可重试", isRetriableFetchError(new Error("fetch failed")) === true);',
			'ok("分类：ECONNRESET → 可重试", isRetriableFetchError(new Error("read ECONNRESET")) === true);',
			'ok("分类：密钥不对（401）→ 不重试", isRetriableFetchError(new Error("密钥不对（401）")) === false);',
			'ok("分类：HTTP 500 → 不重试（状态码错重试也没用）", isRetriableFetchError(new Error("中心返回 HTTP 500")) === false);',
			'ok("分类：没给明文 → 不重试", isRetriableFetchError(new Error("中心没给明文（Token 不对？）")) === false);',
			'// ---- 重试编排 ----',
			'const fakeSleep = async () => {};',
			'let n1 = 0;',
			'const r1 = await withRetry(async () => { n1++; return "ok"; }, 3, [800, 2000], fakeSleep);',
			'ok("重试：第一次就成功 → 只调 1 次", r1 === "ok" && n1 === 1);',
			'let n2 = 0;',
			'const r2 = await withRetry(async (i) => { n2++; if (i < 2) throw new Error("The operation was aborted due to timeout"); return i; }, 3, [800, 2000], fakeSleep);',
			'ok("重试：前 2 次超时、第 3 次成功 → 返回成功值且调了 3 次", r2 === 2 && n2 === 3);',
			'let n3 = 0;',
			'let e3;',
			'try { await withRetry(async () => { n3++; throw new Error("The operation was aborted due to timeout"); }, 3, [800, 2000], fakeSleep); } catch (e) { e3 = e; }',
			'ok("重试：3 次都超时 → 抛错，调用 3 次", !!e3 && n3 === 3);',
			'ok("重试：最后一次的错误原样抛出（不是包装成别的）", !!e3 && String(e3.message).includes("timeout"));',
			'let n4 = 0;',
			'let e4;',
			'try { await withRetry(async () => { n4++; throw new Error("密钥不对（401）"); }, 3, [800, 2000], fakeSleep); } catch (e) { e4 = e; }',
			'ok("重试：第一次 401 → 立刻抛，只调 1 次", !!e4 && e4.message === "密钥不对（401）" && n4 === 1);',
			'let n5 = 0;',
			'try { await withRetry(async () => { n5++; throw new Error("中心返回 HTTP 500"); }, 3, [800, 2000], fakeSleep); } catch { /* expected */ }',
			'ok("重试：HTTP 500 不重试 → 只调 1 次", n5 === 1);',
			'const sleeps = [];',
			'try { await withRetry(async () => { throw new Error("timeout"); }, 3, [800, 2000], async (ms) => { sleeps.push(ms); }); } catch { /* expected */ }',
			'ok("重试：等 2 次（attempts-1）", sleeps.length === 2);',
			'ok("重试：间隔按 delays 依次是 800 / 2000", JSON.stringify(sleeps) === JSON.stringify([800, 2000]));',
			'const sleeps2 = [];',
			'await withRetry(async (i) => { if (i < 3) throw new Error("timeout"); return "v"; }, 4, [100], async (ms) => { sleeps2.push(ms); });',
			'ok("重试：delays 不够长时用最后一项兜底（100）", JSON.stringify(sleeps2) === JSON.stringify([100, 100, 100]));',
			'// ---- 默认参数：3 次 + 不出网（fn 自己抛） ----',
			'let n6 = 0;',
			'try { await withRetry(async () => { n6++; throw new Error("socket hang up"); }, undefined, undefined, fakeSleep); } catch { /* expected */ }',
			'ok("重试：默认 attempts=3", n6 === 3);',
			'// ---- onRetry 回调：重试期间给用户可见反馈 ----',
			'const seen = [];',
			'try { await withRetry(async () => { throw new Error("timeout"); }, 3, [800, 2000], fakeSleep, (info) => seen.push(info)); } catch { /* expected */ }',
			'ok("onRetry：3 次尝试 → 2 次回调（= 重试次数）", seen.length === 2);',
			'ok("onRetry：attempt 依次是 1、2", JSON.stringify(seen.map((x) => x.attempt)) === JSON.stringify([1, 2]));',
			'ok("onRetry：waitMs 依次是 800、2000", JSON.stringify(seen.map((x) => x.waitMs)) === JSON.stringify([800, 2000]));',
			'ok("onRetry：attempts 与 error 也一并给出", seen.every((x) => x.attempts === 3 && x.error instanceof Error));',
			'let threwYet = false;',
			'const rThrow = await withRetry(async (i) => { threwYet = true; if (i < 1) throw new Error("timeout"); return "done"; }, 3, [800, 2000], fakeSleep, () => { throw new Error("回调炸了"); });',
			'ok("onRetry：回调内部抱错不影响重试，最终仍能成功", rThrow === "done" && threwYet);',
			'let cb0 = 0;',
			'const rFast = await withRetry(async () => "fast", 3, [800, 2000], fakeSleep, () => { cb0++; });',
			'ok("onRetry：第一次就成功 → 回调没被调", rFast === "fast" && cb0 === 0);',
		],
		{ PI_CODING_AGENT_DIR: join(tmp, "agent-config") },
	) && allOk;

// ---------- 静态检查：删掉的功能不许留"幽灵引用" ----------
// （踩过：hud.ts 删掉后 voice.ts 还 calling answerPlan()/cardNotify()，打包能过、一 reload 才炸）
{
	const files = ["board.ts", "pi-extensions.ts", "config.ts", "panel.ts", "delegate.ts", "gate.ts", "help.ts", "doctor.ts", "shared.ts", "settings.ts", "form.ts", "live.ts", "mcp-pool.ts", "rpc.ts", "actions.ts", "bg-store.ts"];
	let src = "";
	for (const f of files) {
		src += readFileSync(join(ext, f), "utf8");
	}
	// 已彻底删除的模块/功能：谁再 import 或调用，就是幽灵引用
	const ghosts = [
		'from "./voice"', 'from "./voice-tts"', 'from "./notify"', 'from "./telemetry"', 'from "./remote"',
		'from "./speech"', 'from "./speaker"', 'from "./tts', 'from "./qr"', 'from "./telegram-md"',
		"registerVoiceSettings", "registerNotifySettings", "setupVoice(", "setupVoiceTts", "setupTelemetry", "setupRemote",
		"cardNotify(", "speechText(", "setTts(", "getTts(", "sendResult(", "notifyUser(",
		"openPlanAsk(", "answerPlanAsk(", "closePlanAsk(", "hasPendingPlanAsk(", "parsePlanAnswer(",
		"isLowRiskPlan(", "setBackgroundTurn(", "isBackgroundTurn(",
		"boardPriceIn", "boardPriceOut", "boardPriceCache", "voiceClip", "voiceTalk", "voicePopup", "voiceRoute",
		"answerPlan(", "askPlanInHud", "hudPlanAsk", "setPlanAsker", "hudState", "armHud", "disarmHud", "from \"./hud\"",
	];
	const found = ghosts.filter((g) => src.includes(g));
	if (found.length === 0) {
		console.log("PASS  静态：删掉的功能（voice/notify/telemetry/remote/tts/剪贴板桥）没有幽灵引用");
	} else {
		allOk = false;
		console.log("FAIL  静态：删掉的功能还残留引用 → " + found.join(", "));
	}
}
{
	const need = [["delegate.ts", "registerDelegateSettings"], ["board.ts", "registerBoardSettings"], ["gate.ts", "registerGateSettings"]];
	const miss = need.filter(([f, fn]) => !readFileSync(join(ext, f), "utf8").includes(fn));
	const entry = readFileSync(join(ext, "pi-extensions.ts"), "utf8");
	if (miss.length === 0 && entry.includes("openSettings")) {
		console.log("PASS  静态：/aihelp 面板：三个模块都注册了配置项，入口接到 openSettings");
	} else {
		allOk = false;
		console.log("FAIL  静态：面板接线不完整 → 缺:" + miss.map((m) => m[0]).join(",") + " 入口:" + entry.includes("openSettings"));
	}
}
{
	// actions.ts：面板动作行必须真的注册了 action，且执行一律走命令表（不自己重写逻辑）
	const actSrc = readFileSync(join(ext, "actions.ts"), "utf8");
	const checks = {
		"注册动作行": /registerSettings\(/.test(actSrc) && /registerPanelActions\(/.test(actSrc),
		"助理一人一行": /ASSISTANT_PREFIX/.test(actSrc) && /loadTemplates\(/.test(actSrc),
		"打开前刷新": /setOpenRefresher\(/.test(actSrc),
		"命令走 handler": /cmds\.get\(name\)/.test(actSrc),
		"入口接上了": readFileSync(join(ext, "pi-extensions.ts"), "utf8").includes("registerPanelActions(cmds)"),
	};
	const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
	if (bad.length === 0) {
		console.log("PASS  静态：面板动作 actions.ts 完整（助理行 / 命令表 / 打开前刷新 / 入口接线）");
	} else {
		allOk = false;
		console.log("FAIL  静态：actions.ts 缺 → " + bad.join(", "));
	}
}
{
	// 双栏渲染：宽屏两栏、窄屏退回单栏、右栏标题与折行都得在
	const formSrc = readFileSync(join(ext, "form.ts"), "utf8");
	const checks = {
		"宽屏阈值": /const twoCol = width >= 90;/.test(formSrc),
		"两栏分隔": /leftW/.test(formSrc) && /rightW/.test(formSrc) && /┬/.test(formSrc),
		"窄屏退回单栏": /if \(twoCol\)/.test(formSrc) && /wrapText\(this\.detail/.test(formSrc),
		"视口跟光标": /MAX_ROWS/.test(formSrc) && /还有 \$\{more/.test(formSrc),
	};
	const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
	if (bad.length === 0) {
		console.log("PASS  静态：面板双栏渲染完整（宽屏两栏 / 窄屏单栏 / 超长视口跟光标）");
	} else {
		allOk = false;
		console.log("FAIL  静态：双栏渲染缺 → " + bad.join(", "));
	}
}
{
	const setSrc = readFileSync(join(ext, "settings.ts"), "utf8");
	const formSrc = readFileSync(join(ext, "form.ts"), "utf8");
	const checks = {
		"页面栈": /setPages\(/.test(formSrc) && /pushPage\(/.test(formSrc) && /popPage\(/.test(formSrc),
		"分页入口": /showFormPages/.test(formSrc) && /showFormPages\(ctx/.test(setSrc),
		"三页构建": ["settingsHomePage", "settingsGroupPage", "settingsItemPage"].every((n) => setSrc.includes(`function ${n}`)),
		"助理页复用": /assistantFormPage/.test(readFileSync(join(ext, "delegate.ts"), "utf8")),
		"入口不关面板": /runAction/.test(formSrc) && !/return openSettings\(ctx\)/.test(setSrc),
		// 回归：assistantFormParts 的 commit 必须带 ctx（漏了会是 "Cannot read properties of undefined (reading 'form'）"
		"助理页保存带ctx": !/commit: \(r\) => commitForm\(\{ form/.test(readFileSync(join(ext, "delegate.ts"), "utf8")),
	};
	const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
	if (bad.length === 0) {
		console.log("PASS  静态：面板分页完整（页面栈 / 三页 / 助理页复用 / 动作在本页执行）");
	} else {
		allOk = false;
		console.log("FAIL  静态：分页缺 → " + bad.join(", "));
	}
}
{
	const sharedSrc = readFileSync(join(ext, "shared.ts"), "utf8");
	const boardSrc = readFileSync(join(ext, "board.ts"), "utf8");
	const hasCore = ["guardCtx", "getPlanCfg", "readExtCfg", "patchExtCfg"].every((n) => sharedSrc.includes(n));
	const wired = boardSrc.includes('from "./shared"');
	if (hasCore && wired) {
		console.log("PASS  静态：共享层 shared.ts 完整（旧ctx守卫/计划配置/配置读写）且 board 接上了");
	} else {
		allOk = false;
		console.log("FAIL  静态：共享层缺东西 → 核心:" + hasCore + " board接线:" + wired);
	}
}
{
	// Herdr 分屏模式的**接线**（纯函数已经在 herdr 套件里测过，这里只查有没有真的接上）
	const delegateSrc = readFileSync(join(ext, "delegate.ts"), "utf8");
	const liveSrc = readFileSync(join(ext, "live.ts"), "utf8");
	const herdrSrc = readFileSync(join(ext, "herdr.ts"), "utf8");
	const saSrc = readFileSync(join(ext, "superagent.ts"), "utf8");
	const mustExport = [
		"herdrAvailable",
		"paneSplit",
		"paneRun",
		"paneRename",
		"paneClose",
		"paneList",
		"tabCreate",
		"tabRename",
		"tabClose",
		"tabList",
		"paneLabel",
		"resolveUiMode",
	];
	const checks = {
		"herdr.ts 该导出的都导出了": mustExport.filter((n) => !new RegExp(`export function ${n}\\b`).test(herdrSrc)).length === 0,
		"runAssistant 接上 tryRunInHerdr": /const viaPane = await tryRunInHerdr\(/.test(delegateSrc),
		"降级可见（配了 auto/split/tab 却掉到 panel 会说清楚原因）": /const status = herdrStatus\(\);/.test(delegateSrc) && /resolveUiMode\(cfg, activeRuns, status\.ok\)/.test(delegateSrc) && /herdrDownNote\(status\.reason/.test(delegateSrc) && /notifyHerdrDownOnce\(/.test(delegateSrc),
		"溢出 tab 第一格新开 tab、满了开下一个": /tabCreate\(ws, tabLabel\(n\)/.test(delegateSrc) && /herdrExtraTabs/.test(delegateSrc),
		"槽位分配走串行队列（并发不抢同一格）": /function serializeSlotAlloc/.test(delegateSrc) && /await serializeSlotAlloc\(/.test(delegateSrc),
		"成功改 ✅ / 失败改 ❌（保留 pane 时改成「已停」）": delegateSrc.includes('paneLabel("ok"') && delegateSrc.includes('paneLabel("stopped"') && /kind === "stopped"/.test(herdrSrc),
		"失败保留 pane 会先停掉里面的 pi（ctrl+c -> 已停）": /stopKeptPane\(slot\.paneId/.test(delegateSrc) && /export async function stopKeptPane/.test(delegateSrc) && delegateSrc.includes('"ctrl+c"'),
		"panel 里分屏 worker 压成一行": /function renderPaneJob/.test(liveSrc) && /job\.uiMode === "split"/.test(liveSrc),
		"默认 UI 是 auto（不是 panel）": /ui: "auto",/.test(herdrSrc) && !/ui: "panel",/.test(herdrSrc),
		"UI 模式 set 宽松解析（长标签/被截断也能存）": saSrc.includes("UI_VALUES.find((x) => x === raw)") && saSrc.includes("/[ =（(]/"),
		"UI 候选标签不再是超长说明句（面板里看得全）": /const UI_OPTIONS = \[\s*"panel",/.test(saSrc) && !saSrc.includes("auto = ≤2 个用 split，更多溢出到 tab"),
	};
	const bad = Object.entries(checks)
		.filter(([, v]) => v !== true)
		.map(([k]) => k);
	if (bad.length === 0) {
		console.log("PASS  静态：Herdr 分屏接上了（runAssistant 分支 / 溢出建 tab / 降级 / 一行渲染）");
	} else {
		allOk = false;
		console.log("FAIL  静态：Herdr 分屏缺 → " + bad.join(", "));
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
