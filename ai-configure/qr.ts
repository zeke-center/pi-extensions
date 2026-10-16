/**
 * qr.ts —— 把一段文本渲染成**终端里能扫的二维码**（半块字符 + 真彩色）。
 *
 * 为什么要 vendor 一个 56KB 的库（`vendor/qrcode.js`）而不是加 npm 依赖：
 *   `install.ps1` 是纯 `Copy-Item` 的拷贝通道 —— **没有 `npm install` 那一步**，
 *   所以任何 npm 依赖在拷贝通道下必然缺文件。而二维码编码（RS 纠错 + 掩码选优）
 *   自己写极易出错，干脆内联 kazuhikoarase/qrcode-generator（MIT · 零依赖 · 原文件未改）。
 *
 * 为什么不用主题色、要自己上真彩色：
 *   二维码要求「**深色模块在浅色底上**」。深色终端里如果按主题色画（前景浅、背景深），
 *   那么"浅色模块"会变成深色背景 → 整个码是**反的**，扫码成功率大幅下降。
 *   所以这里对二维码那几行单独套一层 黑字/白底，跟主题无关。
 *
 * 为什么用半块字符（▀▄█）：
 *   终端字符格大约「高 = 2 × 宽」。半块字符正好让**一个模块占一个方格**（宽 W × 高 H/2），
 *   于是模块是正方形 —— 这是二维码能被识别的几何前提。
 */

// vendor 的是 UMD，`module.exports = qrcode`；jiti 会按 CJS 互操作取到默认导出
import qrcodeFactory from "./vendor/qrcode.js";

/** 二维码规范要求静默区（quiet zone）= 4 个模块。终端里窄了容易扫不动，别省 */
const DEFAULT_QUIET = 4;

const BG = "\x1b[48;2;255;255;255m"; // 白底
const FG = "\x1b[38;2;0;0;0m"; // 黑块
const RESET = "\x1b[0m";

export type EcLevel = "L" | "M" | "Q" | "H";

export interface QrMatrix {
	/** 边长（模块数） */
	size: number;
	/** 越界一律当浅色（静默区） */
	isDark(row: number, col: number): boolean;
}

/** 算出模块矩阵。文本过长时抛错（由调用方降级成"只给链接"）。 */
export function qrMatrix(text: string, ecLevel: EcLevel = "M"): QrMatrix {
	// 第一个参数传 0 = 版本自动（按内容长度取最小的那个版本）
	const qr = qrcodeFactory(0, ecLevel);
	qr.addData(text);
	qr.make();
	const size: number = qr.getModuleCount();
	return {
		size,
		isDark: (row, col) => (row >= 0 && col >= 0 && row < size && col < size ? qr.isDark(row, col) : false),
	};
}

/**
 * 渲染成若干行文本。
 * @param colored true = 每行自带 黑字白底 的真彩色转义；false = 纯字符（测试/纯文本用）
 */
export function renderQr(text: string, quiet = DEFAULT_QUIET, colored = true): string[] {
	const m = qrMatrix(text);
	const lines: string[] = [];
	// 按"两行模块合成一行文本"遍历；起点是 -quiet，这样静默区也在里面
	for (let row = -quiet; row < m.size + quiet; row += 2) {
		let body = "";
		for (let col = -quiet; col < m.size + quiet; col++) {
			const top = m.isDark(row, col);
			const bottom = m.isDark(row + 1, col);
			// ▀ = 上半黑，▄ = 下半黑，█ = 上下都黑，空格 = 都浅
			body += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
		}
		lines.push(colored ? BG + FG + body + RESET : body);
	}
	return lines;
}

/** 渲染尺寸预估（给浮层算宽高用） */
export function qrBoxSize(text: string, quiet = DEFAULT_QUIET): { cols: number; rows: number } {
	const { size } = qrMatrix(text);
	return { cols: size + quiet * 2, rows: Math.ceil((size + quiet * 2) / 2) };
}

/**
 * “大码”版本：**每个模块占 2 个字符宽 × 1 行高**。
 *
 * 为什么需要：半块字符省地方，但模块只占 **1 个字符宽** —— 高分屏上二维码在物理屏幕上
 * 可能只有指甲盖大，手机摄像头根本对不上焦（实测：截图能被 jsqr 解码，但手机扫不到）。
 * 这个大版把模块**物理尺寸翻倍**，代价是宽度也翻倍（所以得终端够宽，调用方自己选）。
 */
export function renderQrBig(text: string, quiet = 2, colored = true): string[] {
	const m = qrMatrix(text);
	const lines: string[] = [];
	for (let row = -quiet; row < m.size + quiet; row++) {
		let body = "";
		for (let col = -quiet; col < m.size + quiet; col++) body += m.isDark(row, col) ? "██" : "  ";
		lines.push(colored ? BG + FG + body + RESET : body);
	}
	return lines;
}

/** 大码版的字符尺寸预估 */
export function qrBoxSizeBig(text: string, quiet = 2): { cols: number; rows: number } {
	const { size } = qrMatrix(text);
	return { cols: (size + quiet * 2) * 2, rows: size + quiet * 2 };
}
