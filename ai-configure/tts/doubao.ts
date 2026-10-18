/**
 * tts/doubao.ts —— 豆包（火山引擎）在线语音合成引擎
 *
 * 定位：**更好的"嘴"**。只负责"文本 → 声音"，不做任何语义判断
 * （该说什么由 speech.ts / speaker.ts 决定；换引擎不动那一层）。
 *
 * 端点（已验证存在）：POST https://openspeech.bytedance.com/api/v1/tts
 *   鉴权：appid + token 放在**请求体**里（不是 header）
 *   无效凭据会返回：HTTP 401 {"code":3001,"message":"load grant: requested grant not found in SaaS storage"}
 *
 * 音频格式：这里要 **pcm**（裸 s16le），自己包一层 WAV 头就能用
 * Windows 自带的 SoundPlayer 播 —— 不需要 ffmpeg（本机没装），也不需要第三方库。
 *
 * 凭据从哪来（二选一，环境变量优先）：
 *   DOUBAO_TTS_APPID / DOUBAO_TTS_TOKEN / DOUBAO_TTS_CLUSTER / DOUBAO_TTS_VOICE
 *   或 ai-extensions.json 里的 voiceDoubaoAppId / voiceDoubaoToken / ...
 *
 * 一切失败都抛给调用方（TtsRouter 会自动回退本地引擎），绝不吞掉主流程。
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DoubaoConfig {
	appId: string;
	token: string;
	/** 控制台里应用对应的 cluster，语音合成大模型通常是 volcano_tts */
	cluster: string;
	/** 音色 ID（控制台「音色列表」里试听后复制，如 BV001_streaming） */
	voice: string;
	/** 采样率：24000 足够，越小越快 */
	rate: number;
	/** 语速 0.5~2.0 */
	speed: number;
	/** 情感/语气（部分音色支持，留空用默认） */
	emotion?: string;
	timeoutMs: number;
}

export function doubaoConfigFromEnv(over: Partial<DoubaoConfig> = {}): DoubaoConfig | null {
	const pick = (k: string, d?: string) => process.env[k] ?? d ?? "";
	const appId = pick("DOUBAO_TTS_APPID", over.appId);
	const token = pick("DOUBAO_TTS_TOKEN", over.token);
	if (!appId || !token) return null;
	return {
		appId,
		token,
		cluster: pick("DOUBAO_TTS_CLUSTER", over.cluster) || "volcano_tts",
		voice: pick("DOUBAO_TTS_VOICE", over.voice) || "BV001_streaming",
		rate: over.rate ?? 24000,
		speed: over.speed ?? 1.0,
		emotion: over.emotion,
		timeoutMs: over.timeoutMs ?? 15000,
	};
}

/** 裸 PCM(s16le/mono) 包成 WAV，交给系统播放器（省掉 ffmpeg 依赖） */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
	const head = Buffer.alloc(44);
	head.write("RIFF", 0, "ascii");
	head.writeUInt32LE(36 + pcm.length, 4);
	head.write("WAVE", 8, "ascii");
	head.write("fmt ", 12, "ascii");
	head.writeUInt32LE(16, 16); // fmt chunk size
	head.writeUInt16LE(1, 20); // PCM
	head.writeUInt16LE(1, 22); // mono
	head.writeUInt32LE(sampleRate, 24);
	head.writeUInt32LE(sampleRate * 2, 28); // byte rate
	head.writeUInt16LE(2, 32); // block align
	head.writeUInt16LE(16, 34); // bits
	head.write("data", 36, "ascii");
	head.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([head, pcm]);
}

export class DoubaoClient {
	private playing: ChildProcess | null = null;
	private cacheDir: string;
	readonly lastError: string | null = null;

	constructor(private cfg: DoubaoConfig) {
		this.cacheDir = join(tmpdir(), "pi-tts-doubao");
		try {
			mkdirSync(this.cacheDir, { recursive: true });
		} catch {
			/* 目录建不出来也不影响后面报错 */
		}
	}

	/** 合成一句 → 返回 wav 路径（不播放） */
	async synth(text: string): Promise<string> {
		const reqid = randomUUID();
		const body = {
			app: { appid: this.cfg.appId, token: this.cfg.token, cluster: this.cfg.cluster },
			user: { uid: "pi" },
			audio: {
				voice_type: this.cfg.voice,
				encoding: "pcm",
				rate: this.cfg.rate,
				speed_ratio: this.cfg.speed,
				...(this.cfg.emotion ? { emotion: this.cfg.emotion } : {}),
			},
			request: { reqid, text, text_type: "plain", operation: "query", with_frontend: 1 },
		};

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
		timer.unref?.();
		let resp: Response;
		try {
			resp = await fetch("https://openspeech.bytedance.com/api/v1/tts", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer; " },
				body: JSON.stringify(body),
				signal: ac.signal,
			});
		} finally {
			clearTimeout(timer);
		}

		const raw = await resp.text();
		let json: { code?: number; message?: string; data?: string } = {};
		try {
			json = JSON.parse(raw);
		} catch {
			throw new Error(`豆包返回不是 JSON（HTTP ${resp.status}）`);
		}
		if (!resp.ok || (json.code !== undefined && json.code !== 3000) || !json.data) {
			throw new Error(`豆包合成失败 HTTP ${resp.status} code=${json.code ?? "?"} ${json.message ?? ""}`.trim());
		}
		const pcm = Buffer.from(json.data, "base64");
		if (pcm.length < 1000) throw new Error("豆包返回音频为空");
		const file = join(this.cacheDir, `${reqid}.wav`);
		writeFileSync(file, pcmToWav(pcm, this.cfg.rate));
		return file;
	}

	/** 播放（异步、可打断）：Windows 用 PowerShell SoundPlayer，其它平台用系统播放器 */
	private play(file: string): void {
		if (process.platform === "win32") {
			const ps = spawn(
				"powershell",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`$p=New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}'; $p.PlaySync()`,
				],
				{ windowsHide: true, stdio: "ignore" },
			);
			this.playing = ps;
			ps.on("exit", () => {
				if (this.playing === ps) this.playing = null;
			});
			return;
		}
		const cmd = process.platform === "darwin" ? ["afplay", file] : ["aplay", "-q", file];
		const ps = spawn(cmd[0], cmd.slice(1), { stdio: "ignore" });
		this.playing = ps;
		ps.on("exit", () => {
			if (this.playing === ps) this.playing = null;
		});
	}

	/** 说一句：合成 → 播放 → 等播完（可被 stop 打断） */
	async say(text: string, opts?: { onFirst?: (ms: number) => void }): Promise<{ firstMs: number; dur: number }> {
		const t0 = Date.now();
		const file = await this.synth(text);
		const firstMs = Date.now() - t0;
		opts?.onFirst?.(firstMs);
		this.stop();
		this.play(file);
		const child = this.playing;
		if (child) {
			await new Promise<void>((resolve) => {
				const done = () => resolve();
				child.once("exit", done);
				// 兜底：子进程不退出也要放行（防止队列卡死）
				const t = setTimeout(done, 180_000);
				t.unref?.();
			});
		}
		return { firstMs, dur: (Date.now() - t0 - firstMs) / 1000 };
	}

	stop(): void {
		const p = this.playing;
		this.playing = null;
		if (!p) return;
		try {
			p.kill();
		} catch {
			/* 忽略：可能已经结束 */
		}
	}

	close(): void {
		this.stop();
	}
}
