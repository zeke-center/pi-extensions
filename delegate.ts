/**
 * delegate · 派活给临时助理（最小版）
 *
 * 一个工具：delegate(assistant, task) —— 起一个**独立的后台 pi 进程**干活，
 * 干完只把一张卡带回来。它的中间过程不进主对话（但留在它自己的会话文件里，可回看）。
 *
 * 设计约束（刻意保持最小）：
 *   - 同步跑，不并行
 *   - 不走 RPC，不托管进程
 *   - 助理之间不能互相派活（给子进程加了 -xt delegate）
 *   - 干完进程即销毁 = 临时工
 *
 * 模板 = <项目>/.pi/assistants/*.md 或 <agentDir>/assistants/*.md
 *   frontmatter: name / desc / cwd / model
 *   正文 = 该助理的系统提示词
 *
 * 用法:
 *   /assistants                        列出所有助理模板
 *   让模型调 delegate(assistant="db", task="查一下 X")
 *
 * 环境变量（可选）:
 *   PI_CLI          手动指定 pi 的 CLI 入口（默认自动找）
 *   PI_PACKAGE_DIR  覆盖 pi 包目录（Nix/Guix 场景）
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_KEY = "delegate";

// ======================= 类型 =======================
interface Template {
	/** 模板名 = 文件名去掉 .md */
	key: string;
	/** 显示名（frontmatter.name），默认用 key */
	name: string;
	/** 何时该叫我（frontmatter.desc） */
	desc: string;
	/** 工作目录 —— 决定它有哪些 MCP / 项目配置 */
	cwd: string;
	/** 模型（frontmatter.model），空则不指定、继承默认 */
	model?: string;
	/** 系统提示词正文 */
	body: string;
	/** 模板文件路径 */
	file: string;
}

// ======================= 模板加载 =======================
/** 模板搜索目录：项目级优先，全局其次 */
function templateDirs(cwd: string): string[] {
	const dirs: string[] = [];
	const project = join(cwd, ".pi", "assistants");
	if (existsSync(project)) dirs.push(project);
	const global = join(getAgentDir(), "assistants");
	if (existsSync(global)) dirs.push(global);
	return dirs;
}

function expandHome(p: string): string {
	return p.replace(/^~(?=[/\\]|$)/, homedir());
}

/** 极简 frontmatter 解析：--- 之间是 key: value，其余是正文 */
function parseTemplate(file: string, key: string): Template | null {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	const meta: Record<string, string> = {};
	let body = raw;
	if (m) {
		body = raw.slice(m[0].length);
		for (const line of m[1].split(/\r?\n/)) {
			const i = line.indexOf(":");
			if (i <= 0) continue;
			const k = line.slice(0, i).trim().toLowerCase();
			const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
			if (k && v) meta[k] = v;
		}
	}
	if (!meta.cwd) return null; // 必须有工作目录
	return {
		key,
		name: meta.name || key,
		desc: meta.desc || "(没有描述)",
		cwd: expandHome(meta.cwd),
		model: meta.model || undefined,
		body: body.trim(),
		file,
	};
}

function loadTemplates(cwd: string): Template[] {
	const seen = new Set<string>();
	const out: Template[] = [];
	for (const dir of templateDirs(cwd)) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.endsWith(".md")) continue;
			const key = e.slice(0, -3);
			if (seen.has(key)) continue; // 项目级优先
			const file = join(dir, e);
			try {
				if (!statSync(file).isFile()) continue;
			} catch {
				continue;
			}
			const t = parseTemplate(file, key);
			if (!t) continue;
			seen.add(key);
			out.push(t);
		}
	}
	return out;
}

// ======================= 找 pi 的 CLI =======================
/** 返回可直接 spawn 的入口；找不到返回 null */
function resolveCli(): string | null {
	const candidates: string[] = [];
	const envCli = process.env.PI_CLI;
	if (envCli && existsSync(envCli)) candidates.push(envCli);
	const pkgDir = process.env.PI_PACKAGE_DIR;
	if (pkgDir) {
		const p = join(pkgDir, "dist", "bundle", "cli.js");
		if (existsSync(p)) candidates.push(p);
	}
	// 扩展跑在 pi 进程内，argv[1] 就是 CLI 入口（已实测）
	const argv1 = process.argv[1];
	if (argv1 && /\.(js|cjs|mjs)$/i.test(argv1) && existsSync(argv1)) candidates.push(argv1);
	return candidates[0] ?? null;
}

// ======================= 交卡要求 =======================
function cardPrompt(task: string): string {
	return `【任务】
${task}

【交卡要求】
只输出下面三行，不要写别的东西，不要用 markdown 代码块包起来：

状态: 完成 或 卡住 或 需要信息
结论: 一句话说清结果（要数据/结论，不要写过程）
证据: 你怎么确认的，最多 3 行（表名 / 命令 / 关键输出 / 改了哪些文件）

如果你卡住了、或需要别人给你信息才能继续，把「需要什么」写进结论，状态写「需要信息」。
不要猜，不要编。做不到就说做不到。`;
}

// ======================= 跑一个助理 =======================
interface RunResult {
	ok: boolean;
	text: string;
	elapsedMs: number;
	exitCode: number | null;
	timedOut: boolean;
}

function runAssistant(
	tpl: Template,
	task: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<RunResult> {
	const cli = resolveCli();
	if (!cli) {
		return Promise.resolve({
			ok: false,
			text: "找不到 pi 的 CLI 入口。请设置环境变量 PI_CLI 指向 pi 的 cli.js。",
			elapsedMs: 0,
			exitCode: null,
			timedOut: false,
		});
	}

	const args = [
		cli,
		"-p",
		"--name",
		`助理:${tpl.name}`,
		"-xt",
		"delegate", // 助理不能再派人（防递归）
	];
	if (tpl.model) args.push("--model", tpl.model);
	if (tpl.body) args.push("--append-system-prompt", tpl.body);

	const started = Date.now();

	return new Promise<RunResult>((done) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const child = spawn(process.execPath, args, {
			cwd: tpl.cwd,
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});

		const finish = (ok: boolean, exitCode: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			done({ ok, text: stdout.trim(), elapsedMs: Date.now() - started, exitCode, timedOut });
		};

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		}, timeoutMs);

		const onAbort = (): void => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		};
		signal.addEventListener("abort", onAbort);

		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});
		child.on("error", (e) => {
			stderr += `\n[spawn 失败] ${e.message}`;
			finish(false, null);
		});
		child.on("close", (code) => {
			if (timedOut) {
				stdout += `\n[超时 ${Math.round(timeoutMs / 1000)}s，已杀掉]`;
			} else if (code !== 0 && !stdout.trim()) {
				stdout += `[退出码 ${code}]\n${stderr.trim().split("\n").slice(-8).join("\n")}`;
			}
			finish(code === 0 && !timedOut && stdout.trim().length > 0, code);
		});

		// 任务正文走 stdin —— 避开命令行转义问题
		try {
			child.stdin?.write(cardPrompt(task), "utf8");
			child.stdin?.end();
		} catch (e) {
			stderr += `\n[写入任务失败] ${e instanceof Error ? e.message : e}`;
		}
	});
}

// ======================= 工具参数 =======================
const DelegateParams = Type.Object({
	assistant: Type.String({ description: "助理模板名（先用 /assistants 看有哪些），例如 db 、 backend" }),
	task: Type.String({
		description: "要它做的事。写清：目标 + 怎么算干完（验收标准）。不要写「分析一下」这种模糊指令。",
	}),
	timeoutMs: Type.Optional(Type.Number({ description: "超时毫秒，默认 600000（10 分钟）" })),
});

// ======================= 注册 =======================
export default function (api: ExtensionAPI): void {
	api.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"把一个任务派给一个**临时助理**（另起一个独立的 pi 进程）去干，只把一张卡片（状态/结论/证据）带回来。" +
			"适合：过程很脏、需要试错、你只要结论的活。不适合：查一条数据你也想看过程 —— 那种自己用 MCP 查。" +
			"助理干完即销毁，不能互相派活。",
		parameters: DelegateParams,

		async execute(
			_toolCallId: string,
			params: { assistant: string; task: string; timeoutMs?: number },
			signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const cwd = ctx.cwd ?? process.cwd();
			const templates = loadTemplates(cwd);
			const tpl = templates.find((t) => t.key === params.assistant || t.name === params.assistant);

			if (!tpl) {
				const have = templates.length ? templates.map((t) => `${t.key}(${t.name})`).join(", ") : "(一个都没有)";
				return {
					content: [{ type: "text" as const, text: `找不到助理「${params.assistant}」。可用：${have}` }],
					details: { ok: false, reason: "template_not_found" },
				};
			}

			if (!existsSync(tpl.cwd)) {
				return {
					content: [{ type: "text" as const, text: `助理「${tpl.name}」的工作目录不存在：${tpl.cwd}` }],
					details: { ok: false, reason: "cwd_not_found" },
				};
			}

			const total = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;

			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `📤 ${tpl.name} 干活中…`));
			let r: RunResult;
			try {
				r = await runAssistant(tpl, params.task, total, signal);
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			}

			const secs = Math.round(r.elapsedMs / 1000);
			const head = r.ok ? `【${tpl.name}】回来了一张卡（${secs}s）` : `【${tpl.name}】没干成（${secs}s）`;
			const tail = `\n— ${tpl.key} · cwd ${tpl.cwd}${tpl.model ? ` · ${tpl.model}` : ""}`;
			const text = `${head}\n\n${r.text || "(没有任何输出)"}${tail}`;

			return { content: [{ type: "text" as const, text }], details: { ok: r.ok, elapsedMs: r.elapsedMs } };
		},
	});

	api.registerCommand("assistants", {
		description: "列出可用的助理模板",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const cwd = ctx.cwd ?? process.cwd();
			const templates = loadTemplates(cwd);
			const dirs = templateDirs(cwd);
			if (!templates.length) {
				ctx.ui.notify(
					`没有找到助理模板。\n找过：${dirs.length ? dirs.join("\n") : "(目录都不存在)"}\n` +
						`新建一个：${join(getAgentDir(), "assistants", "myname.md")}`,
					"warning",
				);
				return;
			}
			const lines = templates.map((t) => `• ${t.key} — ${t.name}\n    ${t.desc}\n    cwd: ${t.cwd}${t.model ? `\n    model: ${t.model}` : ""}`);
			ctx.ui.notify(`${templates.length} 个助理模板\n\n${lines.join("\n")}`, "info");
		},
	});
}
