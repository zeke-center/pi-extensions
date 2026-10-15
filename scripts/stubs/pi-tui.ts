/**
 * 测试用桩：把 `@earendil-works/pi-tui` 换成本文件（esbuild --alias）。
 * 只在渲染时才会用到这些函数，无头测试不渲染，所以给个最小实现即可。
 */
export function truncateToWidth(s: string, w: number): string {
	return s.length > w ? s.slice(0, w) : s;
}
export function visibleWidth(s: string): number {
	return s.length;
}

// 常用键的字节序列（用 fromCharCode 写，避免转义层层被吃 —— 之前在这里翻过车）
const ESC = String.fromCharCode(27);
const KEY_SEQ: Record<string, string[]> = {
	escape: [ESC],
	return: [String.fromCharCode(13), String.fromCharCode(10)],
	space: [" "],
	tab: [String.fromCharCode(9)],
	up: [ESC + "[A", ESC + "OA"],
	down: [ESC + "[B", ESC + "OB"],
	right: [ESC + "[C", ESC + "OC"],
	left: [ESC + "[D", ESC + "OD"],
	"ctrl+c": [String.fromCharCode(3)],
};

export function matchesKey(data: string, key: string): boolean {
	const seq = KEY_SEQ[key];
	return !!seq && seq.includes(data);
}

export const CURSOR_MARKER = "";

export type Focusable = any;
export type Component = any;
export type TUI = any;

/** 工具行文本组件（board.ts 的 renderResult 用它）；无头测试不渲染，给个最小实现 */
export class Text {
	constructor(
		public text: string,
		public x = 0,
		public y = 0,
	) {}
}
