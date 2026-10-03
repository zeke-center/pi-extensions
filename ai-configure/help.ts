/**
 * AI configure 的「说明书」。
 *
 * /aihelp 和 /ai help 都调这里的 showHelp()，所以文案只有一份，不会两边不一致。
 * 以后加功能 / 改参数说明，只改这个文件。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const HELP_TEXT = `AI configure · 全部功能

▍命令
/ai                       从 AI 配置中心拉连接（打开选择器）
  /ai status              看状态：密钥 / 会话级 / 项目级
  /ai token               设置 API 密钥
  /ai off                 关掉本会话拉进来的连接
  /ai project off         关掉项目级连接
  /ai project clear       清空项目级连接
  /ai help                就是你现在看的这个（= /aihelp）
/board                    任务进度看板
  /board on | off         开 / 关
  /board clear            清空任务列表
  /board above | below    面板放输入框上方 / 下方
  /board right | mid      显示 / 隐藏 右栏 / 中栏
/assistants               助理模板
  /assistants show <名>   展开全部字段 + 继承链 + 提示词正文
  /assistants edit <名>   弹面板改：MCP / 超时 / AGENTS.md / 存哪儿 / 正文
  /assistants mcp  <名>   同上，只是光标直接落在 MCP 那行
  /assistants new  <名>   弹同一个面板新建
  /assistants open <名>   用系统默认程序打开那个 .md
  （面板：↑↓ 选行 · 回车 改 · ctrl+s 保存 · esc 取消）

  （base / demo 的模板不能直接派；能派的会列在 delegate 工具描述里）

▍工具（你不用打，模型按需调用）
progress(action, ...)     更新输入框上方那个面板
  action       plan｜step｜block｜clear       必填
  title        字符串    计划标题            （action=plan）
  steps        字符串数组 步骤列表，每条≤20字 （action=plan）
  index        数字      步骤序号，从 1 开始   （action=step）
  status       pending｜doing｜done｜blocked （action=step）
  text         字符串    卡点说明            （action=block）
  skipConfirm  布尔      跳过确认弹窗         （action=plan）

delegate(assistant, ...)  派活给临时助理（另起独立 pi 进程），只带一张卡回来
  assistant    字符串    助理模板名（工具描述里会列可用的），如 db / server
  task         字符串    一件事，写清目标 + 验收标准
  tasks        字符串数组 多件互不依赖的事，并行跑（总耗时≈最慢那件）
  resume       字符串    续跑上次的会话 ID（卡片里那个）
  timeoutMs    数字      超时毫秒，默认 300000，上限 1800000

▍顺带一提：这几个内置命令你会用到
/reload    改完扩展代码必须执行（改助理模板不用）
/name      给当前会话起名 —— 直接决定子代理名字的前缀
/session   看当前会话的文件、ID、token 用量、成本
/resume    按名字挑会话`;

export function showHelp(ctx: ExtensionContext): void {
	ctx.ui.notify(HELP_TEXT, "info");
}
