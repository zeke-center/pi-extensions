/**
 * RpcChannel · 子助理的「双向」通信层
 *
 * 为什么需要它：
 *   以前子进程用 `pi -p --mode json` —— 写完 prompt 就 `stdin.end()`，之后**单向**。
 *   于是到点只能 SIGKILL，助理已经想到的结论全丢（`partial` 上限只有 2000 字符）。
 *   换成 `pi --mode rpc` 后 stdin 保持打开，才可能在到点前发 steering 催它交卡。
 *
 * 协议（见 pi 的 docs/rpc.md）：
 *   stdin  → 命令            prompt / steer / abort_bash / extension_ui_response ...
 *   stdout → 三类记录
 *              response                命令回执（带 id / success / data）
 *              <session event>         与 `--mode json` **完全同形状**（平铺，不包一层）
 *              extension_ui_request    扩展要弹框（dialog 必须应答，否则子进程永久挂住）
 *
 * 这一层刻意只做三件事：发命令、按 LF 切行、按类型分发。
 * 事件对象**原样透传**给 delegate 现有的 handleLine —— 两种模式形状一致，解析代码不用改。
 */
import type { ChildProcess } from "node:child_process";

/** 协议里的一条记录（命令或事件）。只用得到 type，其余字段原样带过。 */
export type RpcRecord = Record<string, unknown> & { type: string };
export type RpcHandler = (rec: RpcRecord) => void;

/** 需要应答的 dialog 方法。不含 notify / setStatus / setWidget / setTitle 等"放完就走"的。 */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** 这条 extension_ui_request 是不是"不答就卡住"的 dialog？ */
export function isDialogRequest(rec: RpcRecord): boolean {
	return rec.type === "extension_ui_request" && typeof rec.method === "string" && DIALOG_METHODS.has(rec.method);
}

/** 单行缓冲上限：防某条超长行（比如一个巨大的 JSON）把内存撑爆 */
const MAX_LINE_BUF = 4_000_000;

export class RpcChannel {
	/** 自增 id 序号。协议里 id 是可选的，但带上更好排查。 */
	private seq = 0;
	/** stdout 行缓冲 */
	private buf = "";
	/** stdin 是否已关（关了就再也发不出命令） */
	private closed = false;
	/** 收到过几条 response —— 「RPC 到底通不通」的探测依据（见 delegate 的降级逻辑） */
	private responses = 0;

	private eventFns: RpcHandler[] = [];
	private responseFns: RpcHandler[] = [];
	private uiFns: RpcHandler[] = [];

	constructor(private readonly child: ChildProcess) {
		child.stdout?.on("data", (d: Buffer) => this.feed(d.toString("utf8")));
	}

	/** 发一条命令。返回 false = 写不进去（管道关了 / 出错）。 */
	send(cmd: RpcRecord): boolean {
		if (this.closed) return false;
		const rec = cmd.id === undefined ? { ...cmd, id: `c${++this.seq}` } : cmd;
		try {
			// write 返回 false = 缓冲满了。我们的命令都很小（几百字节），
			// 且 Node 会自己排队，这里不必等 drain。
			return this.child.stdin?.write(`${JSON.stringify(rec)}\n`, "utf8") ?? false;
		} catch {
			return false;
		}
	}

	/**
	 * 有序关闭：关掉 stdin 就是请 pi 收工（见 docs/rpc.md 的 Shutdown）。
	 * pi 会先销毁运行时再退出；关不掉不要紧，到点照样 killTree。
	 */
	closeStdin(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.child.stdin?.end();
		} catch {
			/* 已经关了 / 管道坏了 —— 无所谓 */
		}
	}

	get responseCount(): number {
		return this.responses;
	}
	get isClosed(): boolean {
		return this.closed;
	}

	/** 订阅 session 事件（message_update / tool_execution_* / agent_settled …） */
	onEvent(fn: RpcHandler): this {
		this.eventFns.push(fn);
		return this;
	}
	/** 订阅命令回执 */
	onResponse(fn: RpcHandler): this {
		this.responseFns.push(fn);
		return this;
	}
	/** 订阅扩展 UI 请求（dialog 必须应答） */
	onUi(fn: RpcHandler): this {
		this.uiFns.push(fn);
		return this;
	}

	// ---------- 内部：切行 + 分发 ----------

	private feed(chunk: string): void {
		this.buf += chunk;
		let i: number;
		// ⚠️ 严格只按 LF 切。U+2028 / U+2029 在 JSON 字符串里是合法内容，
		//    用 readline 那种"通用换行"会把一条记录劈成两半。
		while ((i = this.buf.indexOf("\n")) >= 0) {
			let line = this.buf.slice(0, i);
			this.buf = this.buf.slice(i + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1); // 容忍 CRLF
			line = line.trim();
			if (line) this.dispatch(line);
		}
		// 单条超长且一直没有 LF → 丢掉，避免无限增长
		if (this.buf.length > MAX_LINE_BUF) this.buf = "";
	}

	private dispatch(line: string): void {
		if (line.charCodeAt(0) !== 123 /* { */) return; // 不是 JSON 对象（诊断信息应该走 stderr）
		let rec: RpcRecord;
		try {
			rec = JSON.parse(line) as RpcRecord;
		} catch {
			return;
		}
		if (!rec || typeof rec !== "object" || typeof rec.type !== "string") return;

		if (rec.type === "response") {
			this.responses++;
			for (const fn of this.responseFns) fn(rec);
			return;
		}
		if (rec.type === "extension_ui_request") {
			for (const fn of this.uiFns) fn(rec);
			return;
		}
		// 其余全是 session 事件：形状与 --mode json 一模一样，直接透传
		for (const fn of this.eventFns) fn(rec);
	}
}

/**
 * dialog 一律拒绝。
 *
 * 打印模式（-p）下我们是非交互的，本来也弹不出框；RPC 下如果**不答**，
 * pi 会一直 blocking 等 response → 子助理就永久挂在那里。所以必须答，
 * 语义对齐"非交互 = 拒绝/取消"。
 * notify / setStatus / setWidget / setTitle 这类不需要应答，直接忽略。
 */
export function rejectDialog(ch: RpcChannel, rec: RpcRecord): void {
	if (!isDialogRequest(rec)) return;
	ch.send({ type: "extension_ui_response", id: rec.id, cancelled: true });
}
