/**
 * voice-tts.ts —— "答完就播"的接线层（离线引擎 / 系统语音 / 静音）
 *
 * 为什么单独一个文件而不塞进 voice.ts：
 *   voice.ts 已经 2100+ 行，负责"输入侧"（语音上屏/剪贴板/弹窗）；这块是"输出侧"（播报）。
 *   分开的好处：引擎/队列/口播稿各自独立，改一个不会碰坏另一个，也方便单独测。
 *
 * 关键设计（每条都有原因）：
 *   · **单一出口**：所有播报走 Speaker 队列，不允许多处各播各的（会叠音）。
 *   · **谁起谁收**：worker 是常驻子进程 —— 会话结束/插件停用/pi 退出都要 close()。
 *     另外 worker 自己也会在 **stdin EOF（父进程死了）** 时自杀，双保险。
 *   · **不进上下文**：口播稿只走 Speaker + narration.jsonl，绝不写进对话历史（否则每轮都涨 token）。
 *   · **开机不吵**：voiceTts 默认关；装了模型也不自动开（用户手动开）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isExtDisabled, onGateApply } from "./gate";
import { registerSettings, type SettingDef } from "./settings";
import { onPlanAskChange } from "./shared";
import { Speaker } from "./speaker";
import { render, sanitizeForSpeech, type SpeechLevel, type TermMode } from "./speech";
import { TtsRouter, type EngineMode } from "./tts/index";
import { installModel, loadManifest, modelStatus, uninstallModel } from "./tts/models";

const GROUP = "语音播报";
const ACTION_GROUP = "语音播报 · 操作";

interface Cfg {
	voiceTts?: boolean;
	voiceEngine?: EngineMode;
	voiceSpeed?: number;
	voiceLocalModel?: string;
	voiceLocalVoice?: number;
	voiceTerms?: TermMode;
	voiceLevel?: SpeechLevel;
	voiceTtsVoice?: string;
	voiceTtsRate?: number;
	voiceTtsVolume?: number;
}

let curCtx: ExtensionContext | undefined;
let router: TtsRouter | null = null;
let speaker: Speaker | null = null;
let agentDir = "";
let lastAssistantText = "";
let toolStartAt = 0;
let progressSent = false;
let lastStepAt = 0;
let stepsThisTurn = 0;
let lastStepText = "";
let voiceFailures = 0; // 连续失败计数 → 熔断，绝不拖累主流程
let disposeAsk: (() => void) | null = null;

// --------------------------------------------------------------------------- #
// 配置读写（与 voice.ts / delegate.ts 共用 ai-extensions.json）
// --------------------------------------------------------------------------- #
function cfgFile(): string {
	return join(agentDir, "ai-extensions.json");
}

function readCfg(): Cfg {
	try {
		return JSON.parse(readFileSync(cfgFile(), "utf8")) as Cfg;
	} catch {
		return {};
	}
}

function patchCfg(patch: Partial<Cfg>): void {
	try {
		const cur = readCfg();
		const next = { ...cur, ...patch };
		mkdirSync(dirname(cfgFile()), { recursive: true });
		writeFileSync(cfgFile(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
	} catch {
		/* 写不进去也不影响本次会话 */
	}
}

function num(v: unknown, def: number, min: number, max: number): number {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

function settingsOf(c: Cfg = readCfg()) {
	return {
		mode: (c.voiceEngine ?? "auto") as EngineMode,
		speed: num(c.voiceSpeed, 1.0, 0.7, 1.3),
		sid: Math.round(num(c.voiceLocalVoice, 50, 0, 60)),
		model: typeof c.voiceLocalModel === "string" ? c.voiceLocalModel : undefined,
		sapiVoice: typeof c.voiceTtsVoice === "string" ? c.voiceTtsVoice : undefined,
		sapiRate: num(c.voiceTtsRate, 0, -10, 10),
		sapiVolume: num(c.voiceTtsVolume, 100, 0, 100),
	};
}

function ensureSpeech(): { router: TtsRouter; speaker: Speaker } | null {
	if (!agentDir) return null;
	if (!router) router = new TtsRouter(agentDir, settingsOf(), () => {});
	if (!speaker) {
		speaker = new Speaker({
			agentDir,
			router,
			enabled: () => readCfg().voiceTts === true,
		});
	}
	return { router, speaker };
}

/** 释放：会话结束 / 插件停用时必须调用（不留孤儿进程） */
function closeSpeech(): void {
	try {
		speaker?.close();
	} catch {
		/* ignore */
	}
	speaker = null;
	try {
		router?.close();
	} catch {
		/* ignore */
	}
	router = null;
}

function enabled(): boolean {
	return readCfg().voiceTts === true;
}

/** 把一段长回答压成"第一句听得懂"的结论（brief 级别用） */
function firstSentence(text: string): string {
	const t = sanitizeForSpeech(text);
	const m = t.match(/^[^。！？!?]{4,80}[。！？!?]/);
	return (m ? m[0] : t.slice(0, 60)).trim();
}

function speakResult(): void {
	if (!enabled()) return;
	const s = ensureSpeech();
	if (!s) return;
	const c = readCfg();
	const u = render(
		{ kind: "result", full: lastAssistantText, text: firstSentence(lastAssistantText), ref: "turn" },
		{ level: (c.voiceLevel ?? "brief") as SpeechLevel, terms: (c.voiceTerms ?? "en") as TermMode },
	);
	if (u) s.speaker.say(u);
}

// --------------------------------------------------------------------------- #
// 设置项
// --------------------------------------------------------------------------- #
function speechSettings(): SettingDef[] {
	const manifest = (() => {
		try {
			return loadManifest();
		} catch {
			return { models: [], defaultModel: "" } as ReturnType<typeof loadManifest>;
		}
	})();
	const modelIds = manifest.models.map((m) => m.id);

	const defs: SettingDef[] = [
		{
			key: "voiceEngine",
			group: GROUP,
			label: "引擎",
			desc: "auto = 有本地模型就用本地，否则回退系统语音；local = 强制本地（不可用也回退）；off = 静音。装完模型不会自动打开播报。",
			kind: "enum",
			options: ["auto", "local", "sapi", "off"],
			values: ["auto", "local", "sapi", "off"],
			def: "auto",
			get: () => readCfg().voiceEngine ?? "auto",
			set: (v) => {
				patchCfg({ voiceEngine: v as EngineMode });
				void router?.reconfigure({ mode: v as EngineMode });
			},
		},
		{
			key: "voiceSpeed",
			group: GROUP,
			label: "语速",
			desc: "0.7~1.3，默认 1.0。本地引擎用 length_scale 实现（1/speed），实测有效；系统语音走 Rate。",
			kind: "number",
			min: 0.7,
			max: 1.3,
			def: 1.0,
			get: () => num(readCfg().voiceSpeed, 1.0, 0.7, 1.3),
			set: (v) => {
				const sp = num(v, 1.0, 0.7, 1.3);
				patchCfg({ voiceSpeed: sp });
				void router?.reconfigure({ speed: sp });
			},
		},
		{
			key: "voiceLocalModel",
			group: GROUP,
			label: "本地模型",
			desc: `装哪个离线模型（下载到 ~/.pi/agent/models/tts/）。可选：${modelIds.join(" / ") || "（清单读取失败）"}。`,
			kind: "enum",
			options: modelIds,
			values: modelIds,
			def: manifest.defaultModel || "kokoro-multi-lang-v1_0",
			get: () => readCfg().voiceLocalModel ?? manifest.defaultModel ?? "kokoro-multi-lang-v1_0",
			set: (v) => {
				patchCfg({ voiceLocalModel: String(v) });
				router?.invalidate();
			},
		},
		{
			key: "voiceLocalVoice",
			group: GROUP,
			label: "音色",
			desc: "Kokoro 音色号：45~48 中文女声、49~52 中文男声（49 zm_yunjian 沉稳 / 50 zm_yunxi 年轻 / 51 zm_yunxia 浑厚 / 52 zm_yunyang 清朗）、0~19 美式英语。MeloTTS 只有 0。",
			kind: "number",
			min: 0,
			max: 60,
			def: 49,
			get: () => Math.round(num(readCfg().voiceLocalVoice, 50, 0, 60)),
			set: (v) => {
				const sid = Math.round(num(v, 50, 0, 60));
				patchCfg({ voiceLocalVoice: sid });
				void router?.reconfigure({ sid });
			},
		},
		{
			key: "voiceTerms",
			group: GROUP,
			label: "英文术语",
			desc: "en = 保留英文原词（GitHub / API，Kokoro 能当单词读）；cn = 换成中文说法（代码托管站 / 接口）；off = 不动。",
			kind: "enum",
			options: ["en", "cn", "off"],
			values: ["en", "cn", "off"],
			def: "en",
			get: () => readCfg().voiceTerms ?? "en",
			set: (v) => patchCfg({ voiceTerms: v as TermMode }),
		},
		{
			key: "voiceAck",
			group: GROUP,
			label: "开口先应一声",
			desc: "你发消息后先播一句「收到」（steps/chatty 档生效）。我会在动手前再补一句具体要干什么。",
			kind: "bool",
			def: true,
			get: () => readCfg().voiceAck ?? true,
			set: (v) => patchCfg({ voiceAck: v }),
		},
		{
			key: "voiceLevel",
			group: GROUP,
			label: "播报级别",
			desc:
				"brief = 只播结论/卡点/要你拍板（默认）；steps = ＋阶段进展（我先去看代码 → 开始改 → 跑测试）；" +
				"chatty = ＋慢动作也播；normal = ＋风险；full = 念完整回答（超 220 字截断，细节留在屏幕上）。",
			kind: "enum",
			options: ["brief", "steps", "chatty", "normal", "full"],
			values: ["brief", "steps", "chatty", "normal", "full"],
			def: "brief",
			get: () => readCfg().voiceLevel ?? "brief",
			set: (v) => patchCfg({ voiceLevel: v as SpeechLevel }),
		},
	];

	// ---- 操作项（kind=action，回车即执行）----
	const action = (key: string, label: string, desc: string, fn: (ctx: ExtensionContext) => Promise<void> | void): SettingDef => ({
		key: `cmd.${key}`,
		group: ACTION_GROUP,
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

	defs.push(
		action("tts.status", "/tts status", "看引擎状态：用了哪档、模型在不在、为什么不可用", async (c) => c.ui.notify(await statusText(), "info")),
		action("tts.test", "/tts test", "说一句测试句（含 GitHub / CI / TypeScript / diff 这些难点词）", async (c) => {
			await testSay(c);
		}),
		action("tts.demo", "/tts demo", "演一遍完整播报节奏：收到 → 看后端 → 改 → 测 → 结论（约 40 秒）", async () => {
			const c = curCtx;
			if (!c) return;
			const sp = ensureSpeech();
			if (!sp) return;
			c.ui.notify("演示一遍完整播报节奏（约 40 秒）", "info");
			void (async () => {
				try {
					for (const t of [
						"收到，我先去看后端怎么实现的。",
						"后端看完了，问题在配置合并那一步，我改一下。",
						"改完了，跑个测试。",
						"测试全过了，一百零四项。现在推双端。",
						"这轮做完了。第一，配置合并的覆盖顺序修好了。第二，一百零四项测试全过。第三，已经推到 GitHub 和 Gitee。下一步要不要我把告警也接上？",
					]) {
						await sp.router.say(t);
						await new Promise((r) => setTimeout(r, 600));
					}
				} catch (e) {
					c.ui.notify(`演示中断：${e instanceof Error ? e.message : String(e)}`, "error");
				}
			})();
		}),
		action("tts.install", "/tts install", "下载选中的本地模型（384MB/183MB，支持断点续传与镜像切换）", async (c) => {
			await installWithProgress(c);
		}),
		action("tts.rm", "/tts rm", "删掉本地模型（省磁盘；引擎会自动回退系统语音）", async (c) => {
			const id = settingsOf().model ?? loadManifest().defaultModel;
			const ok = uninstallModel(router ?? new TtsRouter(agentDir, settingsOf()), id);
			c.ui.notify(ok ? `已删除 ${id}` : `没有安装 ${id}`, "info");
		}),
	);
	return defs;
}

// --------------------------------------------------------------------------- #
// 动作实现
// --------------------------------------------------------------------------- #
async function statusText(): Promise<string> {
	const s = ensureSpeech();
	if (!s) return "语音模块未初始化";
	const st = await s.router.status(true);
	const lines = [
		`引擎：${st.engine}${st.ok ? "（可用）" : "（不可用）"}`,
		st.reason ? `原因：${st.reason}` : "",
		`模式：${st.mode} · 语速 ${st.speed} · 音色 ${st.sid}`,
		st.model ? `模型：${st.model}${st.sampleRate ? ` · ${st.sampleRate}Hz` : ""}` : "",
		`已装模型：${st.installed.length ? st.installed.join(", ") : "（无）"}`,
		`目录：${st.modelsDir}`,
	].filter(Boolean);
	return lines.join("\n");
}

const TEST_TEXT =
	"这次改动动了三个文件：设置页、GitHub 上的 CI 配置，还有 TypeScript 的类型。一百零四项测试全过，下一步把 diff 推到 Gitee。";

async function testSay(ctx: ExtensionContext): Promise<void> {
	const s = ensureSpeech();
	if (!s) return;
	const st = await s.router.status(true);
	if (!st.ok) {
		ctx.ui.notify(`没有可用引擎：${st.reason || "未知"}`, "error");
		return;
	}
	ctx.ui.notify(`用 ${st.engine} 念测试句（${st.model ?? "系统语音"}）…`, "info");
	try {
		await s.router.say(TEST_TEXT);
	} catch (e) {
		ctx.ui.notify(`播报失败：${e instanceof Error ? e.message : String(e)}`, "error");
	}
}

async function installWithProgress(ctx: ExtensionContext): Promise<void> {
	const s = ensureSpeech();
	if (!s) return;
	const m = loadManifest();
	const id = settingsOf().model ?? m.defaultModel;
	const entry = m.models.find((x) => x.id === id);
	if (!entry) {
		ctx.ui.notify(`清单里没有 ${id}`, "error");
		return;
	}
	if (existsSync(join(s.router.dir, entry.id, "model.onnx"))) {
		ctx.ui.notify(`${entry.id} 已安装（${Math.round(entry.bytes / 1048576)}MB）`, "info");
		return;
	}
	ctx.ui.notify(`开始下载 ${entry.id}（${Math.round(entry.bytes / 1048576)}MB）…`, "info");
	let lastPct = -10;
	try {
		await installModel(s.router, entry, (p) => {
			if (p.phase === "download" && p.pct !== undefined && p.pct - lastPct >= 20) {
				lastPct = p.pct;
				ctx.ui.notify(`下载中 ${p.pct}%`, "info");
			} else if (p.phase === "unpack") {
				ctx.ui.notify("下载完成，正在解压并校验…", "info");
			}
		});
		ctx.ui.notify(`${entry.id} 安装完成。说一句试试：`, "info");
		await testSay(ctx);
	} catch (e) {
		ctx.ui.notify(`安装失败：${e instanceof Error ? e.message : String(e)}`, "error");
	}
}

// --------------------------------------------------------------------------- #
// 接线
// --------------------------------------------------------------------------- #
export function setupVoiceTts(api: ExtensionAPI): void {
	agentDir = getAgentDir();
	registerSettings(speechSettings());

	api.on("session_start", async (_e, ctx) => {
		curCtx = ctx;
		lastAssistantText = "";
	});

	api.on("message_end", async (event) => {
		const msg = (event as { message?: { role?: string; content?: unknown } }).message;
		// 用户开口 = 打断我：正在念的先停（拟人感的关键：别自顾自说）
		if (msg?.role === "user") {
			try {
				const level = (readCfg().voiceLevel ?? "brief") as SpeechLevel;
				const stepsOn = level === "steps" || level === "chatty";
				if (speaker && stepsOn) void speaker.stopAll().catch(() => {});
				lastAssistantText = "";
				lastStepText = "";
				stepsThisTurn = 0;
				lastStepAt = 0;
				if (stepsOn && (readCfg().voiceAck ?? true) && enabled() && !isExtDisabled() && voiceFailures < 3) {
					const sp = ensureSpeech();
					const u = render({ kind: "step", text: "收到，我看一下。", ref: "ack" }, { level, terms: (readCfg().voiceTerms ?? "en") as TermMode });
					if (sp && u) sp.speaker.say(u);
				}
			} catch {
				voiceFailures += 1;
			}
			return;
		}
		if (msg?.role !== "assistant") return;
		const c = msg.content;
		if (typeof c === "string") lastAssistantText = c;
		else if (Array.isArray(c)) {
			lastAssistantText = c
				.filter((b) => (b as { type?: string }).type === "text")
				.map((b) => String((b as { text?: string }).text ?? ""))
				.join("\n");
		}
	});

	// 一轮结束 → 播结论（这就是"答完就播"）
	api.on("agent_settled", async () => {
		progressSent = false;
		stepsThisTurn = 0;
		lastStepAt = 0;
		lastStepText = "";
		if (isExtDisabled()) return;
		speakResult();
	});

	// 长任务占位播报（工具跑了 8 秒还没完 → 一句"还在跑"，20 秒后过期丢弃）
	api.on("tool_execution_start", async (event) => {
		toolStartAt = Date.now();
		// 阶段播报：只在 steps/chatty 档；节流 ≥6s、一轮最多 5 句；任何异常都静默
		try {
			const level = (readCfg().voiceLevel ?? "brief") as SpeechLevel;
			if (level !== "steps" && level !== "chatty") return;
			if (isExtDisabled() || !enabled()) return;
			const now = Date.now();
			if (now - lastStepAt < 6000) return;
			if (stepsThisTurn >= 5) return;
			if (voiceFailures >= 3) return; // 熔断：出过 3 次问题就别再试了
			const ev = event as Record<string, any>;
			const tool = String(ev.toolName ?? ev.name ?? ev.tool?.name ?? "");
			if (!tool) return;
			// 我写的口语行优先（懂语义、像人话）；没写才退回规则模板
			let mine = extractStep(lastAssistantText);
			if (mine && mine === lastStepText) mine = null; // 同一句话不重复念
			const u = render(
				{ kind: "step", text: mine ?? stepTextFor(tool, ev.input ?? ev.args ?? ev.parameters), ref: mine ? "step" : tool },
				{ level, terms: (readCfg().voiceTerms ?? "en") as TermMode },
			);
			if (!u) return;
			lastStepAt = now;
			stepsThisTurn += 1;
			if (mine) lastStepText = mine;
			const sp = ensureSpeech();
			if (sp) sp.speaker.say(u);
		} catch {
			voiceFailures += 1; // 静默失败，主流程不受影响
		}
	});
	api.on("tool_execution_end", async () => {
		const secs = toolStartAt ? (Date.now() - toolStartAt) / 1000 : 0;
		toolStartAt = 0;
		if (secs < 8 || progressSent || !enabled() || isExtDisabled()) return;
		progressSent = true;
		const s = ensureSpeech();
		const u = render(
			{ kind: "progress", text: "还在跑，大概还要一会儿。", ref: "tool" },
			{ level: "brief", terms: (readCfg().voiceTerms ?? "en") as TermMode },
		);
		if (s && u) s.speaker.say(u);
	});

	// 计划确认 → 播"要你拍板"（不打断正在念的结论）
	disposeAsk = onPlanAskChange((ask) => {
		if (!ask || !enabled()) return;
		const s = ensureSpeech();
		const u = render(
			{ kind: "ask", question: `计划准备好了：${ask.title}`, ref: "plan" },
			{ level: "brief", terms: (readCfg().voiceTerms ?? "en") as TermMode },
		);
		if (s && u) s.speaker.say(u);
	});

	// 会话结束/插件停用 → 一定要释放 worker（不留孤儿进程）
	api.on("session_shutdown", async () => {
		closeSpeech();
	});
	onGateApply("voice-tts", (off) => {
		if (off) {
			void speaker?.stopAll();
			closeSpeech();
		}
	});

	// ---------------- /tts 命令 ----------------
	api.registerCommand("tts", {
		description: "语音播报：status / test / install / rm / voice / speed / on / off",
		handler: async (args: string, ctx: ExtensionContext) => {
			curCtx = ctx;
			const a = (args ?? "").trim().toLowerCase();
			if (!a || a === "status") return void ctx.ui.notify(await statusText(), "info");
			if (a === "test") return void (await testSay(ctx));
			if (a === "install") return void (await installWithProgress(ctx));
			if (a === "rm" || a === "uninstall") {
				const id = settingsOf().model ?? loadManifest().defaultModel;
				const ok = uninstallModel(router ?? new TtsRouter(agentDir, settingsOf()), id);
				return void ctx.ui.notify(ok ? `已删除 ${id}` : `没有安装 ${id}`, "info");
			}
			if (a === "on") {
				patchCfg({ voiceTts: true });
				return void ctx.ui.notify("语音播报已打开（每轮回答结束会念一句）", "info");
			}
			if (a === "off" || a === "mute") {
				patchCfg({ voiceTts: false });
				void speaker?.stopAll();
				return void ctx.ui.notify("语音播报已关闭", "info");
			}
			if (a.startsWith("voice")) {
				const sid = Number(a.split(/\s+/)[1]);
				if (!Number.isFinite(sid)) return void ctx.ui.notify("用法：/tts voice 50", "info");
				patchCfg({ voiceLocalVoice: Math.round(sid) });
				await router?.reconfigure({ sid: Math.round(sid) });
				return void ctx.ui.notify(`音色已切到 ${Math.round(sid)}（/tts test 试听）`, "info");
			}
			if (a.startsWith("speed")) {
				const sp = Number(a.split(/\s+/)[1]);
				if (!Number.isFinite(sp)) return void ctx.ui.notify("用法：/tts speed 0.92", "info");
				const v = Math.max(0.7, Math.min(1.3, sp));
				patchCfg({ voiceSpeed: v });
				await router?.reconfigure({ speed: v });
				return void ctx.ui.notify(`语速已设为 ${v}`, "info");
			}
			if (a === "demo") {
				const sp = ensureSpeech();
				if (!sp) return;
				ctx.ui.notify("演示一遍完整播报节奏（约 40 秒，可 /tts off 打断）", "info");
				void (async () => {
					const level = (readCfg().voiceLevel ?? "brief") as SpeechLevel;
					const flow: [string, "step" | "result"][] = [
						["收到，我先去看后端怎么实现的。", "step"],
						["后端看完了，问题在配置合并那一步，我改一下。", "step"],
						["改完了，跑个测试。", "step"],
						["测试全过了，一百零四项。现在推双端。", "step"],
						["这轮做完了。第一，配置合并的覆盖顺序修好了。第二，一百零四项测试全过。第三，已经推到 GitHub 和 Gitee。下一步要不要我把告警也接上？", "result"],
					];
					try {
						for (const [text, kind] of flow) {
							await sp.router.say(text);
							await new Promise((r) => setTimeout(r, 600));
						}
					} catch (e) {
						ctx.ui.notify(`演示中断：${e instanceof Error ? e.message : String(e)}`, "error");
					}
				})();
				return;
			}
			if (a.startsWith("voices")) {
				const s = ensureSpeech();
				if (!s) return;
				const only = Number(a.split(/\s+/)[1]);
				const sids = Number.isFinite(only) ? [only] : [46, 47, 48, 49, 50, 51, 52];
				const SAMPLE = "这次改动动了三个文件：设置页、GitHub 上的 CI 配置，还有 TypeScript 的类型。";
				ctx.ui.notify(`试听 ${sids.length} 个音色，每个念一句…（随时 /tts off 可停）`, "info");
				for (const sid of sids) {
					ctx.ui.notify(`音色 ${sid}`, "info");
					try {
						await s.router.say(SAMPLE, undefined, { sid });
					} catch (e) {
						ctx.ui.notify(`音色 ${sid} 失败：${e instanceof Error ? e.message : String(e)}`, "error");
					}
				}
				ctx.ui.notify("试听结束。选中就用 /tts voice <号> 固定下来。", "info");
				return;
			}
			if (a === "models") {
				const rows = modelStatus(router ?? new TtsRouter(agentDir, settingsOf()));
				return void ctx.ui.notify(
					rows.map((r) => `${r.installed ? "✅" : "⬜"} ${r.id} · ${Math.round(r.bytes / 1048576)}MB · ${r.license}`).join("\n"),
					"info",
				);
			}
			ctx.ui.notify("用法：/tts status | test | install | rm | models | on | off | voice <sid> | speed <0.7~1.3>", "info");
		},
	});
}
