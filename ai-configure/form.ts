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
	/** 值摘要里想写别的字（默认直接用 value）—— 比如 "inherit" 显示成「继承主会话」 */
	short?: string;
	/** 不是真候选（比如「继承主会话」）：判「候选池是不是空的」时不算它 */
	special?: boolean;
	checked: boolean;
}

/** 列宽（标签列） */
const LABEL_W = 16;

/**
 * 折起来的组（**模块级**：同一会话里再打开面板，上次收起的状态还在）。
 *
 * 语义是「展开表」而不是「收起表」—— 默认**全部收起**：`/aihelp` 有 37 行，
 * 一屏平铺根本找不着东西（用户原话：“内容太多了”）。分组表头永远可见。
 */
const expandedGroups = new Set<string>();

/** 这一行属于哪个组（往上找最近的 group 行）；不在任何组里 = undefined */
function ownerGroup(fields: FormField[], i: number): string | undefined {
	if (fields[i]?.kind === "group") return fields[i].key;
	for (let j = i - 1; j >= 0; j--) if (fields[j].kind === "group") return fields[j].key;
	return undefined;
}

/** 这一行现在是不是被藏起来了（它的组收着，且它自己不是表头） */
function isHiddenRow(fields: FormField[], i: number): boolean {
	if (fields[i]?.kind === "group") return false; // 表头永远可见
	const g = ownerGroup(fields, i);
	return g !== undefined && !expandedGroups.has(g);
}

/** 某个组下面有几项（表头上显示 `(8)`） */
function countInGroup(fields: FormField[], groupKey: string): number {
	let n = 0;
	let inGroup = false;
	for (const f of fields) {
		if (f.kind === "group") {
			if (inGroup) break;
			inGroup = f.key === groupKey;
			continue;
		}
		if (inGroup) n++;
	}
	return n;
}

/** 按**字符**切（不是按 UTF-16 码元）—— 中文 / emoji 才不会被劈成半个 */
function charsOf(v: string): string[] {
	return [...v];
}

/** 长文本行的值列摘要：压平换行 + 截断 + 补字数/行数（正文可能几千字，值列塞不下） */
function longSummary(v: string, maxW: number): string {
	const flat = v.replace(/\s+/g, " ").trim();
	if (!flat) return "(空 — 回车写)";
	const chars = [...v].length;
	const lines = v.split("\n").length;
	const suffix = `  (${chars} 字${lines > 1 ? ` · ${lines} 行` : ""})`;
	const headW = Math.max(6, maxW - visibleWidth(suffix));
	const head = truncateToWidth(flat, headW);
	const tail = visibleWidth(head) < visibleWidth(flat) ? "…" : "";
	return `${head}${tail}${suffix}`;
}

/** 右补空格到 w 列（按终端可见宽度算，中文算 2 列） */
function padRight(s: string, w: number): string {
	const vw = visibleWidth(s);
	return vw >= w ? truncateToWidth(s, w) : s + " ".repeat(w - vw);
}

/**
 * 一页（同一个面板框内翻页用）。栈式导航：首页 → 组 → 项，esc 逐层返回。
 * 不提供 pages 时就是老行为（一张表 + 底部/右栏说明）。
 */
export interface FormPage {
	/** 面包屑这一层（例：助理 / db） */
	title: string;
	fields: FormField[];
	/** 这一页的 MCP 候选池（助理页要用） */
	mcp?: PickItem[];
	/** 右栏说明（不传就用构造时那个） */
	detail?: (f: FormField) => string;
	/** 回车在「drill」行上：下一页 / `null` = 弹回上一层 / undefined = 不翻页（走默认行为） */
	enter?: (f: FormField) => FormPage | null | undefined;
	/** 动作行回车：**在本页执行**（面板不关）—— async 也行，错误自己接 */
	runAction?: (f: FormField) => void;
	/** 底部提示（不传用默认那句） */
	footer?: string;
	/** ctrl+s：返回 false = 退回上一层（默认留在本页）；不传 = 老行为（提交并关闭） */
	save?: (values: Record<string, string>) => boolean | void;
	/** 重新读一遍当前值（页外改过之后同步显示，避免旧快照被当改动提交） */
	refresh?: () => void;
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
	 * long   **多行长文本**：值列只显示摘要+字数，回车在本面板内切到编辑视图（不另开窗口）
	 * action 回车 = 立刻执行（分页模式在本页跑；老模式置 openBody 并关面板）
	 * group  **分组表头**：回车 / ←→ 展开收起（它自己不是一项配置）
	 */
	kind: "text" | "bool" | "enum" | "mcp" | "long" | "action" | "group";
	options?: string[];
	readonly?: boolean;
	/** 值后面那句灰字 */
	hint?: string;
	/** 这一行回车 = 翻到下一页（不是改值、也不是执行动作） */
	drill?: boolean;
}

export interface FormResult {
	/** key → 最终值（mcp 行会被换成「勾选的逗号列表」） */
	values: Record<string, string>;
	/** 用户按了那个 action 行（= 关掉面板后打开编辑器） */
	openBody: boolean;
	/** **按下的那一行 action 的 key**（命令总目录用它：选中 = 直接执行） */
	actionKey?: string;
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

	invalidate(): void {
		/* noop：同 FormPane，宿主遍历时别炸 */
	}

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
			const box = it.checked ? t.fg("success", "[✓]") : t.fg("dim", "[ ]");
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
	/** 按下的 action 行的 key（kind="action"） */
	private actionKey: string | undefined = undefined;
	/** 面板内的长文本编辑视图（不另开窗口）：null = 正常列表视图 */
	private edit: { key: string; label: string; lines: string[]; row: number; col: number } | null = null;
	/**
	 * 上一帧画了多少行。
	 * 为什么需要：列表视图 32 行、编辑视图可能只有 7 行，高度一缩宿主不一定清屏，
	 * 旧画面就留在下面变成"两个框叠在一起"。所以**永远按历史最高高度补空行**，只长不缩。
	 */
	private lastH = 0;
	/** 页面栈（至少 1 层）；每层各自的 fields / mcp / detail / 翻页与保存钩子 */
	private stack: FormPage[];
	/** 每层各自的光标位置（返回上一层时能回到原来那行） */
	private sels: number[] = [0];
	/** 用户在本页改过、但还没提交到磁盘的行（refresh 时得保住，否则刚改的值会被磁盘值盖回去） */
	private dirty = new WeakSet<FormField>();

	/** 标记「这行的值是本页刚改的，还没落盘」 */
	private touch(f: FormField | undefined): void {
		if (f) this.dirty.add(f);
	}

	private page(): FormPage {
		return this.stack[this.stack.length - 1]!;
	}
	private flds(): FormField[] {
		return this.page().fields;
	}
	private mcpPool(): PickItem[] {
		return this.page().mcp ?? this.mcp;
	}
	private pageDetail(): ((f: FormField) => string) | undefined {
		return this.page().detail ?? this.detail;
	}
	/** 往里压一页（记住当前光标） */
	private pushPage(next: FormPage): void {
		this.sels[this.stack.length - 1] = this.sel;
		this.stack.push(next);
		this.sel = 0;
		this.mode = "nav";
	}
	/** 弹回上一层；已经是最外层就返回 false（调用方决定要不要关面板） */
	private popPage(): boolean {
		if (this.stack.length <= 1) return false;
		this.stack.pop();
		this.sel = this.sels[this.stack.length - 1] ?? 0;
		this.mode = "nav";
		// 回上一层：里层可能已经把值写盘了（项页 ctrl+s），上层的旧快照必须跟着更新
		this.refreshStack();
		return true;
	}

	/** 从 enum/edit 切回列表视图：本页刚改了值，顺手按定义重算一遍显示 */
	private backToNav(): void {
		this.mode = "nav";
		this.refreshStack();
	}

	/**
	 * 让整页栈按自己的定义重算显示值（项页改完 → 组页那行也得跟着变）。
	 *
	 * 为什么要 sync 本页「改过还没写盘」的行回来：refresh 是按**磁盘当前值**重算的，
	 * 在组页把 enum 改完再回车进项页、再 esc 回来时，会把刚改的值抹成旧值
	 * （表现出来和这次修的 bug 一模一样：改了没保存）。
	 */
	private refreshStack(): void {
		for (const p of this.stack) {
			const keep = p.fields.map((f) => ({ f, v: f.value, dirty: this.dirty.has(f) }));
			try {
				p.refresh?.();
			} catch {
				/* 刷新失败不影响主流程 */
			}
			for (const k of keep) if (k.dirty) k.f.value = k.v;
		}
	}

	constructor(
		private theme: Theme,
		private title: string,
		private fields: FormField[],
		private mcp: PickItem[],
		private done: (r: FormResult | null) => void,
		focusKey?: string,
		/** 可选：给选中的行显示一段完整说明（配置面板用它写「这是干什么用的」） */
		private detail?: (f: FormField) => string,
		/** 可选：TUI 句柄，用来在隐藏/恢复时主动重绘（没有就靠下一帧自然刷新） */
		private tui?: { requestRender?: () => void },
	) {
		// 页面栈：首页 = 传进来的这张表；drill 行回车往里压页，esc 弹回上一层
		this.stack = [{ title: "", fields, mcp, detail }];
		if (focusKey) {
			const i = fields.findIndex((f) => f.key === focusKey);
			if (i >= 0) {
				this.sel = i;
				// 指定要看的那一行，它的组得先打开（否则光标落在看不见的行上）
				const g = ownerGroup(fields, i);
				if (g) expandedGroups.add(g);
			}
		}
	}

	/** 用页面栈启动（首页 + 若干层）；showFormPage 用 */
	setPages(pages: FormPage[]): void {
		if (!pages.length) return;
		this.stack = pages;
		this.sels = pages.map(() => 0);
		this.sel = 0;
		this.mode = "nav";
	}

	/** ↑↓ 移动，**跳过收起的组里的行** */
	private move(d: number): void {
		const n = this.flds().length;
		if (!n) return;
		let i = this.sel;
		for (let k = 0; k < n; k++) {
			i = (i + d + n) % n;
			if (!isHiddenRow(this.flds(), i)) {
				this.sel = i;
				return;
			}
		}
	}

	/**
	 * 收起之后把光标拉回来。
	 * 不这么做的话光标会停在**已经被藏起来的那一行**上 → 界面上看不出选中在哪（实测踩到）。
	 */
	private fixCursor(): void {
		if (!isHiddenRow(this.flds(), this.sel)) return;
		const g = ownerGroup(this.flds(), this.sel);
		if (!g) return;
		const i = this.flds().findIndex((f) => f.key === g);
		if (i >= 0) this.sel = i;
	}

	private cur(): FormField | undefined {
		return this.flds()[this.sel];
	}

	private mcpValue(): string {
		// 必须用「当前页」的池：/ai 的助理页是压栈页，root 的 this.mcp 是空数组，
		// 读 this.mcp 会把勾选结果收集成空串（实测：保存后 mcp 行被整行删掉）
		return this.mcpPool()
			.filter((i) => i.checked)
			.map((i) => i.value)
			.join(", ");
	}

	/** 把画面补到历史最高高度（少几行就在底边框前插几行空白），防止宿主留残影 */
	private fit(out: string[], width: number): string[] {
		const w = Math.min(108, width);
		const inner = w - 2;
		const blank = this.theme.fg("border", "│") + " ".repeat(inner) + this.theme.fg("border", "│");
		while (out.length < this.lastH) out.splice(out.length - 1, 0, blank);
		this.lastH = out.length;
		return out;
	}

	/** 长文本行：**在本面板内**切到编辑视图（不开新窗口），保存后回填、ctrl+s 才落盘 */
	private openText(f: FormField): void {
		const lines = f.value.split("\n");
		this.edit = {
			key: f.key,
			label: f.label,
			lines,
			// 光标停在正文末尾：打开就能接着写，不用先按一堆 ↓ 找末尾
			row: Math.max(0, lines.length - 1),
			col: charsOf(lines[lines.length - 1] ?? "").length,
		};
	}

	/** 编辑视图的按键：回车换行、ctrl+s 保存、esc 取消 */
	private handleTextInput(data: string): void {
		const e = this.edit;
		if (!e) return;
		const line = () => e.lines[e.row] ?? "";
		const chars = () => [...line()];
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.edit = null; // 放弃：值不动
			return;
		}
		if (matchesKey(data, "ctrl+s") || matchesKey(data, "ctrl+enter")) {
			const f = this.flds().find((x) => x.key === e.key);
			if (f) f.value = e.lines.join("\n");
			this.touch(f);
			this.edit = null;
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const cs = chars();
			e.lines[e.row] = cs.slice(0, e.col).join("");
			e.lines.splice(e.row + 1, 0, cs.slice(e.col).join(""));
			e.row++;
			e.col = 0;
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (e.col > 0) {
				const cs = chars();
				cs.splice(e.col - 1, 1);
				e.lines[e.row] = cs.join("");
				e.col--;
			} else if (e.row > 0) {
				const prev = [...(e.lines[e.row - 1] ?? "")];
				e.col = prev.length;
				e.lines[e.row - 1] = prev.join("") + line();
				e.lines.splice(e.row, 1);
				e.row--;
			}
			return;
		}
		if (matchesKey(data, "delete")) {
			const cs = chars();
			if (e.col < cs.length) {
				cs.splice(e.col, 1);
				e.lines[e.row] = cs.join("");
			} else if (e.row < e.lines.length - 1) {
				e.lines[e.row] = line() + (e.lines[e.row + 1] ?? "");
				e.lines.splice(e.row + 1, 1);
			}
			return;
		}
		if (matchesKey(data, "left")) {
			if (e.col > 0) e.col--;
			else if (e.row > 0) {
				e.row--;
				e.col = charsOf(e.lines[e.row] ?? "").length;
			}
			return;
		}
		if (matchesKey(data, "right")) {
			if (e.col < chars().length) e.col++;
			else if (e.row < e.lines.length - 1) {
				e.row++;
				e.col = 0;
			}
			return;
		}
		if (matchesKey(data, "up")) {
			if (e.row > 0) {
				e.row--;
				e.col = Math.min(e.col, charsOf(e.lines[e.row] ?? "").length);
			}
			return;
		}
		if (matchesKey(data, "down")) {
			if (e.row < e.lines.length - 1) {
				e.row++;
				e.col = Math.min(e.col, charsOf(e.lines[e.row] ?? "").length);
			}
			return;
		}
		if (matchesKey(data, "home")) {
			e.col = 0;
			return;
		}
		if (matchesKey(data, "end")) {
			e.col = chars().length;
			return;
		}
		// 普通字符 / 中文输入法上屏的文字：插到光标处
		if (data && !data.startsWith("") && !/^\p{Cc}$/u.test(data)) {
			const cs = chars();
			cs.splice(e.col, 0, ...charsOf(data));
			e.lines[e.row] = cs.join("");
			e.col += charsOf(data).length;
		}
	}

	/**
	 * 编辑视图：还是**同一个面板框**，只是内容换成多行文本。
	 *
	 * 为什么不用 ctx.ui.editor()：那是另开一个 overlay 窗口，会出现"两个面板"、
	 * 退出/重绘时序也容易出问题（v2.2.0 踩过 pi 崩溃）。就地编辑没有这些副作用。
	 */
	private renderEditor(width: number): string[] {
		const t = this.theme;
		const e = this.edit!;
		const w = Math.min(108, width);
		const inner = w - 2;
		const b = (s: string) => t.fg("border", s);
		const full = (s: string) => b("│") + padRight(truncateToWidth(s, inner), inner) + b("│");
		const W = inner - 2; // 正文可用宽度（左右各留一格）

		// 软换行：长行折成多行显示（不折的话一行 100 多列会被截掉，根本读不全）
		const vis: Array<{ text: string; caret?: number }> = [];
		for (let i = 0; i < e.lines.length; i++) {
			const cs = charsOf(e.lines[i] ?? "");
			if (!cs.length) {
				vis.push({ text: "", ...(i === e.row ? { caret: 0 } : {}) });
				continue;
			}
			let pos = 0;
			while (pos < cs.length) {
				let seg = "";
				let wsum = 0;
				let idx = pos;
				while (idx < cs.length) {
					const cw = visibleWidth(cs[idx] ?? "");
					if (wsum + cw > W) break;
					seg += cs[idx];
					wsum += cw;
					idx++;
				}
				if (idx === pos) idx = pos + 1; // 单字比整行还宽（极窄终端）→ 至少前进一格
				vis.push({ text: seg, ...(i === e.row && e.col >= pos && e.col <= idx ? { caret: e.col - pos } : {}) });
				pos = idx;
			}
		}

		const total = e.lines.reduce((n, l) => n + charsOf(l).length, 0);
		const out: string[] = [];
		out.push(b(`╭${"─".repeat(inner)}╮`));
		out.push(
			full(` ${t.fg("accent", t.bold(`✎ 编辑：${e.label}`))} ${t.fg("dim", `(${total} 字 · ${e.lines.length} 行)`)}`),
		);
		out.push(b(`├${"─".repeat(inner)}┤`));

		// 视口跟着光标走
		const VIEW = 21;
		const curVis = Math.max(0, vis.findIndex((v) => v.caret !== undefined));
		const from = Math.max(0, Math.min(curVis - Math.floor(VIEW / 2), vis.length - VIEW));
		const to = Math.min(vis.length, from + VIEW);
		if (from > 0) out.push(full(t.fg("dim", `   ⋮ 上面还有 ${from} 行`)));
		for (let i = from; i < to; i++) {
			const v = vis[i]!;
			if (v.caret === undefined) {
				out.push(full(` ${t.fg("text", v.text)}`));
				continue;
			}
			const cs = charsOf(v.text);
			out.push(
				full(
					" " +
						t.fg("accent", cs.slice(0, v.caret).join("")) +
						CURSOR_MARKER +
						t.fg("text", cs.slice(v.caret).join("")),
				),
			);
		}
		if (to < vis.length) out.push(full(t.fg("dim", `   ⋮ 下面还有 ${vis.length - to} 行`)));

		out.push(b(`├${"─".repeat(inner)}┤`));
		out.push(
			full(
				" " +
					t.fg("dim", "回车 换行 · ↑↓←→ 移动 · ") +
					t.fg("accent", "ctrl+s 保存并回到面板") +
					t.fg("dim", " · esc 取消（原值不动）"),
			),
		);
		out.push(b(`╰${"─".repeat(inner)}╯`));
		return out;
	}

	private finish(): void {
		const values: Record<string, string> = {};
		// 页面栈里每一页的值都收上来（助理页 / 配置页混着改也不会丢）
		for (const page of this.stack) {
			for (const f of page.fields) values[f.key] = f.kind === "mcp" ? this.mcpValue() : f.value;
		}
		this.done({ values, openBody: this.openBody, ...(this.actionKey ? { actionKey: this.actionKey } : {}) });
	}

	handleInput(data: string): void {
		if (this.edit) {
			this.handleTextInput(data); // 编辑视图自己吃按键
			return;
		}
		const f = this.cur();

		// ctrl+s 在任何模式下都能直接存（正在编辑的那格先落地）
		if (matchesKey(data, "ctrl+s")) {
			if (this.mode === "edit" && f) {
				f.value = this.buf;
				this.touch(f);
			}
			this.mode = "nav";
			const page = this.page();
			if (this.stack.length > 1 && page.save) {
				const values: Record<string, string> = {};
				for (const x of page.fields) values[x.key] = x.kind === "mcp" ? this.mcpValue() : x.value;
				const keep = page.save(values);
				// 本页的值已经落盘了 → 不再算「未提交」，让 refresh 按磁盘值把它格式化回来
				for (const x of page.fields) this.dirty.delete(x);
				this.refreshStack(); // 项页存完 → 下面组页那行的旧快照必须跟着更新
				if (keep === false) this.popPage(); // 存完退回上一层
				return;
			}
			this.finish();
			return;
		}

		if (this.mode === "mcp") {
			const pool = this.mcpPool();
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) {
				this.mode = "nav";
				return;
			}
			if (matchesKey(data, "up") && pool.length) {
				this.mcpSel = (this.mcpSel - 1 + pool.length) % pool.length;
				return;
			}
			if (matchesKey(data, "down") && pool.length) {
				this.mcpSel = (this.mcpSel + 1) % pool.length;
				return;
			}
			if (matchesKey(data, "space")) {
				const it = pool[this.mcpSel];
				if (it) it.checked = !it.checked;
			}
			return;
		}

		if (this.mode === "enum") {
			const opts = f?.options ?? [];
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.backToNav(); // 值没动，顺手按定义刷一遍显示
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
				if (f && opts[this.enumSel] !== undefined) {
					f.value = opts[this.enumSel] as string;
					this.touch(f); // 本页刚改，refresh 时别抹掉
				}
				this.backToNav();
			}
			return;
		}

		if (this.mode === "edit") {
			if (matchesKey(data, "escape")) {
				this.backToNav(); // 放弃本行修改（不写回 f.value）
				return;
			}
			if (matchesKey(data, "return")) {
				if (f) {
					f.value = this.buf;
					this.touch(f); // 本页刚改，refresh 时别抹掉
				}
				this.backToNav();
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
			// 粘进来的内容：pi-tui 会把粘贴内容**重新包一层括号粘贴标记**（`\x1b[200~…\x1b[201~`）
			// 再交给组件（pi-tui 源码原话：pasted data will always contain `\x1b[200~`）。
			// 首字符是 ESC(27) → 会被下面「>= 32」的守卫**整段吃掉**，所以这里必须先剥包装。
			// 顺带把换行去掉：本编辑器是单行的，而粘贴常常带个尾部换行。
			let text = data;
			if (text.includes("\x1b[200~")) {
				text = text.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n]+/g, "");
			}
			// 可打印字符（含一次粘进来的整串）；转义序列首字符是 \x1b < 空格，会被排除
			if (text && text.charCodeAt(0) >= 32) {
				this.buf = this.buf.slice(0, this.cursor) + text + this.buf.slice(this.cursor);
				this.cursor += text.length;
			}
			return;
		}

		// nav：esc 逐层返回（深层先弹回上一层，最外层才关面板）
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.popPage()) return;
			this.done(null);
			return;
		}
		if (matchesKey(data, "up")) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.move(1);
			return;
		}
		// ←→ = 收起 / 展开当前这一组（跟文件树的习惯一样）
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const g = ownerGroup(this.flds(), this.sel);
			if (g) {
				if (matchesKey(data, "left")) {
					expandedGroups.delete(g);
					this.fixCursor(); // 光标可能正在这一组里 → 拉回表头
				} else expandedGroups.add(g);
			}
			return;
		}
		if (matchesKey(data, "return")) {
			// 分组表头：回车 = 展开/收起（**不关面板、也不是改值**）
			if (f?.kind === "group") {
				if (expandedGroups.has(f.key)) {
					expandedGroups.delete(f.key);
					this.fixCursor();
				} else expandedGroups.add(f.key);
				return;
			}
			if (!f) return;
			// drill 行：翻到下一页（配置面板靠它做「首页 → 组 → 项」）
			if (f.drill) {
				const next = this.page().enter?.(f);
				if (next === null) {
					this.popPage(); // 「← 返回」行
					return;
				}
				if (next) {
					this.pushPage(next);
					return;
				}
			}
			if (f.readonly) return;
			if (f.kind === "bool") {
				f.value = f.value === "是" ? "否" : "是";
				this.touch(f); // 本页刚改，refresh 时别抹掉
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
			if (f.kind === "long") {
				this.openText(f); // 同一个面板里切到编辑视图
				return;
			}
			if (f.kind === "action") {
				// 分页模式：在本页跑掉，面板不关（老行为是关面板 + 外面重开，很跳）
				if (this.page().runAction) {
					this.page().runAction!(f);
					return;
				}
				this.openBody = true;
				this.actionKey = f.key;
				this.finish();
				return;
			}
			this.buf = f.value;
			this.cursor = this.buf.length;
			this.mode = "edit";
		}
	}

	/**
	 * 渲染。宽屏（≥90 列）走**左右双栏**：左边列表 3，右边说明 1。
	 *
	 * 为什么改双栏：以前说明挤在面板底部一行（`描述｜取值｜当前｜默认` 糊成一段），
	 * 描述稍长就 wrap 三四行、还跟列表抢高度，长描述根本看不全。
	 * 右侧独立窄栏可以固定宽度折行，长描述不再影响左侧能看见的行数。
	 *
	 * 窄屏（<90 列）自动退回单栏 + 底部说明 —— 两栏都挤成碎片更没法读。
	 */
	render(width: number): string[] {
		// 编辑视图：同一个面板框里换内容，不另开窗口
		if (this.edit) return this.fit(this.renderEditor(width), width);
		const t = this.theme;
		const twoCol = width >= 90;
		const w = Math.min(twoCol ? 108 : 84, width);
		const inner = w - 2;
		const b = (s: string) => t.fg("border", s);

		// 标签列宽：按**本页最长的标签**算（上限 22），
		// 别用固定 16 —— 首页有「会话级（重启复位）」这种长组名，会被截掉右括号。
		const labelW = Math.min(
			22,
			Math.max(8, ...this.flds().map((f) => visibleWidth(f.label) + 2)),
		);

		// 两栏宽度先算出来：左栏的值列要按**左栏**宽度截断，不能按整面板算（否则会顶到右边框外）
		const leftW = twoCol ? Math.floor((inner - 1) * 0.75) : inner;
		const rightW = twoCol ? inner - 1 - leftW : 0;

		// ---------- 左栏：列表 ----------
		const left: Array<{ text: string; sel: boolean; selIndex: number }> = [];
		this.flds().forEach((f, i) => {
			if (isHiddenRow(this.flds(), i)) return; // 收起的组里的行不画
			const isSel = i === this.sel;
			if (f.kind === "group") {
				const open = expandedGroups.has(f.key);
				const n = countInGroup(this.flds(), f.key);
				const arrow = t.fg(isSel ? "accent" : "muted", open ? "▾" : "▸");
				left.push({
					text: ` ${arrow} ${t.fg("accent", t.bold(f.label))} ${t.fg("dim", `(${n})`)}`,
					sel: isSel,
					selIndex: i,
				});
				return;
			}
			const indent = ownerGroup(this.flds(), i) ? "  " : "";
			const label = padRight(indent + f.label, labelW);
			let val: string;
			if (f.kind === "mcp") {
				const names = this.mcpPool().filter((x) => x.checked).map((x) => x.short ?? x.value);
				val = names.length ? `${names.length} 个：${names.join(", ")}` : "(不连)";
			} else if (f.kind === "long") {
				val = longSummary(f.value, Math.max(12, leftW - labelW - 6));
			} else {
				// 动作行的值列是摘要，空的就留白（别显示「(空)」，那不是配置）
				val = f.value || (f.kind === "action" || f.drill ? "" : "(空)");
			}
			if (isSel && this.mode === "edit") {
				val = this.buf.slice(0, this.cursor) + CURSOR_MARKER + this.buf.slice(this.cursor);
			}
			const color: "accent" | "text" | "dim" = isSel && !f.readonly ? "accent" : f.readonly ? "dim" : "text";
			left.push({
				text: ` ${isSel ? t.fg("accent", "▸") : " "} ${t.fg(color, label)} ${t.fg(color, val)}`,
				sel: isSel,
				selIndex: i,
			});
		});

		// 列表过长时开一个跟随光标的视口（30 行以内不启用，行为跟以前完全一样）
		const MAX_ROWS = 30;
		let viewFrom = 0;
		if (left.length > MAX_ROWS) {
			const curRow = Math.max(0, left.findIndex((r) => r.sel));
			viewFrom = Math.max(0, Math.min(curRow - Math.floor(MAX_ROWS / 2), left.length - MAX_ROWS));
		}
		const leftView = left.slice(viewFrom, viewFrom + MAX_ROWS);
		const more = left.length > MAX_ROWS ? { above: viewFrom, below: left.length - viewFrom - leftView.length } : undefined;

		// ---------- 右栏：说明 ----------
		const right: string[] = [];
		const cur = this.cur();
		if (twoCol && this.detail && cur) {
			// 标题行：组 = 「组名」；普通行 = 「组名 · 项名」
			const owner = ownerGroup(this.flds(), this.sel);
			const ownerField = owner ? this.flds().find((x) => x.key === owner) : undefined;
			const title = cur.kind === "group" ? cur.label : [ownerField?.label, cur.label].filter(Boolean).join(" · ");
			right.push(` ${t.fg("accent", t.bold(title))}`);
			right.push("");
			const txt = this.pageDetail()!(cur);
			for (const ln of wrapText(txt, rightW - 2, 24)) right.push(ln ? ` ${t.fg("muted", ln)}` : "");
		}

		// ---------- 拼装 ----------
		const out: string[] = [];
		const full = (s: string) => b("│") + padRight(truncateToWidth(s, inner), inner) + b("│");
		/**
		 * 一行铺满整栏；**选中行整行铺底色**。
		 *
		 * 为什么不是只换前景色（accent vs text）：实测在多数主题里这两种前景色
		 * 亮度和色相都接近，扫一眼看不出选中的是哪行（尤其分组表头本身就是 accent+bold）。
		 * 用 padRight 先铺满再包 bg —— `fg()` 收尾只发 \x1b[39m（只重置前景），
		 * 不会把外层底色冲掉，所以整行底色是安全的。
		 */
		const cell = (s: string, sel: boolean, cw: number): string => {
			const padded = padRight(truncateToWidth(s, cw), cw);
			return sel ? t.bg("selectedBg", padded) : padded;
		};
		out.push(b(`╭${"─".repeat(inner)}╮`));
		const crumbs = this.stack.map((p) => p.title).filter(Boolean);
		const titleText = crumbs.length ? `${this.title} › ${crumbs.join(" › ")}` : this.title;
		out.push(full(` ${t.fg("accent", t.bold(titleText))}`));
		if (twoCol) out.push(b(`├${"─".repeat(leftW)}┬${"─".repeat(rightW)}┤`));
		else out.push(b(`├${"─".repeat(inner)}┤`));

		if (twoCol) {
			const rows = Math.max(leftView.length, right.length);
			for (let i = 0; i < rows; i++) {
				let l = leftView[i]?.text ?? "";
				let sel = leftView[i]?.sel ?? false;
				// 视口提示：被挡住的还有多少行（提示行不是真实行，不铺底色）
				if (more && i === 0 && more.above > 0) {
					l = ` ${t.fg("dim", `↑ 还有 ${more.above} 行`)}`;
					sel = false;
				}
				if (more && i === leftView.length - 1 && more.below > 0) {
					l = ` ${t.fg("dim", `↓ 还有 ${more.below} 行`)}`;
					sel = false;
				}
				out.push(b("│") + cell(l, sel, leftW) + b("│") + padRight(truncateToWidth(right[i] ?? "", rightW), rightW) + b("│"));
			}
			// 双栏区收口（这条线同时当下方帮助区上边线，不再额外加一条）
		} else {
			for (let i = 0; i < leftView.length; i++) {
				let l = leftView[i]!.text;
				let sel = leftView[i]!.sel;
				if (more && i === 0 && more.above > 0) {
					l = ` ${t.fg("dim", `↑ 还有 ${more.above} 行`)}`;
					sel = false;
				}
				if (more && i === leftView.length - 1 && more.below > 0) {
					l = ` ${t.fg("dim", `↓ 还有 ${more.below} 行`)}`;
					sel = false;
				}
				out.push(b("│") + cell(l, sel, inner) + b("│"));
			}
			// 窄屏：说明退到列表下面（和旧版一致）
			if (this.pageDetail() && cur) {
				out.push(b(`├${"─".repeat(inner)}┤`));
				for (const ln of wrapText(this.detail(cur), inner - 2, 6)) out.push(full(` ${t.fg("muted", ln)}`));
			}
		}

		out.push(b(`├${"─".repeat(inner)}┤`));
		const groupSel = cur?.kind === "group";
		const help =
			this.mode === "mcp"
				? "↑↓ 移动 · 空格 勾选 · 回车 收起 · ctrl+s 保存"
				: this.mode === "enum"
					? "↑↓ 选 · 回车 确定 · esc 返回"
					: this.mode === "edit"
						? "输入 · 回车 确定 · esc 放弃本行"
						: groupSel
							? "↑↓ 移动 · 回车/←→ 展开收起 · ctrl+s 保存 · esc 取消"
							: "↑↓ 选行 · 回车 改 · ←→ 收起/展开分组 · ctrl+s 保存 · esc 取消";
		out.push(full(` ${t.fg("dim", this.page().footer ?? help)}`));

		if (this.mode === "mcp") {
			out.push(b(`├${"─".repeat(inner)}┤`));
			const pool = this.mcpPool();
			// 「继承主会话」这类特殊项不算候选池内容 —— 池子真的空时仍然要让人知道怎么补
			if (!pool.some((i) => !i.special))
				out.push(full(` ${t.fg("dim", "（候选池是空的 —— 写 mcp-catalog.json，或手写 .pi/mcp.json）")}`));
			pool.forEach((it, i) => {
				const isSel = i === this.mcpSel;
				const box = it.checked ? t.fg("success", "[✓]") : t.fg("dim", "[ ]");
				let row = `   ${isSel ? t.fg("accent", "▶") : " "} ${box} ${t.fg(isSel ? "accent" : "text", it.label)}`;
				if (it.hint) row += `  ${t.fg("dim", it.hint)}`;
				out.push(full(row));
			});
		} else if (this.mode === "enum") {
			out.push(b(`├${"─".repeat(inner)}┤`));
			const opts = this.cur()?.options ?? [];
			// 模型列表可能几十个 —— 只开一扇窗，跟着光标滑动，别把终端顶爆
			const MAXV = 8;
			const start = Math.max(0, Math.min(this.enumSel - Math.floor(MAXV / 2), opts.length - MAXV));
			const end = Math.min(opts.length, start + MAXV);
			if (start > 0) out.push(full(t.fg("dim", `   ⋮ 上面还有 ${start} 个（↑ 继续翻）`)));
			for (let i = start; i < end; i++) {
				const isSel = i === this.enumSel;
				out.push(full(`   ${isSel ? t.fg("accent", "▶") : " "} ${t.fg(isSel ? "accent" : "text", opts[i] ?? "")}`));
			}
			if (end < opts.length) out.push(full(t.fg("dim", `   ⋮ 下面还有 ${opts.length - end} 个（↓ 继续翻）`)));
		}

		out.push(b(`╰${"─".repeat(inner)}╯`));
		return this.fit(out, width);
	}
}

/**
 * 弹出**分页**面板：pages[0] 是首页，往后是已经压好的层。
 * 用户 esc 在最外层按一下才取消（返回 null）。
 */
export async function showFormPages(
	ctx: ExtensionContext,
	title: string,
	pages: FormPage[],
	focusKey?: string,
): Promise<FormResult | null> {
	const root = pages[0]!;
	const r = await ctx.ui.custom<FormResult | null>(
		(_tui, theme, _kb, done) => {
			const pane = new FormPane(theme, title, root.fields, root.mcp ?? [], done, focusKey, root.detail, _tui);
			pane.setPages(pages);
			return pane;
		},
		{ overlay: true },
	);
	return r ?? null;
}

/** 弹出面板；用户 esc 取消就返回 null。focusKey 指定一开始光标停在哪一行 */
export async function showForm(
	ctx: ExtensionContext,
	title: string,
	fields: FormField[],
	mcp: PickItem[] = [],
	focusKey?: string,
	detail?: (f: FormField) => string,
): Promise<FormResult | null> {
	const r = await ctx.ui.custom<FormResult | null>(
		(_tui, theme, _kb, done) =>
			new FormPane(theme, title, fields, mcp, done, focusKey, detail, _tui),
		{ overlay: true },
	);
	return r ?? null;
}

/**
 * 弹窗版单选。
 *
 * 为什么不用 `ctx.ui.select`：它是 pi 的**输入框内联提示**（画在输入框下方），
 * 跟我们的面板不是一套观感 —— 用起来就是「怎么突然掉到输入框下面去了」。
 * 这里走 `ctx.ui.custom({ overlay: true })`，跟 `/aihelp` 面板是同一个弹窗。
 */
export class ListPicker implements Focusable {
	focused = false;
	private sel = 0;

	constructor(
		private theme: Theme,
		private title: string,
		private options: string[],
		private done: (value: string | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.options.length) this.sel = (this.sel - 1 + this.options.length) % this.options.length;
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.options.length) this.sel = (this.sel + 1) % this.options.length;
			return;
		}
		if (matchesKey(data, "return")) {
			const v = this.options[this.sel];
			this.done(v ?? null);
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
		this.options.forEach((o, i) => {
			const isSel = i === this.sel;
			const row = ` ${isSel ? t.fg("accent", "▶") : " "} ${t.fg(isSel ? "accent" : "text", o)}`;
			const padded = padRight(truncateToWidth(row, inner), inner);
			out.push(b("│") + (isSel ? t.bg("selectedBg", padded) : padded) + b("│"));
		});
		out.push(b(`├${"─".repeat(inner)}┤`));
		out.push(b("│") + padRight(" " + t.fg("dim", "↑↓ 移动 · 回车 确定 · esc 取消"), inner) + b("│"));
		out.push(b(`╰${"─".repeat(inner)}╯`));
		return out;
	}
}

/** 开一个**弹窗**让用户单选一行；esc / 异常 → undefined */
export async function pickFromList(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
	const r = await ctx.ui.custom<string | null>(
		(_tui, theme, _kb, done) => new ListPicker(theme, title, options, done),
		{ overlay: true },
	);
	return r ?? undefined;
}

/** 按可见宽度折行（详情说明可能很长） */
function wrapText(s: string, w: number, maxLines = 3): string[] {
	const out: string[] = [];
	for (const para of String(s ?? "").split("\n")) {
		let line = "";
		if (!para) {
			out.push("");
			continue;
		}
		for (const ch of para) {
			if (visibleWidth(line + ch) > w) {
				out.push(line);
				line = ch;
			} else {
				line += ch;
			}
		}
		if (line) out.push(line);
	}
	return out.length ? out.slice(0, maxLines) : [""];
}
