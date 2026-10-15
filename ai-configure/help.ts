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
  /ai doctor              自检：模块健康度 / 台账 / MCP 连接 / 助理 / 看板（= /aidoctor）
  /ai token               设置 API 密钥
  /ai off                 关掉本会话拉进来的连接
  /ai project off         关掉项目级连接
  /ai project clear       清空项目级连接
  /ai help                就是你现在看的这个（= /aihelp）
/ai-ext                   会话级停用 / 恢复整个扩展（不用卸载，本会话记住）
  /ai-ext off             停用：面板收起、progress/delegate 从工具表撤下、后台回投暂停
  /ai-ext on              恢复（后台已跑完的结果会立刻补投）
  /ai-ext status          看当前状态
  （启动即停用：pi --no-ai-ext，或环境变量 PI_AI_EXT=off）
/voice                    语音模块（**不做语音识别**：借微信输入法等 IME，把你的话送进 pi）
                            ★ 首选 /voice clip：pi 最小化也能投，且必须带触发词（不会误发）
  /voice talk on|off      输入框模式（**只管 pi 输入框**）：说句尾触发词才发 —— 默认安全档，
                          跟下面的剪贴板模式**互不影响**，改一个不会动另一个
  /voice talk auto on|off   额外允许「说完停一下自动发」 ⚠️ 中文选词也会上屏 → 会被当成说完
  /voice clip on|off      剪贴板模式：**pi 最小化/不在前台也行** —— 句尾说触发词就投给 pi
  /voice clip trigger 发送,投给pi   改触发词（≥3 字的允许 1 个字识别出错）
  /voice clip mode steer|queue|abort   pi 忙时：插话（默认）/ 排队 / 打断
  /voice clip trigger-mode word|silent   word=必须说触发词 · **silent=粘贴即投（不用喊，默认）**
                          silent（默认）= **不用喊触发词**：说完安静 1.2s 就投（护栏挡代码/网址/日志）
                          word = 结尾必须说触发词（最安全）
  /voice clip silent 1200 静默投递的等待时长（300~10000ms）
  /voice clip tail 6      触发词只要在末尾 6 个字内出现就算命中（0 = 必须严格结尾）
  /voice clip mark on|off 投递正文加不加 「📋 」前缀（默认加，便于分辨是不是语音投递）
  /voice clip guess on|off **内容判断**（默认开）：开 = 猜「像不像人话/像不像指令」（太短·网址·错误栈·代码·/开头·中文太少 → 不投）
                           关 = **不猜**，剪贴板安静下来就投（只保去重+非空；状态栏会显示「·直投」）
  /voice clip log         看本会话最近 10 条投递（时间/字数/剥了几层触发词，不落盘）
  /voice clip status      看剪贴板模式状态
  /voice delay 1800       静默阈值（400~10000ms，**只对 talk auto 生效**）
  （**剪贴板投递来的计划 = 默认直接执行**，先弹一张常驻的「执行弹窗」告诉你干什么；终端手打的计划才弹确认）
  /voice plan             计划兜底：粘一句话回答（同意/不行/改用…）· 超时怎么办
  /voice plan auto on|off 低风险自动过（新规则下后台已一律自动执行，此开关基本用不上）
  /voice plan timeout 120 没答超时秒数（0=一直等）· ontimeout run|cancel 超时后怎么办（默认 cancel）
  /voice popup on|off     **桌面弹窗开关**：输入弹窗(4s自消)/执行弹窗(常驻)/结论弹窗(常驻)，多张自动往下叠

                          通道细调：/voice notify auto|osc|card|both|toast
  /voice tts on|off       **语音播报**：开 = 答完弹卡片的同时自动念结论摘要（卡片照旧常驻，点 ✕ 才关）
  /voice tts test         试听（音色/语速/音量立刻生效，不用等下一轮）
  /voice tts voice <名称>  换音色（Windows: Microsoft Huihui Desktop / Microsoft Zira Desktop；default=恢复默认）
  /voice tts rate -10..10 语速 · /voice tts volume 0~100 音量 · /voice tts 看状态
  /voice result on|off    答完把**结论**弹出来（默认开：语音轮一定弹）
  /voice result long 20   手打的轮跑够 20s 也弹（0 = 只弹语音轮）
  /voice notify auto      通知通道（默认 auto）：终端支持就发**胶囊**（Warp 顶部那个效果），
                           不支持才换。osc=只胶囊 · card=只自绘弹窗 · both=胶囊+弹窗 · toast=系统通知
  /voice beep on|off      投递/跑完时的提示音（默认开）
  /voice send             立刻把输入框内容发出去
  /voice status           总览（talk / clip / 触发词 / 提示音 / 计数）
  （两模式可各自开关、同时开；/ai-ext off 会一并停；clip 会读剪贴板但只比触发词、不落盘）
/board                    任务进度看板
  /board on | off         开 / 关
  /board clear            清空任务列表
  /board above | below    面板放输入框上方 / 下方
  /board right | mid      显示 / 隐藏 右栏 / 中栏
/assistants               助理模板
  /assistants show <名>   展开全部字段 + 继承链 + 提示词正文
  /assistants edit <名>   弹面板改：底座 / MCP / 超时 / AGENTS.md / 存哪儿 / 正文
  /assistants mcp  <名>   同上，只是光标直接落在 MCP 那行
  /assistants new  <名> [底座]   弹同一个面板新建；给了底座就自动 extends 它
  /assistants open <名>   用系统默认程序打开那个 .md
  （面板：↑↓ 选行 · 回车 改 · ctrl+s 保存 · esc 取消）

  （底座（base）**只读 + 只能被 extends + 不能直接派** —— 要定制就
    /assistants new <你的名字> <底座key> ；demo 的样板不能派，只当字段写法参考；
    能派的会列在 delegate 工具描述里）

/agents                   子代理实时面板（派活时自动出现，就在任务看板正上方）
  直接敲                  开（并解开「你手动关过」的封印）
  /agents off             关掉（下次派活也不再自动弹）
  /agents detail          展开 / 折叠 它的思考过程
  /agents widget          改回看板正上方那个整宽面板（默认形态）
  /agents float           改成右侧浮层（会盖住一块，只在你想让它飘着时用）
  /agents text            把当前状态打印成纯文本（RPC / 调试用）
  /agents bg              看后台任务状态（跑完却没投回主会话的、失败原因）
  /agents bg redeliver    把没投回主会话的立刻重投（主对话卡住时的救急口）

/resume-agent             翻看助理的历次会话（它们不在 /resume 里），选中切过去看
  /resume-agent <key>     只看某个助理的
/agent-resume-back        从助理会话一键返回主会话（/resume 在助理会话里看不到主会话）
/delegate-mode            看 delegate 默认是同步还是异步
  /delegate-mode async    默认异步：派完就走，后台跑，完成自动回投主会话（不打断）
  /delegate-mode sync     默认同步：派完等结果才继续（老行为）

  （面板显示：状态 · 已跑多久 · 当前在跑哪个工具及参数 · 结果 · token；
    超过 25 秒没有新事件会提示「⚠ Ns无动静」—— 用来判断它是卡住还是在等；
    跑完后停 45 秒再自动收起；没在跑的时候占 0 行，不碍事）

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
  wait         布尔      默认 false（异步）派完就走；true = 同步等结果。不传用 /delegate-mode 的默认

▍顺带一提：这几个内置命令你会用到
/reload    改完扩展代码必须执行（改助理模板不用）
/name      给当前会话起名 —— 直接决定子代理名字的前缀
/session   看当前会话的文件、ID、token 用量、成本
/resume    按名字挑会话`;

export function showHelp(ctx: ExtensionContext): void {
	ctx.ui.notify(HELP_TEXT, "info");
}
