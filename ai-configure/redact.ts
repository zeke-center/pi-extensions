/**
 * 脱敏（密码 / token / key）—— **单独一个文件，零依赖**。
 *
 * ⚠️ 为什么独立：日志（log.ts）、自检报告（diagnose.ts）、守卫（perm-guard.ts）都要用，
 *    但 diagnose → delegate → log，如果脱敏住在 diagnose 里就会形成循环 import。
 *
 * 原则：**键名保留，值打码** —— 读的人得知道「配了哪一项」，但拿不到值。
 */
/** 打码：URL 里的密码 + 常见的 key/token/secret 字段 */
export function redactSecrets(input: string): string {
	let s = String(input ?? "");
	s = s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@]+)(@)/gi, "$1***$3");
	s = s.replace(
		/(["']?[A-Za-z0-9_.-]*(?:token|secret|passwd|password|api[-_]?key|apikey|dsn|database_url|auth)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
		"$1***",
	);
	// 命令行参数：--password 123456 / --token abc（空格分隔，不是 = 也不是 :）
	s = s.replace(
		/(--?(?:password|passwd|pwd|token|secret|api[-_]?key|apikey|auth|dsn)[=\s]+)("[^"]*"|'[^']*'|\S+)/gi,
		"$1***",
	);
	return s;
}

/**
 * 命令行参数数组打码：`["--password", "123456"` 这种**值在下一项**的写法，逐个元素过正则抓不到，
 * 必须按「flag 后面那一项」处理。
 */
export function redactArgList(args: string[]): string[] {
	const SECRET_FLAG = /^--?(password|passwd|pwd|token|secret|api-?key|apikey|auth|dsn|key)$/i;
	const out = [...args];
	for (let i = 0; i < out.length; i++) {
		if (SECRET_FLAG.test(out[i])) {
			if (i + 1 < out.length) out[i + 1] = "***";
			continue;
		}
		if (/^--?(password|passwd|pwd|token|secret|api-?key|apikey|auth|dsn|key)=/i.test(out[i])) {
			out[i] = out[i].replace(/=.*$/, "=***");
			continue;
		}
		out[i] = redactSecrets(out[i]);
	}
	return out;
}

/** JSON 递归打码（键名敏感 → 整个值变 ***） */
/**
 * 这个**键名**是不是敏感（值要打码）。
 *
 * ⚠️ 别只认 `apikey`/`api_key`：v2.9.1 的报告里 `telemetryKey` 就是明文漏出去的
 *    （用户机器上实拍）。凡是 key/token/secret/passw/auth/dsn/credential 沾边的一律打码，
 *    宁可多打（键名还在，读的人仍知道「配了哪一项」）。
 */
export function isSensitiveKey(k: string): boolean {
	return /(^|[_\-. ])(key|keys|token|secret|passw(or)?d|auth|auth(orization)?|credential|credentials|dsn|database_url|conn(ection)?_?str(ing)?)$|key$|token$|secret$|passwd|password|apikey|api_key|private|signature|salt|hash/i.test(
		k,
	);
}

export function redactDeep(v: unknown): unknown {
	if (typeof v === "string") return redactSecrets(v);
	if (Array.isArray(v)) return v.map(redactDeep);
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			out[k] = isSensitiveKey(k) ? "***" : redactDeep(val);
		}
		return out;
	}
	return v;
}
