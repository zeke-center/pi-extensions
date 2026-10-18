/**
 * tts/index.ts —— 引擎路由：探测 / 选择 / 回退
 *
 * 顺序（mode=auto）：local → api → sapi → off
 * 任何一档坏了都**不能影响 pi**：探测失败只记录原因，播报时按可用档降级。
 *
 * 关键约定：实际用的引擎要能上报（面板显示 + 写 narration.jsonl），
 * 否则用户永远搞不清"为什么没声音"。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { installedModels, LocalTtsClient, modelsDir, pythonCandidates, type LocalInfo } from "./local";
import { sapiAvailable, speakSapi, stopSapi } from "./sapi";
import { DoubaoClient, doubaoConfigFromEnv } from "./doubao";

export type EngineMode = "auto" | "doubao" | "local" | "sapi" | "api" | "off";
export type EngineName = "off" | "doubao" | "sapi" | "local" | "api";

export interface TtsSettings {
	mode: EngineMode;
	speed: number;
	sid: number;
	model?: string;
	/** sapi 专用 */
	sapiVoice?: string;
	sapiRate?: number;
	sapiVolume?: number;
	/** api 档（默认不启用；留好位子） */
	apiVoice?: string;
	/** 豆包（火山引擎）在线语音：没配 appid/token 就自动跳过这一档 */
	doubao?: { appId?: string; token?: string; cluster?: string; voice?: string };
}

export interface TtsStatus {
	mode: EngineMode;
	engine: EngineName;
	ok: boolean;
	reason?: string;
	model?: string | null;
	sampleRate?: number | null;
	kind?: string | null;
	sid: number;
	speed: number;
	python?: string;
	modelsDir: string;
	installed: string[];
}

const PROBE_TTL_MS = 10 * 60 * 1000;

export class TtsRouter {
	private local: LocalTtsClient | null = null;
	private doubao: DoubaoClient | null = null;
	private probeCache: { at: number; info: LocalInfo | null; reason?: string } | null = null;

	constructor(
		private agentDir: string,
		private settings: TtsSettings,
		private log: (msg: string) => void = () => {},
	) {}

	get dir(): string {
		return modelsDir(this.agentDir);
	}

	get installed(): string[] {
		return installedModels(this.dir);
	}

	/** 探测本地引擎（带缓存）：python 可用 + worker 能起 + 至少一个模型 */
	async probeLocal(force = false): Promise<{ info: LocalInfo | null; reason?: string }> {
		if (!force && this.probeCache && Date.now() - this.probeCache.at < PROBE_TTL_MS) {
			return { info: this.probeCache.info, reason: this.probeCache.reason };
		}
		let reason: string | undefined;
		let info: LocalInfo | null = null;
		if (this.installed.length === 0) {
			reason = `没有已安装的模型（${this.dir}）`;
		} else {
			for (const py of pythonCandidates()) {
				const c = new LocalTtsClient({
					python: py,
					modelsDir: this.dir,
					sid: this.settings.sid,
					speed: this.settings.speed,
					model: this.settings.model,
				});
				const got = await c.probe();
				if (got) {
					this.local = c;
					info = got;
					break;
				}
				reason = c.error || `python 不可用：${py}`;
				c.close();
			}
		}
		this.probeCache = { at: Date.now(), info, reason };
		return { info, reason };
	}

	async status(force = false): Promise<TtsStatus> {
		const base = {
			mode: this.settings.mode,
			sid: this.settings.sid,
			speed: this.settings.speed,
			modelsDir: this.dir,
			installed: this.installed,
		};
		if (this.settings.mode === "off") return { ...base, engine: "off", ok: false, reason: "已静音" };
		// 豆包：配了凭据就用（auto 档也优先，音质更好）；没配就跳过，绝不报错
		const cfg = doubaoConfigFromEnv(this.settings.doubao ?? {});
		if (cfg && (this.settings.mode === "auto" || this.settings.mode === "doubao")) {
			this.doubao = this.doubao ?? new DoubaoClient(cfg);
			return { ...base, engine: "doubao", ok: true, model: `doubao:${cfg.voice}`, sampleRate: cfg.rate, kind: "cloud" };
		}
		if (this.settings.mode === "doubao") {
			return { ...base, engine: sapiAvailable() ? "sapi" : "off", ok: sapiAvailable(), reason: "豆包未配置 appid/token（环境变量 DOUBAO_TTS_APPID / DOUBAO_TTS_TOKEN）" };
		}
		if (this.settings.mode === "sapi" || this.settings.mode === "api") {
			const ok = this.settings.mode === "sapi" ? sapiAvailable() : Boolean(this.settings.apiVoice);
			return {
				...base,
				engine: this.settings.mode as EngineName,
				ok,
				reason: ok ? undefined : this.settings.mode === "sapi" ? "当前系统不支持系统语音" : "未配置在线语音",
			};
		}
		// auto / local
		const { info, reason } = await this.probeLocal(force);
		if (info) {
			return {
				...base,
				engine: "local",
				ok: true,
				model: info.model,
				sampleRate: info.sampleRate,
				kind: info.kind,
				python: this.local ? (this.local as any).opts?.python : undefined,
			};
		}
		if (this.settings.mode === "local") {
			// 明确要求 local 但不可用 → 回退 sapi，并把原因说清楚
			return {
				...base,
				engine: sapiAvailable() ? "sapi" : "off",
				ok: sapiAvailable(),
				reason: `${reason || "本地引擎不可用"}；已回退系统语音`,
			};
		}
		if (sapiAvailable()) return { ...base, engine: "sapi", ok: true, reason: reason ? `本地不可用（${reason}），用系统语音` : undefined };
		return { ...base, engine: "off", ok: false, reason: reason || "没有可用引擎" };
	}

	/** 播一句；返回实际用的引擎与首句延迟 */
	async say(
		text: string,
		onFirst?: (ms: number) => void,
		opts?: { sid?: number },
	): Promise<{ engine: EngineName; firstMs: number }> {
		const st = await this.status();
		if (!st.ok) throw new Error(st.reason || "没有可用引擎");
		if (st.engine === "doubao") {
			if (!this.doubao) throw new Error("豆包引擎未就绪");
			const r = await this.doubao.say(text, { onFirst });
			return { engine: "doubao", firstMs: r.firstMs };
		}
		if (st.engine === "local") {
			if (!this.local) throw new Error("本地引擎未就绪");
			const r = await this.local.say(text, {
				sid: opts?.sid ?? this.settings.sid,
				speed: this.settings.speed,
				model: this.settings.model,
				onFirst,
			});
			return { engine: "local", firstMs: r.firstMs };
		}
		if (st.engine === "sapi") {
			const t0 = Date.now();
			onFirst?.(0);
			await speakSapi(text, {
				voice: this.settings.sapiVoice,
				rate: this.settings.sapiRate,
				volume: this.settings.sapiVolume,
			});
			void t0;
			return { engine: "sapi", firstMs: 0 };
		}
		throw new Error("api 引擎尚未实现（可先选 local 或 sapi）");
	}

	async stop(): Promise<void> {
		this.doubao?.stop();
		if (this.local) await this.local.stop();
		stopSapi();
	}

	/** 语速/音色变了要重建（length_scale 在构造时定） */
	async reconfigure(next: Partial<TtsSettings>): Promise<void> {
		Object.assign(this.settings, next);
		this.probeCache = null;
		if (this.local) {
			await this.local.configure({ sid: this.settings.sid, speed: this.settings.speed });
		}
	}

	/** 装完模型后强制刷新探测缓存 */
	invalidate(): void {
		this.probeCache = null;
	}

	close(): void {
		this.doubao?.close();
		this.doubao = null;
		if (this.local) this.local.close();
		this.local = null;
		stopSapi();
	}

	/** 给下载器用：要一个"即使没模型也能起"的 worker 客户端 */
	async rawClient(): Promise<LocalTtsClient> {
		if (this.local) return this.local;
		const py = pythonCandidates()[0] || "python";
		this.local = new LocalTtsClient({
			python: py,
			modelsDir: this.dir,
			sid: this.settings.sid,
			speed: this.settings.speed,
			model: this.settings.model,
		});
		return this.local;
	}

	/** 模型是否已装（按目录名判断） */
	isInstalled(id: string): boolean {
		return existsSync(join(this.dir, id, "model.onnx"));
	}
}
