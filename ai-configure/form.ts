/**
 * 助理模板的「弹窗面板」。
 *
 * 为什么不用 ctx.ui.input 一行行问：
 *   问答式是一次性的 —— 一个字段问一次，问完就散，改错了只能从头再来，
 *   而且看不到「现在这些值合起来是什么样」。
 *   面板把全部字段一次摊开：能来回改、能看清当前值、能选存到哪。
 *
 * 一个组件、四种模式（不是四个组件）：
 *   nav   选行
 *   edit  行内改文本（单行）
 *   enum  行内选一个值（如「保存到」）
 *   mcp   展开多选（嵌套在同一个框里，不另开弹窗）
 *
 * 键盘：↑↓ 选行 · 回车 改 · ctrl+s 保存 · esc 取消
 *       编辑中 esc = 放弃本行；各模式里 ctrl+s 都能直接保存
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** 多选框里的一项 */
export interface PickItem {
	value: string;
	label: string;
	hint?: string;
	checked: boolean;
}

/** 右补空格到 w 列（按终端可见宽度算，中文算 2 列） */
function padRight(s: string, w: number): string {
	const vw = visibleWidth(s);
	return vw >= w ? truncateToWidth(s, w) : s + " ".repeat(w - vw);
}

/** 面板里的一行 */
export interface FormField {
	/** 提交时的键名 */
	key: string;
	/** 左侧标签（中文会被按可见宽度对齐） */
	label: string;
	value: string;
	/**
	 * text   行内改文本
	 * bool   回车切换 是/否
	 * enum   回车展开候选（options）
	 * mcp    回车展开多选（用 showForm 的 mcp 参数）
	 * action 回车 = 立刻保存并置 openBody（给「去编辑正文」这种按钮用）
	 */
	kind: "text" | "bool" | "enum" | "mcp" | "action";
	options?: string[];
	readonly?: boolean;
	/** 值后面那句灰字 */
	hint?: string;
}

export interface FormResult {
	/** key → 最终值（mcp 行会被换成「勾选的逗号列表」） */
	values: Record<string, string>;
	/** 用户按了那个 action 行（= 关掉面板后打开编辑器） */
	openBody: boolean;
}

export class MultiSelect implements Focusable {
	focused = false;
	private sel = 0;

	constructor(
		private theme: Theme,
		private title: string,
		private items: PickItem[],
		private done: (values: string[] | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.items.length) this.sel = (this.sel - 1 + this.items.length) % this.items.length;
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.items.length) this.sel = (this.sel + 1) % this.items.length;
			return;
		}
		if (matchesKey(data, "space")) {
			const it = this.items[this.sel];
			if (it) it.checked = !it.checked;
			return;
		}
		if (matchesKey(data, "return")) {
			this.done(this.items.filter((i) => i.checked).map((i) => i.value));
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const w = Math.min(78, width);
		const inner = w - 2;
		const b = (s: string) => t.fg("border", s);
		const out: string[] = [];
		out.push(b(`╭${"─".repeat(inner)}╮`));
		out.push(b("│") + padRight(" " + t.fg("accent", t.bold(this.title)), inner) + b("│"));
		out.push(b(`├${"─".repeat(inner)}┤`));
		if (!this.items.length) {
			out.push(b("│") + padRight(" " + t.fg("dim", "（候选池是空的）"), inner) + b("│"));
		}
		this.items.forEach((it, i) => {
			const isSel = i === this.sel;
			const box = it.checked ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
			const text = isSel ? t.fg("accent", it.label) : t.fg("text", it.label);
			const prefix = isSel ? t.fg("accent", "▶ ") : "  ";
			let line = ` ${prefix}${box} ${text}`;
			if (it.hint) line += `  ${t.fg("dim", it.hint)}`;
			out.push(b("│") + padRight(truncateToWidth(line, inner), inner) + b("│"));
		});
		out.push(b(`├${"─".repeat(inner)}┤`));
		out.push(b("│") + padRight(" " + t.fg("dim", "↑↓ 移动 · 空格 勾选 · 回车 确定 · esc 取消"), inner) + b("│"));
		out.push(b(`╰${"─".repeat(inner)}╯`));
		return out;
	}
}

export class FormPane implements Focusable {
	focused = false;
	private sel = 0;
	private mode: "nav" | "edit" | "enum" | "mcp" = "nav";
	private buf = "";
	private cursor = 0;
	private enumSel = 0;
	private mcpSel = 0;
	private openBody = false;

	constructor(
		private theme: Theme,
		private title: string,
		private fields: FormField[],
		private mcp: PickItem[],
		private done: (r: FormResult | null) => void,
		focusKey?: string,
	) {
		if (focusKey) {
			const i = fields.findIndex((f) => f.key === focusKey);
			if (i >= 0) this.sel = i;
		}
	}

	private cur(): FormField | undefined {
		return this.fields[this.sel];
	}

	private mcpValue(): string {
		return this.mcp.filter((i) => i.checked).map((i) => i.value).join(", ");
	}

	private finish(): void {
		const values: Record<string, string> = {};
		for (const f of this.fields) values[f.key] = f.kind === "mcp" ? this.mcpValue() : f.value;
		this.done({ values, openBody: this.openBody });
	}

	handleInput(data: string): void {
		const f = this.cur();

		// ctrl+s 在任何模式下都能直接存（正在编辑的那格先落地）
		if (matchesKey(data, "ctrl+s")) {
			if (this.mode === "edit" && f) f.value = this.buf;
			this.mode = "nav";
			this.finish();
			return;
		}

		if (this.mode === "mcp") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) {
				this.mode = "nav";
				return;
			}
			if (matchesKey(data, "up") && this.mcp.length) {
				this.mcpSel = (this.mcpSel - 1 + this.mcp.length) % this.mcp.length;
				return;
			}
			if (matchesKey(data, "down") && this.mcp.length) {
				this.mcpSel = (this.mcpSel + 1) % this.mcp.length;
				return;
			}
			if (matchesKey(data, "space")) {
				const it = this.mcp[this.mcpSel];
				if (it) it.checked = !it.checked;
			}
			return;
		}

		if (this.mode === "enum") {
			const opts = f?.options ?? [];
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.mode = "nav";
				return;
			}
			if (matchesKey(data, "up") && opts.length) {
				this.enumSel = (this.enumSel - 1 + opts.length) % opts.length;
				return;
			}
			if (matchesKey(data, "down") && opts.length) {
				this.enumSel = (this.enumSel + 1) % opts.length;
				return;
			}
			if (matchesKey(data, "return")) {
				if (f && opts[this.enumSel] !== undefined) f.value = opts[this.enumSel] as string;
				this.mode = "nav";
			}
			return;
		}

		if (this.mode === "edit") {
			if (matchesKey(data, "escape")) {
				this.mode = "nav"; // 放弃本行修改（不写回 f.value）
				return;
			}
			if (matchesKey(data, "return")) {
				if (f) f.value = this.buf;
				this.mode = "nav";
				return;
			}
			if (matchesKey(data, "backspace")) {
				if (this.cursor > 0) {
					this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
					this.cursor--;
				}
				return;
			}
			if (matchesKey(data, "delete")) {
				this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
				return;
			}
			if (matchesKey(data, "left")) {
				this.cursor = Math.max(0, this.cursor - 1);
				return;
			}
			if (matchesKey(data, "right")) {
				this.cursor = Math.min(this.buf.length, this.cursor + 1);
				return;
			}
			if (matchesKey(data, "home")) {
				this.cursor = 0;
				return;
			}
			if (matchesKey(data, "end")) {
				this.cursor = this.buf.length;
				return;
			}
			// 可打印字符（含一次粘进来的整串）；转义序列首字符是 \x1b < 空格，会被排除
			if (data && data.charCodeAt(0) >= 32) {
				this.buf = this.buf.slice(0, this.cursor) + data + this.buf.slice(this.cursor);
				this.cursor += data.length;
			}
			return;
		}

		// nav
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "up") && this.fields.length) {
			this.sel = (this.sel - 1 + this.fields.length) % this.fields.length;
			return;
		}
		if (matchesKey(data, "down") && this.fields.length) {
			this.sel = (this.sel + 1) % this.fields.length;
			return;
		}
		if (matchesKey(data, "return")) {
			if (!f || f.readonly) return;
			if (f.kind === "bool") {
				f.value = f.value === "是" ? "否" : "是";
				return;
			}
			if (f.kind === "mcp") {
				this.mode = "mcp";
				return;
			}
			if (f.kind === "enum") {
				const opts = f.options ?? [];
				this.enumSel = Math.max(0, opts.indexOf(f.value));
				this.mode = "enum";
				return;
			}
			if (f.kind === "action") {
				this.openBody = true;
				this.finish();
				return;
			}
			this.buf = f.value;
			this.cursor = this.buf.length;
			this.mode = "edit";
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const w = Math.min(84, width);
		const inner = w - 2;
		const b = (s: string) => t.fg("border", s);
		const line = (s: string) => b("│") + padRight(truncateToWidth(s, inner), inner) + b("│");
		const out: string[] = [];

		out.push(b(`╭${"─".repeat(inner)}╮`));
		out.push(line(` ${t.fg("accent", t.bold(this.title))}`));
		out.push(b(`├${"─".repeat(inner)}┤`));

		this.fields.forEach((f, i) => {
			const isSel = i === this.sel;
			const label = padRight(f.label, 16);
			let val: string;
			if (f.kind === "mcp") {
				const names = this.mcp.filter((x) => x.checked).map((x) => x.value);
				val = names.length ? `${names.length} 个：${names.join(", ")}` : "(不连)";
			} else {
				val = f.value || "(空)";
			}
			if (isSel && this.mode === "edit") {
				val = this.buf.slice(0, this.cursor) + CURSOR_MARKER + this.buf.slice(this.cursor);
			}
			const color: "accent" | "text" | "dim" = isSel && !f.readonly ? "accent" : f.readonly ? "dim" : "text";
			let row = ` ${isSel ? t.fg("accent", "▸") : " "} ${t.fg(color, label)} ${t.fg(color, val)}`;
			if (f.hint) row += `  ${t.fg("dim", f.hint)}`;
			out.push(line(row));
		});

		out.push(b(`├${"─".repeat(inner)}┤`));
		const help =
			this.mode === "mcp"
				? "↑↓ 移动 · 空格 勾选 · 回车 收起 · ctrl+s 保存"
				: this.mode === "enum"
					? "↑↓ 选 · 回车 确定 · esc 返回"
					: this.mode === "edit"
						? "输入 · 回车 确定 · esc 放弃本行"
						: "↑↓ 选行 · 回车 改 · ctrl+s 保存 · esc 取消";
		out.push(line(` ${t.fg("dim", help)}`));

		if (this.mode === "mcp") {
			out.push(b(`├${"─".repeat(inner)}┤`));
			if (!this.mcp.length) out.push(line(` ${t.fg("dim", "（候选池是空的 —— 先 /ai 拉连接，或写 mcp-catalog.json）")}`));
			this.mcp.forEach((it, i) => {
				const isSel = i === this.mcpSel;
				const box = it.checked ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
				let row = `   ${isSel ? t.fg("accent", "▶") : " "} ${box} ${t.fg(isSel ? "accent" : "text", it.label)}`;
				if (it.hint) row += `  ${t.fg("dim", it.hint)}`;
				out.push(line(row));
			});
		} else if (this.mode === "enum") {
			out.push(b(`├${"─".repeat(inner)}┤`));
			for (const [i, o] of (this.cur()?.options ?? []).entries()) {
				const isSel = i === this.enumSel;
				out.push(line(`   ${isSel ? t.fg("accent", "▶") : " "} ${t.fg(isSel ? "accent" : "text", o)}`));
			}
		}

		out.push(b(`╰${"─".repeat(inner)}╯`));
		return out;
	}
}

/** 弹出面板；用户 esc 取消就返回 null。focusKey 指定一开始光标停在哪一行 */
export async function showForm(
	ctx: ExtensionContext,
	title: string,
	fields: FormField[],
	mcp: PickItem[] = [],
	focusKey?: string,
): Promise<FormResult | null> {
	const r = await ctx.ui.custom<FormResult | null>(
		(_tui, theme, _kb, done) => new FormPane(theme, title, fields, mcp, done, focusKey),
		{ overlay: true },
	);
	return r ?? null;
}
