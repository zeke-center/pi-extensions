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
export function matchesKey(): boolean {
	return false;
}
export const CURSOR_MARKER = "";

export type Focusable = any;
export type Component = any;
export type TUI = any;
