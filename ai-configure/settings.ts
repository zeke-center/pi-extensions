/**
 * settings.ts —— 可视化配置面板（像 `/mcp` / `/assistants` 那样的**表单弹窗**）。
 *
 * 为什么要有它：配置项越来越多（26 个），全靠 `/voice clip xxx` 这种子命令记不住也没法浏览。
 * 这里做两件事：
 *   1. **注册表**：各模块（voice / delegate / board / gate …）把自己可配置的项注册进来，
 *      每项都要写清「这是干什么用的」——面板里会显示；
 *   2. **面板**：复用 `form.ts` 的 FormPane（和 `/assistants` 同一个外观）：
 *      `▸ 名称   值   (提示)` 一行一项，选中行的完整说明显示在下面那行；
 *      `↑↓` 选行 · `回车` 改（bool 直接翻 / enum 展开候选 / 数字文本行内输入）· `ctrl+s` 保存 · `esc` 取消。
 *
 * 注册项是「自助餐」式的：以后加新配置只要 `registerSettings([...])`，
 * 面板不用改一行 —— DIY 项（触发词这类）也走同一条路。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FormField, showForm } from "./form";

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
	/** 默认值（`r` 恢复用；面板里也有「恢复默认」这一行） */
	def: string | number | boolean | string[];
	/** 读当前值（内存里的 live 值，不是文件） */
	get: () => string | number | boolean | string[];
	/** 写：负责「改内存 + 写盘 + 立即生效」 */
	set: (v: string | number | boolean | string[]) => void;
	/** 只在本会话有效（不落盘） */
	session?: boolean;
}

const registry: SettingDef[] = [];

/** 各模块启动时注册自己的配置项（重复 key 覆盖，便于 /reload 后重来） */
export function registerSettings(defs: SettingDef[]): void {
	for (const d of defs) {
		const i = registry.findIndex((x) => x.key === d.key);
		if (i >= 0) registry[i] = d;
		else registry.push(d);
	}
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

/** 面板下方那行完整说明：干什么用的 + 取值 + 当前值 + 默认值 */
export function fieldDetail(d: SettingDef): string {
	const cur = d.get();
	const curTxt = Array.isArray(cur) ? cur.join(", ") : String(cur);
	let range = "";
	if (d.kind === "action") range = "回车 = 立即执行（不存值）";
	else if (d.kind === "bool") range = "开 / 关";
	else if (d.kind === "enum") range = (d.options ?? []).join(" / ");
	else if (d.kind === "number") range = `${d.min ?? "-∞"} ~ ${d.max ?? "+∞"}${d.unit ?? ""}`;
	else if (d.kind === "list") range = "逗号分隔的多个词（例：发送, 投给pi）";
	else range = "任意文本";
	const defTxt = Array.isArray(d.def) ? d.def.join(", ") : String(d.def);
	return `${d.desc}｜取值：${range}｜当前：${curTxt || "(空)"}｜默认：${defTxt || "(空)"}`;
}

/** 面板里的分组顺序（常用的在前，「会话级」这种偶尔用的压最后） */
// 「手机接管」排第一：这儿天最常动的就是它（在手机上远程指挥时）
const GROUP_ORDER = ["手机接管", "命令", "剪贴板投递", "输入框投递", "通知与弹窗", "语音播报", "计划确认", "助理 / 委派", "会话级（重启复位）"];

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
		out.push({
			key: d.key,
			// 分组已经当表头显示过了 → 子行**不再重复前缀**（省地方，也免得 20 字被截断）
			label: d.label,
			value: fieldValue(d),
			kind: d.kind === "action" ? "action" : d.kind === "bool" ? "bool" : d.kind === "enum" ? "enum" : "text",
			options: d.kind === "enum" ? d.options : undefined,
			hint: fieldHint(d),
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
		const i = labels.indexOf(raw);
		return i >= 0 ? vals[i] : undefined;
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
	for (const d of defs) {
		if (!(d.key in values)) continue;
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
		} catch {
			failed.push(d.label);
		}
	}
	return { applied, failed };
}

/** 全部恢复默认（面板里「恢复全部默认」那一行用） */
export function resetSettings(defs: SettingDef[] = registry): number {
	let n = 0;
	for (const d of defs) {
		try {
			d.set(Array.isArray(d.def) ? [...d.def] : d.def);
			n++;
		} catch {
			/* 单条失败不影响别的 */
		}
	}
	return n;
}

// ======================= 打开面板 =======================

let lastCtxRef: ExtensionContext | undefined;

/** 打开配置面板（表单式）。改动在 ctrl+s 那一下统一生效并写盘。 */
export async function openSettings(ctx: ExtensionContext): Promise<void> {
	lastCtxRef = ctx;
	const defs = registry;
	if (!defs.length) {
		ctx.ui.notify("还没有注册任何配置项（插件没加载全？）", "warning");
		return;
	}
	const byKey = new Map(defs.map((d) => [d.key, d]));
	const fields = settingsFields(defs);
	const r = await showForm(
		ctx,
		"⚙ ai-configure 配置 / 命令（按分类折叠，回车展开）",
		fields,
		[],
		undefined,
		(f) => {
			// 分组表头：告诉它有项，以及怎么打开
			if (f.kind === "group") {
				const n = defs.filter((d) => d.group === f.label).length;
				return `「${f.label}」共 ${n} 项 —— 回车（或 ←→）展开 / 收起`;
			}
			const d = byKey.get(f.key);
			return d ? fieldDetail(d) : "";
		},
	);
	if (!r) return; // esc = 取消，什么都不改

	// 「命令」分组里是按**行动**不是配置：选中即立即执行，不写值。
	if (r.actionKey) {
		const d = byKey.get(r.actionKey);
		// 先把同一面板里其它真的改了的项落地（用户可能一边改配置一边点了命令）
		applySettingsValues(r.values, defs);
		try {
			d?.set(""); // action 行的 set 就是“跑起来”
			ctx.ui.notify(`▶ 执行：${d?.label ?? r.actionKey}`, "info");
		} catch (e) {
			ctx.ui.notify(`✗ 执行失败：${e instanceof Error ? e.message : String(e)}`, "error");
		}
		return;
	}

	const { applied, failed } = applySettingsValues(r.values, defs);
	const msg = applied.length ? `⚙ 已保存 ${applied.length} 项：${applied.slice(0, 6).join("、")}${applied.length > 6 ? "…" : ""}` : "没有改动";
	ctx.ui.notify(failed.length ? `${msg}（${failed.length} 项没改成功：${failed.join("、")}）` : msg, failed.length ? "warning" : "info");
}

/** 面板里想把「面板没打开时」的上下文留一份 */
export function settingsCtx(): ExtensionContext | undefined {
	return lastCtxRef;
}

/** 各模块的 setupXxx 风格一致性占位（注册项由模块自己 registerSettings） */
export function setupSettings(_api: ExtensionAPI): void {}
