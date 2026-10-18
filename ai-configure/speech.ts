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

export type UtteranceKind = "step" | "progress" | "result" | "error" | "ask";
export type SpeechLevel = "brief" | "steps" | "chatty" | "normal" | "full";
export type TermMode = "cn" | "en" | "off";

export interface Utterance {
	kind: UtteranceKind;
	prio: number;
	text: string;
	ttl?: number;
	ref?: string;
	/** 是否允许打断正在播的内容（错误=是；结论/提问=否，避免"报告被腰斩"） */
	interrupt?: boolean;
	/** 语音指令：交给豆包 context_texts（不计费），控制语气 */
	tone?: string;
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
	/** 显式指定的语气名（如 calm / warm / alert），来自 <step tone="..."> */
	tone?: string;
	/** full 级别用：完整回答原文 */
	full?: string;
}

/** 按播报类型自动选语气（豆包 context_texts，**不计费**） */
export const TONE_BY_KIND: Record<string, string> = {
	result: "请用沉稳、清晰的语气，像向同事当面汇报工作。",
	step: "请用轻松口语的语气，简短地说。",
	progress: "请用平静、不催促的语气。",
	ask: "请用征询的语气，像在问对方要不要这么做。",
	error: "请用提醒的语气，认真但不慌张。",
};

/** 我在 <step tone="..."> 里写的语气名 → 豆包指令 */
export const TONE_ALIAS: Record<string, string> = {
	calm: "请用沉稳、克制的语气说。",
	steady: "请用沉稳、克制的语气说。",
	warm: "请用温和、亲切的语气说。",
	alert: "请用提醒、认真的语气说。",
	brief: "请用简短、干脆的语气说。",
	cheerful: "请用轻快、有精神的语气说。",
	curious: "请用好奇、请教的语气说。",
};

export function toneFor(kind: string, named?: string | null): string | undefined {
	if (named && TONE_ALIAS[named]) return TONE_ALIAS[named];
	return TONE_BY_KIND[kind];
}

const PRIO: Record<UtteranceKind, number> = { progress: 0, step: 1, result: 2, error: 3, ask: 4 };

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

/**
 * 完整播报专用：**绝不说"详情见上文"**，只在句读处收口。
 * 口播稿本来就该一次说完（用户明确要求：别念一半让他去看屏幕）。
 */
export function completeForSpeech(text: string, maxChars = 600): string {
	const t = sanitizeForSpeech(text);
	if (t.length <= maxChars) return t;
	const cut = t.slice(0, maxChars);
	const last = Math.max(
		cut.lastIndexOf("。"),
		cut.lastIndexOf("！"),
		cut.lastIndexOf("？"),
		cut.lastIndexOf("；"),
	);
	return last > maxChars * 0.6 ? cut.slice(0, last + 1) : cut;
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

	if (e.kind === "step") {
		// 只有 steps / chatty 档才播阶段进展（brief 保持安静）
		if (level !== "steps" && level !== "chatty") return null;
		const text = trimForSpeech(e.text || "继续下一步。", 28);
		return { ...base, kind: "step", prio: PRIO.step, text, ttl: 12, tone: toneFor("step", e.tone) };
	}
	if (e.kind === "progress") {
		const text = post(e.text || "还在跑，稍等一下。");
		return { ...base, tone: toneFor("progress"), kind: "progress", prio: PRIO.progress, ttl: 20, text };
	}

	if (e.kind === "error") {
		const text = post(`卡住了：${e.reason || "原因不明"}。我停在原地等你。`);
		return { ...base, tone: toneFor("error"), kind: "error", prio: PRIO.error, text, interrupt: true };
	}

	if (e.kind === "ask") {
		const text = post(`${e.question || "需要你拍板"} 十秒内说停，我就先不动。`);
		return { ...base, tone: toneFor("ask"), kind: "ask", prio: PRIO.ask, text };
	}

	// result
	const whole = e.full || e.text || "";
	if (level === "full") {
		const spoken = extractSpoken(whole);
		const text = completeForSpeech(spoken || whole || "改完了。", 600);
		return { ...base, kind: "result", prio: PRIO.result, tone: toneFor("result"), text, interrupt: true };
	}

	// 1) 主模型自己写的口播稿（最自然，优先用）
	const spoken = extractSpoken(whole);
	if (spoken) {
		// 我自己写的口播稿 = 已经为耳朵准备过 → **整段念完**（最多 600 字保护）
		const text = completeForSpeech(spoken, 600);
		return { ...base, kind: "result", prio: PRIO.result, tone: toneFor("result"), text: applyTerms(text, opts.terms), interrupt: true };
	}

	// 2) 兜底：从标题/列表抽 2~4 条，念成"第一…第二…第三…"
	const maxPoints = level === "normal" ? 4 : 3;
	const points = keyPoints(whole, maxPoints);
	if (points.length) {
		let text = post(composePoints(points));
		if (level === "normal" && e.risk) text = post(`${composePoints(points)}另外要留意，${e.risk}。`);
		return { ...base, kind: "result", prio: PRIO.result, tone: toneFor("result"), text, interrupt: true };
	}

	// 3) 最后兜底：摘要一句话
	const head =
		typeof e.tests === "number" && typeof e.files === "number"
			? `改完了，${e.tests} 项测试全过，动了 ${e.files} 个文件。`
			: typeof e.files === "number"
				? `改完了，动了 ${e.files} 个文件。`
				: trimForSpeech(whole || "这轮做完了。", 120);
	const text = post(head + (level === "normal" && e.risk ? `另外要留意，${e.risk}。` : ""));
	return { ...base, kind: "result", prio: PRIO.result, tone: toneFor("result"), text, interrupt: true };
}

/** 兜底规则：按工具名 + 入参猜一句"我现在干什么"（≤20 字，播报用） */
export function stepTextFor(tool: string, input: any): string {
	const t = String(tool || "").toLowerCase();
	const a = (input ?? {}) as Record<string, any>;
	const cmd = String(a.command ?? a.cmd ?? "");
	const file = String(a.path ?? a.file_path ?? a.file ?? a.filePath ?? "");
	const base = file ? file.split(/[\/]/).pop() : "";
	if (t === "delegate") return "派个助理去查，我继续盯着。";
	if (t === "bash" || t === "shell" || t === "exec") {
		if (/test|vitest|jest|pytest|smoke|unit/i.test(cmd)) return "跑一下测试，稍等。";
		if (/git (push|commit|tag)/i.test(cmd)) return "提交并推送代码。";
		if (/install|npm i|pip install/i.test(cmd)) return "装一下依赖。";
		if (/curl|http/i.test(cmd)) return "查一下线上接口。";
		return "跑一条命令看看。";
	}
	if (t === "read" || t === "cat") return "看一下这段代码。";
	if (t === "grep" || t === "rg" || t === "search") return "在代码里搜一下。";
	if (t === "edit" || t === "write" || t === "patch") return "开始改代码。";
	if (t === "web_search" || t === "webfetch" || t === "fetch") return "上网查一下资料。";
	return "继续下一步。";
}

/**
 * 抽我自己写的阶段口语行：`<step>收到，我先去看后端实现</step>`。
 *
 * 为什么让我自己写：模板句（"看一下这段代码"）信息量低、听着像机器人。
 * 我清楚"这一步到底在干什么"，一句话就够，成本约 10 token，不阻塞任何流程。
 * 取**最后一条**（同一段里我可能写了多条，最新的最贴近当下的动作）。
 */
export function extractStep(text: string): string | null {
	const r = extractStepFull(text);
	return r ? r.text : null;
}

/** 连语气一起解析：`<step tone="calm">…</step>` */
export function extractStepFull(text: string): { text: string; tone?: string } | null {
	const t = String(text || "");
	const all = [...t.matchAll(/<step(?:\s+tone=(?:"([a-z]+)"|'?([a-z]+)'?))?>([\s\S]{1,120}?)<\/step>/gi)];
	if (!all.length) return null;
	const m = all[all.length - 1];
	const body = sanitizeForSpeech(m[3]);
	if (body.length < 2) return null;
	return { text: body, tone: m[1] || m[2] || undefined };
}
