/**
 * telegram-md.ts —— 把 pi 的 Markdown 转成 **Telegram 能渲染的 HTML**。
 *
 * 为什么需要它：
 *   pi 的回复是 Markdown（`**粗体**`、`` `代码` ``、表格、`# 标题`…）。直接用**纯文本**发到
 *   Telegram，用户看到的就是一堆星号、井号、竖线 —— 手机上很难看。Telegram 支持两种
 *   parse_mode：`HTML` 和 `MarkdownV2`。**选 HTML**：MarkdownV2 的转义规则极其苛刻
 *   （`_*[]()~>#+-=|{}.!` 一堆字符都要转义，漏一个整条消息就 400 发不出去），
 *   HTML 只要转 `& < >` 三个字符。
 *
 * 表格怎么办（这条很重要）：
 *   Telegram **不支持表格**。塞进 `<pre>` 里靠等宽对齐在手机上会横向溢出/疯狂折行，更难看。
 *   所以这里把表格**改成逐行列表**：`• 第一列 — 其余列用 · 连起来`。手机上读起来最舒服。
 *
 * 为什么先切分再转换（而不是先转换再切分）：
 *   Telegram 单条消息 4096 字符。如果先把 HTML 切两半，切断处可能出现**不成对的标签**
 *   （`<b>` 在一半、`</b>` 在另一半）→ Telegram 直接 400，整条消息发不出去。
 *   所以在 **Markdown 源文本**上按行切、且**不切在代码块中间**，然后每段各自转换。
 */

/** HTML 只需要转这三个字符（Telegram 官方要求） */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 行内元素：粗体 / 斜体 / 删除线 / 行内代码 / 链接 */
function inline(s: string): string {
	let t = esc(s);

	// 先把行内代码整段抽走，否则代码里的 `**` `_` 会被下面的规则误伤
	const codes: string[] = [];
	t = t.replace(/`([^`\n]+)`/g, (_m, c: string) => {
		codes.push(c);
		return `\u0000${codes.length - 1}\u0000`;
	});

	t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
	t = t.replace(/__([^_\n]+)__/g, "<b>$1</b>");
	t = t.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
	// 单个 * 当斜体。
	// ⚠️ 两个坑都踩过：① 后面跟中文标点（、。，）时要认得出来，所以「尾随字符集」得含中日韩标点；
	//    ② 别把「5 * 3」这种乘法误判，所以要求内容首尾都非空白。
	t = t.replace(
		/(^|[\s（(【「])\*(?!\s)([^*\n]*?[^\s*])\*(?=[\s）)】」。，、；：！？,.;:!?]|$)/g,
		"$1<i>$2</i>",
	);
	// 链接；Telegram 只允许 http/https/tg 协议，其它一律当普通文字（避免 <a href="javascript:">）
	t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, txt: string, url: string) => {
		return `<a href="${url}">${txt}</a>`;
	});

	return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)] ?? ""}</code>`);
}

/** 一行的「是不是表格行」：至少两个竖线 */
const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
/** 表格的分隔行：|---|---| */
const isTableSep = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
const cellsOf = (l: string) =>
	l
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((c) => c.trim());

/** 表格 → 逐行列表（Telegram 没有表格，这是手机上最可读的形态） */
function tableToLines(rows: string[][]): string[] {
	const head = rows[0] ?? [];
	return rows.slice(1).map((r) => {
		const first = r[0] ?? "";
		const rest = r
			.slice(1)
			.map((v, i) => {
				const k = head[i + 1];
				// 有表头就把列名带上（用全角冒号隔开，手机上比空格清楚）
				return k ? `${k}：${v}` : v;
			})
			.filter((v) => v && v !== (head[0] ?? ""));
		// 值全空（比如 ✅/— 之类的占位）时只留第一列
		const tail = rest.filter((v) => v && !/^[^：]*[：:]\s*[\s—–-]*$/.test(v));
		// ⚠️ 不要再套一层 <b>：单元格自己可能已经写了 `**xx**`（那就已经是 <b> 了）
		const firstHtml = inline(first);
		const firstOut = /^<b>/.test(firstHtml) ? firstHtml : `<b>${firstHtml}</b>`;
		return tail.length ? `• ${firstOut} — ${inline(tail.join(" · "))}` : `• ${firstOut}`;
	});
}

/** Markdown → Telegram HTML（单条消息内，调用方保证长度不超限） */
export function mdToTelegramHtml(md: string): string {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];

	let fence: string[] | null = null; // 正在收集的代码块内容
	let quote: string[] = []; // 正在收集的引用
	let table: string[][] = []; // 正在收集的表格行

	const flushQuote = () => {
		if (quote.length) {
			out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
			quote = [];
		}
	};
	const flushTable = () => {
		if (table.length) {
			out.push(...tableToLines(table));
			table = [];
		}
	};
	const flushAll = () => {
		flushTable();
		flushQuote();
	};

	for (const line of lines) {
		// ---------- 代码块 ----------
		if (fence) {
			if (/^\s*(```|~~~)/.test(line)) {
				out.push(`<pre>${esc(fence.join("\n"))}</pre>`);
				fence = null;
			} else fence.push(line);
			continue;
		}
		if (/^\s*(```|~~~)/.test(line)) {
			flushAll();
			fence = [];
			continue;
		}

		// ---------- 表格 ----------
		if (isTableRow(line)) {
			if (!isTableSep(line)) table.push(cellsOf(line));
			flushQuote();
			continue;
		}
		flushTable();

		// ---------- 引用 ----------
		const q = /^\s*>\s?(.*)$/.exec(line);
		if (q) {
			table = [];
			quote.push(inline(q[1]));
			continue;
		}
		flushQuote();

		// ---------- 空行 ----------
		if (!line.trim()) {
			out.push("");
			continue;
		}

		// ---------- 标题 → 加粗（Telegram 没有标题）----------
		const h = /^#{1,6}\s+(.*)$/.exec(line);
		if (h) {
			out.push(`<b>${inline(h[1])}</b>`);
			continue;
		}

		// ---------- 分隔线 ----------
		if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
			out.push("────────");
			continue;
		}

		// ---------- 列表 ----------
		const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (li) {
			const indent = "  ".repeat(Math.min(3, Math.floor(li[1].length / 2)));
			const bullet = /^\d/.test(li[2]) ? li[2] : "•";
			out.push(`${indent}${bullet} ${inline(li[3])}`);
			continue;
		}

		out.push(inline(line));
	}

	// 收尾：未闭合的代码块也要发出去（宁可当纯文本，也别把内容吞掉）
	flushTable();
	flushQuote();
	if (fence?.length) out.push(`<pre>${esc(fence.join("\n"))}</pre>`);

	// 压掉连续空行（手机上空白太多像断了）
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * 按行切分（Telegram 单条上限 4096；给 HTML 转义留足余量所以默认 2400）。
 * ⚠️ 不切在**代码块中间** —— 半个围栏会让下一段被当成普通文本，样式就乱了。
 */
export function splitForTelegram(text: string, limit = 2400): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const chunks: string[] = [];
	let cur: string[] = [];
	let len = 0;
	let inFence = false;

	const flush = () => {
		if (cur.length) {
			chunks.push(cur.join("\n"));
			cur = [];
			len = 0;
		}
	};

	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const add = line.length + 1;
		// 正常攒够就发；但正处在代码块里时，宁可超一点也别断
		if (!inFence && len + add > limit) flush();
		if (inFence && len + add > limit * 2) flush(); // 超长代码块兜底：还是得断
		cur.push(line);
		len += add;
	}
	flush();
	return chunks.length ? chunks : [""];
}
