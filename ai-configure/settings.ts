/**
 * settings.ts —— 可视化配置面板（像 `/mcp` / `/assistants` 那样的**表单弹窗**）。
 *
 * 为什么要有它：配置项越来越多，全靠子命令记不住也没法浏览。
 * 这里做两件事：
 *   1. **注册表**：各模块（delegate / board / gate …）把自己可配置的项注册进来，
 *      每项都要写清「这是干什么用的」——面板里会显示；
 *   2. **面板**：复用 `form.ts` 的 FormPane（和 `/assistants` 同一个外观）：
 *      `▸ 名称   值   (提示)` 一行一项，选中行的完整说明显示在下面那行；
 *      `↑↓` 选行 · `回车` 改（bool 直接翻 / enum 展开候选 / 数字文本行内输入）· `ctrl+s` 保存 · `esc` 取消。
 *
 * 注册项是「自助餐」式的：以后加新配置只要 `registerSettings([...])`，
 * 面板不用改一行 —— DIY 项（触发词这类）也走同一条路。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FormField, type FormPage, showForm, showFormPages } from "./form";

// ======================= 注册表 =======================

export type SettingKind = "bool" | "enum" | "number" | "text" | "list" | "action";

export interface SettingDef {
	/** 配置键（写进 ai-extensions.json 的名字）；会话级项也给个稳定 id */
	key: string;
	/** 分组（显示在标签前缀，例如「剪贴板·触发词」） */
	group: string;
	/** 面板里显示的名字（短） */
	label: string;
	/** **干什么用的**（面板下方那行完整说明） */
	desc: string;
	kind: SettingKind;
	/** enum 的候选（显示文本） */
	options?: string[];
	/** enum 候选对应的真实取值（不传 = 用 options 原文） */
	values?: (string | number | boolean)[];
	min?: number;
	max?: number;
	unit?: string;
	/** 行尾那句灰字（覆盖默认提示）——动作行用它显示「可派 · 通用助理」这种摘要 */
	hint?: string;
	/** 动作行在右栏末尾那句（默认「回车 = 立即执行」；助理行是「回车 = 打开编辑面板」） */
	actionHint?: string;
	/** 这一行回车翻到哪一页（助理行用它翻进编辑页；不传就是普通动作/配置） */
	page?: () => FormPage | undefined;
	/** 默认值（`r` 恢复用；面板里也有「恢复默认」这一行） */
	def: string | number | boolean | string[];
	/** 读当前值（内存里的 live 值，不是文件） */
	get: () => string | number | boolean | string[];
	/** 写：负责「改内存 + 写盘 + 立即生效」 */
	/** 写回一个值。动作行的实现常常是 async（要调命令），所以允许返回 Promise。 */
	set: (v: string | number | boolean | string[]) => void | Promise<void>;
	/** 只在本会话有效（不落盘） */
	session?: boolean;
}

const registry: SettingDef[] = [];

/** 配置变更（埋点用；text/list 可能含密钥，只报 key 不报值） */
export interface SettingsChange {
	key: string;
	kind: SettingKind;
	value?: string | number | boolean;
}

let appliedHook: ((changes: SettingsChange[]) => void) | undefined;

/** 配置面板保存/恢复默认后回调。任何异常都被吞掉，不影响配置本身。 */
export function onSettingsApplied(cb: (changes: SettingsChange[]) => void): void {
	appliedHook = cb;
}

function emitChanges(changes: SettingsChange[]): void {
	if (!changes.length || !appliedHook) return;
	try {
		appliedHook(changes);
	} catch {
		/* 埋点失败不影响配置 */
	}
}

/** 各模块启动时注册自己的配置项（重复 key 覆盖，便于 /reload 后重来） */
export function registerSettings(defs: SettingDef[]): void {
	for (const d of defs) {
		const i = registry.findIndex((x) => x.key === d.key);
		if (i >= 0) registry[i] = d;
		else registry.push(d);
	}
}

/** 按前缀撤掉一批注册项（**动态行**用：助理增删后要重新生成，不然还显示旧的） */
export function unregisterSettings(prefix: string): void {
	for (let i = registry.length - 1; i >= 0; i--) {
		if (registry[i]!.key.startsWith(prefix)) registry.splice(i, 1);
	}
}

/**
 * 打开面板前的刷新钩子。
 *
 * 为什么需要：面板的注册表是**启动时**填的，可助理是文件、随时会新建/改名。
 * 不刷新的话，新建完助理还得 `/reload` 才能在面板里看见 —— 那就不叫"统一在面板里编辑"了。
 */
let openRefresher: (() => void) | undefined;
export function setOpenRefresher(fn: () => void): void {
	openRefresher = fn;
}

export function settingKeys(): string[] {
	return registry.map((d) => d.key);
}

export function getSetting(key: string): SettingDef | undefined {
	return registry.find((d) => d.key === key);
}

export function settingsDefs(): SettingDef[] {
	return [...registry];
}

export function settingsSnapshot(): { key: string; group: string; label: string; kind: SettingKind; desc: string; session: boolean }[] {
	return registry.map((d) => ({ key: d.key, group: d.group, label: d.label, kind: d.kind, desc: d.desc, session: !!d.session }));
}

// ======================= 值 ↔ 表单文本 =======================

/** 面板里那个「值」列（原始值，不带单位 —— 单位放提示里，改的时候好输入） */
export function fieldValue(d: SettingDef): string {
	if (d.kind === "action") return "→ 回车执行";
	const v = d.get();
	if (d.kind === "bool") return v ? "是" : "否";
	if (d.kind === "list") return Array.isArray(v) ? v.join(", ") : String(v);
	if (d.kind === "enum") {
		const vals = d.values ?? d.options ?? [];
		const i = vals.findIndex((x) => x === v);
		return (d.options ?? [])[i >= 0 ? i : 0] ?? String(v);
	}
	return v === undefined || v === null ? "" : String(v);
}

/** 值后面那句灰字（单位 / 范围 / 会话级标记） */
export function fieldHint(d: SettingDef): string {
	if (d.hint) return d.hint;
	const bits: string[] = [];
	if (d.kind === "action") bits.push("回车直接执行");
	else if (d.kind === "number") bits.push(`${d.min ?? "-"}~${d.max ?? "+"}${d.unit ?? ""}`);
	else if (d.kind === "list") bits.push("多个用逗号");
	else if (d.kind === "enum") bits.push("回车选");
	else if (d.kind === "bool") bits.push("回车切换");
	else bits.push("回车输入");
	if (d.session) bits.push("仅本会话");
	return bits.join(" · ");
}

/**
 * 右栏（窄屏时是底部）那段完整说明。
 * **分行写**，别糊成一段 —— 右栏只有 1/4 宽，一段话会折成一坨。
 */
export function fieldDetail(d: SettingDef): string {
	const cur = d.get();
	const curTxt = Array.isArray(cur) ? cur.join(", ") : String(cur);
	if (d.kind === "action") {
		return `${d.desc}\n\n${d.actionHint ?? "回车 = 立即执行（不存值，不参与 ctrl+s）"}`;
	}
	let range = "";
	if (d.kind === "bool") range = "开 / 关";
	else if (d.kind === "enum") range = (d.options ?? []).join(" / ");
	else if (d.kind === "number") range = `${d.min ?? "-∞"} ~ ${d.max ?? "+∞"}${d.unit ?? ""}`;
	else if (d.kind === "list") range = "逗号分隔的多个词（例：发送, 投给pi）";
	else range = "任意文本";
	const defTxt = Array.isArray(d.def) ? d.def.join(", ") : String(d.def);
	return [d.desc, "", `取值：${range}`, `当前：${curTxt || "(空)"}`, `默认：${defTxt || "(空)"}`, d.session ? "仅本会话有效（重启复位）" : ""]
		.filter((x, i) => i < 5 || x)
		.join("\n");
}

/** 面板里的分组顺序（常用的在前，「会话级」这种偶尔用的压最后） */
const GROUP_ORDER = ["助理", "Super Agent", "委派", "看板", "会话级（重启复位）"];

/** 按上面的顺序排一遍（未知分组排在最后，按注册顺序稳定） */
export function orderedDefs(defs: SettingDef[] = registry): SettingDef[] {
	const rank = (g: string) => {
		const i = GROUP_ORDER.indexOf(g);
		return i < 0 ? GROUP_ORDER.length : i;
	};
	return [...defs].sort((a, b) => rank(a.group) - rank(b.group));
}

/** 注册表 → 表单字段（一行一项，标签带分组前缀） */
export function settingsFields(defs: SettingDef[] = registry): FormField[] {
	const out: FormField[] = [];
	let lastGroup = "";
	for (const d of orderedDefs(defs)) {
		// 分组 → 插一行表头（`kind:"group"`：回车/←→ 展开收起）
		if (d.group !== lastGroup) {
			lastGroup = d.group;
			out.push({ key: `__group:${d.group}`, label: d.group, value: "", kind: "group" });
		}
		// 动作行：值列显示**摘要**（「可派 · 通用助理」），行尾只留一句短提示。
		// 以前值列全是 `→ 回车执行`，每行一模一样，白占地方还看不出这行是什么。
		const isAction = d.kind === "action";
		out.push({
			key: d.key,
			// 分组已经当表头显示过了 → 子行**不再重复前缀**（省地方，也免得 20 字被截断）
			label: d.label,
			value: isAction ? (d.hint ?? "") : fieldValue(d),
			kind: isAction ? "action" : d.kind === "bool" ? "bool" : d.kind === "enum" ? "enum" : "text",
			options: d.kind === "enum" ? d.options : undefined,
			hint: isAction ? "回车执行" : fieldHint(d),
		});
	}
	return out;
}

/** 表单文本 → 真实值（数字夹范围、列表切分、enum 映射回真实值） */
export function parseFieldValue(d: SettingDef, text: string): string | number | boolean | string[] | undefined {
	const raw = String(text ?? "").trim();
	if (d.kind === "bool") return raw === "是" || raw === "true" || raw === "开";
	if (d.kind === "enum") {
		const labels = d.options ?? [];
		const vals = d.values ?? labels;
		let i = labels.indexOf(raw);
		if (i < 0) {
			// 面板里长标签可能被截断/去掉说明（"auto = xxx" → "auto"），按值再兜一次
			const head = raw.split(/[ =（(]/)[0].trim();
			i = vals.findIndex((x) => String(x) === head);
			if (i < 0) i = labels.findIndex((x) => x.split(/[ =（(]/)[0].trim() === head);
		}
		return i >= 0 && i < vals.length ? vals[i] : undefined;
	}
	if (d.kind === "list") {
		const list = raw
			.split(/[,，\s]+/)
			.map((x) => x.trim())
			.filter(Boolean);
		return list;
	}
	if (d.kind === "number") {
		const n = Number(raw);
		if (!Number.isFinite(n)) return undefined;
		let v = n;
		if (d.min !== undefined) v = Math.max(d.min, v);
		if (d.max !== undefined) v = Math.min(d.max, v);
		return v;
	}
	return raw;
}

/**
 * 把表单结果写回去（只写真的变了的项）。
 * 返回 { applied, failed } —— 纯逻辑，好测。
 */
export function applySettingsValues(values: Record<string, string>, defs: SettingDef[] = registry): { applied: string[]; failed: string[] } {
	const applied: string[] = [];
	const failed: string[] = [];
	const changes: SettingsChange[] = [];
	for (const d of defs) {
		if (!(d.key in values)) continue;
		// 动作行（kind="action"）不是值 —— 它的 set 就是「跑起来」，只在面板的 actionKey
		// 分支里单独执行**一次**。漏掉这个跳过会把面板里所有 hint 非空的动作行
		// 当成「改过的配置」批量 set：实测选一个助理 → 4 个底座 edit 报警 +
		// /resume-agent 弹出会话列表 + ESC 被后面的模态吃掉。
		if (d.kind === "action") continue;
		const text = values[d.key] ?? "";
		// 没动过的行跳过（表单里 value 就是当前值）
		if (text === fieldValue(d)) continue;
		const v = parseFieldValue(d, text);
		if (v === undefined) {
			failed.push(d.label);
			continue;
		}
		try {
			d.set(v);
			applied.push(d.label);
			changes.push({
				key: d.key,
				kind: d.kind,
				value: d.kind === "bool" || d.kind === "enum" || d.kind === "number" ? (v as string | number | boolean) : undefined,
			});
		} catch {
			failed.push(d.label);
		}
	}
	emitChanges(changes);
	return { applied, failed };
}

/** 全部恢复默认（面板里「恢复全部默认」那一行用） */
export function resetSettings(defs: SettingDef[] = registry): number {
	let n = 0;
	const changes: SettingsChange[] = [];
	for (const d of defs) {
		// 同 applySettingsValues：动作行的 set 是「跑起来」，不是「改值」——
		// 否则一下「恢复全部默认」会把所有动作行挨个执行一遍。
		if (d.kind === "action") continue;
		try {
			d.set(Array.isArray(d.def) ? [...d.def] : d.def);
			n++;
			changes.push({ key: d.key, kind: d.kind });
		} catch {
			/* 单条失败不影响别的 */
		}
	}
	emitChanges(changes);
	return n;
}

// ======================= 打开面板 =======================

let lastCtxRef: ExtensionContext | undefined;

/** 打开配置面板（表单式）。改动在 ctrl+s 那一下统一生效并写盘。 */
export async function openSettings(ctx: ExtensionContext): Promise<void> {
	lastCtxRef = ctx;
	try {
		openRefresher?.(); // 动态行（助理列表）在这里重新生成
	} catch {
		/* 刷新失败就用上次的，不影响打开面板 */
	}
	if (!registry.length) {
		ctx.ui.notify("还没有注册任何配置项（插件没加载全？）", "warning");
		return;
	}

	// 分页：总览 → 组 → 项（全程一个面板框，esc 逐层返回）
	const r = await showFormPages(ctx, "⚙ ai-configure", [settingsHomePage()]);
	if (!r) return; // 最外层 esc = 关掉面板

	// 深层页的值已经由各页 save 钩子落地了；这里只兜一层"真配置键"（防将来加页忘了写 save）
	const known = new Map(registry.map((d) => [d.key, d]));
	const leftovers: Record<string, string> = {};
	for (const [k, v] of Object.entries(r.values)) if (known.has(k)) leftovers[k] = v;
	if (Object.keys(leftovers).length) applySettingsValues(leftovers);
}

/** 面板里想把「面板没打开时」的上下文留一份 */
export function settingsCtx(): ExtensionContext | undefined {
	return lastCtxRef;
}

/** 各模块的 setupXxx 风格一致性占位（注册项由模块自己 registerSettings） */
export function setupSettings(_api: ExtensionAPI): void {}

// ======================= 分页（首页 → 组 → 项） =======================

/** 每组的「这一组是干什么的」—— 首页右栏用 */
const GROUP_BLURB: Record<string, string> = {
	助理: "每个助理一行。回车进去能看到它的角色、继承的底座、挂的 MCP、超时和提示词正文，改完 ctrl+s 直接落盘。",
	"Super Agent": "Router / Worker 双层模式的总开关（现在只记状态，行为逐项接上）：主会话负责对话与验收，助理各自独立上下文执行、干完交证据。",
	委派: "派活的公共偏好，和具体哪个助理无关。",
	看板: "任务看板的动作：清空计划、面板贴上方还是下方、右栏/中栏要不要显示。",
	"会话级（重启复位）": "只在本会话有效：重启 pi 自动复位，不写进配置文件。",
};

/** 首页：每组一行（回车进组） */
export function settingsHomePage(): FormPage {
	const defs = registry;
	const groups = [...new Set(orderedDefs(defs).map((d) => d.group))];
	const fields: FormField[] = groups.map((g) => {
		const items = defs.filter((d) => d.group === g);
		const acts = items.filter((d) => d.kind === "action").length;
		return {
			key: `nav.group.${g}`,
			label: g,
			value: `${items.length} 项${acts ? ` · ${acts} 个动作` : ""}`,
			kind: "text" as const,
			readonly: true,
			drill: true,
			hint: "回车进入",
		};
	});
	return {
		title: "总览",
		fields,
		footer: "↑↓ 移动 · 回车 进入这一组 · ctrl+s 保存 · esc 退出",
		detail: (f) => GROUP_BLURB[f.label] ?? `「${f.label}」共 ${defs.filter((d) => d.group === f.label).length} 项。`,
		enter: (f) => settingsGroupPage(f.label.replace(/^nav\.group\./, "")),
	};
}

/** 组页：只列这一组的行（顶部一个「← 返回总览」） */
export function settingsGroupPage(group: string): FormPage {
	const items = orderedDefs(registry).filter((d) => d.group === group);
	const fields: FormField[] = [
		{ key: "nav.back", label: "← 返回总览", value: "", kind: "text", readonly: true, drill: true },
		...items.map(
			(d): FormField => ({
				key: d.key,
				label: d.label,
				value: d.kind === "action" ? (d.hint ?? "") : fieldValue(d),
				// 动作行保持 action（回车执行）；配置行当成普通行（回车进编辑页）
				kind: d.kind === "action" ? "action" : d.kind === "enum" ? "enum" : d.kind === "bool" ? "bool" : "text",
				options: d.kind === "enum" ? d.options : undefined,
				hint: d.page ? "回车编辑" : d.kind === "action" ? "回车执行" : "回车编辑",
				drill: d.kind !== "action" || !!d.page,
			}),
		),
	];
	return {
		title: group,
		fields,
		footer: "↑↓ 移动 · 回车 编辑/执行 · esc 返回总览 · ctrl+s 保存",
		detail: (f) => {
			if (f.key === "nav.back") return "回到总览（也可以直接按 esc）。";
			const d = getSetting(f.key);
			return d ? fieldDetail(d) : "";
		},
		enter: (f) => {
			if (f.key === "nav.back") return null;
			const d = getSetting(f.key);
			if (!d) return undefined;
			// 有二级页（助理行 = 那个助理的编辑页）→ **在同一个面板里翻页**。
			// 这里必须优先判断 page：否则会落到 runAction 去执行 /assistants edit，
			// 那条命令自己会再开一个面板 —— 就成了"两个窗口"（v2.2.0 踩过）。
			if (d.page) return d.page();
			return d.kind !== "action" ? settingsItemPage(d) : undefined;
		},
		runAction: (f) => {
			const d = getSetting(f.key);
			if (d?.kind === "action") void Promise.resolve(d.set(""));
		},
	};
}

/** 项页：单个配置项的「大视图」（回车改值，ctrl+s 保存并留在本页） */
export function settingsItemPage(d: SettingDef): FormPage {
	return {
		title: d.label,
		footer: "回车 改 · ctrl+s 保存（留在本页）· esc 返回上一层",
		fields: [
			{ key: "nav.back", label: "← 返回", value: "", kind: "text", readonly: true, drill: true },
			{
				key: d.key,
				label: d.label,
				value: fieldValue(d),
				kind: d.kind === "enum" ? "enum" : d.kind === "bool" ? "bool" : "text",
				options: d.kind === "enum" ? d.options : undefined,
				hint: fieldHint(d),
			},
		],
		detail: (f) => (f.key === "nav.back" ? "回到上一层（也可以直接按 esc）。" : fieldDetail(d)),
		enter: (f) => (f.key === "nav.back" ? null : undefined),
		save: (values) => {
			const v = parseFieldValue(d, values[d.key] ?? "");
			if (v !== undefined) d.set(v);
			return true; // 存完留在本页（esc 才回上一层）
		},
	};
}
