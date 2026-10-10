/**
 * 各模块健康度（谁加载失败 / 谁降级）。
 *
 * 为什么单独一个模块：入口把每个 setupXxx 各自 try/catch，坏一块不许带下水；
 * 失败项记在这里，`/ai doctor` 和状态栏都读它。
 */
const parts = new Map<string, string>(); // name -> 错误信息（空串 = 正常）

export function markOk(name: string): void {
	parts.set(name, "");
}

export function markFail(name: string, err: unknown): void {
	parts.set(name, err instanceof Error ? err.message : String(err));
}

/** 有没有失败项 */
export function hasFailure(): boolean {
	return [...parts.values()].some((e) => e);
}

export function failedParts(): { name: string; error: string }[] {
	return [...parts.entries()]
		.filter(([, error]) => error)
		.map(([name, error]) => ({ name, error }));
}

/** 一行摘要：ok / 部分失效: a, b */
export function healthLine(): string {
	const bad = failedParts();
	return bad.length === 0 ? "ok" : `部分失效: ${bad.map((b) => b.name).join(", ")}`;
}

/** doctor 用的多行报告 */
export function healthReport(): string[] {
	const all = [...parts.keys()];
	const bad = failedParts();
	if (all.length === 0) return ["（还没加载任何模块）"];
	if (bad.length === 0) return [`全部模块已加载 ✅（${all.join(" · ")}）`];
	const badNames = new Set(bad.map((b) => b.name));
	const good = all.filter((n) => !badNames.has(n));
	return [
		...bad.map((b) => `❌ ${b.name}: ${b.error}`),
		...(good.length ? [`✅ ${good.join(" · ")}`] : []),
	];
}
