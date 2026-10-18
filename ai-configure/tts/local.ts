/**
 * tts/local.ts —— 本地离线 TTS 引擎的 node 侧客户端（驱动 runtime/tts_worker.py）
 *
 * 为什么是"常驻子进程 + 行协议"：
 *   · sherpa-onnx 只有 Python 绑定，node 侧没有可靠等价物；
 *   · 模型加载要 2.4s，每句话起一个进程 = 每句等 2.4s，必须常驻；
 *   · 行协议（一行一个 JSON）比 RPC/HTTP 简单，崩溃了重拉即可。
 *
 * 三条设计底线：
 *   1. **绝不阻塞 TUI**：全部 async spawn / 事件驱动，禁用 execFileSync。
 *   2. **拿不到就降级**：没 python / 没 sherpa_onnx / 没模型 → 返回 available=false，调用方回退 SAPI。
 *   3. **不能泄漏进程**：空闲 15 分钟自动退出；插件停用/退出时 close()。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IDLE_MS = 15 * 60 * 1000; // 空闲这么久就把 worker 关掉，释放 ~400MB
const REQ_TIMEOUT_MS = 120_000; // 单次合成（长句 + 首次加载模型）上限
const MAX_RESTART = 3;

export interface LocalInfo {
	engine: string;
	model: string | null;
	kind: string | null;
	sampleRate: number | null;
	sid: number;
	speed: number;
	modelsDir: string;
}

export interface SayResult {
	firstMs: number;
	dur: number;
	interrupted?: boolean;
}

/** 插件目录（本文件在 <ext>/tts/ 下） */
export function extRoot(): string {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function workerPath(): string {
	// 允许覆盖：打包成单文件（测试/工具）时 import.meta.url 会变，靠这个指回真实路径
	const env = process.env.PI_TTS_WORKER;
	if (env && existsSync(env)) return env;
	return join(extRoot(), "runtime", "tts_worker.py");
}

/** 模型目录：优先 <agentDir>/models/tts，允许环境变量覆盖 */
export function modelsDir(agentDir: string): string {
	return process.env.PI_TTS_MODELS_DIR || join(agentDir, "models", "tts");
}

/** python 候选：环境变量 > py launcher > python > python3 */
export function pythonCandidates(): string[] {
	const out: string[] = [];
	if (process.env.PI_TTS_PYTHON) out.push(process.env.PI_TTS_PYTHON);
	if (process.platform === "win32") out.push("py", "python", "python3");
	else out.push("python3", "python");
	return [...new Set(out)];
}

/** 已安装的模型目录（含 model.onnx 的子目录） */
export function installedModels(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((n) => !n.startsWith("."))
			.map((n) => join(dir, n))
			.filter((p) => {
				try {
					return statSync(p).isDirectory() && existsSync(join(p, "model.onnx"));
				} catch {
					return false;
				}
			});
	} catch {
		return [];
	}
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class LocalTtsClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private pending = new Map<number, Pending>();
	private doneWaiters = new Map<number, (msg: any) => void>();
	private seq = 1;
	private buf = "";
	private restarts = 0;
	private idleTimer: NodeJS.Timeout | null = null;
	private starting: Promise<LocalInfo> | null = null;
	private lastError: string | null = null;

	constructor(
		private opts: {
			python: string;
			modelsDir: string;
			sid: number;
			speed: number;
			/** 指定模型目录名；不传 = 用第一个已安装的 */
			model?: string;
		},
	) {}

	/** worker 是否活着（不尝试启动） */
	get alive(): boolean {
		return this.child !== null && this.child.exitCode === null;
	}

	get error(): string | null {
		return this.lastError;
	}

	/** 探测：模型在 + worker 能起来并 ping 通 */
	async probe(): Promise<LocalInfo | null> {
		try {
			return await this.ensure();
		} catch (e) {
			this.lastError = e instanceof Error ? e.message : String(e); // 面板要能显示"为什么不可用"
			return null;
		}
	}

	async ensure(allowNoModel = false): Promise<LocalInfo> {
		if (this.alive) return (await this.requestWithId({ cmd: "ping" }, 15_000)).msg;
		if (this.starting) return await this.starting;
		this.starting = this.start(allowNoModel).finally(() => {
			this.starting = null;
		});
		return await this.starting;
	}

	private async start(allowNoModel = false): Promise<LocalInfo> {
		const wp = workerPath();
		if (!existsSync(wp)) throw new Error(`worker 不存在：${wp}`);
		if (!allowNoModel && installedModels(this.opts.modelsDir).length === 0) {
			throw new Error(`没有已安装的模型（${this.opts.modelsDir}）`);
		}
		const env = {
			...process.env,
			PI_TTS_MODELS_DIR: this.opts.modelsDir,
			PI_TTS_SID: String(this.opts.sid),
			PI_TTS_SPEED: String(this.opts.speed),
			PYTHONIOENCODING: "utf-8",
			PYTHONUNBUFFERED: "1",
		};
		const child = spawn(this.opts.python, [wp], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		this.buf = "";

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			// sherpa-onnx 会往 stderr 打 OOV 之类的提示，不当错误，但记最后一条便于排查
			const line = String(chunk).trim().split("\n").pop();
			if (line) this.lastError = line.slice(0, 300);
		});
		child.on("exit", (code) => {
			this.child = null;
			this.failAll(new Error(`worker 退出（code=${code}）`));
			// 崩溃自愈：只在"正在用"的时候重启，且不超过上限
			if (this.restarts < MAX_RESTART) {
				this.restarts += 1;
			}
		});

		// 等 ready（worker 一起来就会打一行 {"event":"ready"}）
		await this.waitReady(20_000);
		this.touchIdle();
		return (await this.requestWithId({ cmd: "ping" }, 20_000)).msg;
	}

	private waitReady(timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const t0 = Date.now();
			const tick = setInterval(() => {
				if (this.alive) {
					clearInterval(tick);
					resolve();
				} else if (Date.now() - t0 > timeoutMs) {
					clearInterval(tick);
					reject(new Error("worker 启动超时"));
				}
			}, 100);
		});
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		let idx: number;
		while ((idx = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, idx).trim();
			this.buf = this.buf.slice(idx + 1);
			if (!line) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // 非协议输出（模型日志）直接忽略
			}
			if (msg.event) continue; // ready/progress 之类的事件
			const id = typeof msg.id === "number" ? msg.id : undefined;
			if (id !== undefined && msg.done) {
				const w = this.doneWaiters.get(id);
				if (w) {
					this.doneWaiters.delete(id);
					w(msg);
					return;
				}
			}
			if (id !== undefined && this.pending.has(id)) {
				const p = this.pending.get(id)!;
				this.pending.delete(id);
				clearTimeout(p.timer);
				p.resolve(msg);
			}
		}
	}

	private requestWithId(payload: Record<string, unknown>, timeoutMs = REQ_TIMEOUT_MS): Promise<{ id: number; msg: any }> {
		const child = this.child;
		if (!child || child.exitCode !== null) return Promise.reject(new Error("worker 未运行"));
		const id = this.seq++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`请求超时（${payload.cmd}）`));
			}, timeoutMs);
			this.pending.set(id, { resolve: (m: any) => resolve({ id, msg: m }), reject, timer });
			try {
				child.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
			} catch (e) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	private failAll(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}

	private touchIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
		this.idleTimer.unref?.();
	}

	/** 播一句话（worker 内部按句切分，首句最快出声） */
	async say(
		text: string,
		opts?: {
			sid?: number;
			speed?: number;
			model?: string;
			onFirst?: (firstMs: number) => void;
			/** 有它就绕开本地模型，直接用豆包在线合成 */
			cloud?: { key: string; speaker: string; sampleRate?: number; resourceId?: string; speechRate?: number };
		},
	): Promise<SayResult> {
		await this.ensure(Boolean(opts?.cloud)); // 云端播报不需要本地模型
		this.touchIdle();
		const { id, msg } = await this.requestWithId({
			cmd: "say",
			text,
			sid: opts?.sid ?? this.opts.sid,
			speed: opts?.speed ?? this.opts.speed,
			model: opts?.model ?? this.opts.model,
			...(opts?.cloud ? { cloud: opts.cloud } : {}),
		});
		if (!msg?.ok) throw new Error(msg?.error || "合成失败");
		const firstMs = Number(msg.first_ms ?? 0);
		opts?.onFirst?.(firstMs);
		// 等 worker 报 done（全部句子播完），队列才知道什么时候能播下一条
		const total = await new Promise<number>((resolve) => {
			this.doneWaiters.set(id, (m: any) => resolve(Number(m?.dur ?? 0)));
			// 兜底：万一 done 丢了，按首句时长 + 30s 超时释放
			const t = setTimeout(() => {
				if (this.doneWaiters.delete(id)) resolve(Number(msg.dur ?? 0));
			}, 180_000); // 长稿子（>30s 音频）也要能等到 done
			t.unref?.();
		});
		return { firstMs, dur: total || Number(msg.dur ?? 0) };
	}

	/** 打断当前播报（毫秒级：worker 侧 SND_PURGE） */
	async stop(): Promise<void> {
		if (!this.alive) return;
		try {
			await this.requestWithId({ cmd: "stop" }, 5000);
		} catch {
			/* 停不下来也要吞掉：不打断上层流程 */
		}
	}

	/** 让 worker 解压并校验内容哈希（下载在 node 侧做，解压在 python 侧做） */
	async extract(req: { src: string; dst: string; sha256?: string }): Promise<{ dir: string }> {
		await this.ensure(true); // 允许"还没装模型"时也能解压
		const { msg } = await this.requestWithId({ cmd: "extract", ...req }, 600_000);
		if (!msg?.ok) throw new Error(msg?.error || "解压失败");
		return { dir: String(msg.dir) };
	}

	async configure(cfg: { sid?: number; speed?: number }): Promise<void> {
		if (!this.alive) return;
		await this.requestWithId({ cmd: "config", ...cfg }, 10_000);
		if (cfg.sid !== undefined) this.opts.sid = cfg.sid;
		if (cfg.speed !== undefined) this.opts.speed = cfg.speed;
	}

	close(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		const child = this.child;
		this.child = null;
		if (!child) return;
		try {
			child.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			try {
				if (child.exitCode === null) child.kill();
			} catch {
				/* ignore */
			}
		}, 500).unref?.();
		this.failAll(new Error("worker 已关闭"));
	}
}
