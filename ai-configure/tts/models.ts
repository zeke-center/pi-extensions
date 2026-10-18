/**
 * tts/models.ts —— 模型下载 / 卸载（模型本体不进 git）
 *
 * 分工：
 *   · **node 负责下载**（https + Range 断点续传 + 进度回调）
 *   · **python worker 负责解压与校验**（标准库有 bz2/tarfile，node 侧不用引第三方）
 *
 * 落盘位置：<agentDir>/models/tts/<model-id>/ （即 ~/.pi/agent/models/tts/…）
 * 删除 = 直接删目录，插件本体不受影响，引擎自动回退。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import { extRoot } from "./local";
import type { TtsRouter } from "./index";

export interface ModelEntry {
	id: string;
	label: string;
	engine: string;
	bytes: number;
	sampleRate: number;
	license: string;
	kind: string;
	defaultSid: number;
	sidNote?: string;
	urls: string[];
	content_sha256: string;
	postInstall?: string[];
}

export interface Manifest {
	defaultModel: string;
	models: ModelEntry[];
	requirements?: { python?: string; pipPackages?: string[]; note?: string };
}

export function loadManifest(): Manifest {
	const p = join(extRoot(), "tts", "manifest.json");
	return JSON.parse(readFileSync(p, "utf8")) as Manifest;
}

function dirSize(p: string): number {
	if (!existsSync(p)) return 0;
	let total = 0;
	const walk = (d: string) => {
		for (const e of require("node:fs").readdirSync(d, { withFileTypes: true })) {
			const c = join(d, e.name);
			if (e.isDirectory()) walk(c);
			else total += statSync(c).size;
		}
	};
	walk(p);
	return total;
}

/** 单文件下载：跟随重定向 + Range 续传 + 进度回调 */
function download(url: string, dest: string, total: number, onProgress?: (got: number, total: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const startAt = existsSync(dest) ? statSync(dest).size : 0;
		if (total > 0 && startAt >= total) return resolve(); // 已经下完
		const mod = url.startsWith("https:") ? httpsGet : httpGet;
		const req = mod(
			url,
			{ headers: startAt > 0 ? { Range: `bytes=${startAt}-` } : {} },
			(res) => {
				// 重定向
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();
					const next = new URL(res.headers.location, url).toString();
					download(next, dest, total, onProgress).then(resolve, reject);
					return;
				}
				if (res.statusCode !== 200 && res.statusCode !== 206) {
					res.resume();
					reject(new Error(`下载失败 HTTP ${res.statusCode}`));
					return;
				}
				const append = res.statusCode === 206 && startAt > 0;
				let got = append ? startAt : 0;
				const out = createWriteStream(dest, { flags: append ? "a" : "w" });
				res.on("data", (chunk: Buffer) => {
					got += chunk.length;
					onProgress?.(got, total || Number(res.headers["content-length"] || 0));
				});
				res.pipe(out);
				out.on("finish", () => out.close(() => resolve()));
				out.on("error", reject);
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.setTimeout(60_000, () => req.destroy(new Error("下载超时")));
	});
}

export interface InstallProgress {
	phase: "download" | "unpack" | "done";
	got?: number;
	total?: number;
	pct?: number;
	msg?: string;
}

export async function installModel(
	router: TtsRouter,
	entry: ModelEntry,
	onProgress?: (p: InstallProgress) => void,
): Promise<string> {
	const root = router.dir;
	mkdirSync(root, { recursive: true });
	const dst = join(root, entry.id);
	if (existsSync(join(dst, "model.onnx"))) return dst;

	const part = join(root, `${entry.id}.tar.bz2.part`);
	let lastErr: Error | null = null;
	for (const url of entry.urls) {
		try {
			onProgress?.({ phase: "download", pct: 0, total: entry.bytes });
			await download(url, part, entry.bytes, (got, total) =>
				onProgress?.({ phase: "download", got, total, pct: total ? Math.floor((got / total) * 100) : 0 }),
			);
			lastErr = null;
			break;
		} catch (e) {
			lastErr = e instanceof Error ? e : new Error(String(e));
			onProgress?.({ phase: "download", pct: 0, msg: `镜像失败，换下一个：${lastErr.message}` });
		}
	}
	if (lastErr) throw lastErr;

	onProgress?.({ phase: "unpack" });
	const client = await router.rawClient();
	await client.extract({ src: part, dst, sha256: entry.content_sha256 });
	router.invalidate();
	onProgress?.({ phase: "done", msg: dst });
	return dst;
}

export function uninstallModel(router: TtsRouter, id: string): boolean {
	const dst = join(router.dir, id);
	if (!existsSync(dst)) return false;
	rmSync(dst, { recursive: true, force: true });
	router.invalidate();
	return true;
}

/** 面板用：每个模型的安装状态 */
export function modelStatus(router: TtsRouter) {
	const m = loadManifest();
	return m.models.map((e) => ({
		id: e.id,
		label: e.label,
		bytes: e.bytes,
		license: e.license,
		installed: existsSync(join(router.dir, e.id, "model.onnx")),
		sizeOnDisk: dirSize(join(router.dir, e.id)),
	}));
}
