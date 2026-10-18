/**
 * speech.ts —— 事件 → 口播稿（"说人话"这一层）
 *
 * 为什么要单独一层：屏幕上那份回答是**给眼睛的**（markdown/列表/代码/路径），
 * 直接念出来又长又难听。这一层把它压成 1~2 句、结论先行、适合耳朵的话。
 *
 * 三种级别：
 *   brief  只播结论/卡点/要你拍板（默认，日常用）
 *   normal ＋风险与决策点
 *   full   原文（给"我要听完整"的场景，会被截断到 ~60s）
 */

export type UtteranceKind = "progress" | "result" | "error" | "ask";
export type SpeechLevel = "brief" | "normal" | "full";
export type TermMode = "cn" | "en" | "off";

export interface Utterance {
	kind: UtteranceKind;
	prio: number;
	text: string;
	ttl?: number;
	ref?: string;
	/** 是否允许打断正在播的内容（错误=是；结论/提问=否，避免"报告被腰斩"） */
	interrupt?: boolean;
}

export interface SpeechEvent {
	kind: UtteranceKind;
	text?: string;
	files?: number;
	tests?: number;
	risk?: string;
	question?: string;
	reason?: string;
	ref?: string;
	/** full 级别用：完整回答原文 */
	full?: string;
}

const PRIO: Record<UtteranceKind, number> = { progress: 0, result: 1, error: 2, ask: 3 };

/** 英文术语 → 中文说法（cn 模式用；en 模式保留原词） */
const TERMS: Record<string, string> = {
	github: "代码托管站",
	gitee: "码云",
	gitlab: "代码托管站",
	codex: "代码模型",
	copilot: "代码助手",
	vscode: "编辑器",
	webpack: "打包工具",
	typescript: "TypeScript",
	javascript: "JavaScript",
	sqlite: "SQLite",
	postgres: "数据库",
	redis: "缓存",
	docker: "容器",
	kubernetes: "容器集群",
	api: "接口",
	sdk: "SDK",
	ui: "界面",
	ux: "体验",
	ci: "持续集成",
	pr: "合并请求",
	diff: "改动",
	commit: "提交",
	merge: "合并",
	branch: "分支",
	bug: "缺陷",
	prompt: "提示词",
	agent: "智能体",
	tts: "语音合成",
	stt: "语音识别",
	gpu: "显卡",
	cpu: "处理器",
	ram: "内存",
	json: "JSON",
	yaml: "YAML",
};

/** 口播前清洗：markdown / 代码块 / 路径 / 全角符号 */
export function sanitizeForSpeech(text: string): string {
	let t = String(text || "");
	t = t.replace(/```[\s\S]*?```/g, "，代码略，");
	t = t.replace(/`([^`]*)`/g, "$1");
	t = t.replace(/^\s*[-*+]\s+/gm, "");
	t = t.replace(/^\s*#{1,6}\s*/gm, "");
	t = t.replace(/[*_#>|]+/g, "");
	t = t.replace(/\[(.*?)\]\((.*?)\)/g, "$1");
	t = t.replace(/([A-Za-z]:)?[\\/][\w./\\-]{3,}\.(ts|js|py|json|md|ps1|tsx|jsx)/g, "");
	t = t.replace(/[（(]\s*[)）]/g, "");
	for (const bad of ["：", ":", "；", ";", "、", "—", "–"]) t = t.split(bad).join("，");
	t = t.replace(/\s+/g, " ").trim();
	// 收尾清理：连续逗号、句首逗号
	t = t.replace(/，{2,}/g, "，").replace(/^，+/, "").replace(/[，,]\s*。?$/, "。");
	return t;
}

export function applyTerms(text: string, mode: TermMode): string {
	if (mode !== "cn") return text;
	return text.replace(/[A-Za-z][A-Za-z0-9_.-]*/g, (w) => TERMS[w.toLowerCase()] ?? w);
}

/** 把一段长文压成"第一句能听懂"的短句（full 级别截断用） */
export function trimForSpeech(text: string, maxChars = 220): string {
	const t = sanitizeForSpeech(text);
	if (t.length <= maxChars) return t;
	const cut = t.slice(0, maxChars);
	const lastPunct = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
	return (lastPunct > 40 ? cut.slice(0, lastPunct + 1) : cut) + "细节在屏幕上。";
}

/** 优先用主模型自己写的口播稿：`[口播]…[/口播]` 或 `<speak>…</speak>` */
export function extractSpoken(text: string): string | null {
	const t = String(text || "");
	const m = t.match(/\[口播\]([\s\S]*?)\[\/口播\]/i) || t.match(/<speak>([\s\S]*?)<\/speak>/i);
	if (!m) return null;
	const body = sanitizeForSpeech(m[1]);
	return body.length >= 8 ? body : null;
}

/**
 * 从回答里抽"要点"（标题 / 列表项）。
 * 这是**没有口播块时的兜底**：至少能念出"第一…第二…第三…"，而不是只有一句"改完了"。
 */
export function keyPoints(text: string, max = 3): string[] {
	const t = String(text || "")
		.replace(/\[口播\][\s\S]*?\[\/口播\]/gi, "")
		.replace(/<speak>[\s\S]*?<\/speak>/gi, "");
	const lines = t.split(String.fromCharCode(10)).map((x) => x.replace(String.fromCharCode(13), "").trim());
	// 列表项优先；只有完全没有列表项时才退而用标题（标题多是"做完了三件事"这种，不适合念）
	const passes = [/^(?:[-*+]|\d+[.)、])\s+(.{4,})$/, /^#{1,5}\s+(.{2,})$/];
	for (const re of passes) {
		const out: string[] = [];
		for (const line of lines) {
			const m = line.match(re);
			if (!m) continue;
			const item = sanitizeForSpeech(m[1]).replace(/[。．.]+$/, "");
			if (item.length < 4 || out.includes(item)) continue;
			out.push(item.length > 42 ? `${item.slice(0, 42)}…` : item);
			if (out.length >= max) break;
		}
		if (out.length) return out;
	}
	return [];
}

const NUMS = ["第一", "第二", "第三", "第四", "第五"];

/** 把要点拼成"第一…第二…第三…"的口播句式 */
export function composePoints(points: string[], lead = "这轮做完了"): string {
	if (!points.length) return `${lead}。`;
	return `${lead}。${points.map((p, i) => `${NUMS[i] ?? "另外"}，${p}`).join("。")}。`;
}

export function render(
	e: SpeechEvent,
	opts: { level: SpeechLevel; terms: TermMode; maxFiles?: number },
): Utterance | null {
	const level = opts.level;
	const post = (s: string) => sanitizeForSpeech(applyTerms(s, opts.terms));
	const base = { ref: e.ref };

	if (e.kind === "progress") {
		const text = post(e.text || "还在跑，稍等一下。");
		return { ...base, kind: "progress", prio: PRIO.progress, ttl: 20, text };
	}

	if (e.kind === "error") {
		const text = post(`卡住了：${e.reason || "原因不明"}。我停在原地等你。`);
		return { ...base, kind: "error", prio: PRIO.error, text, interrupt: true };
	}

	if (e.kind === "ask") {
		const text = post(`${e.question || "需要你拍板"} 十秒内说停，我就先不动。`);
		return { ...base, kind: "ask", prio: PRIO.ask, text };
	}

	// result
	const whole = e.full || e.text || "";
	if (level === "full") {
		const spoken = extractSpoken(whole);
		const text = trimForSpeech(spoken || whole || "改完了。", 400);
		return { ...base, kind: "result", prio: PRIO.result, text, interrupt: true };
	}

	// 1) 主模型自己写的口播稿（最自然，优先用）
	const spoken = extractSpoken(whole);
	if (spoken) {
		const text = trimForSpeech(spoken, level === "normal" ? 320 : 240);
		return { ...base, kind: "result", prio: PRIO.result, text: applyTerms(text, opts.terms), interrupt: true };
	}

	// 2) 兜底：从标题/列表抽 2~4 条，念成"第一…第二…第三…"
	const maxPoints = level === "normal" ? 4 : 3;
	const points = keyPoints(whole, maxPoints);
	if (points.length) {
		let text = post(composePoints(points));
		if (level === "normal" && e.risk) text = post(`${composePoints(points)}另外要留意，${e.risk}。`);
		return { ...base, kind: "result", prio: PRIO.result, text, interrupt: true };
	}

	// 3) 最后兜底：摘要一句话
	const head =
		typeof e.tests === "number" && typeof e.files === "number"
			? `改完了，${e.tests} 项测试全过，动了 ${e.files} 个文件。`
			: typeof e.files === "number"
				? `改完了，动了 ${e.files} 个文件。`
				: trimForSpeech(whole || "这轮做完了。", 120);
	const text = post(head + (level === "normal" && e.risk ? `另外要留意，${e.risk}。` : ""));
	return { ...base, kind: "result", prio: PRIO.result, text, interrupt: true };
}
