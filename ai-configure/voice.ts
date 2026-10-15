/**
 * voice.ts —— 语音模块：**不做语音识别**，只做「把你的话送进 pi」。
 *
 * 两种模式，各自独立开关：
 *
 *   ① `/voice talk`  对话模式（盯着输入框）
 *      你用输入法的语音快捷键把文字上屏到 pi 的输入框 → 认出「说完了」→ 自动回车。
 *      只在「pi 是当前焦点窗口」时有用。
 *
 *   ② `/voice clip`  剪贴板投递（不依赖焦点）
 *      输入法的语音结果会写进**系统剪贴板**（实测：167 字符逐字一致）。所以哪怕 pi
 *      最小化、不在前台，只要你在别处说完话，剪贴板一变 → 我们用触发词确认 → 投给 pi。
 *      你说「……，发送」→ 投递。没带触发词的一律丢弃（你复制网址/代码不会误投）。
 *
 * 为什么不做 STT：中文短句/标点/专有名词上，大厂 IME + 你的个人词库远胜自搭的
 * 「麦克风 → VAD → whisper」；而且喂给模型的本来就只是文字。
 * 为什么不 hook 全局快捷键：① 要从输入法手里抢键，冲突又脆弱；② 换输入法/换键位就得改代码。
 *
 * ⚠️ 剪贴板是全局公共通道：本模块只在**开启 clip 模式**时读它，内容只用于触发词比对，
 *    不落盘、不进日志；不带触发词的直接丢。
 *
 * talk 模式的判定（怎么区分语音上屏和手打、怎么防误发）：见下面 decideFrame 的注释。
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boardSnapshot } from "./board";
import { isExtDisabled, onGateApply } from "./gate";
import {
	cardDirPath,
	cardNotify,
	formatResultMeta,
	getNotifyMode,
	getPopupOn,
	getTts,
	notifyUser,
	sendResult,
	setNotifyMode,
	setPopupOn,
	setTts,
	summarizeReply,
	terminalInfo,
	type NotifyMode,
} from "./notify";
import {
	answerPlanAsk,
	getPlanCfg,
	hasPendingPlanAsk,
	parsePlanAnswer,
	setBackgroundTurn,
	setPlanCfg,
} from "./shared";

const STATUS_KEY = "ai-voice";
/** 轮询间隔：读一次输入框字符串，开销可以忽略 */
const POLL_MS = 250;
/** 单次文本增长到这个字数 = IME 成块上屏（人手打不出 250ms 3 个字） */
const MIN_BLOCK_CHARS = 3;
/** 默认「说完了」判定：最后一次变化后再静默这么久 */
const DEFAULT_SILENCE_MS = 1500;
/** 触发词：结尾说到它立刻发（可选「」。！」等标点/空白） */
export const SEND_WORD_RE = /(发送|确定|发出)[。.!！?？,，、\s]*$/;
/** talk 模式的触发词（与 SEND_WORD_RE 同口径，但走 matchTrigger 的完整清洗） */
export const SEND_WORDS = ["发送", "确定", "发出"];
/** 发完锁这么久，防和你手动回车抢跑 / 防两条拼接 */
const SEND_LOCK_MS = 600;
const MIN_SILENCE_MS = 400;
const MAX_SILENCE_MS = 10_000;

/** clip 模式默认触发词：短、顺口、句尾极少自然出现 */
export const DEFAULT_TRIGGERS = ["发送", "投给pi", "发给pi", "交给pi"];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ======================= 纯逻辑 1：talk 模式（输入框）=======================

export interface VoiceState {
	/** 上一帧的输入框文字 */
	text: string;
	/** 当前这段文字里是否见过「块状上屏」 */
	blockSeen: boolean;
	/** 最后一次文本变化的时刻 */
	lastChangeAt: number;
}

export interface VoiceDecision {
	text: string;
	blockSeen: boolean;
	lastChangeAt: number;
	/** 该不该发 */
	send: boolean;
	/** 发出去的正文（已剥掉触发词） */
	body: string;
}

/**
 * 一帧的判定。**纯函数**，方便单测把所有边界钉死。
 *
 * @param idle 主会话是否空闲（不空闲就绝不发 —— 别往队列里塞）
 * @param lockUntil 发完的锁定截止时间
 * @param autoSend true = 允许「块状上屏 + 静默」自动发（默认**关**）
 *
 * ⚠️ 为什么默认关：中文输入法**选词**也会一次性上屏 2~4 个字，跟语音上屏长得一模一样，
 * 于是「正常打字 → 停 1.5s」就被当成「说完了」把半句发出去（实测踩过）。
 * 关掉后只认句尾触发词（说「发送」），一个字的误发都不会有。
 */
export function decideFrame(
	prev: VoiceState,
	text: string,
	now: number,
	opts: { silenceMs: number; idle: boolean; lockUntil: number; autoSend: boolean },
): VoiceDecision {
	const out: VoiceDecision = {
		text,
		blockSeen: prev.blockSeen,
		lastChangeAt: prev.lastChangeAt,
		send: false,
		body: "",
	};

	// 文字变了 → 记账 + 重置静默计时（IME 会回头纠错改字，所以一变就算「还在说」）
	// ⚠️ 但**不 early return**：触发词要能「上屏那一瞬间就发」（否则白等一个 250ms 轮询）
	let changed = false;
	if (text !== prev.text) {
		if (text.length - prev.text.length >= MIN_BLOCK_CHARS) out.blockSeen = true;
		if (!text.trim()) out.blockSeen = false; // 空了（发完/被清）→ 下一条重新认
		out.lastChangeAt = now;
		changed = true;
	}

	if (!text.trim()) return out; // 空的，没啥可发
	if (now < opts.lockUntil) return out; // 刚发过，别抢

	// 触发词：跟 clip 用**同一套**匹配（含语气词、循环剥离、收尾清洗）
	const m = matchTrigger(text, SEND_WORDS, clipTailWindow);
	const byWord = m.hit;
	if (!byWord) {
		if (!opts.autoSend) return out; // 默认：只认触发词（防选词误发）
		if (changed) return out; // 刚刚变过 → 还不知道说完没
		if (!out.blockSeen) return out; // 手打的（没见过块状上屏）→ 不管
		if (now - out.lastChangeAt < opts.silenceMs) return out; // 停得还不够久
	}
	if (!opts.idle) return out; // pi 正在跑：等它空闲

	// 正文（触发词会被剥掉；只剩触发词 = 没正文可发，别发空的）
	const body = byWord ? m.body : text.trim();
	if (!body) return out;

	out.send = true;
	out.body = body;
	return out;
}

// ======================= 纯逻辑 2：触发词匹配（clip 模式）=======================

/**
 * 归一化**结尾**：去掉尾部标点/空白，再去掉一个语气词。
 * 「帮我查一下，发送吧」→「帮我查一下，发送」→ 命中「发送」。
 */
export function normalizeTail(text: string): string {
	return text
		.replace(/[\s。.!！?？,，、~～"'“”‘’）)】\]]+$/u, "")
		.replace(/[呀啊吧哦啦呢嘛哈嘞]$/u, "");
}

/**
 * 剥掉触发词后，正文尾巴上常留下一个逗号/顿号/冒号 → 清掉。
 * （但保留 ？！ 这类有语义的标点：你说的“？”不能被吃掉）
 */
function trimTailPunct(s: string): string {
	return s.replace(/[\s。.!！?？,，、~～"'“”‘’）)】\]]+$/u, "").trim();
}

function trimBody(s: string): string {
	return s.replace(/[\s,，、;；:：]+$/u, "").trim();
}

/**
 * 触发词匹配。**纯函数**。
 *
 * 三级：
 *   1. 结尾精确匹配（含大小写不敏感）
 *   2. 触发词 ≥3 字时允许**1 个字不同**（语音识别小出入，如「投给pi」→「头给pi」）
 *   3. 2 字触发词要求完全一致（否则「发送/发生」这类误匹配太多）
 *
 * @returns hit=false 时 body 原样返回（调用方直接丢弃）
 */
/**
/**
 * **前置处理**：剪贴板/语音文本进来先洗一遍。只去噪声，**不改语义**。
 *
 * 语音识别产物常见的噪声：多余空白、全角空格、把整句包在引号/书名号里、
 * 偶发控制字符、一条消息被拆成好几行（IME 有时每句一个换行）。
 * 句子**中间**的口癖（“嗯”“那个”）**不动** —— 那是你的原话，让模型自己理解。
 */
export function preprocessClip(text: string): string {
	let t = text
		.replace(/\r\n?/g, "\n")
		// 控制字符（保留 \n \t）
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		// 各种空白压成一个普通空格；三个以上换行压成两个
		.replace(/[ \t\u00a0\u3000]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	// 只在**成对包裹整句**时才剥引号（「…」/“…”/"…"/《…》/【…】）
	const pairs: [string, string][] = [
		["「", "」"],
		["『", "』"],
		["“", "”"],
		["‘", "’"],
		["《", "》"],
		["【", "】"],
		['"', '"'],
		["'", "'"],
	];
	for (const [a, b] of pairs) {
		while (t.length > a.length + b.length && t.startsWith(a) && t.endsWith(b)) t = t.slice(a.length, -b.length).trim();
	}
	return t;
}

/** 最多剥几层触发词（防手抖说八个「发送」把正文剥没了） */
export const MAX_TRIGGER_STRIPS = 4;

/** 单次匹配：只认**结尾**，只剥**一层** */
/** 否定词护栏：「别发送/不要发送/先别发出去」不是叫你投递 */
const NEG_BEFORE_RE = /(别|不要|不用|先别|取消|停|不)$/;

/** 结尾窗口里，触发词**后面**只允许这些填充物（否则就算误命中：“发送那个文件给我”不该命中） */
const FILLER_TAIL_RE =
	/^[\s。.!！?？,，、~～吧啊哦了呀呢嘛哈啦嘞嗯]*(?:(?:一下|这样|谢谢|就|的|好)[\s。.!！?？,，、~～吧啊哦了呀呢嘛哈啦嘞嗯]*)*$/u;

/**
 * 单次匹配。**纯函数**。
 *
 * 三种命中（按优先级）：
 *   ① 严格结尾精确 —— 最可靠
 *   ② 严格结尾模糊：只对 ≥3 字的触发词，末尾同长度片段允许 1 字不同（抗识别误差）
 *   ③ **结尾窗口**（window > 0）：触发词只要在末尾 window 个字以内就行 ——
 *      治「IME 智能整理把『发送』后面又补了字」（“…发送，就这样”），只用精确匹配。
 * 全部命中都要过**否定词护栏**（“别发送”不算）。
 *
 * @returns at = 触发词在原文中的下标（台账用来显示「命中在倒数第几字」）
 */
function matchOnce(
	t: string,
	triggers: string[],
	window = 0,
): { hit: boolean; body: string; trigger: string; at: number } {
	const lower = t.toLowerCase();
	const strip = (i: number, len: number, trig: string): { hit: boolean; body: string; trigger: string; at: number } => ({
		hit: true,
		body: t.slice(0, i) + t.slice(i + len),
		trigger: trig,
		at: i,
	});
	const negated = (i: number): boolean => NEG_BEFORE_RE.test(t.slice(Math.max(0, i - 2), i));
	for (const raw of triggers) {
		const trg = (raw ?? "").trim().toLowerCase();
		if (!trg) continue;
		// ① 精确结尾
		if (lower.endsWith(trg) && !negated(t.length - trg.length)) {
			return strip(t.length - trg.length, trg.length, raw.trim());
		}
		// ② 模糊：只对 ≥3 字的触发词，末尾同长度片段允许 1 字不同（抗识别误差）
		if (trg.length >= 3 && t.length >= trg.length && !negated(t.length - trg.length)) {
			const tail = lower.slice(-trg.length);
			let same = 0;
			for (let i = 0; i < trg.length; i++) if (tail[i] === trg[i]) same++;
			if (same >= trg.length - 1) {
				return strip(t.length - trg.length, trg.length, `${raw.trim()}~${tail}`);
			}
		}
		// ③ 结尾窗口（精确匹配；且触发词后面只能是标点/语气词/“一下”这类填充物）
		// 命中时**连尾部的填充物一起丢掉**（“，就这样”不是正文），只留触发词之前的内容
		if (window > 0) {
			const idx = lower.lastIndexOf(trg, t.length - 1);
			if (idx >= 0 && idx >= t.length - window - trg.length && !negated(idx)) {
				const tail = t.slice(idx + trg.length);
				if (FILLER_TAIL_RE.test(tail)) {
					return { hit: true, body: t.slice(0, idx), trigger: raw.trim(), at: idx };
				}
			}
		}
	}
	return { hit: false, body: t, trigger: "", at: -1 };
}

/**
 * **护栏**：这段剪贴板内容"像不像你随口说的一句话"（静默投递的安全闸门）。**纯函数**。
 *
 * 为什么要它：静默模式下不再要求触发词，那就必须挡住"你复制的代码/网址/日志/英文文档"
 * —— 否则一 Ctrl+C 就会被当成指令投给 pi。
 */
export function looksLikeSpeech(text: string): { ok: boolean; why: string } {
	const t = preprocessClip(text).trim();
	if (t.length < 6) return { ok: false, why: "太短" };
	if (t.length > 800) return { ok: false, why: "太长（像贴进来的文档）" };
	if (/(https?:\/\/|www\.)/i.test(t)) return { ok: false, why: "含网址" };
	if (/\b(Error|Traceback|Exception|TypeError)\b/.test(t)) return { ok: false, why: "像错误信息" };
	if (/^[>$#]|```/.test(t)) return { ok: false, why: "像代码/引用/命令行" };
	// 斜杠开头 = 指令（比如你复制了 /voice 的 help 行）—— 那是要敲进终端的，不是要说给我的
	if (/^\s*\//.test(t)) return { ok: false, why: "像指令（/开头）" };
	// help/文档行：一行里出现多个「/xxx 子命令」样式
	if ((t.match(/\/[a-z][a-z-]{2,}/gi) ?? []).length >= 2) return { ok: false, why: "像文档/命令列表" };
	const cjk = (t.match(/[一-龥]/g) ?? []).length;
	if (cjk / t.length < 0.4) return { ok: false, why: "中文太少（像复制的英文/代码）" };
	const sym = (t.match(/[{}()\[\];=<>|\/`_~^$]/g) ?? []).length;
	if (sym > 8 && sym / t.length > 0.06) return { ok: false, why: "代码符号太多" };
	if (t.split("\n").length >= 5) return { ok: false, why: "分行太多（像日志/列表）" };
	return { ok: true, why: "像一句话" };
}

/**
 * 「内容判断」总开关（纯函数）：
 * - 开：跑 `looksLikeSpeech` 那套启发式（太短/太长/网址/错误栈/代码/指令/中文占比/符号/分行）
 * - 关：**不猜**，只要不是空/单字就投（你自己心里有数时用）
 */
export function guardContent(text: string, guessOn = true): { ok: boolean; why: string } {
	if (guessOn) return looksLikeSpeech(text);
	const t = text.trim();
	return t.length >= 2 ? { ok: true, why: "内容判断已关，直接投" } : { ok: false, why: "太短" };
}

/** 尾部“话头”：说完就停了，留着反而干扰模型（只剥首尾，中间不碰） */
const DANGLING_TAIL = ["然后", "还有", "就是", "另外", "以及", "所以", "但是", "不过", "而且", "那个"];

/**
 * 发出去之前对**正文**做的收尾清洗（触发词已经剥掉了）。**纯函数**。
 *
 * 两条规则都是从**真实语音样本**里踩出来的：
 *   1. ASR 叠字：「看看看到底区别在哪里」→「看看到底区别在哪里」（连续 ≥3 个相同汉字折成 2 个）
 *   2. 尾部悬空连接词：「…有可以优化的地方，然后」→「…有可以优化的地方」（最多剥 2 个）
 */
export function cleanBody(s: string): { text: string; cleaned: number } {
	let t = s.replace(/([\u4e00-\u9fa5])\1{2,}/g, "$1$1");
	let cleaned = 0;
	for (let i = 0; i < 2; i++) {
		const n = trimTailPunct(trimBody(t));
		let hit = false;
		for (const d of DANGLING_TAIL) {
			if (n.length > d.length && n.endsWith(d)) {
				t = trimBody(n.slice(0, n.length - d.length));
				cleaned++;
				hit = true;
				break;
			}
		}
		if (!hit) break;
	}
	return { text: t.trim(), cleaned };
}

/**
 * 触发词匹配。**纯函数**。
 *
 * 流程：前置清洗 → 归一化结尾 → **循环剥**尾部触发词（治「说两遍发送」：
 * 「帮我查一下，发送，发送。」→ 正文「帮我查一下」，strips=2）→ 收尾清洗。
 * 每次剥完再归一化一次（剥完常留一个逗号/语气词）。
 *
 * 三级匹配：① 结尾精确 ② ≥3 字的触发词允许 1 字识别误差 ③ 2 字触发词必须完全一致
 * （否则「发送/发生」误匹配太多）。
 *
 * @returns strips = 剥掉几层触发词；cleaned = 顺手清掉几个尾巴话头；
 *          body 为空表示「你只说了触发词」→ 调用方应丢弃
 */
export function matchTrigger(
	text: string,
	triggers: string[],
	/** 触发词允许出现在末尾多少个字以内（默认 6；0 = 必须严格结尾） */
	window = DEFAULT_TAIL_WINDOW,
): { hit: boolean; body: string; trigger: string; strips: number; cleaned: number; at: number; window: number } {
	let t = normalizeTail(preprocessClip(text));
	const got: string[] = [];
	let at = -1;
	for (let i = 0; i < MAX_TRIGGER_STRIPS; i++) {
		const m = matchOnce(t, triggers, window);
		if (!m.hit) break;
		got.push(m.trigger);
		if (at < 0) at = m.at;
		t = trimBody(trimTailPunct(m.body));
		if (!t) break;
	}
	if (!got.length) return { hit: false, body: text, trigger: "", strips: 0, cleaned: 0, at: -1, window };
	const fin = cleanBody(t);
	return {
		hit: true,
		body: fin.text,
		trigger: got.join(" + "),
		strips: got.length,
		cleaned: fin.cleaned,
		at,
		window,
	};
}

/** 结尾窗口默认值：IME 智能整理常把触发词后面又补一两个字 */
export const DEFAULT_TAIL_WINDOW = 6;

// ======================= 纯逻辑 3：投递档位 =======================

/** 忙的时候怎么办：插话（默认）/ 排队 / 真打断 */
export type ClipMode = "steer" | "queue" | "abort";

export interface ClipDelivery {
	deliverAs?: "steer" | "followUp";
	abort: boolean;
	/** 给用户看的反馈文案 */
	note: string;
}

export function decideDelivery(opts: { idle: boolean; mode: ClipMode }): ClipDelivery {
	if (opts.idle) return { abort: false, note: "已直接开始处理" };
	switch (opts.mode) {
		case "queue":
			return { deliverAs: "followUp", abort: false, note: "已加入后续队列" };
		case "abort":
			return { abort: true, note: "已打断当前任务，改为处理这条" };
		default:
			return { deliverAs: "steer", abort: false, note: "已插话到当前任务" };
	}
}

// ======================= 配置（ai-extensions.json）=======================

function cfgFile(): string {
	return join(getAgentDir(), "ai-extensions.json");
}

function readCfg(): Record<string, unknown> {
	try {
		const raw = JSON.parse(readFileSync(cfgFile(), "utf8")) as unknown;
		return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	} catch {
		return {}; // 没文件 / 坏了 → 用默认值，别因为一个配置项把插件搞挂
	}
}

/** 改键**合并**写回（不能把 delegate 的 assistantLingerMs 冲掉） */
function patchCfg(patch: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(cfgFile()), { recursive: true });
		writeFileSync(cfgFile(), `${JSON.stringify({ ...readCfg(), ...patch }, null, 2)}\n`, "utf8");
	} catch {
		/* 写不进去就算了，内存里照样生效 */
	}
}

// ======================= 状态 =======================

let apiRef: ExtensionAPI | undefined;
let lastCtx: ExtensionContext | undefined;
/** talk 模式：输入框轮询定时器 */
let timer: ReturnType<typeof setInterval> | undefined;

/** talk 模式开关（持久化） */
let talkOn = false;
/** 允许「静默自动发」（默认关 —— 中文选词会误发） */
let talkAuto = false;
let silenceMs = DEFAULT_SILENCE_MS;

/** clip 模式开关 / 档位 / 触发词（持久化） */
let clipOn = false;
/** 投递时给正文加个 `📋 ` 标记（默认开）—— 转录里一眼看出“这条是语音投递来的，不是手打的” */
let clipMark = true;
// 「内容判断」总开关：开 = 猜「像不像人话」（太短/网址/错误栈/代码/指令/中文占比…）；
// 关 = 不猜，剪贴板一安静下来就投（只留去重 + 非空）。默认开。
let clipGuess = true;
let clipMode: ClipMode = "steer";
let clipTriggers: string[] = [...DEFAULT_TRIGGERS];
/** 提示音（持久化，默认开） */
let beepOn = true;

/** 被 `/ai-ext off` 暂停（不持久化） */
let paused = false;

/** talk：输入框状态机 */
let state: VoiceState = { text: "", blockSeen: false, lastChangeAt: 0 };
let lockUntil = 0;
let sentCount = 0;

/** clip：常驻 helper 进程 */
let clipHelper: ChildProcess | undefined;
let helperBuf = "";
/** clip：最近投过的内容 hash（防重复投递） */
/**
 * 剪贴板事件台账（**只在内存里，绝不落盘**）。
 * 记**每一次**事件 + 判定结果 —— “它到底投了没、为什么没投”一句话能查，不用猜。
 */
const clipEvt: { at: number; kind: string; note: string; body?: string }[] = [];

function cancelSilent(): void {
	if (silentTimer) {
		clearTimeout(silentTimer);
		silentTimer = undefined;
	}
	silentPending = undefined;
}

function clipEvent(kind: string, note: string, body?: string): void {
	clipEvt.push({ at: Date.now(), kind, note, body });
	if (clipEvt.length > 12) clipEvt.shift();
}


/** 触发模式：word = 必须说触发词（安全）· silent = 有触发词立刻发，没有就静默后自动发（默认） */
let clipTriggerMode: "word" | "silent" = "silent";
/** 静默模式：剪贴板停止变化多久后才投（IME 可能一段段往上写，不能第一段就投） */
let clipSilentMs = 1200;
let silentTimer: ReturnType<typeof setTimeout> | undefined;
/** 等待静默的候选内容（新的来了就替换、重新计时） */
let silentPending: string | undefined;

/** 触发词允许出现在末尾多少个字以内（0 = 必须严格结尾） */
let clipTailWindow = DEFAULT_TAIL_WINDOW;

/** 同一条内容在这么长时间内只投一次（治输入法把同一段文字又写回剪贴板） */
const DEDUP_WINDOW_MS = 180_000;

/** 最近见过的剪贴板内容（sha1 + 时间，不存正文） */
let clipSeen: { h: string; at: number }[] = [];
let clipCount = 0;
/** clip：投过、但还没跑完的那一轮存在 → 跑完要通知你 */
let clipPending = false;

/** 本轮统计（给结果卡片用） */
let turnStart = 0;
let turnTools = 0;
let turnFailed = 0;
let turnFiles: string[] = [];
/** 本轮是语音投递触发的 */
let turnWasVoice = false;
/** 下一轮会不会是语音投递（deliverClip 发消息前置 true） */
let pendingVoice = false;
/** 本轮是自触发（custom message）轮次 */
let turnIsCustom = false;
/** 本轮已经弹过结果卡片 */
let resultSent = false;
/** 结果卡片开关 + 手打轮的时长阈值（秒，0 = 手打轮从不弹） */
let resultOn = true;
/** 语音播报：开 = 弹卡片的同时自动念，念完卡片一起消失 */
let ttsOn = false;
let ttsVoiceName = "";
let ttsRate = 0;
let ttsVolume = 100;
/** 自绘弹窗总开关 */
let popupOn = true;
let resultLongSec = 20;
/** 最后一轮的 assistant 文本（message_end 抓） */
let lastAssistantText = "";


function isTui(ctx: ExtensionContext | undefined): boolean {
	try {
		return ctx?.hasUI === true && ctx.mode === "tui";
	} catch {
		return false;
	}
}

function running(): boolean {
	return (talkOn || clipOn) && !paused && !isExtDisabled();
}

function preview(s: string, n = 20): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** 最近一次被丢弃的原因（状态栏显示 15s，省得你去翻台账） */
let lastDrop: { why: string; at: number } | undefined;

/** 记一次丢弃 + 刷新状态栏（15s 后自动清掉提示） */
function noteDrop(why: string): void {
	lastDrop = { why, at: Date.now() };
	refreshStatus();
	setTimeout(() => {
		if (lastDrop && Date.now() - lastDrop.at >= 14_000) {
			lastDrop = undefined;
			refreshStatus();
		}
	}, 15_000).unref?.();
}

function refreshStatus(): void {
	const ctx = lastCtx;
	if (!ctx?.hasUI) return;
	try {
		// ⚠️ 两个通道是独立的，状态栏必须各写各的（以前剪贴板那截不显示模式 →
		// 你把剪贴板改成「自动」后，看到输入框那截还写着「只认触发词」就会以为没生效）
		const bits: string[] = [];
		if (talkOn) bits.push(`🎙 输入框·${talkAuto ? `静默${(silenceMs / 1000).toFixed(1)}s` : "触发词"}`);
		bits.push(clipOn ? `📋 剪贴板·${clipTriggerMode === "silent" ? "自动" : "触发词"}${clipGuess ? "" : "·直投"}` : "📋 剪贴板·关");
		if (clipOn && lastDrop && Date.now() - lastDrop.at < 15_000) bits.push(`⚠️ 没投：${lastDrop.why}`);
		const on = running();
		ctx.ui.setStatus(
			STATUS_KEY,
			on && bits.length
				? ctx.ui.theme.fg("accent", `${bits.join(" ")}${sentCount + clipCount ? ` ·${sentCount + clipCount}` : ""}`)
				: undefined,
		);
	} catch {
		/* 状态栏失败不影响功能 */
	}
}

// ======================= talk 模式（输入框）=======================

function arm(): void {
	if (timer || !talkOn) return;
	timer = setInterval(() => {
		try {
			tick();
		} catch (e) {
			// 定时器里的异常没人接 → 会直接干挂进程（实测踩过），必须自己吞
			console.error("[ai-configure] voice: 轮询出错：", e);
		}
	}, POLL_MS);
}

function disarm(): void {
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
}

/** 发一条出去（清空输入框；失败则把文字放回，绝不丢） */
async function sendNow(body: string): Promise<void> {
	const text = body.trim();
	if (!text) return;
	// 先清空：既避免和「你按回车」抢跑，也避免发完残留跟下一条拼一起
	state = { text: "", blockSeen: false, lastChangeAt: Date.now() };
	lockUntil = Date.now() + SEND_LOCK_MS;
	try {
		lastCtx?.ui.setEditorText("");
	} catch {
		/* ignore */
	}
	try {
		await apiRef?.sendUserMessage(text);
		sentCount++;
		refreshStatus();
	} catch (e) {
		console.error("[ai-configure] voice: 自动发送失败：", e);
		try {
			lastCtx?.ui.setEditorText(text); // 放回去，你自己按回车
		} catch {
			/* ignore */
		}
		state = { text, blockSeen: false, lastChangeAt: Date.now() };
		lockUntil = Date.now() + 3000; // 别死循环重试
	}
}

function tick(): void {
	if (!running() || !talkOn) return;
	const ctx = lastCtx;
	if (!ctx?.hasUI) return;
	let text = "";
	try {
		text = ctx.ui.getEditorText();
	} catch {
		return; // ctx 可能已过期（切会话/重载），静等下一次 session_start 刷新
	}
	let idle = false;
	try {
		idle = ctx.isIdle();
	} catch {
		return;
	}
	const now = Date.now();
	const d = decideFrame(state, text, now, { silenceMs, idle, lockUntil, autoSend: talkAuto });
	state = { text: d.text, blockSeen: d.blockSeen, lastChangeAt: d.lastChangeAt };
	if (d.send) void sendNow(d.body);
}

// ======================= clip 模式（剪贴板 helper）=======================

/**
 * ⚠️ 纯 ASCII：PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解，中文会直接把脚本搞成语法错误（踩过）。
 *
 * 要点：
 *   - `GetClipboardSequenceNumber()` 当哨兵（微秒级）→ **只有真变了才去读文本**（CPU 0.15%）
 *   - 中文内容用 **base64** 出 stdout，躲开控制台编码坑
 *   - 每 8 tick（≈2s）查一次父进程还在不在 → pi 没了就自杀（不留孤儿）
 */
const CLIP_PS1 = `
param([int]$ParentPid = 0, [int]$IntervalMs = 250)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace PiVoice -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 孤儿清理：只干掉「父进程已死」的同款 helper（避免两个 helper 抢剪贴板导致重复投递；
# 同时也绝不按名字杀掉活着的那个 —— 免得别的会话被误伤）
try {
  $me = $PID
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    $_.CommandLine -like '*pi-voice-clip.ps1*' -and $_.ProcessId -ne $me
  } | ForEach-Object {
    $alive = $false
    if ($_.ParentProcessId -gt 0) { $alive = [bool](Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) }
    if (-not $alive) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
} catch { }

$seq = [PiVoice.Native]::GetClipboardSequenceNumber()
# 启动登记：把「helper 起来前就已在剪贴板里的内容」报给 pi，**只登记不投递**
# （否则 /reload 重启 helper 后会把上一条旧话当成新话重放一遍 —— 实测踩过）
$p = $null
try { $p = Get-Clipboard -Raw } catch { $p = $null }
if (-not [string]::IsNullOrEmpty($p)) {
  $pb = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($p))
  [Console]::Out.WriteLine('P ' + $seq + ' ' + $pb)
}
$last = $p
$lastAt = Get-Date
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$ticks = 0
while ($true) {
  Start-Sleep -Milliseconds $IntervalMs
  $ticks++
  if ((($ticks % 8) -eq 0) -and ($ParentPid -gt 0)) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  }
  $n = [PiVoice.Native]::GetClipboardSequenceNumber()
  if ($n -eq $seq) { continue }
  $seq = $n
  $t = $null
  try { $t = Get-Clipboard -Raw } catch { $t = $null }
  if ([string]::IsNullOrEmpty($t)) { continue }
  if ($t -eq $last) {
    # 内容没变（只是序号被其他程序顶了一下）→ 不当新内容；但超过 3 分钟后再复制同一句仍然算新
    if (((Get-Date) - $lastAt).TotalSeconds -lt 180) { continue }
  }
  $last = $t
  $lastAt = Get-Date
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t))
  [Console]::Out.WriteLine('T ' + $n + ' ' + $b64)
  [Console]::Out.Flush()
}
`;

const clipPidFile = (): string => join(getAgentDir(), "pi-voice-clip.pid");

/** pid 文件里那个 helper 还活着吗（认领用，避免起第二个导致重复投递） */
function clipHelperAliveByPidFile(): boolean {
	try {
		const f = clipPidFile();
		if (!existsSync(f)) return false;
		const pid = Number(readFileSync(f, "utf8").trim());
		if (!Number.isFinite(pid) || pid <= 0) return false;
		const r = spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-Command",
				`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.CommandLine -like '*pi-voice-clip.ps1*') { 'YES' }`,
			],
			{ encoding: "utf8", windowsHide: true },
		);
		return String(r.stdout ?? "").includes("YES");
	} catch {
		return false;
	}
}

/**
 * 清掉「比 keep 更早」的重复 helper。
 * 两个 helper 抢同一个剪贴板 → 同一条话投两遍（实测踩过）；只清更早的，绝不动最新的。
 */
function sweepOlderClipHelpersKeep(keep: number): void {
	try {
		spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-Command",
				`$k = Get-CimInstance Win32_Process -Filter "ProcessId=${keep}"; if ($k) { Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*pi-voice-clip.ps1*' -and $_.ProcessId -ne ${keep} -and $_.CreationDate -lt $k.CreationDate } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
			],
			{ stdio: "ignore", windowsHide: true },
		);
	} catch {
		/* ignore */
	}
}

function clipScriptPath(): string {
	return join(getAgentDir(), "pi-voice-clip.ps1");
}

function ensureClipScript(): string | undefined {
	try {
		const f = clipScriptPath();
		const cur = existsSync(f) ? readFileSync(f, "utf8") : undefined;
		if (cur !== CLIP_PS1) {
			mkdirSync(getAgentDir(), { recursive: true });
			writeFileSync(f, CLIP_PS1, "utf8");
		}
		return f;
	} catch {
		return undefined;
	}
}

function startClipHelper(): void {
	if (clipHelper) return;
	const f = ensureClipScript();
	if (!f) return;
	// 已经有一个活着的 helper（本实例起的，或另一个扩展实例起的）→ 认领，绝不再起第二个
	// （两个 helper 会抢同一个剪贴板 → 同一条话投两遍 —— 实测踩过）
	if (clipHelperAliveByPidFile()) {
		clipEvent("复用已有 helper", "检测到已有剪贴板 helper，直接复用（避免重复投递）");
		try {
			const keep = Number(readFileSync(clipPidFile(), "utf8").trim());
			if (Number.isFinite(keep) && keep > 0) sweepOlderClipHelpersKeep(keep);
		} catch {
			/* ignore */
		}
		return;
	}
	try {
		clipHelper = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", f, "-ParentPid", String(process.pid), "-IntervalMs", "250"],
			{ detached: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
		);
		clipHelper.stdout?.on("data", (d: Buffer) => {
			for (const line of String(d).split("\n")) onHelperLine(line.trim());
		});
		clipHelper.on("error", () => {
			clipEvent("helper 启动失败", "powershell 起不来");
			clipHelper = undefined;
		});
		clipHelper.on("exit", () => {
			clipHelper = undefined;
		});
		clipHelper.unref();
		try {
			writeFileSync(clipPidFile(), String(clipHelper.pid ?? ""), "utf8");
			if (clipHelper.pid) sweepOlderClipHelpersKeep(clipHelper.pid);
		} catch {
			/* ignore */
		}
		clipEvent("helper 已启动", `pid=${clipHelper.pid ?? "?"}`);
	} catch (e) {
		console.error("[ai-configure] voice: 起剪贴板 helper 失败：", e);
		clipEvent("helper 启动失败", "异常");
	}
}
function stopClipHelper(): void {
	const c = clipHelper;
	clipHelper = undefined;
	helperBuf = "";
	if (!c) return;
	try {
		c.kill();
	} catch {
		/* ignore */
	}
}

/** helper 的一行：READY / T <seq> <base64> */
function onHelperLine(line: string): void {
	if (!line || line === "READY") return;
	const primed = line.startsWith("P ");
	if (!primed && !line.startsWith("T ")) return;
	const parts = line.split(" ");
	if (parts.length < 3) return;
	let text = "";
	try {
		text = Buffer.from(parts[2]!, "base64").toString("utf8");
	} catch {
		return;
	}
	if (!text.trim()) return;

	// 去重：同一条内容（3 分钟内）不重复投 —— 看门狗拿剪贴板时，输入法/系统有时会把同一段文字再写一次
	const h = createHash("sha1").update(text).digest("hex");
	const lru = createHash("sha1").update(text).digest("hex");
	void lru;
	const now = Date.now();
	clipSeen = clipSeen.filter((e) => now - e.at < DEDUP_WINDOW_MS);
	const hit = clipSeen.find((e) => e.h === h);
	clipSeen.push({ h, at: now });
	if (clipSeen.length > 50) clipSeen = clipSeen.slice(-50);
	if (hit) {
		clipEvent("丢弃·重复", `${Math.round((now - hit.at) / 1000)}s 前投过同一条`, text);
		noteDrop("3 分钟内投过同一条");
		return;
	}
	// 启动登记：helper 刚起来时剪贴板里已有的内容 → 只登记不投（治「重载后重放旧话」）
	if (primed) {
		clipEvent("启动登记", "helper 启动时剪贴板里已有的内容（不投递）", text);
		return;
	}

	const m = matchTrigger(text, clipTriggers, clipTailWindow);
	// 带了触发词 → 立刻投（两种模式都一样）
	if (m.hit) {
		if (!m.body.trim()) {
			clipEvent("丢弃·只说了触发词", "没有正文", text);
			noteDrop("只说了触发词、没有正文");
			return;
		}
		cancelSilent();
		void deliverClip(m.body, text, { strips: m.strips, cleaned: m.cleaned, at: m.at });
		return;
	}
	// 没带触发词
	if (clipTriggerMode === "word") {
		clipEvent("丢弃·无触发词", "word 模式：结尾必须有触发词", text);
		noteDrop("word 模式：句尾要带触发词");
		return;
	}
	// 静默模式：先过护栏，再等「剪贴板安静下来」（IME 可能一段段写）
	const look = guardContent(text, clipGuess);
	if (!look.ok) {
		clipEvent("丢弃·不像语音", `静默模式护栏拦下：${look.why}`, text);
		noteDrop(look.why);
		return;
	}
	silentPending = text;
	if (silentTimer) clearTimeout(silentTimer);
	silentTimer = setTimeout(() => {
		silentTimer = undefined;
		const t = silentPending;
		silentPending = undefined;
		if (!t) return;
		const look2 = guardContent(t, clipGuess);
		if (!look2.ok) {
			clipEvent("丢弃·不像语音", `静默模式护栏拦下：${look2.why}`, t);
			noteDrop(look2.why);
			return;
		}
		const fin = cleanBody(preprocessClip(t));
		if (!fin.text.trim()) {
			clipEvent("丢弃·空内容", "清洗后没内容了", t);
			noteDrop("清洗后没内容了");
			return;
		}
		clipEvent("静默投递", `没说触发词，安静 ${clipSilentMs}ms 后自动投（${look2.why}）`, t);
		void deliverClip(fin.text, t, { strips: 0, cleaned: fin.cleaned, at: -1 });
	}, clipSilentMs);
	silentTimer.unref?.();
	clipEvent("等待静默", `候选内容已记下，安静 ${clipSilentMs}ms 就投`, text);
}

/** 把一条内容投给主会话（按档位） */
/**
 * 投递完顺手清掉输入框里那同一段文字。
 *
 * 为什么需要：焦点在 pi 输入框时，输入法的语音结果会「先写剪贴板、再粘贴进输入框」，
 * 于是同一句话既被 clip 投递了、又留在输入框里 —— 不清掉的话你下次按回车会再发一遍。
 * 只在**完全一致**时才清（你正在打自己的草稿绝不动）。
 */
function clearEditorIfSame(raw: string, body: string): void {
	const ctx = lastCtx;
	if (!ctx?.hasUI) return;
	try {
		const cur = ctx.ui.getEditorText();
		const t = cur.trim();
		if (t && (t === raw.trim() || t === body.trim())) {
			ctx.ui.setEditorText("");
			console.error("[ai-configure] voice: 已清掉输入框里同一段语音文本");
		}
	} catch {
		/* 清不掉就算了，不影响投递 */
	}
}

// 当前挂着的弹窗张数（登记簿里还有几个活着的小文件）
function liveCards(): number {
	try {
		const dir = cardDirPath();
		if (!existsSync(dir)) return 0;
		return readdirSync(dir).filter((f) => f.endsWith(".txt")).length;
	} catch {
		return 0;
	}
}

async function deliverClip(
	body: string,
	raw = body,
	meta: { strips?: number; cleaned?: number; at?: number; origin?: string } = {},
): Promise<void> {
	if (!apiRef || !lastCtx) return;
	// ⚠️ 正在等「计划确认」时，这句话不是新任务，而是**对那个计划的答复**（方案 A）：
	//    「同意」→ 执行 · 「不行」→ 撤 · 其他内容 → 当成「我要改」的意见
	if (hasPendingPlanAsk()) {
		const parsed = parsePlanAnswer(body);
		if (parsed) {
			const done = answerPlanAsk(parsed.a, parsed.note ?? body);
			if (done) {
				clipEvent(
					"计划答复",
					parsed.a === "yes" ? "同意该计划" : parsed.a === "no" ? "否决该计划" : "当成修改意见",
					body,
				);
				notifyUser({
					title: `pi · 计划答复已送达（${parsed.a === "yes" ? "同意" : parsed.a === "no" ? "不同意" : "要改"}）`,
					body: preview(body, 60),
					osc: isTui(lastCtx),
					beep: beepOn,
				});
				clipCount++;
				refreshStatus();
				return;
			}
		}
	}
	let idle = false;
	try {
		idle = lastCtx.isIdle();
	} catch {
		idle = true;
	}
	const d = decideDelivery({ idle, mode: clipMode });
	const payload = clipMark ? `📋 ${body}` : body; // 标记：让转录里一眼看出这是语音投递来的
	try {
		if (d.abort) {
			try {
				lastCtx.abort();
			} catch {
				/* ignore */
			}
			// 等它真的停下来（最多 5s），否则 sendUserMessage 会被拒
			for (let i = 0; i < 20; i++) {
				await sleep(250);
				try {
					if (lastCtx.isIdle()) break;
				} catch {
					break;
				}
			}
			await apiRef.sendUserMessage(payload);
		} else if (d.deliverAs) {
			await apiRef.sendUserMessage(payload, { deliverAs: d.deliverAs });
		} else {
			await apiRef.sendUserMessage(payload);
		}
		clipCount++;
		clipPending = true;
		pendingVoice = true;
		setBackgroundTurn(true); // 后台轮：计划确认可以走「粘贴一句话」那条路
		// 「输入弹窗」：刚收到你的输入 → 弹一张看一眼就消失的卡片（不播报、不打断）
		cardNotify("pi · 收到（正在处理）", preview(body, 120), 4);
		const where =
			meta.at !== undefined && meta.at >= 0 && meta.origin ? `｜命中在倒数第 ${meta.origin.length - meta.at} 字` : "";
		clipEvent("✔ 投递", `${d.note}｜${body.length} 字｜剥${meta.strips ?? 1}清${meta.cleaned ?? 0}${where}`, body);
		meta.origin = raw;
		refreshStatus();
		clearEditorIfSame(raw, body);
		notifyUser({
			title: "pi · 语音投递",
			body:
				`${d.note}（${body.length} 字` +
				(meta.strips > 1 ? ` · 剥${meta.strips}层触发词` : "") +
				(meta.cleaned ? ` · 清${meta.cleaned}个尾词` : "") +
				`）：${preview(body)}`,
			osc: isTui(lastCtx),
			beep: beepOn,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error("[ai-configure] voice: 投递失败：", e);
		notifyUser({
			title: "pi · 语音投递失败",
			body: preview(msg, 40),
			osc: isTui(lastCtx),
			beep: beepOn,
		});
	}
}

// ======================= 注册 =======================

export function setupVoice(api: ExtensionAPI): void {
	apiRef = api;

	// 读配置（跟 delegate 的 linger 共用同一份 ai-extensions.json）
	const cfg = readCfg();
	talkOn = cfg.voiceTalk === true;
	talkAuto = cfg.voiceTalkAuto === true;
	clipOn = cfg.voiceClip === true;
	clipMark = cfg.voiceClipMark !== false;
	clipGuess = cfg.voiceClipGuess !== false;
	if (cfg.voiceClipTriggerMode === "word" || cfg.voiceClipTriggerMode === "silent") clipTriggerMode = cfg.voiceClipTriggerMode;
	const csm = Number(cfg.voiceClipSilentMs);
	if (Number.isFinite(csm) && csm >= 300 && csm <= 10000) clipSilentMs = Math.round(csm);
	const ctw = Number(cfg.voiceClipTail);
	if (Number.isFinite(ctw) && ctw >= 0 && ctw <= 20) clipTailWindow = Math.round(ctw);
	beepOn = cfg.voiceBeep !== false;
	resultOn = cfg.voiceResult !== false;
	// 语音播报（TTS）：开着就"弹窗 + 自动念"，念完窗口一起消失
	ttsOn = cfg.voiceTts === true;
	ttsRate = Number.isFinite(Number(cfg.voiceTtsRate)) ? Math.round(Number(cfg.voiceTtsRate)) : 0;
	ttsVolume = Number.isFinite(Number(cfg.voiceTtsVolume)) ? Math.round(Number(cfg.voiceTtsVolume)) : 100;
	ttsVoiceName = typeof cfg.voiceTtsVoice === "string" ? cfg.voiceTtsVoice : "";
	setTts({ on: ttsOn, voice: ttsVoiceName, rate: ttsRate, volume: ttsVolume });
	popupOn = cfg.voicePopup !== false; // 弹窗总开关（默认开）
	setPopupOn(popupOn);
	// 计划确认：C（后台低风险自动过）· B（超时兜底）
	setPlanCfg({
		auto: cfg.voicePlanAuto !== false,
		timeoutSec: Number.isFinite(Number(cfg.voicePlanTimeout)) ? Number(cfg.voicePlanTimeout) : 120,
		timeoutRun: cfg.voicePlanTimeoutRun === true,
	});
	const nm = String(cfg.voiceNotifyMode ?? "").toLowerCase();
	// 老配置里的 "toast" 仍按你选的走；没配就是 auto
	if (nm === "auto" || nm === "toast" || nm === "osc" || nm === "card" || nm === "both") setNotifyMode(nm);

	api.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		state = { text: "", blockSeen: false, lastChangeAt: 0 };
		clipSeen = [];
		clipEvt.length = 0;
		if (talkOn) arm();
		else disarm();
		if (clipOn) startClipHelper();
		else stopClipHelper();
		refreshStatus();
	});

	api.on("agent_settled", async () => {
		setBackgroundTurn(false); // 这一轮结束了，下一轮默认不是"后台投递"
	});

	api.on("session_shutdown", async () => {
		disarm();
		stopClipHelper();
		state = { text: "", blockSeen: false, lastChangeAt: 0 };
	});

	// ================= 轮次统计（给「结果卡片」用） =================

	api.on("before_agent_start", async (event) => {
		// 新一轮：清统计，并把「这轮是不是语音投递来的」接过来
		turnStart = Date.now();
		turnTools = 0;
		turnFailed = 0;
		turnFiles = [];
		turnWasVoice = pendingVoice;
		pendingVoice = false;
		resultSent = false;
		lastAssistantText = "";
		const mt = (event as { messageType?: string }).messageType;
		turnIsCustom = mt === "custom"; // 后台回投等自触发轮次，不抢结果卡片
	});

	api.on("tool_result", async (event) => {
		if ((event as { parentToolCallId?: string }).parentToolCallId) return; // nested 不数
		turnTools++;
		if ((event as { isError?: boolean }).isError) turnFailed++;
		const t = (event as { toolName?: string }).toolName ?? "";
		if (t === "write" || t === "edit" || t === "multi_edit" || t === "patch") {
			const input = (event as { input?: Record<string, unknown> }).input ?? {};
			const p = String(input.file_path ?? input.path ?? "");
			if (p) {
				const base = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
				if (!turnFiles.includes(base)) turnFiles.push(base);
			}
		}
	});

	api.on("message_end", async (event) => {
		const msg = (event as { message?: { role?: string; content?: unknown } }).message;
		if (msg?.role !== "assistant") return;
		const c = msg.content;
		if (typeof c === "string") lastAssistantText = c;
		else if (Array.isArray(c)) {
			lastAssistantText = c
				.filter((b) => (b as { type?: string })?.type === "text")
				.map((b) => String((b as { text?: string }).text ?? ""))
				.join("\n");
		}
	});

	/**
	 * 一轮跑完 → 弹**结果卡片**（结论 + 元信息），不必切回窗口。
	 *
	 * 什么时候弹：
	 *   - 语音投递来的轮 → **一定弹**（你根本不在跟前，这就是后台模式的主场景）
	 *   - 手打的轮 → 只有耗时 ≥ resultLongSec 才弹（你正看着它的时候就别吵）
	 */
	api.on("agent_settled", async (event, ctx) => {
		lastCtx = ctx;
		clipPending = false;
		if (!resultOn || resultSent) return;
		if (turnIsCustom) {
			pendingVoice = false;
			return;
		}
		const secs = turnStart ? Math.round((Date.now() - turnStart) / 1000) : 0;
		const aborted = (event as { aborted?: boolean }).aborted === true;
		const longEnough = resultLongSec > 0 && secs >= resultLongSec;
		if (!turnWasVoice && !longEnough) {
			pendingVoice = false;
			return;
		}
		resultSent = true;
		// 被打断时，最后一轮可能没有结论文字
		const summary =
			summarizeReply(lastAssistantText, 600) || (aborted ? "（被你打断了，没给结论）" : "（这轮没输出文字）");
		const meta = formatResultMeta({ secs, tools: turnTools, failed: turnFailed, files: turnFiles });
		const title =
			`pi · ${aborted ? "已打断" : "答完了"}${turnWasVoice ? "（语音）" : ""}` +
			`（${secs}s${turnTools ? ` · ${turnTools} 次工具` : ""}）`;
		ctx.ui.notify(`${title}\n${summary}`.slice(0, 400), "info");
		sendResult({
			title,
			summary,
			meta,
			osc: isTui(ctx),
			toast: true,
			beep: turnFailed ? "warn" : beepOn,
		});
	});

	api.registerCommand("voice", {
		description:
			"语音模块（不做识别）：/voice talk on|off · clip on|off|mode|trigger|status · beep on|off · delay <ms> · send",
		handler: async (args: string, ctx: ExtensionContext) => {
			lastCtx = ctx;
			const a = (args ?? "").trim();
			const low = a.toLowerCase();

			// ---------- talk 模式 ----------
			if (low === "on" || low === "talk on") {
				talkOn = true;
				paused = false;
				patchCfg({ voiceTalk: true });
				state = { text: "", blockSeen: false, lastChangeAt: 0 };
				arm();
				refreshStatus();
				ctx.ui.notify(
					`🎙 对话模式：开 — 只认句尾触发词（说「发送 / 确定 / 发出」才发）\n` +
						"用法：焦点在 pi 输入框时说话，句尾加个「发送」。\n" +
						"⚠️ 默认**不会**因为「停一下」就自动发 —— 因为中文输入法选词也会一次上屏好几个字，" +
						"跟语音上屏长得一样，会把你半句打字发出去。\n" +
						"（真想要旧行为：/voice talk auto on）关：/voice off",
					"info",
				);
				return;
			}
			if (low === "talk auto on" || low === "auto on") {
				if (!talkOn) {
					ctx.ui.notify("先把对话模式打开：/voice talk on", "info");
					return;
				}
				talkAuto = true;
				patchCfg({ voiceTalkAuto: true });
				refreshStatus();
				ctx.ui.notify(
					`⚠️ 静默自动发：开（停 ${(silenceMs / 1000).toFixed(1)}s 就发）\n` +
						"注意：中文输入法**选词**也是一次上屏好几个字，跟语音上屏长得一样 ——\n" +
						"你打字中途停一下，它可能就把半句发出去了。稳一点就用默认（只认触发词）。",
					"warning",
				);
				return;
			}
			if (low === "talk auto off" || low === "auto off") {
				talkAuto = false;
				patchCfg({ voiceTalkAuto: false });
				refreshStatus();
				ctx.ui.notify("静默自动发：关（只认句尾触发词）", "info");
				return;
			}
			if (low === "off" || low === "talk off") {
				talkOn = false;
				disarm();
				refreshStatus();
				patchCfg({ voiceTalk: false });
				ctx.ui.notify("🎙 对话模式：关（自动回车已停，输入框照旧手打）", "info");
				return;
			}

			if (low === "delay") {
				ctx.ui.notify(`当前静默阈值：${silenceMs}ms（有效 ${MIN_SILENCE_MS}~${MAX_SILENCE_MS}）\n用法：/voice delay 1800`, "info");
				return;
			}

			if (low.startsWith("result")) {
				const rest = a.slice(6).trim();
				const rl = rest.toLowerCase();
				if (rl === "on" || rl === "off") {
					resultOn = rl === "on";
					patchCfg({ voiceResult: resultOn });
					refreshStatus();
					ctx.ui.notify(
						resultOn
							? `📣 结果卡片：开\n　语音投递的轮 → 一定弹；手打的轮 → 超过 ${resultLongSec}s 才弹。\n　内容：结论摘要（≤200 字）+ 耗时/工具次数/改了哪些文件。`
							: "📣 结果卡片：关（答完不再弹结论）",
						"info",
					);
					return;
				}
				if (rl.startsWith("long")) {
					const v = Number(rest.slice(4).trim());
					if (!Number.isFinite(v) || v < 0 || v > 3600) {
						ctx.ui.notify(
							`当前：手打轮 ≥ ${resultLongSec}s 才弹结果卡片。\n用法：/voice result long 30（0 = 手打轮从不弹，只弹语音轮）`,
							"info",
						);
						return;
					}
					resultLongSec = Math.round(v);
					patchCfg({ voiceResultLongSec: resultLongSec });
					ctx.ui.notify(
						resultLongSec === 0
							? "手打轮不再弹结果卡片（只有语音投递的轮才弹）"
							: `手打轮跑够 ${resultLongSec}s 就弹结果卡片`,
						"info",
					);
					return;
				}
				ctx.ui.notify(
					`📣 结果卡片：${resultOn ? "开" : "关"}（手打轮阈值 ${resultLongSec}s，0 = 只弹语音轮）\n` +
						`答完直接把结论 + 耗时/工具次数/改过的文件弹成通知（Warp 胶囊 + Windows toast）。\n` +
						`用法：/voice result on|off · /voice result long 30`,
					"info",
				);
				return;
			}
			if (low.startsWith("delay")) {
				const raw = low.replace("delay", "").trim();
				const v = Number(raw);
				if (!Number.isFinite(v) || v < MIN_SILENCE_MS || v > MAX_SILENCE_MS) {
					ctx.ui.notify(
						`静默阈值要 ${MIN_SILENCE_MS}~${MAX_SILENCE_MS} 毫秒。当前：${silenceMs}ms\n用法：/voice delay 1800`,
						"info",
					);
					return;
				}
				silenceMs = Math.round(v);
				patchCfg({ voiceSilenceMs: silenceMs });
				refreshStatus();
				ctx.ui.notify(`静默阈值：${silenceMs}ms（只对「静默自动发」生效，那个默认是关的）`, "info");
				return;
			}

			if (low === "send") {
				let text = "";
				try {
					text = ctx.ui.getEditorText();
				} catch {
					/* ignore */
				}
				if (!text.trim()) {
					ctx.ui.notify("输入框是空的", "info");
					return;
				}
				await sendNow(matchTrigger(text, SEND_WORDS, clipTailWindow).body.trim() || text.trim());
				return;
			}

			// ---------- clip 模式 ----------
			if (low.startsWith("clip")) {
				const rest = a.slice(4).trim();
				const rlow = rest.toLowerCase();

				if (rlow === "on") {
					clipOn = true;
					paused = false;
					patchCfg({ voiceClip: true });
					startClipHelper();
					refreshStatus();
					ctx.ui.notify(
						`📋 剪贴板投递：开（触发词：${clipTriggers.join(" / ")}）\n` +
							`用法：在任何地方说完，句尾加一个触发词（如「发送」）→ pi 收到就开始干活。\n` +
							`忙的时候：${clipMode === "queue" ? "排队" : clipMode === "abort" ? "打断当前任务" : "插话到当前任务"}（/voice clip mode 改）\n` +
							"没带触发词的内容一律忽略（你复制网址/代码不会被投递）。",
						"info",
					);
					return;
				}
				if (rlow === "off") {
					clipOn = false;
					stopClipHelper();
					refreshStatus();
					patchCfg({ voiceClip: false });
					ctx.ui.notify("📋 剪贴板投递：关（已停止读取剪贴板）", "info");
					return;
				}
				if (rlow.startsWith("trigger-mode")) {
					const v = rlow.replace("trigger-mode", "").trim();
					if (v !== "word" && v !== "silent") {
						ctx.ui.notify(
							`当前：${clipTriggerMode === "word" ? "**word** —— 必须说触发词才投（安全档）" : "**silent** —— 有触发词立刻投，没有就静默后自动投（不用喊「发送」）"}\n` +
								"　silent 靠护栏挡误投：中文占比 / 长度 / 无网址 / 无代码符号 / 不像日志；\n" +
								"　你去 Ctrl+C 复制中文长段落时**有概率被投递**（护栏挡不住的），投错了按 Esc 或 /voice clip off 关掉。\n" +
								"用法：/voice clip trigger-mode word|silent",
							"info",
						);
						return;
					}
					clipTriggerMode = v;
					patchCfg({ voiceClipTriggerMode: v });
					refreshStatus();
					ctx.ui.notify(
						v === "word"
							? `触发模式：word（结尾必须说：${clipTriggers.join(" / ")}）`
							: `触发模式：silent（不用喊触发词，说完安静 ${clipSilentMs}ms 自动投；带触发词则立刻投）`,
						"info",
					);
					return;
				}
				if (rlow.startsWith("silent")) {
					const v = Number(rest.slice(6).trim());
					if (!Number.isFinite(v) || v < 300 || v > 10000) {
						ctx.ui.notify(
							`当前静默阈值：${clipSilentMs}ms（有效 300~10000）
作用：silent 模式下，剪贴板安静这么久才投（IME 可能一段段往上写，太短会投半句）
用法：/voice clip silent 1200`,
							"info",
						);
						return;
					}
					clipSilentMs = Math.round(v);
					patchCfg({ voiceClipSilentMs: clipSilentMs });
					ctx.ui.notify(`静默阈值：${clipSilentMs}ms`, "info");
					return;
				}
				if (rlow.startsWith("tail")) {
					const v = Number(rest.slice(4).trim());
					if (!Number.isFinite(v) || v < 0 || v > 20) {
						ctx.ui.notify(
							`当前：触发词允许出现在末尾 ${clipTailWindow} 个字以内。\n` +
								"为什么不是「必须最后一个字」：语音输入法的智能整理会在「发送」后面又补字（“发送，就这样”），\n" +
								"位置限制太严就会漏投。0 = 回到严格结尾。\n用法：/voice clip tail 6",
							"info",
						);
						return;
					}
					clipTailWindow = Math.round(v);
					patchCfg({ voiceClipTail: clipTailWindow });
					ctx.ui.notify(
						clipTailWindow === 0
							? "触发词：必须严格在结尾"
							: `触发词：末尾 ${clipTailWindow} 个字以内出现即可（比严格结尾宽松，但只用精确匹配）`,
						"info",
					);
					return;
				}
				if (rlow.startsWith("mark")) {
					const v = rlow.replace("mark", "").trim();
					if (v !== "on" && v !== "off") {
						ctx.ui.notify(
							`当前：投递标记 ${clipMark ? "开" : "关"}（正文前面加不加 “📋 ”）\n` +
								`作用：转录里一眼看出“这条是语音投递来的，不是手打的”\n用法：/voice clip mark on|off`,
							"info",
						);
						return;
					}
					clipMark = v === "on";
					patchCfg({ voiceClipMark: clipMark });
					ctx.ui.notify(`投递标记：${clipMark ? "开（正文前加 📋）" : "关（正文原样投递）"}`, "info");
					return;
				}
				if (rlow.startsWith("guess")) {
					const v = rlow.replace("guess", "").trim();
					if (v !== "on" && v !== "off") {
						ctx.ui.notify(
							`当前：内容判断 ${clipGuess ? "开" : "关"}\n` +
								"　开（默认）= 会按内容猜「像不像人话」：太短/太长/带网址/错误栈/代码块/`/` 开头/中文太少/符号多/分行多 → 不投\n" +
								"　关 = **不猜**，剪贴板一安静下来就投（只保去重 + 非空）—— 你自己心里有数时用\n" +
								"用法：/voice clip guess on|off",
							"info",
						);
						return;
					}
					clipGuess = v === "on";
					patchCfg({ voiceClipGuess: clipGuess });
					ctx.ui.notify(
						clipGuess ? "🧠 内容判断：开（会猜像不像人话）" : "🧠 内容判断：关（不猜，安静下来就投）",
						"info",
					);
					refreshStatus();
					return;
				}
				if (rlow.startsWith("log")) {
					if (!clipEvt.length) {
						ctx.ui.notify("本会话还没有剪贴板事件（只记本会话，最多 12 条，正文不落盘）", "info");
						return;
					}
					const lines = clipEvt.map((e, i) => {
						const t = new Date(e.at);
						const hh = String(t.getHours()).padStart(2, "0");
						const mm = String(t.getMinutes()).padStart(2, "0");
						const ss = String(t.getSeconds()).padStart(2, "0");
						const body = e.body ? ` → ${e.body.length > 40 ? `${e.body.slice(0, 40)}…` : e.body}` : "";
						return `${i + 1}. ${hh}:${mm}:${ss} ${e.kind}（${e.note}）${body}`;
					});
					ctx.ui.notify([`📋 剪贴板台账（本会话内存，不落盘）：`, ...lines].join("\n"), "info");
					return;
				}
				if (rlow.startsWith("mode")) {
					const m = rlow.replace("mode", "").trim();
					if (m !== "steer" && m !== "queue" && m !== "abort") {
						ctx.ui.notify(
							`档位只有三种：\n` +
								`  steer（默认）= pi 忙时把这条插进当前任务\n` +
								`  queue = 忙时排队，等这轮跑完接着做\n` +
								`  abort = 忙时直接打断当前任务，改成处理这条\n用法：/voice clip mode queue`,
							"info",
						);
						return;
					}
					clipMode = m;
					patchCfg({ voiceClipMode: m });
					refreshStatus();
					ctx.ui.notify(`忙时档位：${m}`, "info");
					return;
				}
				if (rlow.startsWith("trigger")) {
					const raw = rest.slice(7).trim();
					const list = raw
						.split(/[,，\s]+/)
						.map((x) => x.trim())
						.filter(Boolean);
					if (!list.length) {
						ctx.ui.notify(`当前触发词：${clipTriggers.join(" / ")}\n用法：/voice clip trigger 发送,投给pi`, "info");
						return;
					}
					clipTriggers = list;
					patchCfg({ voiceClipTriggers: list });
					ctx.ui.notify(
						`触发词改成：${list.join(" / ")}\n（句尾说到它们才会投递；≥3 字的允许 1 个字识别出错）`,
						"info",
					);
					return;
				}
				// clip status / clip
				ctx.ui.notify(
					[
						clipOn ? "📋 剪贴板投递：开" : "📋 剪贴板投递：关",
						`　触发词：${clipTriggers.join(" / ")}（/voice clip trigger 改）`,
						`　忙时档位：${clipMode}（/voice clip mode 改）`,
						`　已投递：${clipCount} 条`,
						`　helper 进程：${clipHelper ? "在跑" : "没起"}`,
						"　开关：/voice clip on · /voice clip off",
					].join("\n"),
					"info",
				);
				return;
			}

			// ---------- 弹窗开关 ----------
			if (low === "popup" || low.startsWith("popup ")) {
				const v = low.replace("popup", "").trim();
				if (v !== "on" && v !== "off") {
					ctx.ui.notify(
						`🪟 自绘弹窗：${getPopupOn() ? "开" : "关"}（当前挂着 ${liveCards()} 张 · 通道：${getNotifyMode()}）\n` +
							"　输入弹窗(投递后 4s 自消) · 执行弹窗(计划开跑，常驻) · 结论弹窗(答完，常驻)\n" +
							"　多张自动往下叠、互不顶掉；常驻的只有你点 ✕ 才关\n" +
							"　关 = 不弹窗，只走终端胶囊或系统通知（注意：语音播报靠弹窗承载，关了就不出声）\n" +
							"用法：/voice popup on|off · 通道细调：/voice notify auto|osc|card|both|toast",
						"info",
					);
					return;
				}
				popupOn = v === "on";
				setPopupOn(popupOn);
				patchCfg({ voicePopup: popupOn });
				ctx.ui.notify(popupOn ? "🪟 弹窗：开" : "🪟 弹窗：关（改走胶囊/系统通知）", "info");
				return;
			}

			// ---------- 计划确认（A/C/B） ----------
			if (low === "plan" || low.startsWith("plan ")) {
				const rest = a.slice(4).trim();
				const rlow = rest.toLowerCase();
				const cur = getPlanCfg();
				if (rlow.startsWith("auto")) {
					const v = rlow.replace("auto", "").trim();
					if (v !== "on" && v !== "off") {
						ctx.ui.notify(
							`计划自动过（后台 + 低风险）：${cur.auto ? "开" : "关"}\n` +
								"　开 = 后台投递来的计划，如果 ≤3 步且没有「写/删/提交/发送」这类动作，就不打扰你，直接开工\n" +
								"用法：/voice plan auto on|off",
							"info",
						);
						return;
					}
					const on = v === "on";
					setPlanCfg({ auto: on });
					patchCfg({ voicePlanAuto: on });
					ctx.ui.notify(on ? "✅ 后台低风险计划将自动执行" : "🔔 所有计划都会等你确认", "info");
					return;
				}
				if (rlow.startsWith("ontimeout")) {
					const v = rlow.replace("ontimeout", "").trim();
					if (v !== "run" && v !== "cancel") {
						ctx.ui.notify(
							`当前兜底动作：${cur.timeoutRun ? "run（当成同意，直接干）" : "cancel（当没确认，更安全）"}\n用法：/voice plan ontimeout run|cancel`,
							"info",
						);
						return;
					}
					const run = v === "run";
					setPlanCfg({ timeoutRun: run });
					patchCfg({ voicePlanTimeoutRun: run });
					ctx.ui.notify(run ? "⚠️ 超时后按「同意」执行" : "✅ 超时后按「没确认」处理（更安全）", "info");
					return;
				}
				if (rlow.startsWith("timeout")) {
					const n = Number(rlow.replace("timeout", "").trim());
					if (!Number.isFinite(n) || n < 0) {
						const now = cur.timeoutSec === 0 ? "0（一直等）" : `${cur.timeoutSec}s → ${cur.timeoutRun ? "按同意执行" : "当没确认（取消）"}`;
						ctx.ui.notify(`当前超时：${now}\n用法：/voice plan timeout 120`, "info");
						return;
					}
					setPlanCfg({ timeoutSec: n });
					patchCfg({ voicePlanTimeout: Math.max(0, Math.round(n)) });
					ctx.ui.notify(
						n === 0 ? "计划确认：不再超时（一直等你答）" : `计划确认：${Math.round(n)}s 没答就走兜底动作（/voice plan ontimeout 改）`,
						"info",
					);
					return;
				}
				const nowLine = cur.timeoutSec === 0 ? "0（一直等）" : `${cur.timeoutSec}s → ${cur.timeoutRun ? "按同意执行" : "取消"}`;
				ctx.ui.notify(
					`📋 计划确认：\n` +
						`　自动过（后台+低风险）：${cur.auto ? "开" : "关"}\n` +
						`　超时：${nowLine}\n` +
						"　在后台怎么答：直接粘一句话 —— 「同意」执行 · 「不行」撤 · 其他内容当成「我要改」\n" +
						"　/voice plan auto on|off · timeout <秒> · ontimeout run|cancel",
					"info",
				);
				return;
			}

			// ---------- 语音播报（TTS） ----------
			if (low === "tts" || low.startsWith("tts ")) {
				const rest = a.slice(3).trim();
				const rlow = rest.toLowerCase();
				if (rlow === "on" || rlow === "off") {
					ttsOn = rlow === "on";
					setTts({ on: ttsOn });
					patchCfg({ voiceTts: ttsOn });
					refreshStatus();
					ctx.ui.notify(
						ttsOn
							? `🔊 语音播报：开（音色 ${ttsVoiceName || "系统默认（中文 Huihui）"} · 语速 ${ttsRate} · 音量 ${ttsVolume}）\n` +
								"答完弹卡片的同时**自动念**结论摘要；念完卡片和声音一起消失（点卡片可提前结束）。\n" +
								"想先听听：/voice tts test"
							: "🔇 语音播报：关（结果卡片照旧弹，不念）",
						"info",
					);
					return;
				}
				if (rlow === "test") {
					const demo = "语音播报测试：你好，我是 pi，以后结论会这样念给你听。";
					setTts({ on: true, voice: ttsVoiceName, rate: ttsRate, volume: ttsVolume });
					cardNotify("pi · 语音播报测试", demo, 180, demo);
					setTts({ on: ttsOn });
					ctx.ui.notify(`🔊 正在试听（音色 ${ttsVoiceName || "系统默认"} · 语速 ${ttsRate} · 音量 ${ttsVolume}）`, "info");
					return;
				}
				if (rlow.startsWith("voice")) {
					const v = rest.slice(5).trim();
					if (!v) {
						ctx.ui.notify(
							`当前音色：${ttsVoiceName || "（系统默认）"}\n` +
								"Windows（System.Speech）可用：Microsoft Huihui Desktop（中文）· Microsoft Zira Desktop（英文）\n" +
								"用法：/voice tts voice Microsoft Huihui Desktop · 恢复默认：/voice tts voice default",
							"info",
						);
						return;
					}
					ttsVoiceName = v.toLowerCase() === "default" ? "" : v;
					setTts({ voice: ttsVoiceName });
					patchCfg({ voiceTtsVoice: ttsVoiceName });
					ctx.ui.notify(`🔊 音色：${ttsVoiceName || "（系统默认）"}（/voice tts test 试听）`, "info");
					return;
				}
				if (rlow.startsWith("rate")) {
					const n = Number(rest.slice(4).trim());
					if (!Number.isFinite(n) || n < -10 || n > 10) {
						ctx.ui.notify(`当前语速：${ttsRate}（-10 最慢 ~ 10 最快）\n用法：/voice tts rate -2`, "info");
						return;
					}
					ttsRate = Math.round(n);
					setTts({ rate: ttsRate });
					patchCfg({ voiceTtsRate: ttsRate });
					ctx.ui.notify(`🔊 语速：${ttsRate}`, "info");
					return;
				}
				if (rlow.startsWith("volume")) {
					const n = Number(rest.slice(6).trim());
					if (!Number.isFinite(n) || n < 0 || n > 100) {
						ctx.ui.notify(`当前音量：${ttsVolume}（0~100）\n用法：/voice tts volume 80`, "info");
						return;
					}
					ttsVolume = Math.round(n);
					setTts({ volume: ttsVolume });
					patchCfg({ voiceTtsVolume: ttsVolume });
					ctx.ui.notify(`🔊 音量：${ttsVolume}`, "info");
					return;
				}
				ctx.ui.notify(
					`🔊 语音播报：${ttsOn ? "开" : "关"}（音色 ${ttsVoiceName || "系统默认"} · 语速 ${ttsRate} · 音量 ${ttsVolume}）\n` +
						"　用系统自带语音库：离线、不联网、不外发内容；只念结论摘要，最长 300 字\n" +
						"　/voice tts on|off · test（试听）· voice <名称> · rate <-10..10> · volume 0~100",
					"info",
				);
				return;
			}

			// ---------- 提示音 ----------
			if (low.startsWith("notify")) {
				const ti = terminalInfo();
				const v = low.replace("notify", "").trim() as NotifyMode | "";
				if (v !== "auto" && v !== "osc" && v !== "card" && v !== "toast" && v !== "both") {
					ctx.ui.notify(
						`当前通道：${getNotifyMode()}
` +
							`　auto（默认）= 终端支持就发**胶囊**（Warp 顶部那个），不支持才换别的
` +
							`　osc  = 只发终端胶囊 · card = 只发**自绘弹窗**（贴顶圆角卡片）
` +
							`　both = 胶囊 + 自绘弹窗（后台看别的窗口也能看到，代价是可能显得重复）
` +
							`　toast = 只用系统通知（Windows 上未注册 AUMID 的 toast 可能不显示；mac/linux 原生可用）
` +
							`探测到的终端：${ti.name}（${ti.osc ? "✅ 支持胶囊" : "❌ 不认识 OSC 777"}）
` +
							"用法：/voice notify auto|osc|card|both|toast",
						"info",
					);
					return;
				}
				setNotifyMode(v);
				patchCfg({ voiceNotifyMode: v });
				ctx.ui.notify(
					`通知通道：${v}` +
						((v === "osc" || v === "auto") && !ti.osc ? `（注意：终端「${ti.name}」不支持 OSC 777，胶囊不会出现）` : ""),
					"info",
				);
				return;
			}
			if (low.startsWith("beep")) {
				const v = low.replace("beep", "").trim();
				if (v !== "on" && v !== "off") {
					ctx.ui.notify(`提示音：${beepOn ? "开" : "关"}（/voice beep on|off）`, "info");
					return;
				}
				beepOn = v === "on";
				patchCfg({ voiceBeep: beepOn });
				notifyUser({ title: "pi", body: "提示音测试", osc: isTui(ctx), beep: beepOn });
				ctx.ui.notify(`提示音：${beepOn ? "开" : "关"}`, "info");
				return;
			}

			// ---------- status ----------
			const cfgNow = readCfg();
			ctx.ui.notify(
				[
					talkOn ? "🎙 对话模式：开（输入框）" : "🎙 对话模式：关",
					talkOn
						? talkAuto
							? `　发送方式：块状上屏 + 静默 ${silenceMs}ms（**可能把打字的选词停顿也当说完**）`
							: "　发送方式：只认句尾触发词（默认 · 不会误发）"
						: `　（想开：/voice talk on；静默阈值 ${silenceMs}ms，只对静默自动发生效）`,
					`　输入框触发词：句尾「发送 / 确定 / 发出」立刻发`,
					`　本会话已自动发送：${sentCount} 条`,
					clipOn ? "📋 剪贴板投递：开" : "📋 剪贴板投递：关",
					`　触发模式：${clipTriggerMode === "word" ? `word（必须说触发词）` : `silent（不用喊触发词，安静 ${clipSilentMs}ms 投）`} · 触发词：${clipTriggers.join(" / ")}（末尾 ${clipTailWindow} 字内）· 忙时：${clipMode} · 内容判断${clipGuess ? "开" : "关"} · 标记${clipMark ? "开" : "关"} · 已投递 ${clipCount} 条`,
					`　提示音：${beepOn ? "开" : "关"} · 通知通道：${getNotifyMode()}（终端 ${terminalInfo().name}${terminalInfo().osc ? "·支持胶囊" : "·无胶囊"}）`,
					`　结果卡片：${resultOn ? `开（手打轮 ≥${resultLongSec}s 也弹${resultLongSec === 0 ? "：只弹语音轮" : ""}）` : "关"}` + "（结论摘要 + 耗时/工具/改过的文件）",
					`　配置文件：${cfgFile()}（voiceTalk=${String(cfgNow.voiceTalk ?? false)}, voiceClip=${String(cfgNow.voiceClip ?? false)}）`,
				].join("\n"),
				"info",
			);
		},
	});

	// 停用闸门：/ai-ext off 时全停（开关状态保留，on 回来接着用）
	onGateApply("voice", (off) => {
		paused = off;
		if (off) {
			disarm();
			stopClipHelper();
		} else {
			if (talkOn) arm();
			if (clipOn) startClipHelper();
		}
		refreshStatus();
	});
}
