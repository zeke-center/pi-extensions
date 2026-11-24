# 更新日志

格式要求：每个版本用 `## x.y.z` 开头（pi 靠它解析，用于更新后显示「Extension Updates」）。

## 2.5.4

- 新增：**Router 提示词可外部化** —— 项目级/用户级的 `router.md` 替换内置、`router.extra.md` 追加，改完下一轮生效
- 新增：内置 Router 提示词加入**依赖分析与并行批次**规则（互不依赖的活一次派完、禁止伪串行）
- 新增：`/panes` 与 `/pane-close` —— 列出并关闭子助理 pane（永远跳过自己和主 pane）
- 新增：`superagent.batchLive`（默认关）—— 批量任务每完成一件回投一条 ≤60 字短进度
- 修复：**子助理停下来后 pane 关不掉** —— 以前只发一次 Ctrl+C（等于清空输入框），且「回车关闭」只是个文案；现在连发两次 + exit 兜底，ESC 也会真的停掉
- 修复：Herdr 判定「失败一次就永久降级」—— 改成 30 秒冷却 + 负面缓存 5 秒过期，每会话重新探测
- 优化：Herdr 不可用时不再**静默降级**（卡片上写原因并标 `🖥 panel`）；`/aidoctor` 增加 Herdr 诊断段
- 优化：采样与完成判定 2s → 800ms；保留的 pane 10 分钟自动回收（`paneKeepMinutes`）

## 2.5.3

- 变更：**Router 档位默认改为「只派活」** —— 开启 Super Agent 后主会话只剩 `delegate` / `progress` / `git_read`，只能决策与验收，不能再自己读文件、跑命令、改代码
- 新增：`tool_call` 硬拦截 —— 白名单外的工具（含 `bash`、`codemode`、`write`、`edit`、`mcp__*` 执行类、晚注册的 MCP 工具）一律拒绝并提示「用 delegate 派活，不要重试」；守卫自身出错时放行（fail-open）并记日志
- 新增：`/router` 命令 —— 不带参数看当前档位；`/router blind|readonly|off` 临时切换（本会话有效，重启复位）
- 修复：设置面板里改完一项保存后，回到上一层被**旧快照写回**（表现成「改了没保存」）
- 修复：`readonly` 档的 MCP 危险工具漏判（`ssh_exec` 这类现在会拦）
- 测试：unit 新增 48 条断言（Router guard 26 + 设置刷新 22）

## 2.5.2

- 变更：**UI 模式默认改为 `auto`** —— 本机有 Herdr 就自动分屏，没有则退回面板卡片
- 修复：面板里「UI 模式」改了存不进去（选项标签过长导致匹配失败，现在按前缀兜底）
- 修复：从配置中心拉取连接遇到后端冷启动直接失败（改 3 次重试 + 单次 20 秒超时）
- 体验：拉取期间有「进行中 / 正在重试 N 次 / 重试后成功」提示，不再静默等 60 秒
- 新增：`PI_SA_UI` 环境变量可强制指定 UI 模式（压测脚本用它钉死 `panel`，不再误开 pane）
- 测试：unit 新增 30+ 条断言；压测从「挂 642 秒 + 留 4 个残留 pane」降到 6 秒干净跑完

## 2.5.1

- 修复：分屏任务跑完却被判失败（回执里没有 `<result>` 标签时永远等不到完成信号）
- 修复：交互式 pi 答完不退出，导致「回到 shell」这个完成判据永远不成立
- 修复：读取 pane 状态偶发抛错 3 次就判失败，放宽到 12 次并回落到读会话文件
- 体验：失败/超时保留的 pane 会先发 Ctrl+C 停掉里面的 pi，标签写明「已停，回车关闭」
- 测试：新增 23 条收尾信号断言；四套测试全绿

## 2.5.0

- 新增：Herdr 分屏 UI 模式（`superagent.ui`: panel / split / tab / auto），主窗口左主右上下两格；溢出任务进 tab `sa:extra#n`，可开多个、每个 2×2
- 新增：`herdr.ts` 薄封装 + 分屏布局与收尾回执，非 Herdr 环境自动降级回 panel
- 修复：影子目录缺 bin 导致启动时联网下载 fd/rg（改 junction）、槽位分配竞态、pane 90s 无输出无检测、pane 收尾丢回执
- 修复：后台任务 `delivered` 标记被覆盖，导致 reload 后重复投递
- 体验：同批任务合并成 1 张汇总卡；槽位满时排队等 60s 再降级；只自动投递 10 分钟内的结果、最多自动尝试 3 次
- 测试：unit 422+ 条断言 / smoke 10 条命令 / `herdr-finalize-check` / `concurrency-regress`

## 2.4.1

- 新增：排队任务在面板可见（`⏳ 排队中`），不再“点了没反应”
- 修复：槽位改为进程退出即释放，避免僵尸槽位占满额度
- 修复：`general` 助理权限收紧到 `${cwd}`
- 新增：exec 硬拦开关（可关闭 exec 拦截回到纯观察模式）
- 新增：`scripts/concurrency-regress.mjs` 并发回归脚本 + unit 补充断言

## 2.4.0

- 新增：Worker 侧权限守卫 `perm-guard.ts`（纯函数 `decideToolCall`：protected 硬拦、fs 路径白名单、exec/net 观察期只记录、fail-open）
- 新增：`guard-entry.ts` —— 复制进影子目录的极薄入口，按官方 permission-gate 方式拒绝，文案含「策略性拒绝，不要重试」+ 替代方案
- 保护清单：插件源码、`~/.pi/agent/{extensions,assistants,shadow}`、`ai-extensions.json`、`mcp-catalog.json`、`mcp.json`、`.git` 一律不可写
- 新增：Router 协议支持异步派活（预计 >30s 用 `wait:false`，先回一句，结果回投）
- 测试：unit 新增 perm-guard 套件 16 条断言

## 2.3.1

- 新增：`delegate.tasks` 元素支持 `{ assistant, task }` 对象形式，`assistant` 改为可选
- 执行时按助理去重、各自建影子目录，跨领域并行任务可一次派给不同助理
- Router 协议新增：派活前按 `desc` 挑专才；明确领域的活不许派给 `general`
- `general` 的 `desc` 去掉「不确定就派我」的兜底暗示

## 2.3.0

- 新增：`permissions.ts` —— fs / paths / exec / cmds / net / budget 六项权限，解析 / 摘要 / 声明注入
- 助理编辑页新增权限 6 行，落盘到 frontmatter；新建助理默认 dev / reader 预设
- Worker 提示词注入「你的权限」段（越界不会成功、不要绕），任务卡片显示权限摘要
- 新增：`git_read` 只读工具（status / diff / log / show，spawn 无 shell，拒绝时给替代方案）
- 修复：`assistantFormParts.commit` 漏传 `ctx` 导致面板保存必失败（v2.2.1 遗留）
- 新增：全局助理可「另存为本项目副本」，列表显示 全局 / 本项目 来源

## 2.2.1

- 修复：进入助理会开第二个面板（组页 `enter` 读到 `SettingDef.page` 就走 `d.page()` 同框 pushPage），命令执行次数 0
- 新增：`delegate.assistantNewPage()`，「＋ 新建助理」也改成面板内翻页
- 新增：长文本就地编辑 —— `FormField kind="long"` 值列显示摘要 `(N 字 · M 行)`，回车进编辑视图（软换行、21 行视口跟光标、`ctrl+s` 保存、`esc` 取消）
- 渲染：`FormPane` 加 `lastH` + `fit()`，离开编辑视图时补空行到历史最高高度，避免宿主留残影
- 修复：`FormPane` / `MultiSelect` 补 `invalidate()` 空实现，宿主遍历 overlay 组件时不再 `TypeError` 崩溃
