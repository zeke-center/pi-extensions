/**
 * remote.ts —— **手机接管当前会话**（Telegram 双向同步）。
 *
 * 目标一句话：
 *   终端里 `/remote on` → 屏幕出二维码 → 手机 Telegram 扫一下 →
 *   之后手机上说的话会**出现在你正在看的这个 pi 会话里**，pi 的回复也推回手机。
 *
 * 三条设计底线（都落进代码了）：
 *   1. **默认不公开**：不 `on` 就**一行网络请求都不发**。开关状态存在**本会话**
 *      （appendEntry，不进模型上下文），换会话 / 新会话自动回到「关」。
 *   2. **配对靠一次性码**：`on` 生成 8 位码（15 分钟过期 · 成功即作废 · 错 3 次作废）。
 *      码只负责「第一次绑定」；绑定后靠白名单长期有效，`off`/`on` **不用重扫**。
 *   3. **offset 必须落盘**：Telegram 的 `getUpdates` 是按 offset 增量取的。不存 offset，
 *      重启后会把**历史消息再投一遍** —— 等于把你两小时前那句「重启后端」又执行一次。
 *
 * 为什么用长轮询而不是 webhook：
 *   webhook 要 Telegram **主动连到你**（公网地址 + 证书），家里/公司机器做不到；
 *   长轮询是**你主动连出去**，所以只要能上网就行 —— 不需要公网 IP、不需要内网穿透。
 *
 * 为什么所有 ctx 访问都套 `guardCtx`：
 *   轮询循环是**后台回调**。你 newSession/switchSession 之后 pi 会把旧 ctx 标记失效，
 *   旧 ctx 一碰就抛异常，而定时器回调里没人接 → **直接崩掉整个 pi 进程**
 *   （shared.ts 顶部的注释记着这个坑，别重犯）。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey } from "@earendil-works/pi-tui";
import { hostname } from "node:os";
import { setDefaultResultOrder } from "node:dns";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderQr, renderQrBig } from "./qr";
import { mdToTelegramHtml, splitForTelegram } from "./telegram-md";
import { answerPlanAsk, guardCtx, hasPendingPlanAsk, onPlanAskChange, parsePlanAnswer, patchExtCfg, planAskOutcome, readExtCfg, type PlanAnswer } from "./shared";
import { type FormField, showForm } from "./form";
import { onGateApply } from "./gate";
import { registerSettings, type SettingDef } from "./settings";

// ======================= 配置（<agentDir>/ai-extensions.json 的 telegram 段）=======================

const CFG_KEY = "telegram";

export interface TgChat {
	chatId: number;
	label?: string;
	/** 绑定到「哪台机器 + 哪个工作目录」，**不绑 session id** —— 重开 pi 不用重扫 */
	boundTo?: string;
	at: number;
}

interface TgCfg {
	token?: string;
	/** getUpdates 的增量游标（落盘，见顶部第 3 条） */
	offset?: number;
	/** 已授权设备 */
	chats?: TgChat[];
	/** pi 忙时手机消息怎么投：followUp = 排队不打断（默认） · steer = 插进当前运行 */
	deliver?: "followUp" | "steer";
	/** 手机来的消息要不要在正文前加 `📱 ` 前缀（默认开）—— 这是**唯一**能让模型知道来源的办法 */
	markInbound?: boolean;
	/** 手机上回传多少过程：quiet / tools（默认） / full */
	verbose?: "quiet" | "tools" | "full";
	/** 手机能执行的白名单命令（**只能在电脑上的配置文件里定义**） */
	phoneCommands?: PhoneCmd[];
	/** 白名单命令的超时（毫秒，默认 60000，最大 600000） */
	runTimeoutMs?: number;
}

function cfg(): TgCfg {
	const all = readExtCfg()[CFG_KEY];
	return all && typeof all === "object" ? (all as TgCfg) : {};
}

/** ⚠️ patchExtCfg 是**顶层浅合并**，所以 telegram 这个对象必须我们自己合 */
function saveCfg(patch: Partial<TgCfg>): void {
	patchExtCfg({ [CFG_KEY]: { ...cfg(), ...patch } });
}

// ======================= 会话级状态 =======================

/** 会话条目类型：只进会话文件，不进模型上下文（和 gate.ts 同一套路） */
const ENTRY_TYPE = "ai-remote";

let isOn = false;
/** 当前会话的 ctx（后台循环只能通过它 + guardCtx 碰 UI/中断） */
let curCtx: ExtensionContext | undefined;
/** 代数：每次 session_start / session_shutdown 自增，用来让**旧轮询循环自己退出** */
let gen = 0;
let pollTask: Promise<void> | undefined;
/** 轮询代数：每次 start/stop 自增，让**上一轮循环自己退出**。
 *  为什么不能只看 isOn：off→on 太快时，旧循环的 `.finally` 还没跑，`pollTask` 仍是旧 promise，
 *  新的 `startPoll` 会被 `if (pollTask) return` 挡掉 → 再也不轮询（这个 bug 已修）。 */
let pollGen = 0;
let nextOffset = 0;
let botUsername = "";
/** 待配对的一次性码（只在内存，不落盘） */
let pair: { code: string; exp: number; tries: number } | undefined;

// ---------- 反向配对（手机先发消息，电脑上确认）----------
/** 待确认码的有效期（分钟） */
const BIND_MIN = 15;
interface PendingBind {
	chatId: number;
	code: string;
	label: string;
	exp: number;
}
/** 等电脑端 `/remote bind` 确认的请求（只在内存，不落盘） */
let pendingBinds: PendingBind[] = [];

// ---------- 离线积压（先问再投）----------
/** >0 表示“先问再投”闸门已放下：有这么多条离线消息在等确认 */
let catchupCount = 0;
/** 最旧那条积压消息的大致年龄（秒），只用于提示 */
let catchupOldestS = 0;
/** 比这个更久的消息会被闸门拦住（刚发的正常投，不烦你） */
const CATCHUP_MIN_AGE_S = 120;
/** 二维码浮层的关闭钩子（配对成功时主动关掉） */
let closeQr: (() => void) | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 本机标识：绑定用「主机名 + 工作目录」，这样重开 pi 仍算同一处 */
function thisSite(ctx?: ExtensionContext): string {
	const cwd = guardCtx(ctx, (c) => String(c.cwd ?? "")).value ?? "";
	return `${hostname()}:${cwd}`;
}

// ======================= Telegram API =======================

interface TgResult<T = any> {
	ok: boolean;
	result?: T;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
}

/** 单条消息上限 4096 字符（Telegram 硬限制）；切分逻辑在 telegram-md.ts 里 */

class TgError extends Error {
	constructor(
		message: string,
		readonly code?: number,
		readonly retryAfter?: number,
	) {
		super(message);
	}
}

async function tgCall<T = any>(method: string, payload?: Record<string, unknown>, timeoutMs = 45000): Promise<T> {
	const token = cfg().token;
	if (!token) throw new TgError("没配 token（ai-extensions.json 的 telegram.token）");

	const json = (await tgFetch(`https://api.telegram.org/bot${token}/${method}`, payload ?? {}, timeoutMs)) as TgResult<T>;
	if (!json.ok) {
		throw new TgError(
			json.description ?? "请求失败",
			json.error_code,
			json.parameters?.retry_after,
		);
	}
	return json.result as T;
}

/** 真的发一次请求（在这里加超时，别用 fetch 默认的“永等”） */
async function httpJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
			signal: ac.signal,
		});
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

/** 已经因为 IPv6 问题切过一次解析顺序了？ */
let dnsFixed = false;

/**
 * 先直连；**网络层**失败（不是 Telegram 回的错）就切“IPv4 优先”并**重试几次**。
 *
 * 为什么需要这个：本机 DNS 会返回 AAAA（如 `2001::6ca0:a63e`），而到 Telegram 的
 * IPv6 路由不通 —— undici（Node 的 fetch）先连 IPv6 就被 ECONNRESET；
 * **curl 自带 happy-eyeballs 会自己回退 IPv4，所以会出现“curl 能通、Node 不通”的怪事**（实测踩过）。
 *
 * 为什么要**重试多次**：这台机器的解析结果是**飘的**（有时给 IPv6、有时给被污染的 IPv4），
 * 所以单次失败很常见。以前只重试一次，于是“网络失败”会传给上层，被错当成“HTML 不合法”而降级成纯文本。
 */
async function tgFetch(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= 4; attempt++) {
		try {
			return await httpJson(url, body, timeoutMs);
		} catch (e) {
			lastErr = e;
			if (!dnsFixed) {
				setDefaultResultOrder("ipv4first");
				dnsFixed = true;
				// 在 setupRemote 加载时其实**已经**开过 ipv4first 了，所以这里不能再断言“检测到 IPv6 不通”
				// —— 实测所有网络错误都会走到这（包括代理挂了）。说“可能”才是诚实的。
				notify("网络请求失败（可能是 IPv6 路由不通），已切到 IPv4 优先并退避重试…", "info");
			}
			await sleep(600 * attempt);
		}
	}
	throw lastErr;
}

/**
 * 发文本：**Markdown → Telegram HTML**，超长自动分片。
 *
 * ⚠️ 降级策略是踩过坑才写成这样的：
 *   只有「**Telegram 明确说 HTML 不合法**」才退回纯文本重发。
 *   网络抖动**绝不能**降级 —— 否则手机上会看到一堆 `**` 和 `|`（因为纯文本发的是 Markdown 原文）。
 *   之前把两者混在一个 `catch` 里，结果网络一抽风，格式就“坏”了（实测踩过）。
 *   网络失败优先用**同样的 HTML**再试一次；真不行了才退回纯文本（宁可难看，也别把内容丢了）。
 */
async function sendText(chatId: number, text: string): Promise<void> {
	const body = text && text.length ? text : "(空)";
	for (const chunk of splitForTelegram(body)) {
		const html = mdToTelegramHtml(chunk);
		const send = (payload: Record<string, unknown>) => tgCall("sendMessage", payload);
		const payload = { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
		try {
			await send(payload);
			continue;
		} catch (e) {
			// ① Telegram 说 HTML 不合法（parse / entity 类错）→ 退回纯文本，但它至少是个“能发出去”的状态
			const parseErr = e instanceof TgError && /parse|entit|unsupported/i.test(e.message);
			if (!parseErr) {
				try {
					await send(payload); // ② 网络类失败：先原样重试一次 HTML（tgFetch 里也已重试过）
					continue;
				} catch {
					/* 往下走，兜底纯文本 */
				}
			}
			try {
				await send({ chat_id: chatId, text: chunk });
			} catch {
				/* 真发不出去也不该影响 pi 本体 */
			}
		}
	}
}

/** 广播给所有已授权设备 */
async function broadcast(text: string): Promise<void> {
	for (const c of cfg().chats ?? []) await sendText(c.chatId, text);
}

function typing(chatId: number): void {
	void tgCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

// ======================= 轮询循环 =======================

function startPoll(): void {
	if (pollTask) return;
	const myGen = gen;
	const myPoll = ++pollGen;
	const alive = () => isOn && myGen === gen && myPoll === pollGen;
	nextOffset = cfg().offset ?? 0;

	pollTask = (async () => {
		while (alive()) {
			try {
				const updates = await tgCall<any[]>(
					"getUpdates",
					{ offset: nextOffset, timeout: 25, allowed_updates: ALLOWED_UPDATES },
					40000,
				);
				if (!alive()) return;
				for (const u of updates) {
					if (!alive()) return;
					// ⚠️ 先落盘再处理：万一处理途中崩了/重启，也不会重复投递同一条
					nextOffset = (u.update_id ?? 0) + 1;
					saveCfg({ offset: nextOffset });
					await handleUpdate(u);
				}
			} catch (e) {
				if (!alive()) return;
				if (e instanceof TgError) {
					if (e.code === 409) {
						// 同一个 bot 只能有一个消费者。
						// ⚠️ 必须 selfStop（写回会话状态）—— 只改 isOn 会让“会话状态说开着、实际停了”，
						//    换会话/重启后又会去撞同一个 409（实测踩过）。
						selfStop("⚠ 有另一个会话正在占用这个 bot（Telegram 返回 409），本会话已停下。要在本会话用，先在别的会话里 /remote off");
						return;
					}
					if (e.code === 401) {
						selfStop("⚠ token 无效（401），请检查 ai-extensions.json 的 telegram.token");
						return;
					}
					if (e.code === 429) {
						await sleep((e.retryAfter ?? 3) * 1000);
						continue;
					}
				}
				await sleep(3000); // 网络抖动：退避重试，别打热循环
			}
		}
	})().finally(() => {
		if (myPoll === pollGen) pollTask = undefined;
	});
}

/**
 * 轮询时声明我们想收哪些类型的更新。
 *
 * ⚠️ **以后加了新交互（按钮 / 内联查询 / 回调查询）就必须加到这里。**
 * 少一个的症状是：**点了没反应，过一会儿才到** —— 因为 `getUpdates` 会把请求发出**之后**产生的
 * 其他类型更新过滤掉（请求之前产生的仍会给），要等**下一轮**轮询才拿到。
 * 实测踩过：这里原本只写了 `["message"]`，于是手机上那个计划确认按钮**要点两次才有反应**
 * （第一次永远落在一次 25s 长轮询中间被丢掉），用户以为“根本没点上”。
 *
 * 三处 `getUpdates`（轮询 / 存量检查 / 丢弃）都用这一份 —— 不显式写的话会**沿用上一次的设置**（Telegram 的行为），
 * 这种隐式状态极容易咬人。
 */
const ALLOWED_UPDATES = ["message", "callback_query"];

function stopPoll(): void {
	pollGen += 1; // 让在跑的循环条件立刻变假
	pollTask = undefined;
}

/** 断开时把进度卡也一并收掉（否则手机上会永远停在「运行中」） */
function clearCards(): void {
	stopCardTimer();
	runCards.clear();
	planCards.clear();
	editNoteFor = undefined;
	pendingAmbiguous = undefined;
	allowDanger = false; // 危险命令的放行不跨会话/不跨连接
}

function notify(text: string, level: "info" | "error" = "info"): void {
	guardCtx(curCtx, (c) => c.ui.notify(text, level));
}

// ======================= token 的掩码与写入 =======================

/** 面板里**只显示掩码**：token 等于密码，不该明文摊在屏幕上（截图/旁边有人就漏了） */
function maskToken(t?: string): string {
	if (!t) return "";
	return `已配置 · ${t.length} 位 · 末 4 位 ${t.slice(-4)}`;
}

/**
 * 从面板写 token。三种情况：
 *   · 原样没改（还是那句掩码）→ 不当作新 token（否则会把掩码当 token 存进去）
 *   · 清空 → 删掉已存的 token
 *   · 其他 → 当作新 token 存
 * 存完**后台验一次** `getMe`，不用你再去猜对不对。
 */
function setTokenFromPanel(v: unknown): void {
	const s = String(v ?? "").trim();
	if (s === maskToken(cfg().token)) return; // 没改，忽略
	if (s === "") {
		saveCfg({ token: "" });
		notify("已清空 telegram token（远程功能会提示未配置）", "info");
		return;
	}
	saveCfg({ token: s });
	void verifyToken();
}

/** 后台验 token：拿到 bot 名字就说明有效 */
async function verifyToken(): Promise<void> {
	try {
		const me = await tgCall("getMe", undefined, 15000);
		botUsername = String(me?.username ?? "");
		notify(`✅ token 有效 · bot @${botUsername}`, "info");
	} catch (e) {
		notify(`⚠ token 验证失败：${e instanceof Error ? e.message : String(e)}`, "error");
	}
}

// ======================= 消息处理 =======================

/** 从 AgentMessage 里抠出纯文本（内容块可能是字符串，也可能是 [{type:"text",text}]） */
function textOf(m: any): string {
	const c = m?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter((b) => b && b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("");
	}
	return "";
}

// ======================= 手机能执行的**白名单**命令 =======================

/** 一条白名单命令（写在 `telegram.phoneCommands` 里） */
/**
 * 给语音模块用：把一段音频当**语音条**发到已绑定的手机（失败静默，绝不影响播报）。
 *
 * - Telegram 的 voice 只收 OGG/OPUS；传 wav 会被拒
 * - 所以调用方要么给 ogg，要么走 sendDocument（wav 也能在客户端直接播）
 * - 返回成功发出的会话数
 */
export async function sendVoiceToPhone(
	filePath: string,
	opts: { caption?: string; asDocument?: boolean } = {},
): Promise<number> {
	const token = cfg().token;
	const chats = cfg().chats ?? [];
	if (!token || !chats.length) return 0;
	let { readFile } = await import("node:fs/promises");
	let data: Buffer;
	try {
		data = await readFile(filePath);
	} catch {
		return 0;
	}
	const isOgg = /\.ogg$/i.test(filePath);
	const method = opts.asDocument || !isOgg ? "sendDocument" : "sendVoice";
	const field = opts.asDocument || !isOgg ? "document" : "voice";
	let ok = 0;
	for (const c of chats) {
		try {
			const form = new FormData();
			form.append("chat_id", String(c.chatId));
			if (opts.caption) form.append("caption", opts.caption.slice(0, 900));
			form.append(field, new Blob([data]), filePath.split(/[\/]/).pop() || "voice.ogg");
			const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form });
			if (res.ok) ok += 1;
		} catch {
			/* 静默 */
		}
	}
	return ok;
}

export type PhoneCmd = {
	/** 手机上敲的名字（`/run <name>`） */
	name: string;
	/** 一句话说明（手机 `/run` 清单里显示） */
	desc: string;
	/** 要跑的程序（默认**不走 shell**） */
	cmd: string;
	/** 固定参数（手机带的参数会**追加在后面**，且逐个当 argv 传） */
	args?: string[];
	/** 需要管道/&& 的复杂命令写这里，用 `{args}` 占位（参数会做白名单字符校验） */
	shell?: string;
	/** 危险命令：默认拒绝，要电脑上 `/remote allow-danger` 临时放行 */
	danger?: boolean;
	/** 工作目录（默认用 pi 的 cwd） */
	cwd?: string;
};

/**
 * ⚠️ 安全底线（**是设计，不是懒得做**）：
 *   ① 命令**只能在电脑上的配置文件里预定义** —— 手机侧永远加不了新命令（`/run` 只挑，不定义）；
 *   ② 默认**不走 shell**（`cmd` + `args` 直接当 argv 传）→ 参数里的 `;` `|` `$()` 都不是元字符，注入不成立；
 *   ③ 真需要管道/&& 就用 `shell` 字段，那时参数过**白名单字符校验**（只允许 `\w @ . / : = + -`）；
 *   ④ `danger: true` 默认拒绝 —— 要电脑上 `/remote allow-danger` 临时放行，**每次 `on` 都会重置**；
 *   ⑤ 每次执行都在电脑终端留痕 + 写一条 `ai-remote-run` 审计条目。
 *
 * 为什么要这么紧：手机一旦丢了 / 被人拿到，它就是**能在你电脑上跑命令**的（用户就是要这个能力）。
 */
/** 单个参数的白名单校验（只给 shell 模式用；非 shell 模式参数当 argv 传，不会被解释） */
const PARAM_OK = /^[\w@./:=+-]{1,200}$/;

/** `api.exec`，setupRemote 时抓下来（轮询回调里拿不到扩展 ctx） */
let execFn:
	| ((cmd: string, args: string[], o?: { timeout?: number; cwd?: string }) => Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed?: boolean;
		}>)
	| undefined;

/** 危险命令是否临时放行（会话级；每次 `on` / `off` 重置） */
let allowDanger = false;

/** 手机 `/run` 不带参数时的清单 */
function phoneCmdListText(): string {
	const list = cfg().phoneCommands ?? [];
	if (list.length === 0) {
		return (
			"还没定义任何手机命令。\n\n" +
			"在**电脑**上编辑 `<agentDir>/ai-extensions.json`，加一个 `telegram.phoneCommands`，例如：\n\n" +
			"```json\n" +
			'"phoneCommands": [\n' +
			'  {"name": "gst", "desc": "后端 git 状态", "cmd": "git", "args": ["status", "--short"], "cwd": "F:/AI/My_Center/center_backend"},\n' +
			'  {"name": "deploy", "desc": "拉代码并重启后端", "cmd": "bash", "args": ["-lc", "cd ~/center_backend && git pull && ~/center_start.sh"], "danger": true}\n' +
			"]\n" +
			"```\n\n" +
			"· 默认**不走 shell**（`cmd`+`args` 当 argv 传），所以参数里写 `;` `|` 也没用 —— 注入不成立\n" +
			"· 真要管道就写 `shell` 字段（参数会做白名单字符校验）\n" +
			"· `\"danger\": true` 的默认拒绝，要电脑上 `/remote allow-danger` 临时放行"
		);
	}
	return (
		`手机能跑的命令（都定义在电脑上的配置里）：\n\n` +
		list.map((c) => `· \`${c.name}\`${c.danger ? " ⚠危险" : ""} —— ${c.desc}`).join("\n") +
		`\n\n用法：\`/run <名字> [参数…]\`` +
		(allowDanger ? "\n\n⚠ 危险命令当前**已放行**（\`/remote allow-danger off\` 可收回）" : "")
	);
}

/** 执行一条白名单命令 → 返回要发给手机的文字 */
async function runPhoneCmd(name: string, params: string[]): Promise<string> {
	const list = cfg().phoneCommands ?? [];
	const c = list.find((x) => x.name === name);
	if (!c) {
		return (
			`没有这个命令：\`${name}\`\n\n` +
			(list.length ? `能用的：${list.map((x) => `\`${x.name}\``).join("、")}` : "还没有定义任何命令（发 `/run` 看怎么写）")
		);
	}
	if (c.danger && !allowDanger) {
		return `⛔ \`${c.name}\` 标了**危险**，已默认拒绝。\n\n在电脑上先跑 \`/remote allow-danger\` 临时放行（断开重连会自动收回）。`;
	}
	if (!execFn) return "⛔ 执行接口还没就绪（可能刚重载过，重新 `/remote on` 一下）";

	// shell 模式才需要参数校验（非 shell 模式参数是 argv，不会被解释）
	if (c.shell) {
		const bad = params.find((p) => !PARAM_OK.test(p));
		if (bad) {
			return `⛔ 参数 \`${bad}\` 含不安全字符。\nshell 模式的命令只允许字母数字和 \`@ . / : = + -\`。`;
		}
	}

	const timeout = Math.min(Math.max(cfg().runTimeoutMs ?? 60000, 1000), 600000);
	const started = Date.now();
	const shown = `${c.name}${params.length ? ` ${params.join(" ")}` : ""}`;

	// 留痕：终端上一行 + 落盘一条审计（手机下了什么命令必须看得出来）
	guardCtx(curCtx, (x) => x.ui.notify(`📱 手机在执行白名单命令：${shown}`, "info"));
	try {
		curCtxApi?.appendEntry("ai-remote-run", { name: c.name, params, at: started, danger: !!c.danger });
	} catch {
		/* ignore */
	}

	let r: { stdout: string; stderr: string; code: number; killed?: boolean };
	try {
		const cwd = c.cwd ?? curCtx?.cwd ?? process.cwd();
		if (c.shell) {
			const raw = c.shell.includes("{args}")
				? c.shell.replace(/\{args\}/g, params.join(" "))
				: [c.shell, ...params].join(" ");
			// 要管道 / && 就必须过 shell，只能借操作系统的 shell 来跑
			const [sh, shArgs] =
				process.platform === "win32"
					? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", raw]]
					: ["/bin/sh", ["-lc", raw]];
			r = await execFn(sh, shArgs, { timeout, cwd });
		} else {
			r = await execFn(c.cmd, [...(c.args ?? []), ...params], { timeout, cwd });
		}
	} catch (e) {
		return `❌ \`${c.name}\` 没跑起来：${e instanceof Error ? e.message : String(e)}`;
	}

	const ms = ((Date.now() - started) / 1000).toFixed(1);
	const head =
		r.code === 0
			? `✅ \`${c.name}\` 成功（${ms}s）`
			: `❌ \`${c.name}\` 退出码 ${r.code}${r.killed ? "（超时被杀）" : ""}（${ms}s）`;
	const out = (r.stdout ?? "").trim();
	const err = (r.stderr ?? "").trim();
	let body = out;
	if (err) body += `${body ? "\n\n" : ""}stderr:\n${err}`;
	if (body.length > 3000) body = `${body.slice(0, 3000)}\n…（输出太长已截断，完整输出在电脑终端里）`;
	return `${head}\n\n\`\`\`\n${body || "（没有输出）"}\n\`\`\``;
}

// ======================= 计划确认框 → 手机（可答复） =======================

/**
 * 为什么这是一件**要紧事**：
 *   你从手机驱动会话时，pi 会问“这个计划行不行？”。以前那个确认框**只在电脑终端上**，
 *   手机上根本看不到 → 电脑端一直在等、手机端以为卡死了，**整个会话就停在那儿**。
 *
 * 所以这里把那个框同步到手机，并给**和终端一模一样的三个选项**；答复走 shared 里现成的
 * `answerPlanAsk`（和 voice 的剪贴板通道是同一个口子，不是另开一套）。
 */
/**
 * 推到手机的那张“计划确认”：chatId → { 消息 id, **卡片原文** }。
 *
 * 为什么要把原文也存下来：答复后只改文字是不够的 —— 直接把卡片改成“✅ 已答复…”会把
 * **计划标题 + 步骤全弄丢**（用户实测："本来那张卡直接消失了"）。
 * 正确做法是 **原文保留 + 末尾追加一行答复**。
 */
const planCards = new Map<number, { mid: number; body: string }>();
/** 手机上点了「我要改」→ 下一条文本当修改意见 */
let editNoteFor: number | undefined;
/** 手机上刚答复过 → 让收尾时那条卡显示成对的文案 */
let planAnswered = "";
/** “说不清是答复还是新指令”的那条（等按钮） */
let pendingAmbiguous: { chatId: number; who: string; text: string; mid?: number; body?: string } | undefined;
/** askAmbiguous 时临时带的设备名 */
let ambiguousWho = "";

/** 投递给 pi 的入口（手机消息正文、审计条目、来源前缀都在这里，只此一处） */
/** 最近一次"从手机发进来的消息"的时间戳（给语音路由用：在手机端就别在电脑上念） */
let lastRemoteMsgAt = 0;

export function markRemoteMessage(): void {
	lastRemoteMsgAt = Date.now();
}

/** 这一轮是不是来自手机（默认看最近 3 分钟，够覆盖一轮长任务） */
export function isRemoteTurn(windowMs = 180_000): boolean {
	return Date.now() - lastRemoteMsgAt < windowMs;
}

async function deliverToPi(chatId: number, who: string, text: string): Promise<void> {
	if (!isOn) return;
	markRemoteMessage();
	typing(chatId);
	// 记一条**审计条目**：落盘、可回顾，不进模型上下文 —— 不再只是 UI 上闪一行
	try {
		curCtxApi?.appendEntry("ai-remote-in", { chatId, who, text: text.slice(0, 500), at: Date.now() });
	} catch {
		/* 记不上不能挡住投递 */
	}
	// 正文加来源前缀（可 `/remote mark off` 关）：`sendUserMessage` 没有“来源”字段，
	// 只能从正文上区分 —— 这也正是我们想要的：模型知道你在手机上 → 回答会自动短一点。
	const body = markInbound() ? `📱 ${text}` : text;
	guardCtx(curCtx, (c) =>
		c.ui.notify(`📱 来自手机（${who}）：${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`, "info"),
	);
	try {
		curCtxApi?.sendUserMessage(body, { deliverAs: cfg().deliver ?? "followUp" });
	} catch (e) {
		await sendText(chatId, `⚠ 投递失败：${e instanceof Error ? e.message : String(e)}`);
	}
}

function planRows() {
	return [
		[
			{ text: "✅ 按这个执行", callback_data: "plan:yes" },
			{ text: "✏️ 我要改", callback_data: "plan:edit" },
		],
		[{ text: "⛔ 先别做", callback_data: "plan:no" }],
	];
}

/** 带按钮发一条（计划卡专用：内容短，不需要分片） */
async function sendKeyboard(chatId: number, text: string, rows: unknown[][]): Promise<number | undefined> {
	const r = await tgCall<any>("sendMessage", {
		chat_id: chatId,
		text: mdToTelegramHtml(text),
		parse_mode: "HTML",
		reply_markup: { inline_keyboard: rows },
		link_preview_options: { is_disabled: true },
	});
	return r?.message_id;
}

/**
 * “你这句话到底是答复计划，还是新指令？”——**不猜**。
 *
 * 实测踩过：计划挂起时手机发「先帮我把 README 补一下」，被 `parsePlanAnswer` 猜成“修改意见”
 * → **整条新任务被吞了**。它在剪贴板通道是合理的启发式，在手机上就很危险。
 * 所以说不清的就不猜：给两个按钮，一下点清。
 */
async function askAmbiguous(chatId: number, what: string): Promise<void> {
	const body = `🤔 **电脑正在等你确认一个计划，你这句我不确定是哪种意思**\n\n> ${what.replace(/\n/g, " ").slice(0, 200)}\n\n是**对计划的修改意见**，还是一句**新指令**？`;
	const mid = await sendKeyboard(
		chatId,
		body,
		[
			[
				{ text: "✏️ 作为计划的修改意见", callback_data: "planx:edit" },
				{ text: "📨 作为新指令", callback_data: "planx:new" },
			],
		],
	);
	pendingAmbiguous = { chatId, who: ambiguousWho, text: what.trim(), mid, body };
}

/**
 * 手机在“说不清”那个卡片上点了按钮后的收尾：**原文留着**，末尾追加一行结果。
 * （和计划卡一个道理 —— 直接把卡改成结果行，上下文就没了）
 */
async function closeAmbiguous(chatId: number, mid: number | undefined, body: string | undefined, what: string): Promise<void> {
	if (mid === undefined) return;
	try {
		await tgCall("editMessageText", {
			chat_id: chatId,
			message_id: mid,
			text: mdToTelegramHtml(`${body ? `${body}\n\n` : ""}——\n${what}`),
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
		});
	} catch {
		/* ignore */
	}
}

async function planPush(title: string, steps: string[]): Promise<void> {
	planCards.clear();
	editNoteFor = undefined;
	const list = steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "（没有分步）";
	const body = `🤔 **电脑端在等你定这个计划**\n\n**${title}**\n\n${list}\n\n直接点下面的按钮就行；也可以回一句「同意 / 算了」。\n（其它的句子会被反问一句“是改意见还是新指令”——**不敢猜**，猜错就把任务吞了。）`;
	for (const c of cfg().chats ?? []) {
		const mid = await sendKeyboard(c.chatId, body, planRows());
		if (mid !== undefined) planCards.set(c.chatId, { mid, body });
	}
}

/**
 * 计划已答复（不管是在终端还是手机上答的）→ 重写手机那条：
 * **原文一字不改，末尾追加一行答复**，并顺手把按钮摘掉（免得你再去点）。
 */
async function planPushDone(what: string): Promise<void> {
	if (planCards.size === 0) return;
	for (const [chatId, card] of planCards) {
		try {
			await tgCall("editMessageText", {
				chat_id: chatId,
				message_id: card.mid,
				text: mdToTelegramHtml(`${card.body}\n\n——\n${what}`),
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});
		} catch {
			/* 消息可能被删了，忽略 */
		}
	}
	planCards.clear();
}

/**
 * 回答一次 callback —— 这是**手机上那个转圈停下来的唯一信号**。
 * 所以它一律 **fire-and-forget**：绝不能排在后面的活儿（编辑卡片、发提醒）后面。
 */
function answerCb(cb: any, text?: string): void {
	void tgCall("answerCallbackQuery", { callback_query_id: cb?.id, ...(text ? { text } : {}) }).catch(() => {});
}

/** 手机点了计划按钮 */
async function onPlanCallback(cb: any): Promise<void> {
	const chatId: number | undefined = cb?.message?.chat?.id;
	const data = String(cb?.data ?? "");
	if (chatId === undefined || !(cfg().chats ?? []).some((c) => c.chatId === chatId)) {
		answerCb(cb, "这台设备没配对");
		return;
	}

	// ★ 第一件事：把转圈停掉（见 answerCb 的注释）
	// ★ 防呆：**只认“当前那张卡”上的按钮**。
	//   离线积压 / 以前被过滤掉的旧点击，实现重启后会一起涌进来；
	//   不校验的话，一个**几分钟前的旧点击**可能把你**刚挂的新计划**直接批了。
	//   （以前就会被这个坑到：`allowed_updates` 漏了 callback_query → 那几下点击一直卡在队列里。）
	const cbMid: number | undefined = cb?.message?.message_id;
	const isCurrentCard = (mid: number | undefined) => cbMid === undefined || mid === cbMid;

	if (data.startsWith("planx:")) {
		// “说不清”那个卡片上的两个按钮
		const amb = pendingAmbiguous;
		pendingAmbiguous = undefined;
		if (!amb || amb.chatId !== chatId || !isCurrentCard(amb.mid)) {
			answerCb(cb, "这条已经过期了");
			return;
		}
		if (data === "planx:edit") {
			answerCb(cb, "已收到 ✅");
			planAnswered = "✏️ 已答复：**按你的意见改**";
			answerPlanAsk("edit", amb.text);
			void closeAmbiguous(chatId, amb.mid, amb.body, `✏️ 已作为修改意见转给电脑端\n\n> ${amb.text.slice(0, 200)}`);
			return;
		}
		// planx:new → 当新指令投
		answerCb(cb, "好，按新指令投");
		void closeAmbiguous(chatId, amb.mid, amb.body, `📨 已作为新指令投给电脑端\n\n> ${amb.text.slice(0, 200)}`);
		await deliverToPi(chatId, amb.who, amb.text);
		return;
	}

	const a = data.slice(5) as PlanAnswer;
	const pending = hasPendingPlanAsk() && isCurrentCard(planCards.get(chatId)?.mid);
	answerCb(
		cb,
		!hasPendingPlanAsk() ? "这个计划已经答复过了" : pending ? (a === "edit" ? "好，把改法发过来" : "已收到 ✅") : "这条已经过期了",
	);
	if (!pending) return; // 已经答复过 / 旧卡的点按：不重复动作、不重改卡片

	if (a === "edit") {
		// 「我要改」需要**他的原话**，所以接下来那一条文本就是意见
		editNoteFor = chatId;
		void sendText(chatId, "✏️ 说吧 —— 直接发一条消息告诉我你想怎么改，我会连你的原话一起转给电脑端。");
		return;
	}
	planAnswered = a === "yes" ? "✅ 已答复：**按这个执行**" : "⛔ 已答复：**先别做**";
	// 同步触发（内部走 onPlanAskChange 监听 → 后台把手机那张卡改掉）
	answerPlanAsk(a);
}

// （导出仅为测试 / 诊断用，正常流程只由轮询循环调）
export async function handleUpdate(u: any): Promise<void> {
	// 计划确认按钮（inline keyboard）走这里 —— 它不是 message，得单独收
	if (u?.callback_query) {
		await onPlanCallback(u.callback_query);
		return;
	}
	const msg = u?.message;
	const chat = msg?.chat;
	if (!msg || !chat) return;
	// 只认私聊：bot 一旦被拉进群，群里谁说话都会变成指令，直接丢掉
	if (chat.type !== "private") return;

	const chatId: number = chat.id;
	const text: string = typeof msg.text === "string" ? msg.text : "";

	const known = (cfg().chats ?? []).find((c) => c.chatId === chatId);

	// ---------- 未授权设备：配对 ----------
	// 支持**两个方向**：
	//   ① 正向（扫码/口令）：电脑 `/remote qr` 出码 → 手机 `/start 口令` → 直接绑
	//   ② **反向（推荐）**：**手机先随便发一句** → bot 回一个 6 位码 → 电脑 `/remote bind 码` 确认
	// 为什么要反向：在**手机**上敲 8 位口令很难受，而电脑上有键盘。
	// 为什么反向更安全：光有码绑不上 —— **必须在电脑上手动执行一次**，所以码本身泄露也不致命。
	// ⚠️ 手机侧只是“申请”，电脑侧才是“批准”。这也是为什么这里对任何私聊都发码而不泄露任何东西。
	if (!known) {
		const code = text
			.replace(/^\/start(@[A-Za-z0-9_]+)?/i, "")
			.trim()
			.toUpperCase();
		// 正向：手机上发的口令刚好对上电脑端正在等的那个 → 直接绑
		if (code && pair && Date.now() < pair.exp && code === pair.code) {
			await bind(chatId, nameOf(msg));
			return;
		}
		// 反向：给这台设备发一个新的待确认码，等电脑端 `/remote bind`
		const p = issuePendingBind(chatId, msg);
		await sendText(
			chatId,
			"👋 这台设备还没配对。\n\n" +
				`请在**电脑**上执行：\`/remote bind ${p.code}\`\n\n` +
				`（配对码 \`${p.code}\`，${BIND_MIN} 分钟内有效）\n` +
				"电脑上确认之后，你在里说的话就会进入那台电脑的 pi 会话。",
		);
		return;
	}

	// ---------- 手机侧命令 ----------
	if (text === "/stop") {
		guardCtx(curCtx, (c) => c.abort());
		await sendText(chatId, "⏹ 已请求停止当前任务");
		return;
	}
	if (text === "/status" || text === "/usage") {
		await sendText(chatId, statusText());
		return;
	}
	if (text === "/compact") {
		// 手机上没终端那个进度条，上下文快满时 pi 会自己压缩（“突然失忆”），
		// 所以给一个**能主动压**的入口（用户跑来问“手机上能不能压上下文”）。
		const ok = guardCtx(curCtx, (c) => c.compact()).ok;
		await sendText(
			chatId,
			ok ? "🗜 已请求压缩上下文（终端里能看到进度）——压完会继续对话，早期的细节会被概括掉。" : "⚠ 当前没有可用的会话（可能刚重载过，试着在电脑上动一下再说）",
		);
		return;
	}
	if (text.startsWith("/run")) {
		const parts = text.slice(4).trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) {
			await sendText(chatId, phoneCmdListText());
			return;
		}
		typing(chatId);
		// ⚠ **不能 await**：白名单命令最长 60s（还会等 SSH、跑测试）。轮询循环是**串行**的，
		// 在这里等它就会把后面所有手机输入（包括点按钮）堵在后面 —— 用户会以为手机没反应。
		// 所以：命令后台跑，跑完主动把结果发回去。
		void (async () => {
			try {
				await sendText(chatId, await runPhoneCmd(parts[0], parts.slice(1)));
			} catch (e) {
				await sendText(chatId, `⚠ 执行出错：${e instanceof Error ? e.message : String(e)}`);
			}
		})();
		return;
	}
	if (text === "/help" || text === "/start" || text === "/?") {
		await sendText(chatId, phoneHelpText());
		return;
	}
	if (text.startsWith("/verbose")) {
		const v = text.slice(8).trim().split(/\s+/)[0];
		if (v === "quiet" || v === "tools" || v === "full") {
			saveCfg({ verbose: v });
			loadVerbose();
			await sendText(chatId, `回传详细度已设为「${v}」`);
		} else {
			await sendText(
				chatId,
				`回传详细度：现在是「${verbose}」\n\n` +
					"· `quiet` —— 只要最终回复\n" +
					"· `tools` —— 加上每一步工具调用（默认）\n" +
					"· `full` —— 连正在生成的文字也看\n\n" +
					"用法：`/verbose quiet|tools|full`",
			);
		}
		return;
	}

	// ---------- 电脑端正在等“计划确认” → 手机可以直接答复 ----------
	// 见上面 planPush 的注释：不接这个，手机驱动会话会**卡在那个弹窗上**。
	if (editNoteFor === chatId) {
		editNoteFor = undefined;
		planAnswered = "✏️ 已答复：**按你的意见改**";
		const ok = answerPlanAsk("edit", text.trim());
		await sendText(chatId, ok ? "✏️ 已把你的修改意见转给电脑端" : "（电脑端已经没有在等的计划了）");
		return;
	}
	if (text.trim() && hasPendingPlanAsk()) {
		const parsed = parsePlanAnswer(text);
		// 只有**明确的**同意 / 拒绝才当答复（“不猜”原则，见 askAmbiguous 的注释）
		if (parsed && parsed.a !== "edit") {
			planAnswered = parsed.a === "yes" ? "✅ 已答复：**按这个执行**" : "⛔ 已答复：**先别做**";
			const ok = answerPlanAsk(parsed.a, parsed.note);
			await sendText(chatId, ok ? planAnswered : "（电脑端已经没有在等的计划了）");
			return;
		}
		ambiguousWho = known.label ?? String(chatId);
		await askAmbiguous(chatId, text.trim());
		return;
	}
	if (!text.trim()) {
		// 图片/文件/语音：v1 只做了文本，但**必须回一句**，否则用户以为坏了（实测就问过“图片发不过来”）
		if (msg.photo || msg.document || msg.voice || msg.video || msg.sticker) {
			await sendText(
				chatId,
				"📷 图片 / 文件 / 语音我暂时还收不了（当前版本只做了文本）。\n" +
					"你可以先用文字描述，或者把图放到电脑上再让人看。",
			);
		}
		return;
	}

	// ---------- 投给 pi ----------
	await deliverToPi(chatId, known.label ?? String(chatId), text);
}

/** bind 之外还要用 api.sendUserMessage，所以把 api 存一份 */
let curCtxApi: ExtensionAPI | undefined;

/** 入站消息要不要加 `📱 ` 前缀（默认开） */
function markInbound(): boolean {
	return cfg().markInbound !== false;
}

/** 从 Telegram 的 msg 里取个人名（用来说“是谁在请求配对”） */
function nameOf(msg: any): string {
	return (
		[msg?.from?.first_name, msg?.from?.last_name].filter(Boolean).join(" ") ||
		msg?.from?.username ||
		String(msg?.chat?.id ?? "")
	);
}

/** 6 位数字配对码（避开以 0 开头，读起来不出错） */
function newBindCode(): string {
	return String(100000 + Math.floor(Math.random() * 900000));
}

/**
 * 反向配对：给一台未授权设备发一个待确认码，等电脑端 `/remote bind` 确认。
 * 同一台设备重复发消息 → **复用/刷新**同一条，不会刷出一堆待确认。
 * （导出仅为测试 / 诊断用，正常流程只由 handleUpdate 调。）
 */
export function issuePendingBind(chatId: number, msg: any): PendingBind {
	const now = Date.now();
	pendingBinds = pendingBinds.filter((p) => p.exp > now);
	// 同一台设备重复发消息 → **沿用同一个码**，只刷新有效期。
	// 为什么不用新码：用户很可能先看到码、又随手发了一条消息（比如点 START），
	// 换码会让屏幕上那个码突然失效，很迷惑。
	const existing = pendingBinds.find((p) => p.chatId === chatId);
	if (existing) {
		existing.exp = now + BIND_MIN * 60 * 1000;
		const n = nameOf(msg);
		if (n) existing.label = n;
		return existing;
	}
	const p: PendingBind = { chatId, code: newBindCode(), label: nameOf(msg), exp: now + BIND_MIN * 60 * 1000 };
	pendingBinds = [...pendingBinds, p].slice(-5); // 最多同时留 5 条，别被刷爆
	return p;
}

async function bind(chatId: number, name: string): Promise<void> {
	const site = thisSite(curCtx);
	const chats = (cfg().chats ?? []).filter((c) => c.chatId !== chatId);
	chats.push({ chatId, label: name, boundTo: site, at: Date.now() });
	saveCfg({ chats });
	pair = undefined;
	pendingBinds = pendingBinds.filter((p) => p.chatId !== chatId);
	closeQr?.();
	closeQr = undefined;
	await sendText(
		chatId,
		`✅ 配对成功。\n这台设备已接管：${site}\n\n` +
			"· 直接发消息 = 对它说话\n" +
			"· /stop 停止当前任务\n" +
			"· /status 看当前状态\n" +
			"电脑端 `/remote off` 可随时切断（切断后本设备完全看不到）。",
	);
	notify(`✅ 手机已配对：${name || chatId}`, "info");
}

function statusText(): string {
	const site = thisSite(curCtx);
	const idle = guardCtx(curCtx, (c) => c.isIdle()).value;
	const who = (cfg().chats ?? []).map((c) => c.label || c.chatId).join("、") || "（无）";
	return [
		`${isOn ? "🟢 已连接" : "⚪ 未连接"}${idle === undefined ? "" : idle ? " · 空闲" : " · 正在跑任务"}`,
		`会话：${site}`,
		`模型：${modelText()}`,
		`已授权设备：${who}`,
		usageText(),
		`插件：v${pluginVersion()}`,
	].join("\n");
}

/**
 * 上下文占用。
 * 为什么要给手机一个数字：终端里有那个进度条，**手机上什么都看不见** ——
 * 而上下文快满时 pi 会自己压缩（“突然失忆”），你至少该能提前看到。
 */
function usageText(): string {
	const u = guardCtx(curCtx, (c) => c.getContextUsage()).value;
	if (!u) return "上下文：拿不到（刚压缩过 / 刚重载）";
	if (u.tokens === null || u.percent === null) return `上下文：窗口 ${Math.round(u.contextWindow / 1000)}k · 刚压缩过`;
	const pct = Math.round(u.percent * 100);
	const bar = pct >= 80 ? "⚠️" : pct >= 50 ? "🟡" : "🟢";
	return `${bar} 上下文：${pct}%（${Math.round(u.tokens / 1000)}k / ${Math.round(u.contextWindow / 1000)}k）`;
}

// ======================= 二维码浮层 =======================

class QrPane implements Focusable {
	focused = false;
	constructor(
		private readonly theme: Theme,
		private readonly title: string,
		private readonly qrBig: string[],
		private readonly qrLines: string[],
		private readonly footer: string[],
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "ctrl+c")) this.done();
	}

	render(width: number): string[] {
		const out: string[] = [];
		const put = (s: string, color?: "accent" | "muted" | "success") => {
			const styled = color ? this.theme.fg(color, s) : s;
			out.push(styled);
		};
		put(this.title, "accent");
		out.push("");
		// 两种画法都自带「黑字白底」，各自自洽；宽度不够就不硬塞（塞了会扫不出）。
		// 优先用大码：模块物理尺寸翻倍，手机摄像头才对得上焦（半块字符的模块只有 1 字符宽，高分屏上太小）。
		const cols = (lines: string[]) => (lines.length ? lines[0].replace(/\x1b\[[0-9;]*m/g, "").length : 0);
		if (this.qrBig.length && cols(this.qrBig) <= width) out.push(...this.qrBig);
		else if (this.qrLines.length && cols(this.qrLines) <= width) out.push(...this.qrLines);
		else {
			put("（终端太窄，二维码放不下）", "muted");
			put("请把窗口拉宽，或直接用手输口令：", "muted");
		}
		out.push("");
		for (const f of this.footer) put(f, f.startsWith("口令") ? "success" : "muted");
		out.push("");
		put("Esc / 回车 关闭（配对在后台照常进行）", "muted");
		return out;
	}

	invalidate(): void {}
}

function newPairCode(): string {
	// 去掉容易看错的 0/O/1/I，取 8 位
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const buf = new Uint8Array(8);
	for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
	let out = "";
	for (const b of buf) out += alphabet[b % alphabet.length];
	return out;
}

/** 配对信息（链接 + 口令）—— 二维码扫不出来时的**文字兜底**，手机照着发就行 */
function pairLines(): string[] {
	if (!pair) return [];
	return [
		`链接：https://t.me/${botUsername}?start=${pair.code}`,
		`口令：${pair.code}`,
		`（手机上：搜索 / 粘链接打开 @${botUsername}，然后发 /start ${pair.code}）`,
	];
}

function showQr(ctx: ExtensionContext): void {
	const link = `https://t.me/${botUsername}?start=${pair!.code}`;
	let qrLines: string[] = [];
	let qrBig: string[] = [];
	try {
		qrBig = renderQrBig(link, 2, true); // 大码：模块 2 字符宽
		qrLines = renderQr(link, 3, true); // 小码：模块占半格（终端窄时用）
	} catch {
		qrLines = []; // 文本过长等 → 退化成只给链接 + 口令
		qrBig = [];
	}
	const footer = [
		...pairLines(),
		"· 手机 Telegram 的「扫一扫」直接扫上面的码",
		"· 扫不动就抄口令手输（手机搜索框粘链接也能打开 bot）",
		"· 口令 15 分钟有效",
	];
	if (qrLines.length || qrBig.length) {
		void ctx.ui
			.custom<void>((_tui, theme, _kb, done) => {
				closeQr = () => done();
				return new QrPane(theme, "📱 手机接管 · 扫码配对", qrBig, qrLines, footer, () => done());
			}, { overlay: true })
			.catch(() => {});
		return;
	}
	ctx.ui.notify(["📱 手机接管：请手输配对口令", ...footer].join("\n"), "info");
}

// ======================= 开 / 关 =======================

function appendState(on: boolean): void {
	try {
		curCtxApi?.appendEntry(ENTRY_TYPE, { on, at: Date.now() });
	} catch {
		/* 写不进会话文件也不挡住开关 */
	}
}

function readSessionOn(ctx: ExtensionContext): boolean {
	const r = guardCtx(ctx, (c) => {
		const entries = c.sessionManager.getEntries() as Array<{ type?: string; customType?: string; data?: { on?: boolean } }>;
		return entries.filter((e) => e.type === "custom" && e.customType === ENTRY_TYPE).pop()?.data?.on === true;
	});
	return r.ok ? r.value === true : false;
}

/** 人话化一段秒数 */
function fmtAge(sec: number): string {
	if (sec < 60) return `${sec} 秒`;
	if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
	if (sec < 86400) return `${Math.round(sec / 3600)} 小时`;
	return `${Math.round(sec / 86400)} 天`;
}

/**
 * 检查有没有**过期的**离线积压。
 *
 * 为什么要这个：`getUpdates` 是按 offset 增量取的。pi 关着的时候手机发的消息会留在 Telegram
 * 服务器上，一旦开始轮询就会**一次性全部投进来并被 pi 执行** —— 你两小时前随口说的
 * “重启一下后端”会被当成新指令执行。所以这里拦一道，让**人**决定要不要补收。
 *
 * ⚠️ 用 `offset = nextOffset` 查不会**确认**任何消息（确认只发生在我们传更大的 offset 时），
 * 所以查完不丢消息；真正开始轮询时它们还会原样再来一遍。
 */
async function hasStaleBacklog(): Promise<boolean> {
	try {
		const ups = await tgCall<any[]>("getUpdates", { offset: nextOffset, limit: 100, timeout: 0, allowed_updates: ALLOWED_UPDATES }, 15000);
		if (!ups.length) return false;
		const nowS = Math.floor(Date.now() / 1000);
		const oldest = ups.reduce((min, u) => Math.min(min, Number(u?.message?.date ?? nowS)), nowS);
		const age = nowS - oldest;
		if (age <= CATCHUP_MIN_AGE_S) return false; // 都是刚发的，正常投，不烦你
		catchupCount = ups.length;
		catchupOldestS = age;
		return true;
	} catch {
		return false; // 查不出来就别拦（网络问题不该把功能堵死）
	}
}

async function turnOn(ctx: ExtensionContext): Promise<void> {
	if (isOn) {
		ctx.ui.notify("已经在连接状态了。要再配一台设备：`/remote qr` 出码，或让手机先发一句话再 `/remote bind 码`", "info");
		return;
	}
	if (!cfg().token) {
		ctx.ui.notify("还没配 token：在 /aihelp 面板里填，或编辑 <agentDir>/ai-extensions.json 的 telegram.token", "error");
		return;
	}
	// 先 getMe：既验证 token，又拿 bot username 拼 t.me 链接
	let me: any;
	try {
		me = await tgCall("getMe", undefined, 15000);
	} catch (e) {
		ctx.ui.notify(`连不上 Telegram：${e instanceof Error ? e.message : String(e)}`, "error");
		return;
	}
	botUsername = String(me?.username ?? "");

	// getMe 成功了就把 IPv4 优先打开 —— 这台机器到 Telegram 的 IPv6 路由不通，早开早少踩坑。
	// （不靠“失败后再改”：这里的解析结果是飘的，会间歇性失败。）
	setDefaultResultOrder("ipv4first");

	isOn = true;
	allowDanger = false; // 危险命令的放行**不跨会话**：每次连上都要重新授权
	appendState(true);

	// 这台机器的这个目录是否已经绑过设备？
	const site = thisSite(ctx);
	const bound = (cfg().chats ?? []).find((c) => c.boundTo === site);

	// ---------- 离线积压闸门（必须先于 startPoll）----------
	// 否则轮询一开就把旧消息全投进来并被执行了。
	nextOffset = cfg().offset ?? 0;
	if (await hasStaleBacklog()) {
		ctx.ui.notify(
			[
				`⚠ 离线期间积压了 ${catchupCount} 条消息（最早约 ${fmtAge(catchupOldestS)}前）。`,
				"**不会自动执行**它们 —— 怕你把过时的指令当成新指令。",
				"",
				"· 要补收并执行：`/remote catchup`",
				"· 丢掉这些，只收新消息：`/remote drop`",
			].join("\n"),
			"error",
		);
		return;
	}

	startPoll();

	// 顺手把手机上的「/」菜单刷成**手机真能用**的那几个（改代码后自动生效）
	void syncPhoneCommands();

	if (bound) {
		ctx.ui.notify(`🟢 已连上（沿用已绑定设备：${bound.label || bound.chatId}）。手机上直接说话即可。`, "info");
		return;
	}
	// 没绑过 → **不再自动弹二维码**，而是把两条路都讲清楚（反向那条手机不用打字，推荐）
	pair = { code: newPairCode(), exp: Date.now() + 15 * 60 * 1000, tries: 0 };
	ctx.ui.notify(
		[
			"🔌 已连上 Telegram，但这台机器的这个目录还没配对过设备。两种方式任选：",
			"",
			`① 【推荐】手机上打开 @${botUsername || "你的 bot"} 随便发一句话 →`,
			"　　它会回一个 6 位配对码 → 回这里执行 `/remote bind 那个码`",
			"② `/remote qr` 出二维码（扫码，或抄口令手输）",
		].join("\n"),
		"info",
	);
}

function turnOff(reason: string, bindingsKept = true): void {
	if (!isOn) return;
	isOn = false;
	pair = undefined;
	closeQr?.();
	closeQr = undefined;
	stopPoll();
	clearCards();
	appendState(false);
	notify(
		`⚪ 已切断：${reason}。手机侧现在完全看不到、也发不进来。` +
			(bindingsKept ? "绑定还在，下次 on 不用重扫。" : "设备绑定已清空，下次要重新配对。"),
	);
}

/** 出错了自己停掉（和 turnOff 一样要把**会话状态**写回，否则状态会不一致） */
function selfStop(reason: string): void {
	if (!isOn) return;
	isOn = false;
	pair = undefined;
	closeQr?.();
	closeQr = undefined;
	stopPoll();
	clearCards();
	appendState(false);
	notify(reason, "error");
}

// ======================= 过程回传：手机上的「进度消息」 =======================

/**
 * 为什么需要：
 *   电脑终端里每一步都看得见（工具调用、进度），但**手机上只有“你发的”和“最终回复”两头，中间是黑的**。
 *   这里在手机上维护**一条持续被编辑的消息**：每次工具开始/结束就改它一次 —— 不刷屏，但进度一直在动。
 *
 * 为什么是“反复编辑同一条”而不是“每条都发新消息”：
 *   Telegram 对同一个聊天约 1 条/秒，连发 N 条既刷屏又会被限速（429）。所以这里
 *   **节流 1.5s 编辑同一条**；跑完把这条“冻结”，最终回复**另发**一条。
 */
type ToolLine = { id: string; text: string; done: boolean; startedAt: number };
interface RunCard {
	/** 那条进度消息的 id（拿到后才能编辑） */
	messageId?: number;
	lines: ToolLine[];
	/** 被折叠掉的更早的调用次数 */
	hidden: number;
	startedAt: number;
	dirty: boolean;
	/** verbose=full 时，把流式输出的尾巴挂在这里 */
	stream?: string;
}

/** 每个聊天一张卡（多台设备各一张） */
const runCards = new Map<number, RunCard>();
let cardTimer: ReturnType<typeof setInterval> | undefined;

/** 进度消息最多显示多少行工具（多了手机屏幕也看不下） */
const CARD_MAX_LINES = 10;
/** 编辑节流：Telegram 同聊天约 1 条/秒，1.5s 是实测稳的值 */
const CARD_EDIT_MS = 1500;

/** 回传详细度：quiet = 只要有最终回复 · tools = 工具行（默认） · full = 连流式文本尾巴也看 */
type Verbose = "quiet" | "tools" | "full";
let verbose: Verbose = "tools";

/** 从配置读回传详细度（存在 `telegram.verbose` 里，所以能跨会话保留） */
function loadVerbose(): void {
	const v = cfg().verbose;
	verbose = v === "quiet" || v === "full" ? v : "tools";
}

/**
 * 手机侧的命令菜单（Telegram 那个「/」菜单）。
 *
 * 为什么要每次连上都刷：菜单里写的是**手机真能用的**命令（跟终端的不一样），
 * 改了代码不刷就一直是旧的。只列**真能用的** —— 列了用不了比不列更糟。
 */
async function syncPhoneCommands(): Promise<void> {
	const cmds = [
		{ command: "status", description: "看当前会话状态（忙不忙 / 上下文占用）" },
		{ command: "stop", description: "停掉正在跑的任务" },
		{ command: "compact", description: "压缩上下文（手机上也能主动压）" },
		{ command: "verbose", description: "回传详细度：quiet / tools / full" },
		...(cfg().phoneCommands ?? []).map((c) => ({
			command: c.name,
			description: (c.danger ? "⚠ " : "") + c.desc,
		})),
		{ command: "help", description: "手机上能敲哪些命令" },
	];
	// setMyCommands 是“锦上添花”：失败（比如某个命令名不合法）不能影响连接本身
	await tgCall("setMyCommands", { commands: cmds }).catch(() => {});
}

/** 工具调用的“一句话摘要” —— 手机上不该看到一坨 JSON */
function toolDetail(name: string, args: any): string {
	const a = args ?? {};
	const short = (v: unknown, n = 52) => {
		const t = String(v ?? "")
			.replace(/\s+/g, " ")
			.replace(/`/g, "'")
			.trim();
		return t.length > n ? `${t.slice(0, n)}…` : t;
	};
	switch (name) {
		case "read":
		case "write":
		case "edit":
			return short(a.path ?? a.file_path ?? a.filePath);
		case "bash":
			return short(a.command, 60);
		case "grep":
		case "glob":
			return short(a.pattern);
		case "delegate":
			return short(a.task ?? "", 36);
		case "codemode":
			return "脚本";
		default: {
			const s = Object.values(a).find((v) => typeof v === "string") as string | undefined;
			return s ? short(s, 36) : "";
		}
	}
}

/** 把卡渲染成 Markdown（随后会走 mdToTelegramHtml）；工具明细用反引号包住 → 变等宽，且不会被 markdown 误伤 */
function cardText(card: RunCard, secs: number, head: string): string {
	const body = card.lines.map((l) => (l.done ? `🔧 \`${l.text}\`` : `⏳ \`${l.text}\``)).join("\n");
	const more = card.hidden > 0 ? `\n…（前面还有 ${card.hidden} 次调用）` : "";
	const stream = card.stream ? `\n\n✍ ${card.stream}` : "";
	return `${head} · ${secs}s\n\n${body}${more}${stream}`;
}

/** 确保有这个聊天的卡（第一次工具调用时才会建，纯文本回答就不建卡，不刷屏） */
async function ensureCard(chatId: number): Promise<RunCard> {
	let c = runCards.get(chatId);
	if (c) return c;
	c = { lines: [], hidden: 0, startedAt: Date.now(), dirty: true };
	runCards.set(chatId, c);
	scheduleCardFlush();
	return c;
}

function ensureCardsForAll(): void {
	for (const c of cfg().chats ?? []) {
		if (!runCards.has(c.chatId)) {
			runCards.set(c.chatId, { lines: [], hidden: 0, startedAt: Date.now(), dirty: true });
		}
	}
}

function scheduleCardFlush(): void {
	if (cardTimer) return;
	cardTimer = setInterval(() => void flushCards(), CARD_EDIT_MS);
}

/** 把脏卡刷到 Telegram（节流：只改变了的、每次都改同一条消息） */
async function flushCards(): Promise<void> {
	if (!isOn || runCards.size === 0) {
		stopCardTimer();
		return;
	}
	let pending = false;
	for (const [chatId, card] of runCards) {
		if (!card.dirty) continue;
		pending = true;
		card.dirty = false;
		const text = mdToTelegramHtml(cardText(card, Math.round((Date.now() - card.startedAt) / 1000), "🔄 **运行中**"));
		try {
			if (card.messageId === undefined) {
				const r = await tgCall<any>("sendMessage", {
					chat_id: chatId,
					text,
					parse_mode: "HTML",
					link_preview_options: { is_disabled: true },
				});
				card.messageId = r?.message_id;
			} else {
				await tgCall("editMessageText", {
					chat_id: chatId,
					message_id: card.messageId,
					text,
					parse_mode: "HTML",
					link_preview_options: { is_disabled: true },
				});
			}
		} catch {
			/* 编辑失败（包括“内容没变”和限速）忽略，下一拍再试 */
		}
	}
	if (!pending) stopCardTimer();
}

function stopCardTimer(): void {
	if (cardTimer) clearInterval(cardTimer);
	cardTimer = undefined;
}

/** 收尾：把卡冻结成“完成/中断”，然后从表里去掉（最终回复由 agent_settled 另发） */
async function finishCards(outcome: "done" | "aborted"): Promise<void> {
	stopCardTimer();
	if (runCards.size === 0) return;
	const head = outcome === "aborted" ? "⏹ **已中断**" : "✅ **完成**";
	for (const [chatId, card] of runCards) {
		if (card.messageId === undefined) continue; // 还没来得及发过（比如工具立刻就完成）→ 就不发了
		const text = mdToTelegramHtml(cardText(card, Math.round((Date.now() - card.startedAt) / 1000), head));
		try {
			await tgCall("editMessageText", {
				chat_id: chatId,
				message_id: card.messageId,
				text,
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});
		} catch {
			/* ignore */
		}
	}
	runCards.clear();
}

/** 把工具行压进卡（超长就折叠最早的） */
function pushToolLine(card: RunCard, line: ToolLine): void {
	card.lines.push(line);
	while (card.lines.length > CARD_MAX_LINES) {
		card.lines.shift();
		card.hidden += 1;
	}
	card.dirty = true;
}

// ======================= 装配 =======================

/**
 * `/remote` 不带参数 → **图形面板**。
 *
 * 为什么改：命令长到十几个（on/off/qr/bind/catchup/drop/mark/verbose/allow-danger/unpair…），
 * 打印一屏用法你**记不住**、每次还要往回翻 —— 面板里 ↑↓ 选、回车改，不用记。
 * 命令本身全部保留（`/remote help` 看全量），面板只是多一个入口。
 */
async function showRemotePanel(ctx: ExtensionContext): Promise<void> {
	const devCount = (cfg().chats ?? []).length;
	const cmds = cfg().phoneCommands ?? [];
	const fields: FormField[] = [
		{ key: "on", label: "连接", kind: "bool", value: isOn ? "是" : "否", hint: "关掉后手机完全看不到、也发不进来" },
		{ key: "verbose", label: "回传详细度", kind: "enum", value: verbose, options: ["quiet", "tools", "full"], hint: "手机上回传多少过程" },
		{ key: "mark", label: "来源前缀 📱", kind: "bool", value: markInbound() ? "是" : "否", hint: "让模型知道这条来自手机" },
		{ key: "danger", label: "危险命令放行", kind: "bool", value: allowDanger ? "是" : "否", hint: "白名单里标了 danger 的命令" },
		{
			key: "devices",
			label: "配对",
			kind: "enum",
			value: "—（不操作）",
			options: ["—（不操作）", "出二维码（手机扫码）", "解除全部设备"],
			hint: devCount ? `已绑 ${devCount} 台（手机先发码 → /remote bind 码）` : "还没绑设备",
		},
		{
			key: "backlog",
			label: "离线消息",
			kind: "enum",
			value: "—（不操作）",
			options: ["—（不操作）", "补收（会执行旧消息）", "丢弃（只收新的）"],
			hint: catchupCount ? `⏸ 积压 ${catchupCount} 条` : "没有积压",
		},
		{ key: "cmds", label: "白名单命令", kind: "text", readonly: true, value: `${cmds.length} 条`, hint: "改这个要编辑配置文件" },
	];
	let r: Awaited<ReturnType<typeof showForm>>;
	try {
		r = await showForm(ctx, "手机接管（Telegram）", fields, [], "on");
	} catch {
		// rpc / json 模式没有浮层 → 退回文字用法（不能直接崩）
		ctx.ui.notify("这个运行模式开不了浮层面板，用 `/remote help` 看命令", "info");
		return;
	}
	if (!r) return;
	const v = r.values;

	// 逐项落实（**只有真的改了才动** —— 只是打开看看不应该触发任何动作）
	if (v.on !== undefined && v.on !== (isOn ? "是" : "否")) {
		if (v.on === "是") await turnOn(ctx);
		else turnOff("你在面板里关的");
	}
	if (v.verbose && v.verbose !== verbose) {
		saveCfg({ verbose: v.verbose as Verbose });
		loadVerbose();
		ctx.ui.notify(`手机上回传详细度已设为「${v.verbose}」`, "info");
	}
	if (v.mark !== undefined && v.mark !== (markInbound() ? "是" : "否")) {
		saveCfg({ markInbound: v.mark === "是" });
		ctx.ui.notify(`📱 来源前缀已${v.mark === "是" ? "开启" : "关闭"}`, "info");
	}
	if (v.danger !== undefined && v.danger !== (allowDanger ? "是" : "否")) {
		allowDanger = v.danger === "是";
		ctx.ui.notify(
			allowDanger ? "⚠ 手机现在可以执行标了 danger 的命令了" : "已收回危险命令的放行",
			allowDanger ? "error" : "info",
		);
	}
	if (v.devices === "出二维码（手机扫码）") {
		if (!isOn) ctx.ui.notify("先打开上面的「连接」再出二维码", "info");
		else if (!botUsername) ctx.ui.notify("还没拿到 bot 用户名（token 可能没配）", "error");
		else {
			pair = { code: newPairCode(), exp: Date.now() + 15 * 60 * 1000, tries: 0 };
			showQr(ctx);
		}
	} else if (v.devices === "解除全部设备") {
		saveCfg({ chats: [] });
		turnOff("已解除全部设备绑定", false);
		ctx.ui.notify(`已解除 ${devCount} 台设备的绑定，下次要重新配对`, "info");
	}
	if (v.backlog === "补收（会执行旧消息）") {
		if (!doCatchup()) ctx.ui.notify("现在没有待补收的离线消息", "info");
	} else if (v.backlog === "丢弃（只收新的）") {
		await doDrop();
	}
}

/** 补收离线积压（**会执行旧消息**，所以默认不自动做）；返回 false = 本来就没积压 */
function doCatchup(): boolean {
	if (!catchupCount) return false;
	const n = catchupCount;
	catchupCount = 0;
	startPoll();
	notify(`▶ 开始补收 ${n} 条离线消息（它们会被当成新指令执行，注意）`);
	return true;
}

/** 丢弃离线积压：把游标跳到最新那条之后，中间的全不要 */
async function doDrop(): Promise<void> {
	try {
		// offset = -1 取“最后一条”，把游标跳到它之后 → 中间的全丢弃
		const last = await tgCall<any[]>("getUpdates", { offset: -1, limit: 1, timeout: 0, allowed_updates: ALLOWED_UPDATES }, 15000);
		if (last.length) {
			nextOffset = Number(last[0].update_id ?? nextOffset) + 1;
			saveCfg({ offset: nextOffset });
		}
	} catch {
		/* 跳不过去也别卡住，照常开始 */
	}
	catchupCount = 0;
	notify("🗑 已丢弃离线消息，从现在起只收新消息");
	startPoll();
}

/** 插件版本：优先读**自己旁边**的 package.json（真值），读不到就退回下面这个手写常量 */
const PLUGIN_VER_FALLBACK = "1.32.0";

/**
 * `/status` 里会显示它 —— 用途很具体：**一眼确认"我到底 reload 上了没"**。
 * （这几天反复出现：改了代码 → 得 reload → 但 reload 完不知道生效没有。）
 */
function pluginVersion(): string {
	const candidates: string[] = [];
	try {
		// 正常路径：和本文件同目录的 package.json（install.ps1 会把整棵目录拷过去）
		candidates.push(join(dirname(fileURLToPath(import.meta.url)), "package.json"));
	} catch {
		/* 某些加载方式下 import.meta 不可用 */
	}
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir) candidates.push(join(agentDir, "extensions", "ai-configure", "package.json"));
	for (const p of candidates) {
		try {
			const v = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
			if (v?.version) return String(v.version);
		} catch {
			/* 换下一个 */
		}
	}
	return PLUGIN_VER_FALLBACK;
}

/** 手机上"现在跟哪个模型说话"（`ctx.model` 的形状在不同版本里不一样，所以防御着取） */
function modelText(): string {
	const m = guardCtx(curCtx, (c) => (c as { model?: unknown }).model).value as
		| { id?: string; name?: string; model?: string; provider?: string; providerId?: string }
		| undefined;
	if (!m) return "（未知）";
	const id = m.id ?? m.name ?? m.model ?? "";
	const prov = m.provider ?? m.providerId ?? "";
	return id ? `${id}${prov ? ` @ ${prov}` : ""}` : "（未知）";
}

/**
 * 手机侧能敲的命令一览。
 * 为什么要它：手机上原来只能靠 `/run`（不带参数）看到白名单，而 `/status` `/stop` `/compact` `/verbose`
 * 这几个**内置的没地方查** —— 手机上又没有 pi 那个 `/` 菜单。
 */
function phoneHelpText(): string {
	const list = cfg().phoneCommands ?? [];
	const lines = [
		"**我（手机）能敲的**",
		"",
		"· `/status`（=`/usage`）—— 连接状态 · 空闲/忙 · 上下文占用 · 当前模型",
		"· `/stop` —— 停掉正在跑的任务",
		"· `/compact` —— 主动压缩上下文（手机上也能压）",
		"· `/verbose` —— 看 / 改回传详细度（`quiet` / `tools` / `full`）",
		"· `/run` —— 看我被授权跑哪些命令（白名单，定义在电脑的配置里）",
		"· `/help` —— 这张表",
		"",
		"**直接说话** = 投给电脑上的 pi（默认排队、不打断它干活）。",
		"**电脑问你“这个计划行不行”时**会推一张带按钮的卡过来 —— 点按钮，或回一句「同意 / 算了」。",
		"其它斜杠命令**不会执行**，会原样当消息投进去（安全边界，故意的）。",
	];
	lines.push(
		"",
		list.length
			? `白名单目前 ${list.length} 条：${list.map((c) => `\`${c.name}\``).join("、")}`
			: "白名单命令还没配（在**电脑**上写 `telegram.phoneCommands`）。",
	);
	return lines.join("\n");
}

/**
 * `/remote` 的**全部用法**（抽出来是因为命令目录那个 action 行也要打印它）。
 * 注意开头那几行是**动态状态**（待配对/待确认/积压）。
 */
function remoteHelpText(): string {
	const lines = [statusText()];
	const pl = pairLines();
	if (pl.length) lines.push("", "⏳ 待扫码/口令配对（15 分钟内有效）：", ...pl);
	if (pendingBinds.length)
		lines.push("", "⏳ 待确认的配对请求：", ...pendingBinds.map((p) => `  /remote bind ${p.code}   ← ${p.label}`));
	if (catchupCount) lines.push("", `⏸ 离线积压 ${catchupCount} 条未处理：/remote catchup 补收 · /remote drop 丢弃`);
	lines.push("");
	lines.push("· /remote catchup / drop —— 处理离线期间积压的消息");
	lines.push("· /remote mark on|off —— 手机消息正文要不要带 `📱 ` 来源前缀");
	lines.push("· 计划确认框会自动同步到手机（带 ✅/✏️/⛔ 按钮，也能直接回一句）");
	lines.push("· /remote verbose quiet|tools|full —— 手机上回传多少过程");
	lines.push("· /remote allow-danger [off] —— 手机能不能跑标了 danger 的白名单命令");
	lines.push("· 手机侧命令：/status · /stop · /compact · /verbose · /run（白名单，定义在配置的 telegram.phoneCommands）");
	lines.push("· /remote bind [码] —— 确认手机上申请配对的设备（不带码则列出全部）");
	lines.push("· /remote qr —— 出二维码（扫码，或抄口令在手机上 /start 口令）");
	lines.push("· /remote on —— 连接（没绑过会给配对指引；已连接时不再重复动作）");
	lines.push("· /remote off —— 切断（绑定保留，下次 on 直接回来）");
	lines.push("· /remote unpair —— 解除全部绑定（下次要重新配对）");
	if (!cfg().token) lines.push("· ⚠ 还没配 token：/aihelp 面板里填，或写进 ai-extensions.json 的 telegram.token");
	if (catchupCount) lines.unshift(`⏸ 已连接但**暂停收消息**（离线积压 ${catchupCount} 条待你决定）`);
	return lines.join("\n");
}

/**
 * `/aihelp` 面板里「命令」分组的内容（`kind:"action"` 行：**选中即执行**）。
 *
 * 为什么需要它：命令已经十多个，`/` 弹出的列表**平铺着、记不住**。
 * ⚠️ pi 的 `RegisteredCommand` **没有** hidden/group 字段 —— 那个列表本身改不了（查过类型），
 * 所以“分层”只能做在**入口**上：命令名全部保留，另外给一个**按模块分组、可点执行**的目录。
 */
function commandActions(): SettingDef[] {
	const def = (
		key: string,
		label: string,
		desc: string,
		fn: (ctx: ExtensionContext) => void | Promise<void>,
	): SettingDef => ({
		key: `cmd.${key}`,
		group: "命令",
		label,
		desc,
		kind: "action",
		def: "",
		get: () => "",
		set: () => {
			const c = curCtx;
			if (!c) throw new Error("没有可用的会话上下文（重新打开一次面板）");
			void fn(c);
		},
	});
	return [
		def("remote.panel", "/remote", "打开手机接管面板（连接 / 配对 / 回传 / 白名单）", (c) => showRemotePanel(c)),
		def("remote.status", "/remote status", "手机接管状态：连接 · 忙不忙 · 上下文占用", (c) => c.ui.notify(statusText(), "info")),
		def("remote.on", "/remote on", "连上 Telegram（手机开始能收发）", async (c) => turnOn(c)),
		def("remote.off", "/remote off", "切断（手机完全看不到、也发不进来；绑定保留）", (c) => {
			turnOff("你在命令目录里关的");
			if (!isOn) c.ui.notify("已切断（本来就没连）", "info");
		}),
		def("remote.qr", "/remote qr", "出二维码配对（手机扫码，或抄口令在手机上 /start）", (c) => {
			if (!isOn) c.ui.notify("先 `/remote on` 连上", "info");
			else if (!botUsername) c.ui.notify("还没拿到 bot 用户名（token 可能没配）", "error");
			else {
				pair = { code: newPairCode(), exp: Date.now() + 15 * 60 * 1000, tries: 0 };
				showQr(c);
			}
		}),
		def("remote.mark", "/remote mark", "切换 📱 来源前缀（让模型知道这条来自手机）", (c) => {
			saveCfg({ markInbound: !markInbound() });
			c.ui.notify(`📱 来源前缀已${markInbound() ? "开启" : "关闭"}`, "info");
		}),
		def("remote.verbose", "/remote verbose", "轮换回传详细度 quiet → tools → full", (c) => {
			const next: Verbose = verbose === "quiet" ? "tools" : verbose === "tools" ? "full" : "quiet";
			saveCfg({ verbose: next });
			loadVerbose();
			c.ui.notify(`手机上回传详细度 →「${next}」`, "info");
		}),
		def("remote.help", "/remote help", "打印手机接管的全部命令用法", (c) => c.ui.notify(remoteHelpText(), "info")),
	];
}

export function setupRemote(api: ExtensionAPI): void {
	curCtxApi = api;

	// ---------- 默认 IPv4 优先（进程级）----------
	// Node 从 17 起默认是 `verbatim`（按 DNS 返回顺序，**通常 IPv6 在前**）。
	// 这台机器到 Telegram 的 IPv6 路由不通，而解析结果又是飘的 → 会“间歇性抽风”。
	// `ipv4first` 只是**优先** IPv4（IPv4 不通仍会回落到 IPv6），不会禁用 IPv6，所以是安全的。
	try {
		setDefaultResultOrder("ipv4first");
	} catch {
		/* 老 Node 不支持就算了 */
	}

	// ---------- 配置面板（/aihelp）----------
	registerSettings([
		{
			key: "remoteToken",
			group: "手机接管",
			label: "Bot token",
			desc: "Telegram 机器人令牌（@BotFather 给你的那串）。⚠ 这是**密码**，所以面板里只显示掩码：要换就把整行清空再粘贴新的；清空后保存 = 删掉已存的 token。贴完会自动 Verify（跑一次 getMe），成功会提示 bot 名字。",
			kind: "text",
			def: "",
			get: () => maskToken(cfg().token),
			set: (v) => setTokenFromPanel(v),
		},
		{
			key: "remoteOn",
			group: "手机接管",
			label: "连接开关",
			desc: "把本会话接到手机上（Telegram）。开 = 起长轮询、显示配对二维码。关 = 一条网络请求都不发，手机侧完全看不到。本会话记住，换会话自动回到「关」。",
			kind: "bool",
			def: false,
			session: true,
			get: () => isOn,
			set: (v) => {
				if (v) {
					if (curCtx) void turnOn(curCtx);
				} else turnOff("你在配置面板里关的");
			},
		},
		{
			key: "remoteDeliver",
			group: "手机接管",
			label: "手机消息投递方式",
			desc: "followUp = pi 正在跑任务时**排队**，等它跑完再说（不打断）；steer = 直接**插进**当前运行，会改变它的方向。",
			kind: "enum",
			options: ["排队（不打断）", "插话（打断）"],
			values: ["followUp", "steer"],
			def: "followUp",
			get: () => cfg().deliver ?? "followUp",
			set: (v) => saveCfg({ deliver: v === "steer" ? "steer" : "followUp" }),
		},
	]);

	// ---------- 会话开场：读回开关状态 ----------
	api.on("session_start", (_event, ctx) => {
		gen += 1; // 让上一轮循环自己退出
		isOn = false;
		pollTask = undefined;
		curCtx = ctx;
		const was = readSessionOn(ctx);
		if (was && cfg().token) {
			// 上次这个会话是开着的 → 恢复连接（绑定还在就不用重扫）
			void turnOn(ctx);
		}
	});

	api.on("session_shutdown", () => {
		gen += 1;
		isOn = false;
		stopPoll();
		closeQr = undefined;
		curCtx = undefined;
	});

	// ---------- /ai-ext off 时一并停掉（复用 gate 的闸门）----------
	onGateApply("remote", (off) => {
		if (off) turnOff("整个扩展被停用");
	});

	// ---------- 命令 ----------
	api.registerCommand("remote", {
		description: "手机接管本会话（Telegram）：不带参数开面板；/remote help 看全部命令",
		handler: async (args: string, ctx: ExtensionContext) => {
			curCtx = ctx;
			const a = (args ?? "").trim().toLowerCase();
			// 不带参数 → 图形面板（命令太多，打印一屏用法记不住）
			if (!a) return void showRemotePanel(ctx);
			if (a === "on") return void turnOn(ctx);
			if (a === "off") {
				turnOff("你手动关的");
				if (!isOn) ctx.ui.notify("已切断（本来就没连）", "info");
				return;
			}
			if (a === "unpair") {
				const n = (cfg().chats ?? []).length;
				saveCfg({ chats: [] });
				turnOff("已解除全部设备绑定", false);
				ctx.ui.notify(`已解除 ${n} 台设备的绑定，下次要重新配对`, "info");
				return;
			}
			// 出二维码（扫码配对 / 抄口令）
			if (a === "qr") {
				if (!isOn) {
					ctx.ui.notify("先 `/remote on` 连上", "info");
					return;
				}
				if (!botUsername) {
					ctx.ui.notify("还没拿到 bot 用户名（token 可能没配），先用 `/remote off` → `/remote on` 重连", "error");
					return;
				}
				pair = { code: newPairCode(), exp: Date.now() + 15 * 60 * 1000, tries: 0 };
				showQr(ctx);
				return;
			}
			// 反向配对：确认手机上申请的那个 6 位码
			if (a.startsWith("bind")) {
				const want = a.slice(4).trim();
				const now = Date.now();
				pendingBinds = pendingBinds.filter((p) => p.exp > now);
				if (!pendingBinds.length) {
					ctx.ui.notify("现在没有待确认的配对请求。\n手机上给 bot 发一句话，它会回一个 6 位码。", "info");
					return;
				}
				const hit = want
					? pendingBinds.find((p) => p.code === want)
					: pendingBinds.length === 1
						? pendingBinds[0]
						: undefined;
				if (!hit) {
					ctx.ui.notify(
						(want ? "没找到这个配对码。" : "有多个待确认请求，请带上配对码：") +
							"\n" +
							pendingBinds.map((p) => `  /remote bind ${p.code}   ← ${p.label}`).join("\n"),
						"info",
					);
					return;
				}
				await bind(hit.chatId, hit.label);
				return;
			}
			if (a.startsWith("allow-danger")) {
				const on = !a.endsWith("off");
				allowDanger = on;
				ctx.ui.notify(
					on
						? "⚠ 手机现在可以执行标了 danger 的命令了（`/remote allow-danger off` 可收回；断开/重连会自动收回）"
						: "已收回危险命令的放行",
					on ? "error" : "info",
				);
				return;
			}
			if (a.startsWith("verbose")) {
				const v = a.slice(7).trim();
				if (v !== "quiet" && v !== "tools" && v !== "full") {
					ctx.ui.notify(
						[
							`回传详细度：现在是「${verbose}」`,
							"· quiet —— 只要最终回复",
							"· tools —— 加上每一步工具调用（默认）",
							"· full —— 连正在生成的文字也看",
							"用法：/remote verbose quiet|tools|full",
						].join("\n"),
						"info",
					);
					return;
				}
				saveCfg({ verbose: v });
				loadVerbose();
				ctx.ui.notify(`手机上的回传详细度已设为「${v}」`, "info");
				return;
			}
			if (a.startsWith("mark")) {
				const v = a.slice(4).trim();
				if (!v) {
					ctx.ui.notify(`📱 来源前缀现在是「${markInbound() ? "开" : "关"}」（\`/remote mark on|off\`）`, "info");
					return;
				}
				const on = v === "on";
				saveCfg({ markInbound: on });
				ctx.ui.notify(
					on
						? "📱 手机消息会在正文前带 `📱 ` 前缀（模型也能区分来源）"
						: "已关闭来源前缀（模型不再能区分手机/电脑，你仍能在终端看到 📱 提示）",
					"info",
				);
				return;
			}
			// 补收 / 丢弃离线积压
			if (a === "catchup") {
				if (!doCatchup()) ctx.ui.notify("现在没有待补收的离线消息", "info");
				return;
			}
			if (a === "drop") {
				await doDrop();
				return;
			}
			// status / help
			ctx.ui.notify(remoteHelpText(), "info");
		},
	});

	// ---------- 命令总目录（`/aihelp` 面板的「命令」分组）----------
	// 命令十多个、`/` 列表平铺着记不住（而且 pi 没给 hidden/group 字段，那个列表改不了），
	// 所以在这里给一个**按模块分组、可点执行**的目录。
	registerSettings(commandActions());

	// ---------- 终端 → 手机 ----------
	// `api.exec` 抓下来给白名单命令用
	execFn = api.exec?.bind(api);

	// 配置里的回传详细度（telegram.verbose）→ 进内存
	loadVerbose();

	// 计划的确认框 → 同步到手机（终端上那个框照旧，两边随便哪边先答都行）
	onPlanAskChange((ask) => {
		if (!isOn) return;
		if (ask) {
			void planPush(ask.title, ask.steps);
		} else {
			const what = planAnswered || planAskOutcome() || "✔ 已在电脑端答复";
			planAnswered = "";
			void planPushDone(what);
		}
	});

	// ---------- 过程回传：工具调用 → 手机上的进度消息 ----------
	api.on("tool_execution_start", async (event) => {
		if (!isOn || verbose === "quiet") return;
		const e = event as any;
		ensureCardsForAll();
		const detail = toolDetail(String(e.toolName ?? "?" ), e.args);
		for (const card of runCards.values()) {
			pushToolLine(card, { id: String(e.toolCallId ?? ""), text: `${e.toolName}${detail ? `  ${detail}` : ""}`, done: false, startedAt: Date.now() });
		}
		scheduleCardFlush();
	});

	api.on("tool_execution_end", async (event) => {
		if (!isOn || verbose === "quiet") return;
		const e = event as any;
		for (const card of runCards.values()) {
			const line = card.lines.find((l) => l.id === String(e.toolCallId ?? ""));
			if (!line) continue;
			const ms = typeof e.durationMs === "number" ? e.durationMs : Date.now() - line.startedAt;
			const secs = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
			line.text = `${line.text}   ${e.isError ? "❌" : "✅"} ${secs}`;
			line.done = true;
			card.dirty = true;
		}
		scheduleCardFlush();
	});

	// verbose=full 时，把流式输出的尾巴也挂到卡上（默认不开，手机上看半句话很吵）
	api.on("message_update", async (event) => {
		if (!isOn || verbose !== "full" || runCards.size === 0) return;
		const m: any = (event as any).message;
		if (m?.role !== "assistant") return;
		const t = textOf(m).replace(/\s+/g, " " ).trim();
		if (!t) return;
		const tail = t.length > 80 ? `…${t.slice(-80)}` : t;
		for (const card of runCards.values()) {
			if (card.stream === tail) continue;
			card.stream = tail;
			card.dirty = true;
		}
	});

	// pi 的回复收尾时推给手机。
	// 为什么用 message_end 记、agent_settled 发：流式途中会反复触发，攒到最后一次再发，
	// 既省 Telegram 的限速额度，也避免手机上刷出一堆半句话。
	let lastAssistant = "";
	let lastUser = "";

	api.on("message_end", async (event) => {
		if (!isOn) return;
		const m: any = (event as any).message;
		if (m?.role === "assistant") lastAssistant = textOf(m);
		else if (m?.role === "user") lastUser = textOf(m);
	});

	api.on("agent_settled", async (event) => {
		if (!isOn) return;
		const aborted = Boolean((event as any).aborted);
		// 先把进度消息“冻结”（否则它会一直显示“运行中”）
		await finishCards(aborted ? "aborted" : "done");
		const body = lastAssistant.trim();
		const prefix = aborted ? "⏹ 已中断\n\n" : "";
		if (!body) {
			await broadcast(`${prefix}(这一轮没有文字输出)`);
		} else {
			await broadcast(prefix + body);
		}
		lastAssistant = "";
		lastUser = "";
	});
}
