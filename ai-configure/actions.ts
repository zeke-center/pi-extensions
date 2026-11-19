/**
 * actions.ts —— 把「命令」和「助理」搬进 /aihelp 面板。
 *
 * 为什么单独一个文件：
 *   form.ts 早就有 `kind:"action"` 的能力（选中一行 = 执行一个动作），
 *   但组件级的配置项删光之后就没人用了。这里只负责**把命令挂成动作行**，
 *   不碰面板渲染、不碰各模块内部。
 *
 * 两条设计约束：
 *   1. **动作行不改值**：选中就执行，不参与 ctrl+s 的保存流程（settings.ts 已经处理）。
 *   2. **助理行是动态的**：助理是 `assistants/*.md` 文件，随时会新建。
 *      所以每次打开面板前用 `setOpenRefresher` 重新生成一遍 —— 新建完不用 /reload。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTemplates } from "./delegate";
import type { CommandMap } from "./pi-extensions";
import { registerSettings, setOpenRefresher, settingsCtx, unregisterSettings, type SettingDef } from "./settings";

const ASSISTANT_PREFIX = "act.ai.";
const COMMAND_PREFIX = "act.cmd.";

/** 面板里执行一条命令：handler 就是各模块注册的那个（不重写逻辑） */
type Runner = (name: string, args?: string) => Promise<void>;

function makeRunner(cmds: CommandMap): Runner {
	return async (name, args = "") => {
		const ctx = settingsCtx();
		if (!ctx) {
			console.error(`[ai-configure] actions: 没有 ctx，跳过 /${name}`);
			return;
		}
		const h = cmds.get(name);
		if (!h) {
			ctx.ui.notify(`没找到命令 /${name}（模块没加载全？）`, "warning");
			return;
		}
		try {
			await h(args, ctx);
		} catch (e) {
			ctx.ui.notify(`✗ /${name} 执行失败：${e instanceof Error ? e.message : String(e)}`, "error");
		}
	};
}

/**
 * 二级选单：一行命令挂多个子动作时用（避免面板一屏铺 30 行）。
 * 返回 undefined = 用户 esc 了，什么都不做。
 */
async function pick(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
	try {
		const r = await ctx.ui.select(title, options, undefined);
		return r ?? undefined;
	} catch {
		return undefined;
	}
}

/** 一个「动作行」的定义（kind:"action"，选中就跑 run） */
function action(key: string, group: string, label: string, desc: string, run: (ctx: ExtensionContext) => void | Promise<void>): SettingDef {
	return {
		key,
		group,
		label,
		desc,
		kind: "action",
		def: "",
		// 值不落地：面板把它当"按钮"，settings.ts 在 actionKey 分支里直接调 set("")
		get: () => "",
		set: () => {
			const ctx = settingsCtx();
			if (!ctx) return;
			void (async () => {
				try {
					await run(ctx);
				} catch (e) {
					ctx.ui.notify(`✗ 执行失败：${e instanceof Error ? e.message : String(e)}`, "error");
				}
			})();
		},
	};
}

// --------------------------------------------------------------------------- //
// 助理组：一个助理一行
// --------------------------------------------------------------------------- //

function assistantRows(): SettingDef[] {
	const ctx = settingsCtx();
	const cwd = ctx?.cwd ?? process.cwd();
	let tpls: ReturnType<typeof loadTemplates> = [];
	try {
		tpls = loadTemplates(cwd);
	} catch {
		return [];
	}

	// 能派的排前面，底座/样例在后（和你 /assistants 列表的分组一致）
	const rank = (t: { base?: boolean; demo?: boolean; enabled?: boolean }) => (t.base ? 1 : t.demo ? 2 : t.enabled === false ? 3 : 0);
	const sorted = [...tpls].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));

	const rows: SettingDef[] = sorted.map((t) => {
		const tag = t.base ? "底座" : t.demo ? "样例" : t.enabled === false ? "已停用" : "可派";
		const bits = [tag];
		if (t.extends) bits.push(`← ${t.extends}`);
		if (t.mcp.length) bits.push(`${t.mcp.length} MCP`);
		const brief = (t.desc || t.name || "").replace(/\s+/g, " ").slice(0, 28);
		const detail = [
			`${t.key}：${t.desc || "（没写 desc，模型就不知道什么时候该派它）"}`,
			`${[`${tag}`, t.extends ? `底座 ${t.extends}` : "无底座", t.mcp.length ? `MCP ${t.mcp.join("、")}` : "不连 MCP", `超时 ${t.timeoutMs ? Math.round(t.timeoutMs / 1000) + "s" : "默认"}`, t.agentsMd === false ? "不读 AGENTS.md" : "读 AGENTS.md"].join(" · ")}`,
			`文件：${t.file}`,
			"回车 = 打开编辑面板（名字 / 何时派它 / 底座 / 工作目录 / 模型 / MCP / 超时 / AGENTS.md / 存哪儿 / 正文）",
		].join("\n");
		const row = action(
			`${ASSISTANT_PREFIX}${t.key}`,
			"助理",
			t.key,
			detail,
			async () => {
				const runner = runnerRef;
				if (runner) await runner("assistants", `edit ${t.key}`);
			},
		);
		// 行上显示「可派 · 简述」，比只显示 key 好认
		row.hint = `${bits.join(" · ")}${brief ? ` · ${brief}` : ""}`;
		return row;
	});

	rows.push(
		action(`${ASSISTANT_PREFIX}__new`, "助理", "＋ 新建助理", "新建一个助理模板：可以选一个底座一键派生（自动 extends + 预勾它带的 MCP），也可以从空白开始。", async () => {
			const runner = runnerRef;
			if (runner) await runner("assistants", "new");
		}),
	);
	return rows;
}

/** 由 registerPanelActions 注入，助理行要用它跑 /assistants edit */
let runnerRef: Runner | undefined;

/** 重新生成助理行（面板打开前、以及新建助理之后调用） */
export function refreshAssistantRows(): void {
	try {
		unregisterSettings(ASSISTANT_PREFIX);
		registerSettings(assistantRows());
	} catch {
		/* 助理目录读不到就不显示这组，别把面板搞挂 */
	}
}

// --------------------------------------------------------------------------- //
// 命令组
// --------------------------------------------------------------------------- //

function commandRows(run: Runner): SettingDef[] {
	const G = "命令";
	const direct = (key: string, label: string, desc: string, name: string, args = "") =>
		action(`${COMMAND_PREFIX}${key}`, G, label, `${desc}\n选中等价于敲 /${name}${args ? ` ${args}` : ""}`, () => run(name, args));

	/** 二级选单：options 的显示文本要和 args 一一对应 */
	const menu = (key: string, label: string, desc: string, name: string, items: Array<[string, string]>) =>
		action(`${COMMAND_PREFIX}${key}`, G, label, desc, async (ctx) => {
			const picked = await pick(ctx, `/${name} —— 选一个动作`, items.map(([t]) => t));
			if (picked === undefined) return;
			const hit = items.find(([t]) => t === picked);
			if (hit) await run(name, hit[1]);
		});

	return [
		menu("ai", "/ai 配置中心", "从 AI 配置中心拉连接台账，或看状态 / 自检 / 设密钥 / 关掉连接。", "ai", [
			["拉取连接（打开选择器）", ""],
			["状态：密钥 / 会话级 / 项目级", "status"],
			["自检（模块健康度 / 台账 / MCP / 助理 / 看板）", "doctor"],
			["设置 API 密钥", "token"],
			["关掉本会话拉进来的连接", "off"],
			["关掉项目级连接", "project off"],
			["清空项目级连接", "project clear"],
			["文本版帮助", "help"],
		]),
		menu("agents", "/agents 子代理面板", "派活时的实时面板：形态 / 详情 / 后台任务。", "agents", [
			["开（也是重新叫回）", ""],
			["关掉（下次派活也不再自动弹）", "off"],
			["展开 / 折叠 思考过程", "detail"],
			["整宽面板（默认形态）", "widget"],
			["右侧浮层", "float"],
			["打印成纯文本（调试用）", "text"],
			["看后台任务状态", "bg"],
			["把没投回主会话的立刻重投", "bg redeliver"],
		]),
		menu("ai-ext", "/ai-ext 停用开关", "会话级停用整个扩展（面板收起、工具撤下、回投暂停）。", "ai-ext", [
			["停用（本会话）", "off"],
			["恢复", "on"],
			["看当前状态", "status"],
		]),
		menu("delegate-mode", "/delegate-mode 派活模式", "派活默认同步等结果，还是异步派完就走。", "delegate-mode", [
			["异步：派完就走，完成自动回投（默认）", "async"],
			["同步：派完等结果才继续", "sync"],
		]),
		direct("usage", "/usage 全局 token 账", "本会话 + 所有子代理的 token 明细。", "usage"),
		direct("resume", "/resume-agent 助理会话", "翻看助理的历次会话（它们不在 /resume 里）。", "resume-agent"),
		direct("back", "/agent-resume-back 回主会话", "从助理会话一键回主会话。", "agent-resume-back"),
	];
}

/** 看板组：都是动作（真正的开关在看板模块自己的「会话级」里） */
function boardRows(run: Runner): SettingDef[] {
	const G = "看板";
	return [
		action(`${COMMAND_PREFIX}board.clear`, G, "清空任务列表", "把看板上的计划和步骤都清掉（等价 /board clear）。面板上不留残留。", () => run("board", "clear")),
		action(`${COMMAND_PREFIX}board.pos`, G, "面板位置", "任务看板贴在输入框上方还是下方。等价 /board above | below。", async (ctx) => {
			const picked = await pick(ctx, "任务看板放在哪儿？", ["输入框上方（默认）", "输入框下方"]);
			if (picked) await run("board", picked.includes("下方") ? "below" : "above");
		}),
		action(`${COMMAND_PREFIX}board.cols`, G, "栏位显示", "右栏（MCP / 插件 / 助理）和中栏（运行状态 / 用量）要不要显示。等价 /board right | mid。", async (ctx) => {
			const picked = await pick(ctx, "要切哪个栏位？", ["右栏：MCP / 插件 / 助理 显示或隐藏", "中栏：运行状态 / 用量 显示或隐藏"]);
			if (picked) await run("board", picked.startsWith("右栏") ? "right" : "mid");
		}),
	];
}

// --------------------------------------------------------------------------- //
// 注册
// --------------------------------------------------------------------------- //

/**
 * 入口在所有模块装配完之后调这里。
 * cmds = 各模块注册的命令表（pi-extensions.ts 里拦下来的）。
 */
export function registerPanelActions(cmds: CommandMap): void {
	const run = makeRunner(cmds);
	runnerRef = run;

	// 助理行与命令行都走 openRefresher：助理列表会变，命令表在 /reload 后也可能变
	setOpenRefresher(() => {
		unregisterSettings(ASSISTANT_PREFIX);
		unregisterSettings(COMMAND_PREFIX);
		registerSettings(assistantRows());
		registerSettings(boardRows(run));
		registerSettings(commandRows(run));
	});

	// 启动时先填一批（不发面板也能被 settingsSnapshot / 测试看到）
	refreshAssistantRows();
	registerSettings(boardRows(run));
	registerSettings(commandRows(run));
}
