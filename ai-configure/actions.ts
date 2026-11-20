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
import { pickFromList } from "./form";
import { assistantFormPage, assistantNewPage, isProjectFile, loadTemplates } from "./delegate";
import type { CommandMap } from "./pi-extensions";
import { registerSettings, setOpenRefresher, settingsCtx, unregisterSettings, type SettingDef } from "./settings";

const ASSISTANT_PREFIX = "act.ai.";

/** 按**显示宽度**截断（中文算 2 列），超了补省略号 —— 左栏就 30 来列，别让它把边框撑开 */
function clip(s: string, cols: number): string {
	let n = 0;
	let out = "";
	for (const ch of s) {
		const w = (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
		if (n + w > cols) return `${out}…`;
		out += ch;
		n += w;
	}
	return out;
}
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
		// ⚠️ 用**弹窗**版（ctx.ui.custom），不要用 ctx.ui.select：
		// 那个是 pi 的输入框内联提示，会掉到输入框下面去，跟面板不是一套观感。
		return await pickFromList(ctx, title, options);
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
		const brief = clip((t.desc || t.name || "").replace(/\s+/g, " "), 11);
		const role = t.base ? "底座" : t.demo ? "示例样板" : t.enabled === false ? "已停用" : "可派";
		const detail = [
			`${t.desc || "（没写 desc —— 模型就不知道什么时候该派它）"}`,
			"",
			`角色：${role}${t.extends ? `（继承 ${t.extends}）` : ""}`,
			`MCP：${t.mcp.length ? t.mcp.join("、") : "不连"}`,
			`超时：${t.timeoutMs ? Math.round(t.timeoutMs / 1000) + "s" : "默认"}`,
			`AGENTS.md：${t.agentsMd === false ? "不读" : "读"}`,
			`文件：${t.file}`,
			"",
			t.base
				? "底座只读：只能被 extends。要定制就「＋ 新建助理」派生一个。"
				: "回车进入 → 能改：文件名 / 显示名 / 何时派它 / 底座 / 工作目录 / 模型 / MCP / 超时 / AGENTS.md / 存哪儿 / 提示词正文",
		].join("\n");
		const row = action(
			`${ASSISTANT_PREFIX}${t.key}`,
			"助理",
			t.key,
			detail,
			async () => {
				// 兜底：只有面板翻页失败时才会真的跑这条命令
				const runner = runnerRef;
				if (runner) await runner("assistants", `edit ${t.key}`);
			},
		);
		// 行上显示「可派 · 简述」，比只显示 key 好认
		// 来源徽标：一眼看出改它会影响所有项目（全局）还是只影响这个项目
		const from = isProjectFile(t.file, cwd) ? "本项目" : "全局";
		row.hint = `${from} · ${bits.join(" · ")}${brief ? ` · ${brief}` : ""}`;
		// 面板里回车直接翻进这一页（同一个框，esc 返回），不另开面板
		row.page = () => {
			const c = settingsCtx();
			return c ? assistantFormPage(c, c.cwd ?? process.cwd(), t.key) : undefined;
		};
		return row;
	});

	const newRow = action(
		`${ASSISTANT_PREFIX}__new`,
		"助理",
		"＋ 新建助理",
		"新建一个助理模板：可以选一个底座一键派生（自动 extends + 预勾它带的 MCP），也可以从空白开始。",
		async () => {
			const runner = runnerRef;
			if (runner) await runner("assistants", "new");
		},
	);
	// 面板里回车 = 在同一个框里翻到「新建」页（不跑命令，否则又是两个面板）
	newRow.page = () => {
		const c = settingsCtx();
		return c ? assistantNewPage(c, c.cwd ?? process.cwd()) : undefined;
	};
	rows.push(newRow);
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

/** 看板组：都是动作（真正的开关在看板模块自己的「会话级」里） */
function boardRows(run: Runner): SettingDef[] {
	const G = "看板";
	return [
		action(
			`${COMMAND_PREFIX}board.clear`,
			G,
			"清空任务列表",
			"把看板上的计划和步骤**全部清掉**，面板立刻变空。\n\n⚠ 不可撤销：会话记录里还能翻到历史，但面板不再显示。\n\n等价 `/board clear`。",
			() => run("board", "clear"),
		),
		action(
			`${COMMAND_PREFIX}board.pos`,
			G,
			"面板位置",
			"任务看板贴在哪一侧：**上方**（默认，推荐 —— 不挡输入）或**下方**。\n只影响显示位置，不影响任何功能。\n\n等价 `/board above` / `/board below`。",
			async (ctx) => {
				const picked = await pick(ctx, "任务看板放在哪儿？", ["输入框上方（默认）", "输入框下方"]);
				if (picked) await run("board", picked.includes("下方") ? "below" : "above");
			},
		),
		action(
			`${COMMAND_PREFIX}board.cols`,
			G,
			"栏位显示",
			"两栏各管一块：\n\n**右栏** = MCP / 插件 / 助理 那几列（终端窄就关掉）。\n**中栏** = 本轮运行状态 + token 用量。\n\n等价 `/board right` / `/board mid`。",
			async (ctx) => {
				const picked = await pick(ctx, "要切哪个栏位？", ["右栏：MCP / 插件 / 助理 显示或隐藏", "中栏：运行状态 / 用量 显示或隐藏"]);
				if (picked) await run("board", picked.startsWith("右栏") ? "right" : "mid");
			},
		),
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
	});

	// 启动时先填一批（不发面板也能被 settingsSnapshot / 测试看到）
	refreshAssistantRows();
	registerSettings(boardRows(run));
}
