/**
 * gate.ts —— 「一键停用整个扩展」的**会话级**闸门。
 *
 * 为什么需要：不想为了关功能去删插件文件 / 改 settings；有时只是「这一轮别让看板、助理、
 * MCP 配置掺和」。停用后**不用卸载**，`/ai-ext on` 立刻回来。
 *
 * 机制（三条）：
 *   1. 状态只有一处：本模块的 `disabled`。各模块在自己入口首行 `if (isExtDisabled()) return;`，
 *      并在 setup 末尾用 `onGateApply("名字", fn)` 登记「怎么关自己」（登记时立刻按当前状态跑一次）。
 *   2. 工具没法反注册（pi 官方说法：*re-register a tool with `exposure: "hidden"` to withdraw it*），
 *      所以停用时把 `progress` / `delegate` 用 `exposure:"hidden"` 重新注册；恢复时按原定义重注册。
 *   3. **会话级**：状态写进本会话的自定义 entry（`appendEntry`，不进模型上下文），
 *      `session_start` 读回来 → 换个会话 / 新会话自动恢复启用；老规矩，入口 `/ai-ext` 自己永远可用，
 *      否则关掉就开不回来了。
 *
 * 启动即停用：`pi --no-ai-ext`，或环境变量 `PI_AI_EXT=off`。
 *
 * ⚠️ 别把 off/on 当灯按：工具集变化会被 pi 写进 transcript（下次请求前追加），
 *    provider 不支持过渡时会收到完整 checkpoint → 缓存前缀作废。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 会话条目类型：只进会话文件，不进模型上下文 */
const ENTRY_TYPE = "ai-ext-off";

let disabled = false;
/** setupGate 里存下的 api（取/恢复激活工具集合用） */
let gateApi: ExtensionAPI | undefined;
/** 停用前的「激活工具集合」快照；恢复时按它还原 —— 别把我们撤下的工具又擅自激活 */
let activeSnapshot: string[] | undefined;

/** 各模块登记的「应用停用 / 恢复」回调 */
const appliers: Array<{ name: string; apply: (off: boolean) => void }> = [];

/** 快照只取一次：取的那一刻必须是「我们的工具还处于正常（direct/active）状态」的时候 */
function snapActiveTools(): void {
	if (activeSnapshot) return;
	try {
		activeSnapshot = gateApi?.getActiveTools();
	} catch {
		activeSnapshot = undefined;
	}
}

export function isExtDisabled(): boolean {
	return disabled;
}

/**
 * 模块登记自己的开关逻辑。**注册时立刻执行一次**（拿到当前状态），
 * 所以要在自己的 setup **末尾**调 —— 那时模块内部状态都已就绪。
 */
export function onGateApply(name: string, apply: (off: boolean) => void): void {
	appliers.push({ name, apply });
	// 启动即停用的情况：模块刚把自己的工具注册成 direct，此刻正是「正常状态」→ 趁机快照
	if (disabled) snapActiveTools();
	try {
		apply(disabled);
	} catch (e) {
		console.error(`[ai-configure] gate: 模块 ${name} 应用停用态失败：`, e);
	}
}

function applyAll(): void {
	for (const { name, apply } of appliers) {
		try {
			apply(disabled);
		} catch (e) {
			// 一块坏不许带下水：其余模块照常切换
			console.error(`[ai-configure] gate: 模块 ${name} 应用停用态失败：`, e);
		}
	}
}

/** 本会话最后一条停用记录说了算 */
function readSessionOff(ctx: ExtensionContext): boolean {
	try {
		const entries = ctx.sessionManager.getEntries() as Array<{
			type?: string;
			customType?: string;
			data?: { off?: boolean };
		}>;
		const last = entries.filter((e) => e.type === "custom" && e.customType === ENTRY_TYPE).pop();
		return last?.data?.off === true;
	} catch {
		return false; // 读不到就按启用
	}
}

/** 切换状态（唯一的入口：快照 → 各模块应用 → 恢复时还原激活工具集） */
function setDisabled(next: boolean): void {
	if (next === disabled) return;
	if (next) snapActiveTools();
	disabled = next;
	applyAll();
	if (!next && activeSnapshot) {
		// 各模块已经把工具重新注册回 direct（= 激活），这里按快照把用户自己的选择盖回去
		try {
			gateApi?.setActiveTools(activeSnapshot);
		} catch {
			/* 还原不了也不算错：至少功能回来了 */
		}
		activeSnapshot = undefined;
	}
}

export function setupGate(api: ExtensionAPI): void {
	gateApi = api;
	// ---------- 启动即停用（flag / 环境变量）----------
	try {
		api.registerFlag("no-ai-ext", {
			description: "本次运行停用 ai-configure 扩展的全部功能（面板 / progress / delegate）",
			type: "boolean",
			default: false,
		});
	} catch {
		/* 已注册过就算了 */
	}
	const envOff = /^(off|0|false|no)$/i.test(String(process.env.PI_AI_EXT ?? "").trim());
	let flagOff = false;
	try {
		flagOff = api.getFlag("no-ai-ext") === true;
	} catch {
		/* ignore */
	}
	if (flagOff || envOff) disabled = true;

	// ---------- 会话级状态：开场读回来 ----------
	// ⚠️ 本 handler 必须**第一个**注册（入口里 setupGate 排最前），否则看板会先画一帧。
	// ⚠️ CLI flag（--no-ai-ext）的值要等扩展加载完才注入 runtime，所以**这里再判一次**
	//    （setup 时 getFlag 只能拿到 default）。
	api.on("session_start", (_event, ctx) => {
		let flagOff = false;
		try {
			flagOff = api.getFlag("no-ai-ext") === true;
		} catch {
			/* ignore */
		}
		// 优先级：本次运行的 flag / 环境变量 > 本会话记住的状态
		const off = flagOff || envOff || readSessionOff(ctx);
		setDisabled(off); // 只在真的变了才动（内部已判）
	});

	// ---------- 开关命令（自己永不停用）----------
	api.registerCommand("ai-ext", {
		description: "会话级停用/恢复本扩展（面板 · progress · 助理派发与回投）：/ai-ext [off|on|status]",
		handler: async (args: string, ctx: ExtensionContext) => {
			const a = (args ?? "").trim().toLowerCase();

			if (a === "off" || a === "on") {
				const next = a === "off";
				if (next === disabled) {
					ctx.ui.notify(`已经是「${next ? "停用" : "启用"}」状态了`, "info");
					return;
				}
				try {
					// 只写本会话 → 别的会话、新会话都是启用态
					api.appendEntry(ENTRY_TYPE, { off: next, at: Date.now() });
				} catch {
					/* 写不进会话文件也不挡住切换 */
				}
				setDisabled(next);
				ctx.ui.notify(
					next
						? "本会话已停用扩展：面板收起、progress/delegate 从工具表撤下、后台回投暂停（/ai-ext on 恢复；本会话记住）"
						: "本会话已恢复扩展：面板/工具/回投都回来了" + (appliers.length ? "" : "（模块还没登记，稍后自动生效）"),
					"info",
				);
				return;
			}

			// status / 无参数 / 认不出的参数
			const lines: string[] = [];
			lines.push(disabled ? "⛔ 已停用（本会话）" : "✅ 启用中");
			lines.push(disabled ? "　　改写用 /ai-ext on；换会话自动恢复启用" : "　　要关：/ai-ext off（本会话记住）");
			lines.push(`　　已接入闸门的模块：${appliers.map((x) => x.name).join(" / ") || "（还没登记）"}`);
			if (disabled) {
				lines.push("　　工具：progress、delegate 已按 hidden 撤下（模型看不到）");
				lines.push("　　后台投递：暂停；已跑完的小票保留，/ai-ext on 后自动补投");
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
