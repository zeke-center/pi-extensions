/**
 * speaker.ts —— 唯一播报出口（队列 / 抢占 / 过期 / 打断 / 落盘）
 *
 * 为什么必须是"唯一出口"：
 *   · 语音是**单通道**。多个来源各播各的 = 叠音、抢话、顺序乱（旧实现就是每张卡片一个进程）。
 *   · 豆包那种体感来自三件事：**短句 + 抢占 + 可打断**，都在这一层实现。
 *
 * 抢占规则（只有两条，别用"优先级大就打断"）：
 *   1. 新来者显式 interrupt（报错/取消这类必须立刻说）
 *   2. 正在播的是 progress 占位，而新来者更重要（占位本来就该被替换）
 *   —— 结论和提问**不互相打断**，否则你会听到"报告被腰斩"。
 *
 * 落盘：<agentDir>/narration/YYYY-MM-DD.jsonl（一行一个事件，含 latency/duration/engine）
 *       跨端回听、审计、"它到底说了什么"都靠它；**不进模型上下文**。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Utterance } from "./speech";
import type { TtsRouter } from "./tts/index";

export interface SpeakerOpts {
	agentDir: string;
	router: TtsRouter;
	enabled: () => boolean;
	log?: (msg: string) => void;
}

interface Queued extends Utterance {
	seq: number;
	enqueuedAt: number;
	startedAt?: number;
	endedAt?: number;
	engine?: string;
	firstMs?: number;
	status: "queued" | "playing" | "done" | "expired" | "preempted" | "error";
}

export class Speaker {
	private heap: Queued[] = [];
	private seq = 0;
	private running = false;
	private stopped = false;
	private current: Queued | null = null;
	private preempt = false;

	constructor(private opts: SpeakerOpts) {}

	private narrationFile(): string {
		const d = new Date();
		const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		const dir = join(this.opts.agentDir, "narration");
		mkdirSync(dir, { recursive: true });
		return join(dir, `${day}.jsonl`);
	}

	private log(rec: Record<string, unknown>): void {
		try {
			appendFileSync(this.narrationFile(), JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", "utf8");
		} catch {
			/* 落盘失败不影响播报 */
		}
	}

	/** 投递一条播报（非阻塞） */
	say(u: Utterance): void {
		if (!this.opts.enabled()) return;
		const q: Queued = { ...u, seq: ++this.seq, enqueuedAt: Date.now(), status: "queued" };
		this.heap.push(q);
		this.heap.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
		this.log({ event: "enqueue", kind: q.kind, prio: q.prio, text: q.text, ref: q.ref });

		// 抢占判定
		const cur = this.current;
		if (cur && cur.status === "playing") {
			const can =
				Boolean(q.interrupt) ||
				(cur.kind === "progress" && q.prio > cur.prio) ||
				// 阶段播报是"实时进展"，新的直接顶掉旧的（不然会排队积压、说完就过时了）
				(cur.kind === "step" && q.kind === "step");
			if (can) {
				this.preempt = true;
				void this.opts.router.stop().catch(() => {});
			}
		}
		void this.pump();
	}

	private expired(q: Queued): boolean {
		return q.ttl !== undefined && (Date.now() - q.enqueuedAt) / 1000 > q.ttl;
	}

	private async pump(): Promise<void> {
		if (this.running || this.stopped) return;
		this.running = true;
		try {
			while (!this.stopped) {
				if (this.preempt && this.current) this.preempt = false;
				// 取最高优先级里没过期的
				let next: Queued | undefined;
				while (this.heap.length) {
					const cand = this.heap.shift()!;
					if (this.expired(cand)) {
						cand.status = "expired";
						this.log({ event: "expired", kind: cand.kind, text: cand.text, ref: cand.ref });
						continue;
					}
					next = cand;
					break;
				}
				if (!next) break;

				next.status = "playing";
				next.startedAt = Date.now();
				this.current = next;
				const latency = next.startedAt - next.enqueuedAt;
				this.log({
					event: "playing",
					kind: next.kind,
					prio: next.prio,
					text: next.text,
					ref: next.ref,
					latency_ms: latency,
				});
				try {
					const r = await this.opts.router.say(next.text, (ms) => {
						next.firstMs = ms;
					}, { tone: next.tone });
					next.engine = r.engine;
					next.firstMs = r.firstMs;
					next.status = this.preempt ? "preempted" : "done";
				} catch (e) {
					next.status = "error";
					this.opts.log?.(`播报失败：${e instanceof Error ? e.message : String(e)}`);
				}
				next.endedAt = Date.now();
				this.log({
					event: next.status,
					kind: next.kind,
					text: next.text,
					ref: next.ref,
					engine: next.engine,
					first_ms: next.firstMs,
					duration_ms: (next.endedAt ?? 0) - (next.startedAt ?? 0),
					latency_ms: (next.startedAt ?? 0) - next.enqueuedAt,
				});
				this.current = null;
			}
		} finally {
			this.running = false;
		}
	}

	/** 立刻闭嘴（人插话 / 切换会话 / 插件停用） */
	async stopAll(): Promise<void> {
		this.heap = [];
		if (this.current) {
			this.current.status = "preempted";
			this.log({ event: "preempted", kind: this.current.kind, text: this.current.text, reason: "stopAll" });
			this.current = null;
		}
		this.preempt = false;
		await this.opts.router.stop().catch(() => {});
	}

	close(): void {
		this.stopped = true;
		this.heap = [];
		this.current = null;
	}
}
