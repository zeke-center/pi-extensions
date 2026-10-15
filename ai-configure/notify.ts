/**
 * notify.ts —— 给「后台投递」用的反馈：**终端原生通知 + 提示音**。
 *
 * 通道（**系统通知是主力**，终端胶囊只在探测到支持时补充）：
 *   0. **系统通知（默认主力）**：Windows = WinRT toast（就是你看到的那种弹窗），
 *      macOS = osascript，Linux = notify-send。**与终端无关**，CMD / 任何终端 / pi 完全在后台都能看见。
 *      （早期把 OSC 777 当主力是错的：conhost 不认识它，轻则没提示、重则刷乱码。）
 *   1. OSC 777（补充，需探测）：
 *   1. **OSC 777**（主）：写到终端，Warp 会在顶部弹那个小胶囊（「pi: 答完了，等你说话」）——
 *      实测你机器上 Warp 认这个东西；pi 窗口不在前台时 Warp 自己会转成系统通知。
 *      只是往 stdout 写一个控制序列，不用起进程、不用装东西。
 *   2. **Windows toast**（兜底）：非 Warp / 非 TUI 环境用，走 WinRT（实测通过）。
 *   外加可选的系统提示音。
 *
 * ⚠️ 为什么不用 pi 的 ctx.ui.notify：那个只在 TUI 里可见；而本模块的典型场景是
 * **pi 最小化 / 不在前台** —— 你必须能在别的地方看到「你的话已经进去了」。
 *
 * 实现：两个 ASCII-only 的 PowerShell 脚本写到 agentDir，按需 fire-and-forget 起一个进程：
 *   - toast 走 WinRT：`ToastNotificationManager` + `Windows.Data.Xml.Dom.XmlDocument`（实测通过）
 *   - 中文标题/正文用 **base64 传参**，彻底躲开 PowerShell 的编码坑
 *   - 脚本本体必须是纯 ASCII：PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解，中文会直接把脚本搞成语法错误（踩过）
 *
 * 失败一律静默：通知发不出去绝不能影响投递本身。
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** ⚠️ 纯 ASCII（原因见文件头） */
const NOTIFY_PS1 = `
param([int]$Toast = 1, [string]$TitleB64 = '', [string]$BodyB64 = '', [int]$Beep = 0)
$ErrorActionPreference = 'SilentlyContinue'
function Esc([string]$s) {
  return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}
if ($Toast -eq 1) {
  try {
    $title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleB64))
    $body = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BodyB64))
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>" + (Esc $title) + "</text><text>" + (Esc $body) + "</text></binding></visual></toast>")
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Windows PowerShell").Show($toast)
  } catch { }
}
if ($Beep -ge 1) {
  try {
    if ($Beep -eq 2) { [System.Media.SystemSounds]::Exclamation.Play() }
    else { [System.Media.SystemSounds]::Asterisk.Play() }
  } catch { }
}
`;

function scriptPath(): string {
	return join(getAgentDir(), "pi-voice-notify.ps1");
}

function ensureScript(): string | undefined {
	try {
		const f = scriptPath();
		const cur = existsSync(f) ? readFileSync(f, "utf8") : undefined;
		if (cur !== NOTIFY_PS1) {
			mkdirSync(getAgentDir(), { recursive: true });
			// 带 BOM 写：双保险（脚本本身是 ASCII，加了 BOM 就算以后误加中文也不会乱）
			// 双 BOM 会让 PS 解析报错（param 块失效），去重一下
			writeFileSync(f, `\ufeff${NOTIFY_PS1.replace(/^\ufeff/, "")}`, "utf8");
		}
		return f;
	} catch {
		return undefined;
	}
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

function popupScriptPath(): string {
	return join(getAgentDir(), "pi-voice-popup.ps1");
}

/** 把当前剪贴板/终端**外面**的“弹窗”画出来（Windows 专用；其他平台走系统通知） */
/** 弹窗的“登记簿”目录：每张弹窗把自己的 pid + 位置写在这里，新弹窗读它决定叠在哪儿 */
const cardDir = (): string => join(getAgentDir(), "pi-cards");

/** 登记簿目录（导出给测试/诊断用） */
export function cardDirPath(): string {
	return cardDir();
}

/**
 * 桌面弹窗（Windows 专用；其他平台走系统通知）。
 * - `seconds = 0`（默认）= **常驻**，只有你手动点 X 才会消失
 * - `seconds > 0` = 到点自己消失（用于“输入弹窗”这种看一眼就够的）
 * - 多张弹窗会**自动往下叠**，不会互相顶掉
 * - `speak` 传了才播报（不传 = 静默）
 */
export function cardNotify(title: string, body: string, seconds = 0, speak?: string): void {
	if (!popupOn) return;
	if (process.platform !== "win32") {
		systemNotifyPosix(title, body, 0);
		if (speak) speakPosix(speak);
		return;
	}
	try {
		const f = popupScriptPath();
		if ((existsSync(f) ? readFileSync(f, "utf8") : "") !== POPUP_PS1) {
			mkdirSync(getAgentDir(), { recursive: true });
			writeFileSync(f, "\ufeff" + POPUP_PS1, "utf8");
		}
		mkdirSync(cardDir(), { recursive: true });
		const c = spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-STA",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				f,
				"-TitleB64",
				b64(title),
				"-BodyB64",
				b64(body),
				"-Seconds",
				String(seconds),
				"-SpeakB64",
				b64(speak ?? ""),
				"-VoiceName",
				ttsVoice,
				"-Rate",
				String(ttsRate),
				"-Volume",
				String(ttsVolume),
				"-CardDir",
				cardDir(),
			],
			{ detached: false, stdio: "ignore", windowsHide: true },
		);
		c.on("error", () => {});
		c.unref();
	} catch {
		/* 画不出来就算了，胶囊/系统通知还在 */
	}
}
/** 自绘“弹窗”脚本（纯 ASCII，参数走 base64）：圆角 + 半透明 + 贴屏幕顶部居中，不抢焦点，到点自动消失，点一下立刻关 */
const POPUP_PS1 = `param([string]$TitleB64 = '', [string]$BodyB64 = '', [int]$Seconds = 0, [int]$Top = 14, [string]$SpeakB64 = '', [string]$VoiceName = '', [int]$Rate = 0, [int]$Volume = 100, [string]$CardDir = '')
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class PiCard : Form {
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int a,int b,int c,int d,int e,int f);
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x00000080; return cp; }
  }
  public void Round() { this.Region = System.Drawing.Region.FromHrgn(CreateRoundRectRgn(0,0,this.Width+1,this.Height+1,14,14)); }
}
"@ -ReferencedAssemblies System.Windows.Forms,System.Drawing
$title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleB64))
$body  = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BodyB64))
$f = New-Object PiCard
$f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.TopMost = $true
$f.ShowInTaskbar = $false; $f.BackColor = [System.Drawing.Color]::FromArgb(43, 45, 49); $f.Opacity = 0.97
$padX = 16; $padY = 11; $w = 470
$tf = New-Object System.Drawing.Font('Microsoft YaHei UI', 10.5, [System.Drawing.FontStyle]::Bold)
$bf = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
# 关闭按钮（只有你点它，或者本来就说好自动消失，窗口才会走）
$cl = New-Object System.Windows.Forms.Label
$cl.Text = 'X'; $cl.ForeColor = [System.Drawing.Color]::FromArgb(150, 155, 165); $cl.Font = $tf
$cl.AutoSize = $true; $cl.Cursor = 'Hand'
$cl.Location = New-Object System.Drawing.Point(($w - $padX - 16), $padY)
$tl = New-Object System.Windows.Forms.Label
$tl.Text = $title; $tl.ForeColor = [System.Drawing.Color]::FromArgb(130, 215, 245); $tl.Font = $tf
$tl.AutoSize = $true; $tl.MaximumSize = New-Object System.Drawing.Size(($w - 2 * $padX - 24), 0)
$tl.Location = New-Object System.Drawing.Point($padX, $padY)
$bl = New-Object System.Windows.Forms.Label
$bl.Text = $body; $bl.ForeColor = [System.Drawing.Color]::FromArgb(238, 240, 244); $bl.Font = $bf
$bl.AutoSize = $true; $bl.MaximumSize = New-Object System.Drawing.Size(($w - 2 * $padX), 0)
$bl.Location = New-Object System.Drawing.Point($padX, ($padY + 26))
$f.Controls.Add($tl); $f.Controls.Add($bl); $f.Controls.Add($cl); $cl.BringToFront()
$bottom = $padY + 26 + $bl.PreferredHeight
$h = $bottom + $padY
$f.ClientSize = New-Object System.Drawing.Size($w, $h)
$sc = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$f.Left = [int](($sc.Width - $w) / 2)
# 多张弹窗「往下叠」：读同目录里还活着的窗口占了多高，排在它们下面
$myTop = $Top
if ($CardDir -ne '') {
  $maxBottom = $Top - 8
  Get-ChildItem -Path $CardDir -Filter '*.txt' -ErrorAction SilentlyContinue | ForEach-Object {
    $otherPid = 0
    [void][int]::TryParse([System.IO.Path]::GetFileNameWithoutExtension($_.Name), [ref]$otherPid)
    if ($otherPid -gt 0 -and (Get-Process -Id $otherPid -ErrorAction SilentlyContinue)) {
      $t = 0; $hh = 0
      try {
        $parts = @((Get-Content $_.FullName -Raw) -split '\\s+' | Where-Object { $_ -ne '' })
        if ($parts.Count -ge 2) { $t = [int]$parts[0]; $hh = [int]$parts[1] }
      } catch { }
      if (($t + $hh) -gt $maxBottom) { $maxBottom = $t + $hh }
    } else {
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    }
  }
  $myTop = $maxBottom + 8
  try { [System.IO.File]::WriteAllText((Join-Path $CardDir "$PID.txt"), "$myTop $h") } catch { }
}
$f.Top = $myTop
$cl.Add_Click({ $f.Close() })
$f.Add_FormClosed({
  if ($CardDir -ne '') { Remove-Item (Join-Path $CardDir "$PID.txt") -Force -ErrorAction SilentlyContinue }
})
# 语音播报（可选；默认关）
$spk = $null
if ($SpeakB64 -ne '') {
  try {
    Add-Type -AssemblyName System.Speech
    $spk = New-Object System.Speech.Synthesis.SpeechSynthesizer
    if ($VoiceName -ne '') { try { $spk.SelectVoice($VoiceName) } catch { } }
    $spk.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
    if ($Volume -gt 0) { $spk.Volume = [Math]::Max(0, [Math]::Min(100, $Volume)) }
    $say = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SpeakB64))
    $spk.SpeakAsync($say) | Out-Null
  } catch { $spk = $null }
}
# 只有显式传 Seconds > 0 才会自动消失；默认 0 = 常驻，必须你手动点 X
if ($Seconds -gt 0) {
  $started = Get-Date
  $tm = New-Object System.Windows.Forms.Timer
  $tm.Interval = 250
  $tm.Add_Tick({
    $el = ((Get-Date) - $started).TotalSeconds
    if ($spk) {
      if ($el -gt 1.0 -and $spk.State -eq 'Ready') { $f.Close() }
      elseif ($el -gt 180) { $f.Close() }
    } elseif ($el -gt $Seconds) { $f.Close() }
  })
  $tm.Start()
}
[System.Windows.Forms.Application]::Run($f)
`;

/** 终端原生通知（OSC 777）。Warp 会弹顶部胶囊；窗口不在前台时由 Warp 转系统通知。
 * 只写控制序列，不动屏幕内容，不会搞花 pi 的 TUI。
 */
export function oscNotify(title: string, body: string): void {
	try {
		// OSC 777 里不能出现 BEL/ESC/换行，分号会把字段切断
		const clean = (s: string): string => s.replace(/[\x00-\x1f;]/g, " ").slice(0, 160);
		process.stdout.write(`\x1b]777;notify;${clean(title)};${clean(body)}\x07`);
	} catch {
		/* 写不进去就算了 */
	}
}

/**
 * 把一轮回复（Markdown）压成**能直接看懂的短摘要**。**纯函数**。
 *
 * 目标场景：你不在看屏幕，要的就是“它到底说完了什么”，所以：
 *   - 堆排版（代码块、表格、标题、列表符、**强调**、链接 URL）全去掉
 *   - 开场空话（“好的”“我来看一下”）跳过
 *   - 优先在句读处截断，末尾加省略号
 * **不做二次 LLM 调用**：不花 token、不加延迟；规则完全可测。
 */
/** 开场空话（这些当摘要第一句等于没说） */
const OPENER_RE = /^(好的|好嘞|好[，,。!！\s]|明白了?|收到|OK|Ok|ok|嗯+|行|可以|没问题|稍等|我来看一下|这就去)/;

export function summarizeReply(md: string, maxLen = 160): string {
	if (!md) return "";
	let t = md.replace(/\r\n?/g, "\n");
	t = t.replace(/```[\s\S]*?```/g, " "); // 围栏代码块（含内容）整块丢掉
	const parts: string[] = [];
	for (const raw of t.split("\n")) {
		let l = raw.trim();
		if (!l) continue;
		if (/^([-*_]\s*){3,}$/.test(l)) continue; // 分隔线
		if (l.startsWith("|") && l.endsWith("|")) continue; // 表格行
		const isHeading = /^#{1,6}\s/.test(l);
		l = l.replace(/^#{1,6}\s*/, "");
		l = l.replace(/^>\s*/, "");
		l = l.replace(/^([-*+]|\d+[.)])\s+/, "");
		l = l.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
		l = l.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
		l = l.replace(/`([^`]*)`/g, "$1");
		l = l.replace(/\*\*([^*]*)\*\*/g, "$1").replace(/__([^_]*)__/g, "$1");
		l = l.replace(/\s+/g, " ").trim();
		if (!l) continue;
		if (!/[\p{L}\p{N}]/u.test(l)) continue; // 纯符号/emoji 行
		if (isHeading && l.length <= 12) continue; // 短标题只是标签（“结论”“改动”），没信息量
		parts.push(l);
	}
	// 跳过开场空话（“好的”“我来看一下”… —— 你不在看屏幕时这些没信息量）
	while (parts.length > 1 && parts[0]!.length <= 10 && OPENER_RE.test(parts[0]!)) parts.shift();
	let out = "";
	for (const p of parts) {
		if (!out) out = p;
		else if (out.length + p.length + 1 <= maxLen) out += ` ${p}`;
		else break;
		if (out.length >= maxLen * 0.8) break;
	}
	out = out.trim();
	if (out.length > maxLen) {
		const cut = out.slice(0, maxLen);
		const m = cut.match(/^[\s\S]*[。！？!?；;，,]/);
		out = `${(m ? m[0] : cut).replace(/[，,、；;：:\s]+$/, "")}…`;
	}
	return out;
}

/** 结果卡片的元信息行：耗时 · 工具次数 · 改了哪些文件 · 有没有失败 */
export function formatResultMeta(o: { secs?: number; tools?: number; failed?: number; files?: string[] }): string {
	const bits: string[] = [];
	if (o.secs !== undefined && o.secs > 0) {
		bits.push(o.secs < 60 ? `${o.secs}s` : `${Math.floor(o.secs / 60)}m${String(o.secs % 60).padStart(2, "0")}s`);
	}
	if (o.tools) bits.push(`${o.tools} 次工具`);
	const files = o.files ?? [];
	if (files.length) {
		bits.push(`改了 ${files.length} 个文件：${files.slice(0, 3).join("、")}${files.length > 3 ? ` 等 ${files.length} 个` : ""}`);
	}
	if (o.failed) bits.push(`⚠️ ${o.failed} 个工具失败`);
	return bits.join(" · ");
}

/** 终端探测：只有确认支持 OSC 777 的终端才写那个控制序列（不认识它的终端会刷乱码） */
export function detectTerminal(env: Record<string, string | undefined> = process.env): { name: string; osc: boolean } {
	const tp = (env.TERM_PROGRAM ?? "").toLowerCase();
	if (tp.includes("warp")) return { name: "Warp", osc: true };
	if (env.WT_SESSION) return { name: "Windows Terminal", osc: true };
	if (tp.includes("iterm")) return { name: "iTerm2", osc: true };
	if (env.KITTY_WINDOW_ID) return { name: "kitty", osc: true };
	if (env.GHOSTTY_RESOURCES_DIR) return { name: "Ghostty", osc: true };
	if ((env.TERM ?? "").includes("kitty")) return { name: "kitty", osc: true };
	if (env.WEZTERM_PANE) return { name: "WezTerm", osc: true };
	if (env.VTE_VERSION) return { name: "GNOME/VTE 系", osc: true };
	const guess = env.TERM_PROGRAM || env.TERM || (env.ComSpec ? "cmd/conhost" : "未知终端");
	return { name: guess, osc: false };
}

/**
 * 通知通道：
 *   auto（默认）= 终端支持 OSC 777 就发**胶囊**（就是你截图里那个效果），不支持才换别的
 *   osc  = 只发终端胶囊 · card = 只发自绘弹窗（贴顶圆角卡片） · toast = 只用系统通知 · both = 胶囊 + 自绘弹窗
 */
export type NotifyMode = "auto" | "osc" | "card" | "toast" | "both";
let notifyMode: NotifyMode = "auto";
/** 自绘弹窗总开关（有些人不喜欢弹窗 → /voice popup off；胶囊/系统通知不受影响） */
let popupOn = true;
export function setPopupOn(v: boolean): void {
	popupOn = v;
}
export function getPopupOn(): boolean {
	return popupOn;
}

// ======================= 语音播报（TTS）=======================
// 用系统自带语音库（Windows: System.Speech · macOS: say · Linux: spd-say）：
// 零安装、离线、不外发内容。开关 = /voice tts on|off（配置 voiceTts）。
let ttsOn = false;
let ttsVoice = "";
let ttsRate = 0;
let ttsVolume = 100;
/** 播报文本上限（超了念不完，还不如短点） */
const SPEECH_MAX = 300;

export function setTts(o: { on?: boolean; voice?: string; rate?: number; volume?: number }): void {
	if (typeof o.on === "boolean") ttsOn = o.on;
	if (typeof o.voice === "string") ttsVoice = o.voice;
	if (Number.isFinite(o.rate)) ttsRate = Math.max(-10, Math.min(10, Math.round(o.rate as number)));
	if (Number.isFinite(o.volume)) ttsVolume = Math.max(0, Math.min(100, Math.round(o.volume as number)));
}
export function getTts(): { on: boolean; voice: string; rate: number; volume: number } {
	return { on: ttsOn, voice: ttsVoice, rate: ttsRate, volume: ttsVolume };
}

/**
 * 把结论摘要洗成**适合念**的文本。**纯函数**。
 *
 * 念出来和看起来不一样：emoji、markdown 记号、括号旁注都得去掉，
 * 否则它会念「星号 星号 结论 星号 星号」「括号 见截图 括号」。
 */
export function speechText(md: string): string {
	let t = (md ?? "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[#*_>~|]+/g, " ")
		.replace(/（[^）]{0,40}）/g, " ")
		.replace(/\([^)]{0,40}\)/g, " ")
		.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (t.length > SPEECH_MAX) t = `${t.slice(0, SPEECH_MAX)}……以下省略`;
	return t;
}

/** 非 Windows 的播报（macOS say / Linux spd-say）；失败静默 */
function speakPosix(text: string): void {
	try {
		const cmd = process.platform === "darwin" ? "say" : "spd-say";
		const args = process.platform === "darwin" ? [text] : ["-w", text];
		const c = spawn(cmd, args, { detached: false, stdio: "ignore" });
		c.on("error", () => {});
		c.unref();
	} catch {
		/* ignore */
	}
}


export function setNotifyMode(m: NotifyMode): void {
	notifyMode = m;
}
export function getNotifyMode(): NotifyMode {
	return notifyMode;
}
/** 当前终端探测结果（状态/命令里显示给你看） */
export function terminalInfo(): { name: string; osc: boolean } {
	return detectTerminal();
}

/**
 * **结果卡片**：答完一轮后直接把结论推给你（不必切回窗口）。
 *
 * 分两个通道，因为容量差很多：
 *   - Warp 胶囊（OSC 777）：只有一行 → 放**首句**（60 字）
 *   - Windows toast：可多行 → 放**完整摘要 + 元信息**
 */
export function sendResult(opts: {
	title: string;
	summary: string;
	meta?: string;
	/** true = 同时进终端胶囊（Warp） */
	osc?: boolean;
	/** true = 同时弹 Windows toast */
	toast?: boolean;
	beep?: boolean | "warn";
}): void {
	const title = opts.title;
	const body = opts.summary || "（这轮没有文字结论）";
	const full = opts.meta ? `${body}\n${opts.meta}` : body;
	notifyUser({
		title,
		body: full.slice(0, 700), // 卡片是**常驻**的，够看完整结论就行，别太长
		oscBody: body.slice(0, 60),
		card: true,
		cardSeconds: 0, // 0 = 常驻：你不点 ✕ 它不会走
		osc: opts.osc,
		toast: opts.toast,
		beep: opts.beep,
		speak: body,
	});
}

/**
 * 弹通知 +/或 响一下。**异步、不阻塞、失败静默**。
 *
 * 通道选择：默认走**系统通知**（任何终端/后台都可见）；终端胶囊只在
 * 「模式含 osc」且「探测到该终端支持」时才额外写。显式传 osc/toast 时以传的为准（兼容老调用）。
 *
 * @param oscBody 终端胶囊只有一行 → 传更短的那句（不传就用 body）
 */
export function notifyUser(opts: {
	title?: string;
	body?: string;
	/** 终端胶囊专用短文本（单行） */
	oscBody?: string;
	osc?: boolean;
	/** 显式控制“自绘弹窗”通道（false = 不要） */
	card?: boolean;
	/** 卡片停留秒数：0 = 常驻（点 ✕ 才关）——结果卡片用 0；不传则 12 秒自动消失 */
	cardSeconds?: number;
	toast?: boolean;
	/** true = 响一下系统提示音；"warn" = 换成警告音 */
	beep?: boolean | "warn";
	/** 要念的文本（传了且 TTS 开着 → 弹卡片 + 自动播报；念完卡片一起消失） */
	speak?: string;
}): void {
	const tm = terminalInfo();
	const mode = notifyMode;
	// 胶囊：终端支持 + 模式要它（auto/osc/both 都算）
	const wantOsc = opts.osc === false ? false : mode === "auto" || mode === "osc" || mode === "both";
	const useOsc = tm.osc && wantOsc;
	// 自绘弹窗：显式要，或 auto 在“不支持胶囊的 Windows”上兜底
	const wantCard =
		opts.card === false
			? false
			: popupOn &&
				(opts.card === true ||
					mode === "card" ||
					mode === "both" ||
					(mode === "auto" && !tm.osc && process.platform === "win32"));
	// 系统通知：显式要 toast，或 auto 在 mac/linux（那两边系统通知是原生的，比自绘强）
	const wantSys =
		opts.toast === false
			? false
			: mode === "toast" || (mode === "auto" && process.platform !== "win32");
	const beep = opts.beep === "warn" ? 2 : opts.beep === true ? 1 : 0;
	// TTS 靠"弹窗"承载（Win 上就是卡片里那台喇叭）→ 弹窗关了就不出声，避免你以为坏了
	const speak = ttsOn && popupOn ? speechText(opts.speak ?? opts.body ?? "") : "";
	if (useOsc) oscNotify(opts.title ?? "pi", opts.oscBody ?? opts.body ?? "");
	// TTS 开着 → 一定要弹卡片（卡片就是"播报台"：念完自己消失）
	if (wantCard || (speak && process.platform === "win32")) {
		cardNotify(opts.title ?? "pi", opts.body ?? "", opts.cardSeconds ?? 12, speak || undefined);
	}
	if (speak && process.platform !== "win32") speakPosix(speak);
	if (!wantSys && !beep) return;
	// 非 Windows：直接另起平台原生命令（macOS / Linux），连提示音一起办
	if (process.platform !== "win32") {
		systemNotifyPosix(opts.title ?? "pi", opts.body ?? "", beep);
		return;
	}
	const f = ensureScript();
	if (!f) return;
	try {
		const child = spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				f,
				"-Toast",
				useToast ? "1" : "0",
				"-TitleB64",
				b64(opts.title ?? ""),
				"-BodyB64",
				b64(opts.body ?? ""),
				"-Beep",
				String(beep),
			],
			{ detached: false, stdio: "ignore", windowsHide: true },
		);
		child.on("error", () => {
			/* 起不来就算了 */
		});
		child.unref();
	} catch {
		/* ignore */
	}
}
