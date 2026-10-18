/**
 * tts/sapi.ts —— 系统语音（Windows System.Speech）引擎
 *
 * 作用：**永远可用的兜底**。没装本地模型、没 python、或者用户就想省事时用它。
 * 与旧实现（notify.ts 里把 SAPI 塞进弹窗进程）的区别：这里是**独立的一次播报**，
 * 跟弹窗解耦，并且能被打断（kill 子进程）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

let current: ChildProcessWithoutNullStreams | null = null;

export function sapiAvailable(): boolean {
	return process.platform === "win32";
}

function b64(s: string): string {
	return Buffer.from(s, "utf8").toString("base64");
}

/**
 * 播一段话（异步；resolve 表示"播完了"或"被打断"）
 * @param opts.voice 系统语音名（如 "Microsoft Huihui Desktop"），空 = 系统默认
 */
export function speakSapi(
	text: string,
	opts: { voice?: string; rate?: number; volume?: number } = {},
): Promise<void> {
	if (!sapiAvailable()) return Promise.resolve();
	stopSapi();
	const rate = Math.max(-10, Math.min(10, Math.round(opts.rate ?? 0)));
	const volume = Math.max(0, Math.min(100, Math.round(opts.volume ?? 100)));
	const ps = [
		"Add-Type -AssemblyName System.Speech",
		"$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
		opts.voice ? `try { $s.SelectVoice('${opts.voice.replace(/'/g, "''")}') } catch { }` : "",
		`$s.Rate = ${rate}`,
		`$s.Volume = ${volume}`,
		`$txt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}'))`,
		"$s.Speak($txt)",
	]
		.filter(Boolean)
		.join("; ");

	const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
		windowsHide: true,
		stdio: ["ignore", "ignore", "pipe"],
	});
	current = child;
	return new Promise<void>((resolve) => {
		const done = () => {
			if (current === child) current = null;
			resolve();
		};
		child.on("close", done);
		child.on("error", done);
	});
}

export function stopSapi(): void {
	const c = current;
	current = null;
	if (!c) return;
	try {
		c.kill();
	} catch {
		/* ignore */
	}
}
