/**
 * gitread.ts —— `git_read`：**只读**的 git 查看工具（Super Agent 模式里 Router 用）。
 *
 * 为什么需要它
 * ----------
 * Super Agent 模式下主会话（Router）被摘掉 bash，只留 read/grep。但验收 Worker 的活
 * 恰恰要看 git：改了哪些文件（status）、改了什么（diff）、最近提交（log）、某个提交的内容（show）。
 * 没有它，Router 只能信 Worker 的一面之词。
 *
 * 为什么不是"给 bash 加白名单"
 * --------------------------
 * 因为那需要运行期拦截（先试再被拦，体验很差，还会被注入绕过）。
 * 这里直接把动作空间收成 4 个子命令 —— 模型**根本想不到** `git push`，
 * 因为参数类型里没有这个选项。
 *
 * 安全约束
 * -------
 * · 只接受 status / diff / log / show 四个子命令（其余直接拒，且说明"这是策略性拒绝，别重试"）
 * · 用 spawn(参数数组) 执行，**不经过 shell**（避免 `;` `&&` `$(...)` 注入）
 * · 不接受任意 flag（只认一小份白名单：--stat/--name-only/-n/--oneline 等）
 * · 输出有上限（默认 20k 字符），超出截断并提示用 --stat 之类手段缩小
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { logEvent } from "./log";

/** 允许的子命令 */
const ALLOWED_SUB = ["status", "diff", "log", "show"] as const;
type Sub = (typeof ALLOWED_SUB)[number];

/** 允许的 flag（按子命令分开；不在表里的一律拒） */
const ALLOWED_FLAGS: Record<Sub, string[]> = {
	status: ["--short", "--porcelain", "--branch", "-s", "-b", "--"],
	// -U 的位数不用枚举（写死 -U0/-U1/-U3 时用户传 -U2 就被拒了，纯属自找麻烦）
	diff: ["--stat", "--name-only", "--name-status", "--cached", "--staged", "--"],
	log: ["--oneline", "--stat", "--name-only", "-n", "--graph", "--decorate", "--all", "--"],
	show: ["--stat", "--name-only", "--oneline", "-U"],
};

const MAX_OUT = 20_000;

const GitReadParams = Type.Object({
	sub: Type.Union(
		[Type.Literal("status"), Type.Literal("diff"), Type.Literal("log"), Type.Literal("show")],
		{ description: "git 子命令：status / diff / log / show（只读，不能 add/commit/push）" },
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"额外参数。flag 只允许 --short/--stat/--name-only/--oneline/-n/-U<n>（任意位数）/-- 这类查看用参数；也可以是文件路径或 commit hash",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "在哪个仓库执行（默认当前会话目录）" })),
});

interface RunOut {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** 跑 git（参数数组，无 shell） */
function runGit(args: string[], cwd: string): Promise<RunOut> {
	return new Promise((done) => {
		let out = "";
		let err = "";
		let child;
		try {
			child = spawn("git", args, { cwd, windowsHide: true, shell: false });
		} catch (e) {
			done({ code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
			return;
		}
		child.stdout?.on("data", (b: Buffer) => {
			if (out.length < MAX_OUT) out += b.toString("utf8");
		});
		child.stderr?.on("data", (b: Buffer) => {
			if (err.length < 4000) err += b.toString("utf8");
		});
		child.on("error", (e) => done({ code: null, stdout: out, stderr: err + String(e) }));
		child.on("close", (code) => done({ code, stdout: out, stderr: err }));
	});
}

/** 拒绝时的话术：**一次性、明确不可重试、给替代方案**（这是减少"穷举"的关键） */
function refuse(why: string): string {
	return (
		`EPERM[git_read] ${why}\n\n` +
		"这是**策略性拒绝**：换参数、换写法都不会成功，**不要重试**。\n" +
		"`git_read` 只做查看：status / diff / log / show。要改仓库（add/commit/push/checkout）请让用户放开权限，或派 Worker 去做。"
	);
}

export function setupGitRead(api: ExtensionAPI): void {
	const tool = {
		name: "git_read",
		label: "Git 只读",
		description:
			"只读地查看 git 仓库：status（改了哪些文件）/ diff（改了什么）/ log（最近提交）/ show（某个提交）。" +
			"不能 add / commit / push / checkout —— 那是写操作，会被拒。",
		promptSnippet: "查看 git 状态与差异（只读，不能提交）",
		promptGuidelines: [
			"验收 Worker 的改动时，先 git_read diff --stat 看范围，再 git_read diff 看细节。",
			"不要试图用 git_read 做写操作（add/commit/push），它只读。",
		],
		parameters: GitReadParams,

		async execute(
			_toolCallId: string,
			params: { sub: Sub; args?: string[]; cwd?: string },
			_args: unknown,
			ctx: ExtensionContext,
		): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
			const sub = params.sub;
			if (!ALLOWED_SUB.includes(sub)) {
				logEvent("tool.reject", { tool: "git_read", why: "bad-sub", arg: String(sub) }, "warn");
				return { content: [{ type: "text", text: refuse(`不支持子命令「${String(sub)}」`) }], isError: true };
			}
			const allowed = ALLOWED_FLAGS[sub];
			const extra: string[] = [];
			for (const raw of params.args ?? []) {
				const a = String(raw ?? "").trim();
				if (!a) continue;
				if (a.startsWith("-")) {
					// `-U0` / `-U1` / `-U2` / `-U99`：上下文行数是查看用参数，位数不该枚举
					if (/^-U\d+$/.test(a)) {
						extra.push(a);
						continue;
					}
					// flag：只认表里的（`-n 5` 这种带值的，值不是 flag 会走下面的分支）
					const base = a.split("=")[0] ?? a;
					if (!allowed.some((f) => base === f || base.startsWith(`${f}=`) || base === f.replace(/^-+/, "-"))) {
						logEvent("tool.reject", { tool: "git_read", why: "not-allowed-flag", arg: a, sub }, "warn");
						return { content: [{ type: "text", text: refuse(`参数「${a}」不在只读白名单里`) }], isError: true };
					}
					extra.push(a);
				} else {
					// 非 flag：路径或 commit hash（不允许出现 shell 元字符）
					if (/[;&|<>`$(){}[\]!*?\n\r]/.test(a)) {
						logEvent("tool.reject", { tool: "git_read", why: "suspicious-arg", arg: a, sub }, "warn");
						return { content: [{ type: "text", text: refuse(`参数「${a}」含可疑字符`) }], isError: true };
					}
					extra.push(a);
				}
			}

			const cwd = params.cwd?.trim() || ctx.sessionManager?.getCwd?.() || process.cwd();
			const r = await runGit([sub, ...extra], cwd);
			const body = (r.stdout || "").trim();
			const errText = (r.stderr || "").trim();
			if (r.code !== 0 && !body) {
				return {
					content: [{ type: "text", text: `git ${sub} 失败（exit ${r.code ?? "?"}）：${errText || "(没有输出)"}` }],
					isError: true,
				};
			}
			const truncated = r.stdout.length >= MAX_OUT;
			const text =
				`$ git ${sub} ${extra.join(" ")}`.replace(/\s+$/, "") +
				"\n" +
				(body || "(没有输出 —— 工作区可能是干净的)") +
				(truncated ? `\n\n…（输出超过 ${MAX_OUT} 字符已截断；用 --stat 或更小的范围重看）` : "");
			return { content: [{ type: "text", text }] };
		},
	};

	api.registerTool(tool as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
}
