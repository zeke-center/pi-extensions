# pi-extensions

我在用的 pi 编码 agent 扩展。**一个目录式插件 `ai-configure/`（入口装配 6 个模块 + 面板动作 actions.ts）** · 当前版本 **v2.9.2**，外加助理模板与提示词模板。全部是「本地 TypeScript」：pi 用 jiti 直接加载，**不需要编译、不需要 npm install**。

```bash
pi install git:github.com/zeke-center/pi-extensions   # 在终端里敲，不是在 pi 聊天框里
```

装完先敲 **`/aihelp`**（总控制台：助理配置 / 看板 / 命令都能点）· 另有 `/board`、`/usage`（全局 token 账）、`/ai`（含 `/ai doctor` 自检）、`/ai-ext`（会话级停用总闸）、`/assistants`、`/resume-agent`、`/agent-resume-back`、`/agents`、`/ai-delegate`，以及一个能直接派的**通用助理**。

| 文件 | 功能 | 入口 |
|---|---|---|
| `ai-configure/pi-extensions.ts` | 入口：装配下面六个模块 + 注册 `/aihelp`；各模块各自 try/catch（坏一块不带下水） | — |
| `ai-configure/gate.ts` | **会话级停用总闸**（面板收起、`progress`/`delegate` 从工具表撤下、后台回投暂停） | `/ai-ext` |
| `ai-configure/config.ts` | **MCP 配置管理命令**（撤销 / 状态 / 密钥；拉取功能已于 v2.5.9 删除） | `/ai` |
| `ai-configure/board.ts` | **任务进度看板**（含中栏运行状态 + 全局用量） | `/board` · `/usage` + `progress` 工具 |
| `ai-configure/delegate.ts` | **派活给临时助理** | `/assistants` · `/resume-agent` · `/agent-resume-back` + `delegate` / `read_result` 工具 |
| `ai-configure/live.ts` | 子代理实时状态机（把 JSON 事件流翻成可画的行） | — |
| `ai-configure/panel.ts` | 子代理实时面板（看板正上方整宽，默认） | `/agents` |
| `ai-configure/mcp-pool.ts` | MCP 候选池 + 影子目录（`mcp` 隔离的底层） | — |
| `ai-configure/form.ts` | 弹窗面板（表单 + 多选 + **分组折叠树**，`new`/`edit`/`/aihelp` 共用） | — |
| `ai-configure/settings.ts` | `/aihelp` 面板本体（分类折叠、`ctrl+s` 保存） | — |
| `ai-configure/actions.ts` | 把**命令和助理**挂成面板里的动作行（助理一人一行、命令走二级选单） | `/aihelp` |
| `ai-configure/help.ts` | 说明书文案（`/aihelp` 与 `/ai help` 共用一份）| — |
| `ai-configure/health.ts` | 模块健康度登记（入口失败上报，doctor/状态栏读它） | — |
| `ai-configure/doctor.ts` | **自检报告**（健康度 / 密钥 / MCP 连接判定 / 助理 / 看板） | `/ai doctor` = `/aidoctor` |

```text
pi-extensions/
├── ai-configure/        # 一个插件，入口装配 6 个模块
│   ├── package.json     # 内层清单：显式声明入口（显示名 = pi-extensions，不叫 index）
│   ├── pi-extensions.ts # 入口：装配下面六个 + 注册 /aihelp；各模块独立 try/catch
│   ├── config.ts        # MCP 配置管理命令（/ai 撤销 / 状态 / 密钥）
│   ├── board.ts         # 进度看板（/board + progress 工具）
│   ├── delegate.ts      # 派活给临时助理（/assistants + delegate 工具）
│   ├── live.ts          # 子代理实时状态机（JSON 事件流 → 可画的行）
│   ├── panel.ts         # 子代理实时面板（/agents，看板正上方整宽）
│   ├── mcp-pool.ts      # MCP 候选池 + 影子 agentDir
│   ├── form.ts          # 弹窗面板（表单 + 多选 + 分组折叠树）
│   ├── health.ts        # 模块健康度登记（入口失败上报）
│   ├── doctor.ts        # /ai doctor 自检
│   ├── shared.ts        # 模块间共享状态（旧ctx守卫/计划配置/配置读写）
│   ├── gate.ts          # 会话级停用总闸（/ai-ext）
│   ├── settings.ts      # /aihelp 面板本体（分类折叠）
│   ├── actions.ts       # 命令/助理挂成面板动作行
│   ├── rpc.ts           # RPC 通道辅助
│   └── help.ts          # /aihelp 的说明书文案
├── prompts/             # 提示词模板（= /命令，按需展开）
│   └── ai-delegate.md   #   派活纪律（配合 delegate 工具）
├── assistants/          # 助理模板（每个 .md 一个助理）
│   ├── general.md       # ✅ 可派：通用助理（装完就能用它）
│   ├── role-dev.md      # 底座：开发类公共规矩（base，不能直接派）
│   ├── role-ops.md      # 底座：只读查证类公共规矩（base，不能直接派）
│   ├── role-doc.md      # 底座：写文档类公共规矩（base，不能直接派）
│   ├── role-review.md   # 底座：审查/复核类公共规矩（base，不能直接派）
│   ├── frontend.md      # 示例：前端助理（extends role-dev，demo）
│   ├── backend.md       # 示例：后端助理（extends role-dev，demo）
│   ├── db.md            # 示例：数据库助理（extends role-ops，demo，挂 my-db）
│   └── server.md        # 示例：服务器助理（extends role-ops，demo，挂 my-server）
├── install.ps1          # 同步脚本：源 → ~/.pi/agent/（Windows，只删自己装过的）
├── scripts/             # 无头测试（CI 也跑这两个）
│   ├── smoke.mjs        #   让 pi 真加载扩展、断言命令都注册上
│   ├── unit.mjs         #   用 pi 自带 esbuild 打包真实源码 → 调内部函数（锁/归属/env/并发/影子目录）
│   └── stubs/           #   测试用的宿主桩（getAgentDir / pi-tui / typebox）
├── .github/workflows/   # CI：装 pi → 跑上面两个脚本
├── package.json         # pi 包清单（pi.extensions 指到 ai-configure/pi-extensions.ts）
├── LICENSE              # MIT
├── .gitignore
└── README.md
```

本地跑测试（需已装 pi，它自带 esbuild）：`node scripts/smoke.mjs && node scripts/unit.mjs && node scripts/typecheck.mjs`

### 为什么是「目录插件」而不是一个大文件

pi 原生支持两种扩展形态，**两种都会加载**：

| 形态 | 例子 |
|---|---|
| 根级单文件 | `extensions/foo.ts` |
| 目录式插件 | `extensions/foo/index.ts`（整棵目录，支持相对 `import`）|

合并前是三个各 700~830 行的独立文件（共 2036 行）。挤进一个 `.ts` 要处理 **7 处顶层重名**（`STATUS_KEY`、`McpEntry`、`pi`、`lastCtx`、`padTo`、`refreshStatus`、`timer`），而且**一处笔误带下水全部功能**。分模块就没这些问题 —— 每个文件还是独立作用域。

⚠️ 要注意的反面：**两种形态都加载** —— 旧单文件没删干净就会和新目录同时生效，**同一个工具被注册两遍**。`install.ps1` 的「清理孤儿」就是为这件事准备的。

---

## 命令总览

> **分工**：`/aihelp` 面板只放**配置**和**助理**（点着改，不用背语法）；**命令一律直接敲**，不塞进面板。

| 命令 | 子命令 | 干什么 |
|---|---|---|
| **`/aihelp`** | — | **★ 总控制台（改配置、改助理都在这儿）**：4 组 `助理`（每人一行）/ `委派` / `看板` / `会话级`。`↑↓` 移动 · `回车` 进组/编辑 · `esc` 逐层返回 · `ctrl+s` 保存。文本版说明 = `/ai help` |
| **`/ai`** | （无参数） | 打印说明书（原来的「拉取连接」入口已于 v2.5.9 删除，MCP 现在写在助理的 `mcp:` 行 / 手写 `.pi/mcp.json`） |
| | `status` | 看状态：密钥 / 会话级连接 / 项目级连接 |
| | `doctor` | 自检：模块健康度 / MCP 连接 / 助理 / 看板（等价 `/aidoctor`） |
| | `token` | 设置 API 密钥（内存态，不落盘） |
| | `off` | 关掉本会话注册的 MCP |
| | `project off` \| `project clear` | 关掉 / 清空**项目级**连接（写进项目 `.pi/mcp.json`） |
| | `help`（`?` / `h`） | 打印全部功能与参数（文本版说明书） |
| **`/aidoctor`** | — | 和 `/ai doctor` 同一个自检报告 |
| **`/ai-ext`** | `off` \| `on` | **会话级停用 / 恢复整个扩展**（不用卸载）：看板与子代理面板收起、`progress`/`delegate` 从工具表撤下、后台回投暂停。本会话记住，换会话自动恢复 |
| | `status` | 看当前状态 + 已接入闸门的模块 |
| | （启动即停用） | `pi --no-ai-ext`，或环境变量 `PI_AI_EXT=off` |
| **`/board`** | `on` \| `off` | 开会话级看板 / 临时关掉（不落盘，重启复位） |
| | `clear` | 清空任务列表（计划与步骤都清） |
| | `above` \| `below` | 面板贴输入框**上方** / **下方** |
| | `right` \| `mid` | 显示 / 隐藏**右栏**（MCP / 插件 / 助理）· 显示 / 隐藏**中栏**（运行状态 / 用量） |
| **`/usage`** | — | **全局 token 账**：本会话 + 所有子代理（按助理列明细）。中栏只显示合计，要明细敲这个 |
| **`/assistants`** | — | 列出所有助理模板（分「可派发 / 基础模板 / 示例模板」三组） |
| | `show <key>` | 展开全部字段 + 继承链 + 提示词正文 |
| | `edit <key>` | 弹面板改（底座 / MCP / 超时 / AGENTS.md / 存哪儿 / 正文）。底座只读，会被拒 —— **日常改助理请用 `/aihelp` 的「助理」组** |
| | `mcp <key>` | 同上，光标直接落在 MCP 那行 |
| | `new <key>` | 新建（面板里选底座） |
| | `new <key> <底座>` | **从底座一键派生**：自动 `extends` + 预勾底座带的 MCP |
| | `open <key>` | 用系统默认程序打开那个 `.md` |
| **`/agents`** | （无参数） | 开**子代理实时面板**（派活时本来就会自动出现；手动敲 = 重新叫回） |
| | `off` | 关掉（下次派活也不再自动弹） |
| | `detail` | 展开 / 折叠它的思考过程 |
| | `widget` \| `float` | 看板正上方的整宽面板（默认）/ 右侧浮层 |
| | `text` | 把当前状态打印成纯文本（RPC / 调试用） |
| | `bg` | 看**后台任务**（只列本对话）：`已投` / `待投` / `未投(已放弃)`、重试次数、失败原因 |
| | `bg all` | 连别的会话的历史记录也列出来（会标 `⚠别的会话`） |
| | `bg redeliver` | 把没投回主会话的**立刻重投**（主对话卡住时的救急口） |
| | `linger <时长>` | 跑完的子代理在面板上停留多久（默认 `45s`，`0` = 立刻消失）。写进 `~/.pi/agent/ai-extensions.json` |
| **`/resume-agent`** | — | 翻看助理的**历次会话**（它们**不在 `/resume` 里**），选中直接切过去看 |
| | `<key>` | 只看某个助理的（例 `/resume-agent db`） |
| **`/agent-resume-back`** | — | 从助理会话**一键回主会话**（在助理会话里 `/resume` 扫不到主会话，用这个回来） |
> **派活默认异步**（`/delegate-mode` 命令已于 v2.5.9 删除）：派完就走，后台跑，完成自动回投，主会话始终可交互；要同步只能在派活时显式传 `wait: true`（**会阻塞主会话**）。
| **`/router`** | `[blind\|readonly\|off]` | 看 / 切 **Router 档位**（Super Agent 主会话的管束强度）。本会话有效、**重启复位**；默认 `blind`（只派活，不许主会话自己动手）。无参数 = 只看当前档 |
| **`/panes`** | — | 列出本会话的子助理 pane（编号 / 助理 / 状态），标出「自己」和主 pane；**v2.6.2 起每行带 pid、健康状态、最后活动时间**（`45s` / `2m10s` 这种格式） |
| **`/pane-close`** | `[all\|编号]` | 关闭卡住的子助理 pane；无参只关「已停 / 失败保留」的；**永远跳过自己和主 pane** |
| **`/batch`** | — | 列出最近归档的子助理结果（7 天，最多 20 条） |
| | `<id>` | 打印该次任务的**完整正文** |
| | `<id> --raw` | 只输出正文（便于复制） |

**三个工具** —— 不是命令，你**不用打**，模型按需自己调：

| 工具 | 参数 | 干什么 |
|---|---|---|
| `progress` | `action`（必填：`plan`/`step`/`block`/`clear`）、`title`、`steps`、`index`、`status`、`text`、`skipConfirm` | 更新输入框上方那个面板 |
| `delegate` | `assistant`（必填）、`task` \| `tasks`、`resume`、`timeoutMs`、`wait` | 派活给临时助理（另起独立 pi 进程）；`wait` 默认 false=异步派完就走、完成自动回投，true=同步等结果（会阻塞主会话） |
| `read_result` | `id`（必填）、`raw`、`offset`、`limit` | 按需读取某次任务的**归档正文**（默认 120 行、上限 400 行，带行号 + 摘要；`raw: true` 只出正文）—— 不用 `/batch`、不用 resume |

> 带完整参数说明的版本敲 **`/aihelp`**。

> **异步派活的三条硬规矩**（v1.1.0 起，第 3 条 v1.3.0 加）：
> 1. **结果只回投「派发它的那个主会话」** —— 在 B 会话派完切到 A，结果**不会窜到 A**；等回到 B 才投（后台记录带了 owner，其他会话扫到也不投）。
> 2. **同一子会话运行中不能 resume** —— 正忙时返回「会话正忙」（`session_busy`），**不会偷偷起第二个进程**写同一份文件。要补要求就等它跑完，或换一个新会话重派。
> 3. **投递失败不会「假装成功」**（v1.3.0 起）—— `sendUserMessage` 返回的是 Promise，**发失败就保留重试**（1s→2s→4s…封顶 30s）；超过 10 分钟还是发不出去 → 标 `undelivered`，面板上直接显示 `⚠ N 条没回投`，你还能 `/agents bg redeliver` 手动救。另外还挂了 `agent_settled` 兑底轮询，就算 `/reload` 把定时器弄丢了也不会漏。

---

## 安装

### 方式 A：`pi install`（推荐 —— 给别人用就走这条）

把仓库当 pi 包装进来。**在终端里敲**（不是在 pi 聊天框里）：

```bash
pi install git:github.com/zeke-center/pi-extensions
```

前置：装好 pi（`npm i -g @earendil-works/pi-coding-agent`）。**不需要额外 `npm install`** —— `typebox`、`pi-tui` 这些依赖都由 pi 宿主提供。

> ⚠️ **装的时候别带 `@具体commit`**。git 包按 ref 锁定版本：带 `@<commit>` 装的话，
> `pi update --extensions` 只会「对齐到那个 ref」，**永远不会往前拉**。
> 想能自动更新 → 装裸地址（跟踪默认分支 main）；想锁死版本 → 才用 `@<tag或commit>`。

pi 会 clone 到自己的包目录，按 `package.json` 里的 `pi.extensions` 加载 `ai-configure/pi-extensions.ts`。
仓库自带的 `assistants/*.md` 也会一起被找到 —— **装完就有一个能派的「通用助理」**，不用自己写。

**怎么确认装好了**：

| 敲什么 | 应该看到 |
|---|---|
| `pi list`（终端） | 列表里有这条包 |
| `/assistants`（pi 里） | 有个 `general — 通用助理`，且**可以派** |
| `/aihelp`（pi 里） | 全部命令的说明书 |

> **一个 MCP 都不配也能用。** `general` 不挂任何 MCP，靠读文件 / 跑命令 / 改代码干活；
> 要用 MCP 就在助理的 `mcp:` 行里勾（候选池 `mcp-catalog.json` + 用户级/项目级 `mcp.json`）。

| 命令 | 作用 |
|---|---|
| `pi list` | 看装了哪些包 |
| `pi update --extensions` | 拉最新版（见下） |
| `pi remove git:github.com/zeke-center/pi-extensions` | 卸载 |

**已装的人怎么更新到最新**（实测：`80074fc` → `8ab89ae` 一步到位）：

```bash
pi update --extensions
```

**怎么确认自己装的是最新版**（跟仓库 HEAD 对一眼）：

```bash
git -C ~/.pi/agent/git/github.com/zeke-center/pi-extensions log --oneline -1
git ls-remote https://github.com/zeke-center/pi-extensions refs/heads/main
```

两行打出来的 commit 一样，就是最新。

> 本地改代码时：`pi install ./pi-extensions`（路径直接生效，不用复制，也不用 `/reload`）。
> 已经发到 npm 的话：`pi install npm:@zeke-center/pi-extensions`（目前未发布）。
>
> 只想抄一份模板、不想装插件：把 `assistants/general.md` 拷到 `~/.pi/agent/assistants/` 就行。

### 方式 A₂：Gitee 镜像（国内无梯子）

GitHub 访问不稳/慢的话，用同一个仓库的 Gitee 镜像 —— 内容一样、同步更新：

```bash
pi install git:gitee.com/zqk0815/pi-extensions
```

其余和方式 A 完全一样：`pi list` 确认、`pi update --extensions` 更新、`pi remove git:gitee.com/zqk0815/pi-extensions` 卸载。

**从 GitHub 换到 Gitee**（已经装过 `git:github.com/…` 的人）：

```bash
pi remove  git:github.com/zeke-center/pi-extensions   # 先删旧的
pi install git:gitee.com/zqk0815/pi-extensions         # 再从 Gitee 装
```

> ⚠️ 顺序不能反、也不要**两个源都装**：GitHub 版和 Gitee 版是**同一份扩展**，两个都装会各加载一份、同名工具冲突（`Tool "progress" conflicts`）。换源要「先删后装」。换完 `pi list` 里应该只剩 Gitee 那条。

> **维护方（本机开发）**：`origin` 已配成**一次推两边**（GitHub + Gitee），改完直接敲：
>
> ```bash
> git push
> ```
>
> （`origin` 的 push URL = `git@github.com:zeke-center/pi-extensions.git` **+** `git@gitee.com:zqk0815/pi-extensions.git`。GitHub 那半需要能连上 GitHub，没梯子时它那半会报错、Gitee 那半照常——想彻底免梯子，可在 Gitee 仓库「管理 → 仓库镜像管理 → 推送」里让 Gitee 帮你同步 GitHub。）

### 方式 B：同步脚本（Windows —— 自己改代码时用）

> 别跟方式 A 混用：一个走 `pi install`、一个手动拷到 `extensions/`，混用会**各加载一份、命令注册两遍**。
> 自己开发用 B，装给别人用 A。

pi 默认从 `~/.pi/agent/extensions/` 加载扩展，从 `~/.pi/agent/prompts/` 自动发现提示词模板。用脚本把**扩展、助理模板、提示词模板**同步过去：

```powershell
.\install.ps1
```

脚本用 **SHA256 比对**，所以会告诉你哪个文件真的变了，没变就不白写：

```text
pi 扩展同步
  源    D:\code\pi-extensions
  目标  C:\Users\you\.pi\agent

  [新增] ai-configure\pi-extensions.ts
  [新增] ai-configure\config.ts
  [更新] ai-configure\board.ts  （2026-10-03 20:04 → 2026-10-03 20:17）
  [最新] ai-configure\delegate.ts
  [最新] ai-configure\help.ts

  [清理] ai-config.ts         ← 旧单文件，现在已不存在于源里
  [清理] task-board.ts
  [清理] delegate.ts

  [最新] backend.md
  [最新] db.md

  [新增] ai-delegate.md       ← prompts\

扩展：5 个文件（1 更新, 2 新增, 2 未变）
2 个助理模板：0 更新, 0 新增, 2 未变
1 个提示词模板：1 新增, 0 更新, 0 未变
→ 在 pi 里执行 /reload 生效
```

| 用法 | 作用 |
|---|---|
| `.\install.ps1` | 同步全部扩展 |
| `.\install.ps1 ai-config` | 只同步指定的（可写多个，不带扩展名），同时匹配 `.ts` 和 `.md` |
| `.\install.ps1 -List` | **只对比、不写文件**，用来检查两份是否一致 |
| `.\install.ps1 -Force` | 跳过错比对，无条件覆盖 |

目标目录取 `$env:PI_CODING_AGENT_DIR`，没设就用默认的 `~\.pi\agent`；目录不存在会自动创建。

若 PowerShell 拦执行策略，用 `powershell -ExecutionPolicy Bypass -File .\install.ps1`。

#### ⚠️ 同步前先清掉 `PI_CODING_AGENT_DIR`（真踩过）

**现象**：跑完 `install.ps1`，`diff` 看「没有变化」，实际**一个文件都没装到真实目录**。

**原因**：这个变量可能还指着派活时给子助理用的**影子目录**（`mcp` 隔离会临时改它）。`install.ps1` 只认环境变量，会老老实实把文件同步到那个影子目录里去。

**PowerShell 里没有 `unset`**，所以两边写法不一样：

| 你在哪 | 怎么写 |
|---|---|
| bash / Git Bash | `unset PI_CODING_AGENT_DIR && powershell -File install.ps1` |
| PowerShell | 先 `Remove-Item Env:PI_CODING_AGENT_DIR`，再 `.\install.ps1`（只影响当前窗口） |

**验证**（必须**无输出**，有输出就是没同步到真实目录）：

```bash
diff -r ai-configure ~/.pi/agent/extensions/ai-configure
```

### 方式 A′：手动复制（macOS / Linux）

```bash
mkdir -p ~/.pi/agent/extensions
cp -R pi-extensions/ai-configure   ~/.pi/agent/extensions/
mkdir -p ~/.pi/agent/assistants
cp pi-extensions/assistants/*.md ~/.pi/agent/assistants/
```

无论哪种方式，同步完在 pi 里执行 `/reload`（或重开 pi）。依赖 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox` 都由 **pi 宿主提供**，不用自己装。

### 方式 C：用 settings 指向本目录

不想复制、想直接编辑本仓库的，在 `~/.pi/agent/settings.json` 里加路径（用户设置的相对路径以 agent 目录为基准，绝对路径和 `~` 也支持）：

```json
{
  "extensions": ["D:/code/pi-extensions"]
}
```

> ⚠️ **本仓库是「源」，`~/.pi/agent/extensions/` 里的是「生效副本」。** 两份是独立文件、不会自动同步。改了源之后要跑一遍 ``.\install.ps1`` 再 `/reload`（或者用 `-List` 先确认差异）；用方式 B 就没这个问题。

---

## 模块 0 · gate.ts（会话级停用总闸）

`/ai-ext off` 把**整个扩展**停掉，但**不卸载插件**、不改任何配置文件；`/ai-ext on` 立刻回来。

| 命令 | 作用 |
|---|---|
| `/ai-ext off` | 本会话停用：看板/子代理面板收起、`progress`+`delegate` 从模型工具表撤下、`before_agent_start` 不再注入看板内容、后台回投暂停 |
| `/ai-ext on` | 恢复；**停用期间已跑完的后台结果会立刻补投** |
| `/ai-ext status` | 看状态 + 已接入闸门的模块 |
| `pi --no-ai-ext` / `PI_AI_EXT=off` | 启动即停用（本次运行） |

**怎么实现的（以后加模块照这个来）**

1. 模块入口首行判 `isExtDisabled()`（`import { isExtDisabled } from "./gate"`）；
2. 模块 setup **末尾** `onGateApply("模块名", (off) => { … })` 登记「怎么关自己」——
   **登记时会立刻按当前状态跑一次**，所以晚加载的模块也能正确落到停用态；
3. 工具用 `exposure: "hidden"` **重新注册**来撤下（pi 不允许反注册，官方给的就是这条路），
   所以工具定义必须提成常量（`PROGRESS_TOOL` / `DELEGATE_TOOL`）而不是直接 `registerTool({...})`。

**会话级怎么做到的**：`/ai-ext off` 会 `appendEntry("ai-ext-off", { off: true, at })` 写进**本会话**的
自定义 entry（不进模型上下文）；`session_start` 读该会话最后一条 → 回到停用态。
所以：换会话 / 新建会话 / 别的 pi 窗口都不受影响；老会话重启也记得。

**停用之后仍然能用的**：`/ai-ext`（否则开不回来）、`/aihelp`、`/ai doctor` 这类纯查看/自检，
以及 pi 自带的全部能力。`/board`、`/agents`、`/ai`、`/usage` 会提示「扩展已停用」。

> ⚠️ 别拿它当灯按：切换工具集会被 pi 记进 transcript（下次请求前追加），
> provider 不支持过渡时会收到完整 checkpoint，**缓存前缀会作废**。

## 模块 1 · config.ts（MCP 配置管理命令）

> **v2.5.9 起「从配置中心拉取连接台账」整段删掉了**（用户明确说没用）：不再请求
> 配置中心的 `api/ai/connectors`，也不再有多选 → 会话级/项目级应用那条流程。
> 这个模块现在只剩管理命令。

| 命令 | 作用 |
|---|---|
| `/ai` | 无参数 = 打印说明书（原来这里是拉取入口） |
| `/ai token` | 手动输入 Master 密钥（**只存内存，不落盘**；目前只有 `/ai status` 会看） |
| `/ai off` | 撤销本次会话级注册 |
| `/ai project off` | 从当前项目的 `.pi/mcp.json` 移除本扩展写入的条目 |
| `/ai status` | 查看当前状态 |
| `/ai doctor` | 自检（= `/aidoctor`） |
| `/ai help` | 打印全部功能（= `/aihelp` 的文本版） |

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CENTER_TOKEN` | 无 | Master 密钥初始值，也可以 `/ai token` 设置 |
---

## 模块 2 · board.ts（任务进度看板）

在编辑器上方常驻一个「左大右小」的面板。pi 的 widget 只有 above/below 两个位置，**左右分栏是组件自己画出来的**。

### 工具：`progress`

模型用它打点，也是「先声明计划、再逐步报进度」的实现方式。

| `action` | 其他参数 | 作用 |
|---|---|---|
| `plan` | `title`、`steps[]`、`skipConfirm?` | 声明计划，弹确认框；用户可选「按这个执行 / 我要改 / 先别做」 |
| `step` | `index`、`status`（`pending`/`doing`/`done`/`blocked`） | 更新某一步状态 |
| `block` | `text` | 记录卡点，并说明原因 |
| `clear` | — | 清空看板 |

### 命令

| 命令 | 作用 |
|---|---|
| `/board` | 显示 / 隐藏整个面板（切换） |
| `/board on` · `/board off` | 显式开关 |
| `/board clear` | 清空任务 |
| `/board above` · `/board below` | 面板在输入框**上方** / **下方** |
| `/board right` | 显示 / 隐藏**右区**（MCP / 插件 / 助理 三栏）|
| `/board mid` | 显示 / 隐藏**中栏**（现在 / 本轮 / 会话 / 子代理）|
| `/usage` | **全局用量**：本会话 + 所有子代理的 token 账（含按助理明细表） |

> ⚠️ **`/board off` 只隐藏面板，不是「关掉功能」**：
> - `progress` 工具照旧注册、模型照旧能调（数据依旧更新并 persist）；只是你看不到。
> - 静态规则依旧在 system prompt 的 `<task-board>` 段（只是动态状态那行不再注入）。
> - 与助理完全无关（`/agents` / `delegate` 是另一个模块，`/board off` 不动它）。
> - 想真的停掉看板/助理：卸掉对应扩展文件，或者在派活前自己别调 `delegate`。

### 面板分栏

**左栏（任务）固定最左；右边是几栏会话信息**：

| 栏 | 宽度 | 内容 |
|---|---|---|
| 左（任务） | 自适应，**保底 28** | 任务进度：标题、步骤（最多显示 **8** 步）、卡点、以及**自动跟踪的当前动作**（由 `tool_call` 事件推出，如「读取文件」「执行命令」） |
| 中（运行） | 30 | `现在` / `本轮` / `会话` / `子代理`（详见下）。**面板总宽 ≥ 116 列才出现**，窄终端自动收起 |
| MCP | 平分剩余（上限 26 / 下限 9） | **MCP 服务**（区分 session / project / global 三级） |
| 插件 | 同上 | **已加载插件** |
| 助理 | 同上 | **助理**（`delegate` 现在能派谁） |

> **窄终端自动降级**：面板总宽 **< 88 列**时，MCP / 插件 / 助理 会**叠回一栏**（就是改之前的样子）。
> 名字按**实际栏宽**截断（带 `…`）。所以是 **4 栏**（总宽 < 116）还是 **5 栏**（总宽 ≥ 116）取决于你的终端宽度。

长这样（总宽 100 → 4 栏）：

```text
▛ 任务 看板拆成四栏 · 1/5   │ MCP 7 ●5             │ 插件 3                │ 助理 3
  ✓ 1 拆右栏为三个独立栏    │ ● 全局 my-db          │ ● ai-configure        │ ● 业务数据库助理
  ⠋ 2 渲染改成多栏          │ ● 项目 my-server      │ ● pi-mcp-adapter      │ ● 业务服务器助理
     ▸ 读取文件 board.ts    │ ◌ 全局 some-server…   │ ● some-plugin         │ ● 通用助理
  ○ 3 无头预览各宽度        │ ● 会话 dev-radius     │                       │ ○ 6 个不可派
```

> 面板**曾**有「模型 / token 用量 / git 分支」一行，已删 —— 一是你不想看，二是它每 2.4s 要跑一次 `git branch` 子进程。想看 token 用量和成本，用内置的 **`/session`**。

#### 「中栏」一栏

常驻显示**这一次到底花掉了什么**。四行：

| 行 | 内容 |
|---|---|
| `⚙ 运行 · N 轮` | 标题 + 本会话跑过几轮（**一轮 = 一问一答**） |
| `现在` | `生成中 · 62t/s`（流式实时估算） / `工具 · 3.2s` / `思考中…` / `待命` |
| `本轮` | 本回合**真正在跑**的时长 + `↑输入 ↓输出 R缓存` |
| `会话` | 本会话**累计活跃时长** + `↑↓R` |
| `子代理` | 所有 `delegate` 子会话的累计 + `↑↓R`（没有子代理时不显示这一行） |

**四条关键设计**：

1. **「一轮」= 一问一答，不是一次模型请求**。pi 里 `turn` 是「一次模型请求」，而一次问答里可能夹着好几次请求（工具调用）。面板统计的是 `agent_start` → `agent_settled`。
2. **计时只在真正运行时走**：跑完**立刻定格**，不会继续涨；**弹窗等你点按钮的时间扣掉**（否则发会儿呆，时长就虚高了）。
3. **TPS 是估算值**：用流式回调里的**字符数**除以时间；每轮结束再拿 API 返回的**真实 `output` token** 反推 `charsPerToken` 自动校准（首次默认 2.0）。所以它只能「看个趋势」，不是精确值。
4. **子代理的账要单独扫**：`delegate` 的返回值里**不含 usage**，子代理的用量只写在它自己的会话文件里 —— 所以 `/usage` 和这行会去扫 `~/.pi/agent/assistant-sessions/*/*.jsonl`，**按 mtime + size 缓存**，不是每帧重读。

**token 只能「跳跃更新」** —— 只有每次 API 请求结束才知道真实用量（流式过程中只数得到字符）。所以**时长是连续涨的，token 是一跳一跳的**，这是物理限制，不是 bug。

**三色**：`↑` 输入（亮） / `↓` 输出（accent） / `R` 缓存命中（灰）。**不显示命中率** —— footer 的 `CH` 已经有了，中栏不重复。

#### 「MCP」一栏

```
 MCP 7 ●2
 ● 全局 my-db
 ◌ 全局 other-server
 ● 项目 my-server
```

| 标记 | 意思 |
|---|---|
| `●` | **已经见到它的工具** —— 真的连上了（有证据） |
| `◌` | **还没见到它的工具** —— 还没连上 / 还没调用过。**不是「挂了」** |

表头 ` MCP 7 ●2` = 一共配了 7 个、其中 2 个已连上（全部连上时就不显示后面那段）。

**为什么不能直接查「连了没」**：pi 没把这个状态暴露给扩展 —— 内置 MCP 扩展内部的 `connection.state` 拿不到；`getMcpServers()` 只报「拓展自己 `registerMcpServer()` 注册的」，跟 `mcp.json` 里的服务器无关（实测就是空的）。所以只能从**工具名**反推。

而 MCP 是**后台连**的：实测从会话开始到工具出现要 **~10 秒**（工具数 12 → 19）。因为信号来得慢，面板就**多刷**：空闲时全量刷（2.4s）、**有步骤在跑时也刷 MCP 那一栏（1.5s）**、每轮开头刷一次、以及**跑完任何一个 `mcp__*` 工具立刻刷**。所以那个「慢」不会让你看到假的 `◌`。

> ⚠️ 想要**权威**的实时状态（看清 `connected` / `failed` / `needs-auth`、能手动 reconnect），敲 pi 内置的 **`/mcp`** —— 面板那栏只是个「一眼扫」的近似。

#### 「助理」一栏

```
助理 2
 ● 业务数据库助理
 ● 业务服务器助理
 ○ 6 个不可派
```

只列**能派的**（名字就是你传给 `delegate` 的 `assistant`）。
`base`（底座）和 `demo`（样板）派了会被拒，所以只数个数、不列名 —— 否则白白占两行。
数据来自 `delegate.ts` 导出的 `loadTemplates(cwd)`，跟插件一起在同一个低频刷新点更新（**不是每帧扫盘**）；MCP 那栏刷得更勤，见上。

> 代价：新增/改名助理后最多 **2.4s** 才出现在「助理」栏；派发本身不缓存，随时改随时生效。

### 防止「看板不动」（v1.11.0 起）

多步任务常常**在同一次用户输入里**就跑完了（一整轮 = 一个 turn），而最早的过时判定只数 turn
→ 轮内永远不报警，模型从头做到底一次也不更新看板，面板一直停在 `0/N`（实测踩过）。

修法：
- **轮内计数**：自上次 `progress()` 起跑了几次工具调用（只数顶层，codemode 的 nested 调用不算）
- **轮内提醒**：每 8 次工具调用，往工具结果后面附一句「这轮已经 8 次调用没调 progress()，做完一步就标 done」
  （pi 允许 `tool_result` 处理器改写内容 → 这是唯一能在**同一轮里**让模型看到提醒的地方）
- 过时判定同时看「N 轮没更新」和「本轮 N 次调用没更新」，提醒里带上进度和距上次更新的分钟数

### ③b 会话替换：背景回调绝不许碰旧 ctx（会崩整个 pi 进程）

> 真实事故（crashes.json 里躺着）：`/new` 或切会话之后，后台定时器/子进程回调拿着**已被 pi 失效的旧 ctx** 读 `ctx.hasUI` → 抛
> `This extension ctx is stale after session replacement or reload` →
> **定时器/子进程回调里没人接这个异常 → 整个 pi 进程崩掉**。
> 表现就像是"我刚改完名/刚切会话，会话不见了"。

pi 的规矩（`docs/extensions.md`）：`newSession/fork/switchSession/reload` 之后**旧 ctx 彻底作废**，
任何属性访问都会抛；要把工作搬进 `withSession` 的回调，或者等新的 `session_start`。

本插件的做法（`shared.ts`）：

| 工具 | 作用 |
|---|---|
| `isStaleCtxError(e)` | 认得出 pi 的 stale 报文（普通错误**不**冒充，别吞真 bug） |
| `guardCtx(ctx, fn)` | 用缓存 ctx 干活的唯一入口：`{ok:false, stale:true}` 时调用方就**清掉缓存**，等下一个 `session_start` 自动恢复 |

后台路径（子进程输出、`setInterval`、后台助理回投）**全部**走 `guardCtx`：
`delegate.pollBgTasks`（`bgCtx.isIdle`）· `board` 撤 widget。单测里有一条专门的模拟：拿一个"一碰就抛"的假 ctx 去打真实回调链，
并且验证过**回退修复时它会 FAIL**。

### ④ 总控制台 `/aihelp`（首选入口：配置 + 助理 + 命令都在这儿点）

**v2.2.0 起 `/aihelp` 是插件的总控制台**：助理**一人一行**，回车在**同一个框里**翻进它的编辑页
（面包屑 `⚙ ai-configure › 总览 › 助理 › db`，esc 逐层返回，不弹第二个面板）。
**命令不进面板**（面板只放配置和助理）—— 命令直接敲，完整清单见上一节「命令总览」。

```
╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ⚙ ai-configure 总控制台                                                                          │
├────────────────────────────────────────────────────────────────────────┬─────────────────────────┤
│ ▾ 助理 (10)                                                            │ 助理 · db               │
│     general        可派 · 什么都能干…                                  │                         │
│     role-dev       底座 · 开发类助理…                                  │ 连数据库查数据、验证数  │
│     role-doc       底座 · 写文档 / 总…                                 │ 据、探表结构时用我。默  │
│     role-ops       底座 · 只读类助理…                                  │ 认只读，不主动改数据。  │
│     role-review    底座 · 代码审查 / …                                 │ 互相独立的多件查询可以  │
│     backend        样例 · ← role-dev · 改后端代码…                     │ 一次并行派给我。        │
│ ▸   db             样例 · ← role-ops · 1 MCP · 连数据库查…             │                         │
│     frontend       样例 · ← role-dev · 改前端页面/…                    │ 角色：示例样板（继承 ro │
│     server         样例 · ← role-ops · 1 MCP · 看服务器状…             │ le-ops）                │
│     ＋ 新建助理                                                        │ MCP：my-db              │
│ ▸ 委派 (1)                                                             │ 超时：300s              │
│ ▸ 看板 (3)                                                             │ AGENTS.md：读           │
│ ▸ 会话级（重启复位） (2)                                               │ 文件：…ssistants\db.md │
│ ▸ 命令 (7)                                                             │                         │
│                                                                        │ 回车 = 打开编辑面板（名 │
│                                                                        │ 字 / 何时派它 / 底座 /  │
│                                                                        │ MCP / 超时 / 正文）     │
├────────────────────────────────────────────────────────────────────────┴─────────────────────────┤
│ ↑↓ 选行 · 回车 改 · ←→ 收起/展开分组 · ctrl+s 保存 · esc 取消                                    │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**v2.2.0 起是「一个框里翻页」：总览 → 组 → 项，`esc` 逐层返回**，右栏始终是当前这行/这页的说明（3:1 双栏）。

第 1 页 · 总览（回车进组）：

```
╭──────────────────────────────────────────────────────────────────────────────────╮
│ ⚙ ai-configure › 总览                                                            │
├──────────────────────────────────────────────────────────┬───────────────────────┤
│ ▸ 助理                 10 项 · 10 个动作                 │ 助理                  │
│   委派                 1 项                              │                       │
│   看板                 3 项 · 3 个动作                   │ 每个助理一行。回车进  │
│   会话级（重启复位）   2 项                              │ 去能看到它的角色、继  │
│   命令                 7 项 · 7 个动作                   │ 承的底座、MCP、超时…  │
├──────────────────────────────────────────────────────────┴───────────────────────┤
│ ↑↓ 移动 · 回车 进入这一组 · ctrl+s 保存 · esc 退出                               │
╰──────────────────────────────────────────────────────────────────────────────────╯
```

第 2 页 · 回车「助理」（同一个框，标题变面包屑）：

```
│ ⚙ ai-configure › 总览 › 助理                                                     │
├──────────────────────────────────────────────────────────┬───────────────────────┤
│ ▸ ← 返回总览                                             │ 助理 · db            │
│   general       可派 · 什么都能干…                       │                       │
│   role-dev      底座 · 开发类助理…                       │ 连数据库查数据、验证  │
│   …                                                      │ 数据、探表结构时用我  │
│   db            样例 · ← role-ops · 1 MCP · 连数据库…    │ 角色：示例样板        │
│   …                                                      │ 继承：role-ops        │
│   ＋ 新建助理                                            │ MCP：my-db            │
├──────────────────────────────────────────────────────────┴───────────────────────┤
│ ↑↓ 移动 · 回车 编辑/执行 · esc 返回总览 · ctrl+s 保存                          │
```

第 3 页 · 再回车「db」（还是同一个框，变成编辑页）：

```
│ ⚙ ai-configure › 总览 › 助理 › 数据库助理                                        │
├──────────────────────────────────────────────────────────┬───────────────────────┤
│ ▸ ← 返回助理列表                                         │ 显示名                │
│   文件名         db                                      │                       │
│   显示名         数据库助理                              │ (中文也行)            │
│   描述           连数据库查数据、验证数据…               │                       │
│   基础模板       role-ops                                │                       │
│   MCP            1 个：my-db                             │                       │
│   提示词正文     (351 字)                                │                       │
├──────────────────────────────────────────────────────────┴───────────────────────┤
│ 回车 改 · ctrl+s 保存（退回列表）· esc 返回上一层                              │
```

要点：

- **全程一个框**：不回退到"关掉面板 → 再开一个"，标题栏就是面包屑
- **`esc` 逐层返回**：编辑页 → 组页 → 总览 → 关闭；每层的光标位置都记着
- **动作行在本页执行**：`/ai`、`/board` 这类命令点了面板不关（要选子命令才弹二级选单）
- **配置项落到单项页**：回车进这一项的大视图，改完 `ctrl+s` 保存并留在本页
- **助理页复用同一套字段**：`delegate.ts` 的字段构建抽成了 `assistantFormParts`，面板和 `/assistants edit` 共用一份
- **窄屏（<90 列）退回单栏**，说明回到列表下方
- **列表超过 30 行才开视口**，首尾提示 `↑ 还有 N 行` / `↓ 还有 N 行`
### 其他

- **状态会持久化**：每次更新都 `pi.appendEntry("task-board", …)`，所以 `/resume`、`/tree`、fork 之后看板还在。
- 监听的事件：`session_start`、`tool_call`、`agent_start`、`agent_end`、`agent_settled`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`ui_prompt_start`、`ui_prompt_end`、`model_select`、`mcp_servers_change`、`before_agent_start`、`session_shutdown`。
- **`agent_end` 和 `agent_settled` 都收（双保险）**，用 `runAccounted` 标记防重复入账 —— 只挂其中一个，遇到压缩 / 自动重试 / 排队续跑时可能漏记。
- 顶栏的 spinner 会随 agent 运行状态动。

---

## 模块 3 · delegate.ts（派活给临时助理）

主 pi 多一个 `delegate` 工具：**另起独立的 pi 进程干活，只把一张卡带回来**。中间过程不进主对话（但会话文件在，可以回看），且助理会话**不污染 `/resume`** —— 用 `/resume-agent` 单独翻。

| 什么时候用 | 什么时候别用 |
|---|---|
| 过程很脏、要试错、**你只要结论** | 查一条数据你**也想看过程** —— 那自己用 MCP 查 |

### 用法

| 做什么 | 怎么写 |
|---|---|
| 看有哪些助理 | `/assistants` |
| 派一件活 | `delegate(assistant="db", task="…")` |
| **同时派多件**（并行） | `delegate(assistant="db", tasks=["查 A", "查 B"])` |
| **续跑**没做完的 | `delegate(assistant="db", task="接着做…", resume="<上次的会话ID>")` |

### 并行

`tasks` 数组里的任务会**同时**跑（`Promise.all`），总耗时 ≈ 最慢的那件：

```
串行：10s + 12s + 8s = 30s
并行：max(10, 12, 8) = 12s
```

只在任务**互相没有依赖**时用。有依赖（比如「前端要看后端接口怎么写」）就分开派，或在任务里写清「自己去读 xxx 文件」。

⚠️ 并行 = 同时打 N 个模型请求 + N 份完整上下文，成本和限流要留意。

实测（真实派发，不是估算）：

| 一批 | 各件耗时 | 整批墙钟 | 串行要多久 | 省了 |
|---|---|---|---|---|
| 数据库查表 + 服务器体检 | 18s / 11s | **18s** | 29s | **38%** |
| 内存 top8 + 翻日志 + du 全盘 | 13s / 25s / **300s 超时** | **300s** | 338s | 11% |

**教训：一批的时间 = 最慢那件，快的那几件完全被浪费。**
第二行里两件 13s/25s 的早就交卷了，大家却一起等到 `du` 扫完盘、撞上 5 分钟默认超时才收。

所以：

- ✅ **一批同类活**（都是 10~30s 的查询 / 体检 / 翻日志）→ 真省时间
- ❌ **混进一件可能卡很久的**（扫全盘、大范围搜索、装依赖、跑测试）→ 整批陪你等，白搭
- 👉 那种给慢活改用具模板的 `timeout` 单独放宽（或干脆不给），**别把它和快活混在一批里**
- 👉 真卡住的用 `resume: "<会话ID>"` 续，历史都在，不会重做
- 👉 想知道**逐件进度**（而不是干等整批）：把 `superagent.batchLive` 打开（写在 `~/.pi/agent/ai-extensions.json` 的 `superagent` 块下，**默认关**）—— 每完成一件回投一条 **≤60 字短卡**，一批最多 **4** 条（并发上限），序号 1 基

### 超时：到点前先叫停，不会再白跑

子进程跑在 `pi --mode rpc`（**双向**）上，所以到点前能插话 —— 而不是像以前那样只能 SIGKILL。

| 档位 | 时机 | 动作 |
|---|---|---|
| **软档** | `T - max(120s, 25%·T)` | `steer` 一句「开始收尾，把已确认的结论整理出来」。不打断它，只在两个 tool call 之间插话 |
| **硬档** | `T - 45s` | `abort` **真的打断**当前工具调用 → 再追一句「立刻交卡」。上下文还在，所以能拿到**真结论**而不是一句空话 |
| 兑底 | `T` | 仍然 `killTree`。绝不留孤儿 |

超时卡片会带上：**阶段成果**（不是只有半成品文字）+ **工具时间线**（哪几条最慢）+ **收尾动作** + `resume` 会话 ID。

实测（不是估算）—— 派一个「跑 `sleep 240`」的活，`timeoutMs=180000`：

```
【通用助理】超时被停止（137s）
状态: 超时（到点前已叫停，下面是它交回的阶段成果）
状态: 卡住
结论: 未完成：`sleep 240` 需要 240 秒，超出本会话 180 秒时限……
证据: 执行 `time sleep 240`（timeout=175）→ 输出 "Command aborted"
它调用过：bash
最慢的几步：bash 134.0s
收尾动作：收尾提醒 → 打断卡住的 run → 追问交卡

要接着做就再调一次 delegate，带上 resume: "general-20261010-170806-1" ……
```

> 超时**不等于失败**。它会把阶段成果交回主会话，由你自己（或主会话）判断要不要 `resume` 重启，而不是自动偷偷重跑。

前提与回退：

- 需要 pi 支持 `--mode rpc`。开工前用 `pi --help` 探一次（进程内缓存），**不支持就自动回退**到旧的单向模式，行为与改造前一致。
- `PI_DELEGATE_RPC=0` 强制走旧路径（应急开关）。
- 时限低于 3 分钟不发收尾提醒（提醒本身也要占一个 turn）。
- ⚠️ `abort_bash` **不用指望**：它只管 RPC 客户端自己发的 `bash` 命令，掐不动模型的 bash 工具调用。能打断它的是 `abort`。

### 生命周期：退出 / 中止 / 面板保鲜期

**⚠️ 退出 pi = 中止所有在跑的子代理。** 看门狗会在主进程退出时 SIGKILL 子进程（这是
「不留孤儿」的代价 —— 否则你关掉窗口后还有看不见的进程在烧钱）。所以：

- 有子代理在跑时，面板会显一行：`⚠ N 个助理在跑 / 退出 pi 会中止它们`，状态栏也有 `⏳ N 个助理在跑`。
- 真的退出了，那些后台任务会被当场标成：

  ```
  （主会话退出，任务被中止）
  要接着做：回到主会话重新派一次，带上 resume: "general-20261010-171720-1" —— 它的历史都在，会接着做而不是重做。
  ```

  （以前是只杀进程、不写状态 —— 要等下次启动 10 分钟后才看到一句误导的「孤儿任务：子进程已消失」。）

**面板保鲜期**：子代理跑完后会在面板上呆 **45 秒**再自动摘掉（以前只有“下次派活前”才清，
所以跑完的会一直堆着）。改：`/agents linger 2m` / `/agents linger 0`，落在 `~/.pi/agent/ai-extensions.json`。

**孤儿判定按任务自己的 deadline**：每个后台任务记 `deadlineAt`（= 派发时刻 + `timeoutMs` + 2 分钟余量），
超了才标失败。**不写死 10 分钟** —— `timeoutMs` 最大 30 分钟，写死会把一个设了 20 分钟的活
在第 10 分钟误判成失败，先投一张假失败卡、等它真跑完再投一张。

**记账小票的回收**：派异步任务时会在 `assistant-sessions/.bg/<会话ID>-<随机>.json` 写一张小票（投递记账）。
**只有同时满足「已投递成功 + 超过 24 小时」的才在下次启动时自动删**；
没投成功的一律不碰（你还能 `/agents bg redeliver`）。

> 小票 ≠ 会话。助理的**完整对话历史**在 `assistant-sessions/<助理>/<时间>_<会话ID>.jsonl`，
> 那是 `/resume-agent` 和 `resume` 续跑靠的东西，**永远不会被回收**（单测里把这条钉死了）。
> 小票只是“这张卡投进主对话了没”的一行回执，0.6~1.8 KB；会话是 14~38 KB 起步。

**看板里的数字只算本对话**：`⚠ N 条没回投` 只统计**本对话**派出去的 ——
别的会话遗留的小票不会在你这儿刷警告（`/agents bg redeliver` 本来就只投自己会话的，口径保持一致）。

### 结果怎么回主会话（唤醒）

异步派出去后，结果靠一个小轮询回投（`session_start` 挂 1 秒定时器，`agent_settled` 再兑底一次）。三个要紧的设计：

1. **只在主会话空闲时投，流式时传 `deliverAs: "followUp"`，旧版 pi 自动降级**。
   pi 在 streaming 时 `sendUserMessage` 只是「入队」（followUp），而用户按 Esc 中止时 pi 会
   `clearQueue()` 把队列**交还给编辑器** —— 卡片没进上下文，可发送方已经 resolve，我们会
   记成 `delivered: true` → 永远不再重投（这就是以前「助理跑完了但唤不醒主会话」的一个根因）。
   空闲时普通 prompt 必然起新一轮；万一撞上竞态会直接报错 → 记失败重试，**不会假成功**。
2. **认领锁带接管**（`<id>.json.claim`）：同一个会话开在多个实例上时只允许一个投；
   但持有者进程死了 / 锁太旧（>60s）就接管 —— 否则残留锁会让这条结果被**永远跳过**，
   既不投也不标 `undelivered`（面板上看不出问题）。
3. **轮询在扩展加载时就挂**，不只靠 `session_start`：`/reload` 之后万一 `session_start` 没触发，
   光靠 `agent_settled` 要等你再发一句话才轮得到，助理结果就一直躺着。

真的没投成功（发不出去 / 超时）时会标 `undelivered`，面板上显示 `⚠ N 条没回投`，
可 `/agents bg redeliver` 手动救 —— 不会静默丢。

### 结果去哪儿了（v2.5.9 起）

子助理跑完后，**正文不再塞进主会话上下文**（避免上下文膨胀）。回投卡带的是：
- 状态（done / failed / timeout）
- **结论 + 证据**（取结构化回执：结论 ≤3 行、证据 ≤5 行；没有回执才退化成摘要首行）
- 归档路径（`~/.pi/agent/results/<YYYY-MM-DD>/task-<id>.md`）

> v2.5.9 之前连结论都被归档掉了，用户和 Router 都看不到重点；现在重点直接进回投卡。
> 卡片摘要也不再抓错行（以前会把正文里的编号列表当成结论）。

要看完整正文，三条路任选：`read_result <id>`（工具，可带 `raw` / `offset` / `limit`）、`/batch <id>`、直接打开那个文件。
小任务（正文 ≤300 字）仍然直接贴全文，省一步。
归档保留 30 天（`superagent.resultsKeepDays`，0 = 不清理）。

### 命名规则

每次派发都会开一个**会话**，名字分两种：

| | 格式 | 例子 |
|---|---|---|
| **显示名**（`/resume-agent` 里看到的） | `<主进程名>-<代理名><序号>` | `修复登录bug-数据库助理1` |
| **会话 ID**（ASCII，机器用） | `<助理指纹>-<年月日>-<时分秒毫秒>-<序号>` | `yd4ljq-20261013-102109-802-1` |

> **Herdr 里的短名**（v2.5.7 起见名知意）：pane 标题 = `状态 助理名#序号 · 任务摘要`（`▶ 数据库助理#1 · 查订单表结构`），
> tab 标题 = `sa:<n> · 助理名列表`（`sa:1 · 数据库助理,通用助理`）。

> ⚠️ **ID 里必须带「助理指纹」**（v1.9.0 起）：pi 硬性要求会话 ID 只能是 ASCII，中文助理名过一遍清洗（`[^A-Za-z0-9\-_.]` → `-`，再把首尾非字母数字剥掉）会被**整段抹掉** ——
> 于是 `个人中心服务器助理` 和 `个人中心数据库助理` 在同一秒派发会得到**完全相同**的 ID（都退化成 `20261013-102109-1`），第二个直接被会话锁拒掉。**这不是巧合，是必然。**
> 现在把助理 key 用 **FNV-1a 哈希**压成 6 位 ASCII 指纹（`yd4ljq` / `1cx6p4` / `a6tffv`）拼在最前面，并且时间戳**精确到毫秒**，并发派多少个都不会撞。

- 主进程名 = 主 pi 的 `/name`；没设就是 `主进程`
- 序号 = 该代理**在本会话里第几次被派**（累加，所以不会撞名）
- **时间戳在 ID 里**，所以你能知道「哪个任务、什么时候」干的
- 会话 ID 只允许 ASCII 字母数字 `-_.`（pi 的硬性要求），所以中文显示名和 ID 是分开的

### 会话存在哪儿（为什么 `/resume` 里看不到）

**助理会话不落在 `~/.pi/agent/sessions/` 里** —— 否则派几次就把主项目的 `/resume` 列表刷满了。
它们单独放在：

```
~/.pi/agent/assistant-sessions/<助理 key>/<时间戳>_<会话ID>.jsonl
```

| 想干什么 | 怎么做 |
|---|---|
| 在 pi 里翻（推荐） | **`/resume-agent`** ← 列出历次会话，选中就切过去看；`/resume-agent db` 只看某个助理 |
| 拿文件路径直接进 | `pi --session "<文件路径>"` |
| 自己扫目录 | `ls ~/.pi/agent/assistant-sessions/<助理 key>/` |

卡片尾部的「找回」那行会直接把可粘贴的命令打给你：

```
──── 本次派发 ────
会话名  修复登录bug-数据库助理1
会话ID  db-20261003-195122-1
代理    数据库助理（db · deepseek-v4-flash）
目录    D:/code/my-project
任务    查 records 表有多少行
耗时    6s
找回    /resume-agent 里挑，或 pi --session "<agentDir>\assistant-sessions\db\<时间戳>_db-20261003-195122-1.jsonl"
```

### 超时与续期

**到点就杀，绝不放任它继续跑**（所以永远不会留孤儿）。杀了以后你能拿到：

- 它**已经产出的文字**（靠 `--mode json` 流式抓的 —— 文本模式拿不到，它在结束前不输出）
- 它**调用过哪些工具**
- 它的**会话 ID**

要接着做，就带上 `resume` 再派一次：历史都在磁盘上，它是**接着做**，不是重做。

超时默认 **5 分钟**，单次上限 30 分钟。助理的系统提示词里会自动追加一条「到时限就交半成品，别硬撑」。

### 停止：三层，不留孤儿

| 层 | 什么时候 | 做什么 |
|---|---|---|
| 1 | 主 pi 被中止（Esc） | 杀掉所有在跑的子进程 |
| 2 | 主 pi 正常退出 | 同上（`process.on("exit")`） |
| 3 | 主 pi 被**强杀**（任务管理器 / `kill -9`） | **看门狗**：子进程每 2 秒探一次主进程是否还活着，主进程没了就自杀 |

第 3 层靠一个 12 行的 node 包装器实现（代价：每次派发多一个中转进程）。实测主进程被强杀后 **1.5s 内**子进程消失。

Windows 下杀的是**整棵进程树**（`taskkill /T`），所以助理自己起的 bash 子进程也一起走。

### 助理模板

三处都能找到模板，**前面的优先**（同名时后面的直接忽略）：

| 位置 | 用途 |
|---|---|
| `<项目>/.pi/assistants/*.md` | 项目级 —— 这个项目专用的助理 |
| `~/.pi/agent/assistants/*.md` | 全局 —— 所有项目都能用 |
| `<包根>/assistants/*.md` | 包自带 —— `pi install` 装进来时自带的那几个样板 |

文件名（去掉 `.md`）就是 `key`。

#### 文件长什么样（v2.6.0：顶部可以放 `<!-- -->` 说明块）

`---` **之前**可以随便写说明文字，最常见的写法是用 HTML 注释包一块「字段速查」——
解析器只认第一个 `---` 开始的那块 frontmatter，**前面的内容一律跳过**（v2.6.0 起修好了，
以前顶部有东西整份模板会失效）。`/assistants new` 新建时就是直接生成下面这份：

```markdown
<!--
db · 助理配置（改完下一次派活生效，不用 reload）

字段速查：
  name          名字（唯一，面板显示这个）
  description   ⚠️ Router 靠它挑人，别空着。写清「什么活该派给我」+ 触发词
  extends       继承底座（role-dev / role-ops / role-doc / role-review，可省略）
  cwd           工作目录，${cwd} 表示项目根
  mcp           要连的 MCP：名字 / inherit（继承主会话）/ 留空=一个不连
  fs            文件权限：read | write
  exec          执行权限：none | any | cmds
  net           联网：none | allow
  paths         可写目录（fs=write 时生效）
  timeout       单次超时，如 8m
  maxTurns      最多轮数（默认 60，到 80% 会被要求收尾）

详细说明见 README「助理模板字段」。
-->

---
name: 数据库助理
description: 查库表结构、写只读 SQL、排慢查询。用户提到「查数据 / 表结构 / SQL」时用我。
cwd: ${cwd}
mcp: inherit
fs: read
net: none
timeout: 8m
maxTurns: 40
---

你是一个数据库助理。拿到任务先确认库和表，再动手查。
```

> 描述写成 `description:` 或老的 `desc:` **都认**（v2.6.0 起；两个都写时以 `description` 为准），
> 按 Claude 的 subagent 写法写的文件直接能用，不用改。描述留空时 `/assistants` 里会显示
> `⚠ 无描述` —— Router 就是靠这句话挑人的，空着等于永远选不中（不拦保存，但别留空）。

#### 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `cwd` | | **在哪儿干活**。文件读写、相对路径、项目 `AGENTS.md` 都看它。**省略 = 跟随主进程当前所在的项目目录**（所以模板能跨机器复用，别在里面写死绝对路径） |
| `name` | | 显示名（中文也行）。省掉用文件名 |
| `description` | | **什么时候该叫我**。不只是给人看的 —— 主 pi 就是靠这句话决定派谁，所以写「什么时候用我」，别写「我是谁」。**旧写法 `desc` 也认**（两个都写时以 `description` 为准） |
| `maxTurns` | | 这个助理最多跑多少轮（v2.6.0）。留空 = 用全局 `superagent.maxTurns`（默认 60）；模板写了就以模板为准（5~500）。到 80% 会被要求「停止探索、立刻总结」，到顶就停下标 `partial` |
| `mcp` | | 要挂的 MCP 名字，逗号分隔（`mcp: my-db, my-server`）。**留空 = 一个都不挂**。写 `inherit` = 继承主会话的 MCP，见下 |
| `timeout` | | 默认超时，如 `10m` / `90s` / `1.5h`。省掉 = 5 分钟 |
| `model` | | 指定模型（如 `deepseek-v4-pro` 或 `provider/id`）。**留空 = 继承主会话当前模型** |
| `mcp_exposure` | | `codemode`（默认）/ `direct`（专职助理更省事）/ `deferred` |
| `agents_md` | | `false` = 不带全局 `AGENTS.md`，每次省约 1500 token |
| `extends` | | 继承父模板，见下 |
| `base` | | `true` = **只给 extends 用，不能直接派**（拿来写公共规矩） |
| `demo` | | `true` = **示例模板：能看 / 能 show / 能 extends，但绝对不能派** |
| `enabled` | | `false` = 列表里不显示、也派不了 |
| `tools` | | **工具白名单**（逗号分隔）。写了就只给列出的工具。✅ pi 1.0.4 起 **MCP 工具默认保留**（白名单里没写 `mcp__` 也会照常可用）；只有白名单里出现 `mcp__` 开头的条目时才按它过滤 MCP。要连 MCP，记得模型得能看见工具（`-t` 里给 `codemode`，或直接列 `mcp__<server>__<tool>`） |
| `deny_tools` | | 额外禁用的工具，逗号分隔（追加到默认的 `delegate,progress` 黑名单） |
| `isolate_env` | | `true` = **环境变量隔离**：子进程只拿一份白名单（系统必需变量 + `PI_*`/`NODE_*`/`npm_*`）。默认 `false`（继承全部）。⚠️ 模型 key 若只放在环境变量里，要用 `env_passthrough` 显式保留 |
| `env_passthrough` | | `isolate_env: true` 时额外保留的环境变量名，逗号分隔（如 `ANTHROPIC_API_KEY`） |

#### 助理能连哪些 MCP

| 写法 | 效果 |
|---|---|
| （不写） | **一个都不连**（默认，最安全） |
| `mcp: center-pg` | 只连候选池里这几个 |
| `mcp: inherit` | **继承主会话的 MCP**（用户级 `~/.pi/agent/mcp.json` + 项目级 `.pi/mcp.json`） |
| `mcp: inherit, center-pg` | 继承 + 再从候选池补一个（同名以显式写的为准） |

⚠️ `inherit` 会把主会话**全部** MCP 交给子助理（可能含可写库、SSH），等于放大权限 ——
只给可信助理开；派活卡片上会提示「⚠ 已继承主会话 MCP（N 个…）」。

#### 权限（Super Agent 模式生效）

frontmatter 里 6 个扁平键。**默认很保守**（`read` / `none` / `none`）—— 要写、要跑、要联网都得显式打开。

| 字段 | 取值 | 说明 |
|---|---|---|
| `fs` | `read`（默认）/ `write` | 只读就不发 `write`/`edit` |
| `paths` | 逗号分隔，支持 `${cwd}` | 可写范围。**留空 = 不限目录**（等于全盘可写） |
| `exec` | `none`（默认）/ `safe` / `any` | `safe` = 只允许 `cmds` 里的命令 |
| `cmds` | 逗号分隔，支持末尾 `*` | `exec: safe` 的白名单（`npm test*` / `npx tsc*`） |
| `net` | `none`（默认）/ `allow` | 允许联网（拉依赖 / `curl` 排障） |
| `budget` | `120k/10m` | 只做声明，不强制 |

三层表达：**L1 工具面**（`fs: read` 就不发写工具）→ **L2 提示词**（把边界写进它的 system prompt，让它规划时就不越界）→ **L3 guard 兜底**（Worker 影子目录里装 `guard-entry.ts`，`tool_call` 那一刻再判一次）。

**自带的 `general` 模板**：`fs: write` + `paths: ${cwd}`（只允许写自己项目目录）+ `exec: any` + `net: allow`。
为什么 `exec` 不设白名单：dev 角色要跑 `build` / `commit` / `push`，命令白名单对 `node`/`powershell` 等于没限 —— 与其给一个假的安全感，不如靠 guard 记日志。

**exec 硬拦开关**：`<影子目录>/guard-config.json` 里写 `"execHardBlock": true` 时，`exec` 命中外也硬拦；默认 `false` = 只往 `guard.log` 记一行 `WOULD_BLOCK`（观察期，先量误拦率）。`guard-config.json` 由派发时自动重写，所以长期生效要改的是模板/生成逻辑，不是影子目录里那一份。

#### 配置面板（`/assistants new` · `/assistants edit <key>`）

`new` 和 `edit` 弹的是**同一个面板**，不是一个字段问一次。`↑↓` 选行 · `回车` 改 · `ctrl+s` 保存 · `esc` 取消。
编辑中按 `esc` 只放弃当前这一行；`ctrl+s` 在任何模式下都能直接存。

```
╭─────────────────────────────────────────────────────────────────────────╮
│ 助理模板 · 新建                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ ▸ 文件名           db                 (去掉 .md —— 派它时就用这个名字)   │
│   显示名           数据库助理          (中文也行)                         │
│   描述             连数据库查数据…     (写「什么时候用我」，主 pi 靠它决定派谁) │
│   工作目录         D:/code/my-project  (在哪儿干活：文件读写 / 项目 AGENTS.md) │
│   模型             (空)               (留空 = 继承主会话)                  │
│   超时             5m                 (10m / 90s / 1.5h，留空 = 5 分钟)  │
│   带 AGENTS.md     是                 (关掉每次省约 1500 token)           │
│   MCP              1 个：my-db       (回车勾选能连什么 —— 跟工作目录无关) │
│   可派发           是                 (关掉 = 写 demo: true：能看能改，但派不了) │
│   保存到           全局（所有项目都能用）                                  │
│   提示词正文       (357 字)           回车 = 保存并打开编辑器              │
├─────────────────────────────────────────────────────────────────────────┤
│ ↑↓ 选行 · 回车 改 · ctrl+s 保存 · esc 取消                                │
╰─────────────────────────────────────────────────────────────────────────╯
```

各行的改法：`回车` 进本行编辑（`esc` 放弃本行）· `bool` 行直接切换 · `MCP` / `保存到` 回车展开候选再选。

#### 存在哪（永久，不是一次性的）

写的是磁盘上的 `.md` 文件，跟会话无关，重启 pi 照样在：

| `保存到` | 落到哪 | 谁能用 |
|---|---|---|
| `全局` | `~/.pi/agent/assistants/<key>.md` | 所有项目 |
| `项目级` | `<工作目录>/.pi/assistants/<key>.md` | 只那个项目（**同名时项目级优先**） |

鼠标不知道存哪了、改完想确认，就 `/assistants show <key>` —— 第一行「文件」就是完整路径。

三个细节：
- 编辑一个全局模板、又把 `保存到` 选成项目级 → **会另存一份到项目里，老文件不删**（其它项目照旧有）。
- 会动到 `提示词正文` 的只有「正文」那一行被回车（= 打开编辑器）。平时只改 MCP 不会把正文覆盖掉。
- 面板开的路径下写不进去、或 `文件名`空的时候，会直接报错不写，不会静默失败。

#### 继承（`extends`）

子模板只写差异，没写的从父模板拿。`cwd` / `mcp` / `timeout` / `model` / `mcp_exposure` 都是**覆盖**（不是合并 —— 免得你以为只挂了 1 个其实带一堆）；正文是**父 + 子拼接**。
最多继承 2 层（子 → 父 → 祖父），有环会直接报错。

```markdown
<!-- role-dev.md：公共底座 -->
---
name: 开发助理（底座）
desc: 只给其它模板 extends 用，不能直接派
base: true
timeout: 10m
---
动手前先把「改哪些文件、怎么改」说清楚；改完必须自验；结论写清改了啥、怎么验证的。
```

```markdown
<!-- db.md：只写差异，cwd / 超时 / exposure 都从 role-ops 继承 -->
---
name: 数据库助理
desc: 连数据库查数据、验证数据、探表结构时用我。默认只读
extends: role-ops
mcp: my-db
---
只碰业务库；表名字段名拿不准先探结构；报数要写清口径。
```

#### 底座（`base`）：只读，而且能一键派生

底座是「公共父类」—— 被多个助理 `extends`。改坏它 = **所有派生助理一起坏**，而且很难发现。所以底座**只读**：

- `/assistants edit <底座>` → **被拒**（并告诉你该怎么派生）
- 保存路径上也兜一层（防绕过）
- 它由扩展提供，**升级 / 重装会覆盖**手改 —— 别把定制写进底座里

自带的 4 个底座，每个带一套对应功能的提示词：

| 底座 | 适合派生什么 | 它带的公共规矩 |
|---|---|---|
| `role-dev` | 改代码类（后端 / 前端 / 脚本） | 动手前先说要改哪些文件 · 必须自验 · 结论写清改了啥、怎么验证的 |
| `role-ops` | 只读查证类（数据库 / 服务器巡检） | 只读 · 必须给证据 · 查不到就说查不到，不圆场 |
| `role-doc` | 写文档 / 总结 / 整理结论 | 只写文档不动代码 · 先看再写 · 不编（拿不准标 `TODO(待确认)`）· 给能直接粘的 Markdown |
| `role-review` | 代码审查 / 复核改动 | 只看不改 · 每条给 `文件:行号` · 按严重度排序 · 不凑数 · 区分事实和口味 |

**怎么派生**（两条路等价）：

```bash
/assistants new 我的db助理 role-ops   # 一条命令：挂上 extends，并预勾上 role-ops 带的 MCP
/assistants new 我的助理              # 空白起步，在面板里把「基础模板」选成 role-ops
```

面板里「基础模板」那一行就是选底座的地方 —— 选它就继承它的**提示词正文 + 默认值**（`cwd`/`mcp`/`timeout`/`model`/`tools`/`deny_tools`…），你只写差异。

#### `mcp` 跟 `cwd` 是两回事

- `cwd` 管**文件 + 上下文**（相对路径、项目 `AGENTS.md`）
- `mcp` 管**能连什么**

以前只有 `cwd`，等于「在哪儿干活」和「能连什么」绑死了。现在解耦：想让某个助理只连数据库，`mcp: my-db` 就行，不必专门给它造一个目录。

**它是真隔离，不是过滤**：没选中的 MCP **进程根本不会启动**，凭据也不会进那个子进程。

#### `base` 和 `demo` 都是「不能派」，区别只在说法

| 标记 | 意思是 | 出现在 |
|---|---|---|
| `base: true` | 底座 —— 有别的模板 extends 它 | `/assistants` 的「基础模板」组 |
| `demo: true` | 样板 —— 没有人 extends 它，纯给你看字段怎么写 | `/assistants` 的「示例模板」组 |

两者都会被挡在三道门外：不列在 `delegate` 工具描述里（模型根本看不到）、`/assistants` 列表单独分组、真派了会被 `execute` 拒并告知原因。

仓库里 7 个模板：**只有 `general` 开箱能派**；其余 2 个是 base（`role-dev` / `role-ops`），4 个是 demo（`frontend` / `backend` / `db` / `server`）。想要哪个能派，把它 frontmatter 里的 `demo` / `base` 那行删了就行。

#### 三个 MCP 来源

候选池 = 这三处合并（同名后者覆盖前者）：

| 来源 | 位置 | 用途 |
|---|---|---|
| **候选池** | `~/.pi/agent/mcp-catalog.json` | 自己手写的候选清单。**不会被任何会话自动加载**，只当助理能勾选的候选（名字原来叫「本地目录」，容易和项目级混，已改） |
| 用户级 | `~/.pi/agent/mcp.json` | 所有会话都加载的那种 |
| 项目级 | `<cwd>/.pi/mcp.json` | 你自己（或别的工具）写进去的线上连接；助理勾选时会看到 |

`/assistants edit <key>` 里那个多选框列的就是这三处合起来的候选池，并标注每个是从哪来的。文件不存在会自动建空壳。

> `mcp: inherit` **不走候选池**，直接读主会话配置（用户级 + 项目级，项目级优先）；候选池里没被点名的 server 仍然一个都不带。
> 多选框最上面「继承主会话 MCP」就是这一项，可以和候选池里的 server 一起勾。

#### 隔离原理（为什么 `mcp` 说了算）

子进程拿到一个**影子配置目录**（`~/.pi/agent/shadow/<key>/`），加 `-na`：

| 影子目录里 | 效果 |
|---|---|
| **只写**挑好的那几个 MCP | 其余 MCP 的进程压根不启动 |
| **不复制** `trust.json` | 项目不被信任 → `<cwd>/.pi/mcp.json` 不会 merge 回来 |
| **自己生成** `mcp.json`（空也写） | 不会沿用上一轮的内容 |
| **复制** `models.json` / `auth.json` / `models-store.json` | 鉴权和模型照常 |
| **过滤复制** `settings.json` | 剔掉 `packages`（否则助理会去重新克隆插件，线上踩过）；其余字段照常 |
| 写失败 | **直接拒绝启动**（不再静默拿半截配置去跑） |
| 副作用（是好事） | 子进程**不加载用户级扩展** → 自动防递归、少约 825 token/次 |

影子目录名 = `<key 的 ASCII 部分>-<6 位哈希>-<本次派发随机后缀>`，比如 `我的示例数据库助理-1cx6p4r-a3f9k2`。

为什么要那个哈希：中文名如果只做「非 ASCII 换成 `_`」，`我的示例数据库助理` 会被整串换成 `_________` ——
**两个同字数的中文助理就撞同一个目录，并行派发时互相覆盖 `mcp.json`**。拼一段基于原名的哈希就没这事了。
末尾再加「本次派发」的随机后缀：**同一个助理并发派发时也不会互相覆盖**。旧目录由 `session_start` 回收（超 24h 的删）。

#### `mcp` 写错名字会怎样

模板里的 `mcp: xxx` **只是个名字**，不是定义（定义在三个来源里）。名字找不到时：

| 什么时候 | 行为 |
|---|---|
| **派发时** | **直接拒绝**，返回 `reason: mcp_not_found`，列出缺的名字 / 实际挂上了什么 / 三个来源的完整路径 / 怎么补。判断点在起子进程之前，**一个子进程都不会起** |
| 编辑面板保存时 | 弹确认框让你决定 —— 因为可能你就是先写好模板、回头再补连接 |

为什么不只是警告：一个连不上库的「数据库助理」会**假装在干活、给你编结果**，这比直接失败吓人得多。

### 交卡格式

交卡要求由扩展自动追加到任务后面，助理必须按这三行回：

```
状态: 完成 或 卡住 或 需要信息
结论: 一句话说清结果（要数据/结论，不要过程）
证据: 你怎么确认的，最多 3 行
```

### 刻意保持最小的地方

| 决定 | 原因 |
|---|---|
| **默认异步、可选同步** | `wait` 默认 false：派完就走，后台跑，完成用 `deliverAs:"followUp"` 回投（**不打断**当前轮）。要等结果再继续就 `wait: true` |
| **结果只回投「派发它的那个会话」** | 后台记录里带 owner 会话（文件 + ID）；别的会话/实例扫到也不投，避免串台 |
| **同一子会话运行中拒绝 resume** | 用文件锁（`assistant-sessions/.locks/<会话ID>.lock`）；正忙就返回 `session_busy` 卡片，**绝不起第二个进程**交叉写同一份会话/文件 |
| **不走 RPC** | 临时工不需要「托管」，一次调用就够 |
| **助理不能再派人**（自动加 `-xt delegate`） | 防止递归打转 |
| **超时到点就杀** | 宁可杀掉再靠 `resume` 续跑，也不留孤儿进程 |

### 已知限制

- ⚠️ **插件层面做不到「安全沙箱」。** 助理是**你本人身份下的普通 pi 进程**：能读你能读的文件（`env` 和工具是能收窄，但收不成沙箱）。真要硬隔离得靠 OS —— 容器 / 受限用户 / 只读挂载。
- ⚠️ **「只读」不是权限边界，只是「少给犯错机会」。** 现在能做三件事：① 用 `tools` 白名单 / `deny_tools` 精确控制它能用哪些工具；② 用 `mcp` 决定它连不连得上某台 MCP；③ SSH 白名单已经**去掉了有副作用的子命令**（`git branch`/`git remote`、`mount`、裸 `ip`）。但**真解**是：数据库用只读账号、服务器用受限用户。
- 环境变量默认**全部继承**。要收窄就在模板里写 `isolate_env: true`（配 `env_passthrough` 保留模型 key）。
- ⚠️ 同时最多跑 **4 个助理**（`delegate.ts` 的 `MAX_CONCURRENT_RUNS`），超出的**排队** —— 防一次 `tasks` 派太多把机器 / 额度打爆。排队中的任务在面板上显示为 **⏳ 排队中**（小票先建、拿到槽位才起进程），不是看不见。
  - 槽位在**子进程退出（`close`/`exit`）那一刻**就归还，回执解析 / 落盘 / 面板收尾都在释放之后做 —— 否则每个任务之间会白占 ~3.7s（4 个槽位等于只跑 3 个）。
  - 释放是**单次**的（`released` 标志 + `releaseSlot()`），异常 / 超时 / 手动中断三条路径都兜底；kill 之后 8 秒还等不到 `close` 也会强制收尾 —— 宁可报失败，绝不泄漏槽位（漏一个 = 以后永远只剩 3 个并发）。
- **后台结果只回投派发它的那个主会话**（切走了就等回去才投）；同一子会话**运行中拒绝 `resume`**（返回「会话正忙」），不会起第二个进程交叉写文件。
- **后台结果投递失败不会丢**：退避重试（封顶 30s），超 10 分钟标 `undelivered`；面板显示 `⚠ N 条没回投`，`/agents bg` 看原因、`/agents bg redeliver` 手动重投。
- ⚠️ `delegate` 工具里列的那份「可用助理清单」是**扩展加载时算的**。新加 / 改名助理后要 `/reload` 才会出现在清单里（派发本身不缓存，`/assistants` 看到的就是最新的）。
- ⚠️ **`mcp` 写了池子里没有的名字，如果面板里你选了「仍要保存」，派发时会被硬拦**（见上面的「`mcp` 写错名字会怎样」）。不会静默降级成一个没连上库的助理。
- 项目级模板和项目级 MCP 都**要求该目录被 pi 信任**（`trust.json`）。
- 每个助理是**独立进程 + 独立模型调用**，会再多花一份钱。
- 找 pi 的 CLI 入口的顺序：`$PI_CLI` → `$PI_PACKAGE_DIR/dist/bundle/cli.js` → `process.argv[1]`；找不到就报错。

---

## 模块 4 · live.ts + panel.ts（子代理实时面板）

**解决的问题**：派活时子进程是**无窗口**的（stdio 被接管），界面原来只有一行 `📤 xxx 干活中…`。
于是「它到底在干什么？是不是卡住了？要不要我介入？」全都答不上来。

### 数据从哪来（关键）

子进程是 `pi -p --mode json` 起的，**stdout 本身就是逐事件的 JSON 流**，而 `handleLine()`
本来就在解析它（只是原来只留了最终卡片）。所以面板**不需要去 tail 会话文件**，
把同一个事件同时喂给 `live.ts` 的状态机就行。

用得到的事件（规范见 pi 自带 `docs/json.md`）：

| 事件 | 拿它显示 |
|---|---|
| `tool_execution_start` | `⚙ bash  git pull --rebase` ← 「现在在干什么」（带**完整参数**） |
| `tool_execution_update` | 执行中的输出（**bash 拿不到**，见下面「实测坑」） |
| `tool_execution_end` | `↳ 240 行 · 12.1s · exit 0` |
| `message_update` → `text_delta` / `thinking_delta` | 它的实时正文 / 思考（逐字） |
| `message_update.usage` | token 数 |

### 两个实测得出的坑（写代码时特别注意）

1. **长命令期间事件流是静默的。** `tool_execution_update` 对 bash **不是**实时输出流 ——
   只有「开始时一条空的」+「结束时一条完整的」（实测 3 条 `sleep 12`，全程 0 条有内容的更新）。
   所以面板**必须自己每秒 tick** 去走「已跑 2:31 / 40s 无动静」，否则用户会以为死机。
   `AgentPanel` 里的 `setInterval(…, 1000)` 就是干这个的。
2. **定时器里绝不能用捕获的 `ctx`。** ct 会在 `/reload`、切会话、会话重载后变成 stale，
   再访问 `ctx.hasUI` / `ctx.mode` 会触发 pi 的 `assertActive` 抛错；而**定时器里的异常没人接，
   会直接把进程打挂**（实测踩过一次，退出码 1 + 一大串堆栈）。所以：
   - `closeAgentPanel()` **不接 ctx**（45 秒后的自动收起也会调它）
   - `autoClosePanel()` 的回调包 try/catch
   - `AgentPanel` 的每秒 tick 包 try/catch
   - 一切面板失败都不允许连累派活（`openAgentPanel` 整体 try/catch）

### 面板长什么样
它就在**任务看板正上方，整宽**（同一套 widget 机制）：

```text
…对话（滚动区）…
 ▛ 子代理 1 个在跑
 ● 业务服务器助理  1:23
   在 VM 上修好服务的依赖安装，能修好就一路把环境准备跑完
   ✗ execute_command  cd ~/my-service && pip install…  → Validation failed…
   ⚙ bash  git pull --rebase  已跑 5s
 ▛ 任务 部署服务到 VM · 8/8
 ✓ 1 修 VM 依赖安装      │ ⚙ 运行     │ 会话信息
> 输入框（照常可用，面板在它上面、不盖住它）
```

实现要点（都是官方开关，不用自己造反制）：

| 需求 | 怎么做的 |
|---|---|
| **看板正上方、整宽** | `setWidget(key, factory, { placement: "aboveEditor" })` —— 它是**布局的一部分**，顶上去只把对话区缩几行，**永不覆盖** |
| **稳定排在看板前面** | 在 `session_start` **注册一次就不再注册**（`setupPanel` 必须在 `setupBoard` 之前调）。pi 的 widget 按注册顺序从上往下排，而且 `setWidget` 每次都会把该 key **挪到末尾** —— 重复注册就把自己送到看板后面去了 |
| 高度不会无限涨 | `MAX_WIDGET_ROWS = 10`（对齐 pi 对字符串数组 widget 的 `MAX_WIDGET_LINES = 10`） |
| 不占地方 | 没在跑 / 被关掉时 `render()` 返回 `[]` → 占 **0 行**（所以能一直挂着） |
| 窄屏降级 | `< 100` 列 → 只画一行摘要 |
| `/agents float` 换成浮层 | `anchor: "right-center"` + `width: "42%"` + `nonCapturing: true`（不抢键盘焦点）+ `visible: (w) => w >= 100` + `maxHeight: 60%` |
| 跑完不一直占着屏幕 | 全部结束后停 45 秒自动收起（期间又派活则取消） |

### 与 `ASSISTANT` 相关的事实

- 面板只读 `live.ts` 的注册表，**不持有子进程句柄** —— 杀进程、超时、看门狗都不受影响。
- 面板是「看」的，**不承载对话** —— 这是整个插件的既定设计。
- 事件流節流：实测 40 秒 429 条 `message_update`（≈ 10 条/秒），所以重画通知做了
  **100ms 合并**（`notifyLive()`），面板本来就是按秒刷的。
- `/agents text` 能在无 TUI 环境（RPC / 调试）把当前状态打成纯文本。

---

## 模块 5 · Herdr 分屏模式（v2.5.0）

派出去的活不只在面板里看 —— 装了 Herdr（终端分屏 CLI）的话，可以直接开窗看子助理跑。

配置项：`superagent.ui`（写在 `~/.pi/agent/ai-extensions.json` 的 `superagent` 块下）

| 值 | 行为 |
|---|---|
| `panel` | 只在面板里显示卡片（**默认**，哪里都能用） |
| `split` | Herdr 分屏：主窗口 = **左主 + 右侧上下两格** |
| `tab` | 每个子助理一个 Herdr tab |
| `auto` | ≤2 个走 `split`，更多溢出到 tab |

`superagent` 块下还有两个跟「保留的 pane」有关的配置：

| 配置 | 默认 | 行为 |
|---|---|---|
| `paneKeepOnError` | `true` | 失败 / 超时 / ESC 中止后**保留 pane**（先停掉里面的 pi，标签写「已停」），方便回看现场；`false` 则直接关 |
| `paneKeepMinutes` | `10` | 保留的 pane 多少分钟后自动回收；**`0` = 永不自动关**（只留给人手动 `/pane-close`） |
| `batchLive` | `false` | 批量任务每完成一件就回投一条 **≤60 字**短进度卡（一批最多 4 条） |
| `maxConcurrent` | `8` | 同时最多跑几个子助理（可调 **1~16**）；**每 4 个占一个 tab**，到这个上限才排队 |
| `resultsKeepDays` | `30` | 结果归档保留多少天；**`0` = 不清理** |
| `maxTurns` | `60` | 子助理最多跑多少轮（可调 **5~500**）；**到 80% 自动要求「停止探索，立刻总结并交回执」，到 100% 停掉并标 `partial`**（模板 frontmatter `maxTurns` 可单独覆盖）。轮数是本扩展自己数的（pi 没有 `--max-turns`） |
| `workerCompactPercent` | `60` | 子助理在上下文用到这个百分比时**提前压缩**（**`0` = 不设，用 pi 自己的默认阈值**；有效范围 30~95）。长任务不再突然「失忆」 |

- **降级**：`split` / `tab` / `auto` 都需要 Herdr；非 Herdr 环境（没装 CLI / 不是交互式 TUI）**自动降级回 `panel`**，不会派成空任务。Super Agent 全局关掉时也强制 `panel`。
- **布局**（v2.5.7 起**子助理不再占主窗口**）：

  | 场景 | 布局 |
  |---|---|
  | 默认（`mainSlots=0`） | **主窗口不动**，子助理全进独立 tab，每 tab 4 格（2×2） |
  | 4 个以上 | 自动开 `sa:2`、`sa:3`…（tab 数量不设上限，到 `maxConcurrent` 才排队） |
  | 想占主窗口 | 面板把「主窗口格数」改成 1 或 2（旧行为） |

  跑成功自动收起，失败保留（标签写「已停」）。
- **命名**：pane 标题 = `状态 助理名#序号 · 任务摘要`（例 `▶ 数据库助理#1 · 查订单表结构`），tab 标题 = `sa:<n> · 助理名列表`（例 `sa:1 · 数据库助理,通用助理`）—— 见名知意，不用再猜 `sa:` 是什么。
- **回投**：同一次 `delegate(tasks)` 整批 settle 后**只回投 1 张汇总卡**（每条结论一行），不会一个助理一张。
- **槽位**：拿不到格子会**排队等 60s**，仍无位 → 降级 rpc（卡片备注「槽位等待 60s 超时已降级 rpc」，不是派失败）。
- **卡死判定**：pane **90s 无输出** → 判卡死，自动降级 rpc 重跑（备注「pane 卡死 90s（无输出）已降级 rpc」）。

### 健康灯（v2.6.1）：一眼看出「在跑还是在死」

pane 标题和卡片上多一个灯。判据看四样东西：**进程还在吗 + 有没有子进程在跑 + 会话文件改了吗 + 屏幕有新输出吗**。
**有子进程在跑就不报警** —— 跑 build / 测试几分钟没输出是正常的，不再被误报成卡死。

| 灯 | 含义 | 怎么办 |
|---|---|---|
| 🟢 | 正常（有活动，或有子进程在跑） | 不用管 |
| 🟡 | 30~90 秒无输出 | 可能在跑长任务，再等等 |
| 🟠 | >90 秒无任何活动（进程还在） | 用 `/panes` 看详情，必要时 `read_result` 或 resume |
| 🔴 | 进程已退出但没有回执 | 真失败，结果已归档，用 `/batch <id>` 看 |
| ✅ | 已完成（有回执） | — |

灯只在**状态变化时**才重命名 pane（不每秒调 herdr CLI）。

### 配置项之间的限制关系（v2.7.0）

**每个配置只管一件事，管不到的别指望它**：

| 配置 | 真正影响 | **不影响** |
|---|---|---|
| `mcp: <名字>` | 影子 `mcp.json` 写哪几个 server → **只启动这几个** | 与 `exec` / `net` 无关 |
| `fs: read/write` | 工具面摘掉 write/edit（read 时，v2.8.0）+ 调用时硬拦 | 不影响跑命令、不影响 MCP |
| `paths` | **只在 `fs: write` 时生效** | `fs: read` 时写了没用 |
| `exec: none/safe/any` | **工具面直接摘掉** bash（none）或按 `cmds` 白名单拦（safe，v2.8.0 起 L1+L3 双层） | ❌ 不拦 MCP 子进程（MCP 由 pi 拉起） |
| `net: none/allow` | ① 联网类工具硬拦 ② **bash 命令级**识别 psql/curl/ssh/npm install/git push 等（v2.8.0） | ❌ 不是沙箱：真要硬隔离用 `exec: safe` + `cmds` 白名单 |
| `cwd` | AGENTS.md 注入、`paths`/`${cwd}` 的基准目录 | 不决定能读哪些文件 |
| `timeout` / `maxTurns` | 到点停 / 到限标 `partial` | 不影响 MCP |
| `budget` | 纯显示 | 不做任何限制 |

**容易写错的地方**（v2.7.0 起会在卡片 / `/assistants` 里标出来）：

| 写法 | 后果 |
|---|---|
| `exec: restrict` / `net: yes` | **非法值** → 静默回落默认（`none`）。合法：`exec: none|safe|any`、`net: none|allow` |
| `exec: safe` + `cmds` 空 | 等于 `none`，什么都不能跑 |
| `fs: write` + `paths` 空 | 全盘可写（插件源码 / `~/.pi` / `.git` 仍受保护） |
| `mcp:` 留空 | 一个 MCP 都不连（默认隔离） |
| 项目级助理 + 项目未信任 | 项目级被忽略 → 实际用全局同名那份（会在列表/卡片里明说） |

**MCP 工具没挂上时，按这个顺序查**（跟 exec/net 无关）：

1. 候选池有没有这个 server 定义 → `~/.pi/agent/mcp-catalog.json`
2. 影子目录的 `mcp.json` 里有没有写进去 → `~/.pi/agent/shadow/<助理>-*/mcp.json`
3. 那个 server 的 command 能不能手动跑起来（exe 路径 / 参数 / 环境变量 / 凭据）
4. worker 那次会话开头有没有 MCP 报错 → `/resume-agent`

### 自检报告（给别人用的，v2.9.0）

出问题时跑：

```
/aidoctor export
```

会在**当前项目**生成 `.pi/pi-extensions-diagnose.md`（700~1800 行），把整份发给我就行。里面包含：

| 段 | 内容 |
|---|---|
| 0 | **给读报告的 AI 的说明**（怎么读、哪些被脱敏了） |
| 1 | 结论：❌ 严重 / ⚠ 注意，每条带修法 |
| 2 | 环境：插件/pi/node 版本、路径、trust 状态、Herdr 可用性、影子目录数 |
| 3 | 关键文件清单（存在性 + 大小 + 修改时间） |
| 4 | 全局/项目/pi 自身 `settings.json` 配置原文（脱敏） |
| 5 | **每个助理逐一**（含「被同名的哪份盖住」）：来源/类型/extends/描述/工作目录/权限/MCP/模型/超时/轮数 + 「能做 / 不能做」人话 + 原始 frontmatter + 正文开头 |
| 6 | MCP 候选池全量（含 exposure）+ **Worker 实际加载的 mcp.json** |
| 7 | 影子目录（Worker 的 PI_CODING_AGENT_DIR）概况 |
| 8 | 最近 20 次派活的状态/原因/耗时/错误 |
| 9 | guard.log（200 行）+ 命中统计、herdr.log（100 行）、崩溃记录 |
| 10 | 采集过程中读不到的东西（明确列出缺失信息） |
| 11 | **还需要你提供什么**（现象描述、会话 ID、是否重启过…） |

**脱敏**：URL 密码、`TOKEN=`、`--password xxx`、JSON 敏感键 → 全部 `***`；键名保留。发之前扫一眼路径/库名即可。

### 排障：现象 → 原因 → 怎么办

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 派了 N 个，只看到几块分屏 | 槽位有限：**每个 tab 4 格**，默认 `maxConcurrent=8`（= 2 个 tab） | 再多就自动开新 tab（`sa:2`、`sa:3`…）；到 `maxConcurrent` 才排队，仍无位 → 降级 rpc（卡片会写「槽位等待 60s 超时已降级 rpc」）。不是派失败 |
| 某任务没进分屏，而是直接出结果 | 该任务降级走了 rpc | 看卡片里的降级原因；非 Herdr 环境（没装 CLI / 不是交互式 TUI）属正常设计 |
| Pane 标签是 `❌` 且保留 | 任务**失败**，pane 故意留着等你看 | 按回车关掉。**成功**的会自动收起，不用管 |
| Pane 里卡住不动 | **90s 无输出**被判卡死 | 自动收 pane + 降级 rpc 重跑（备注「pane 卡死 90s（无输出）已降级 rpc」） |
| 分屏里看着半天没动 | 未必是卡死 | 看标题的灯：**🟡 是可能在跑长命令（有子进程）**，**🟠 才是真可疑**（>90s 无任何活动）；用 `/panes` 看 pid / 最后活动 |
| 子助理启动慢 / 日志刷 `fd not found. Downloading...` | 影子目录缺 `bin/`，启动时现联网下载 fd/rg | **v2.5.0 已修**：影子目录的 `bin` 建成 junction，指向真实 `~/.pi/agent/bin` |
| 每次 `/reload` 都收到旧卡片 | `.bg` 的 `delivered` 被覆盖，重投逻辑重复投递 | **v2.5.0 已修**：只自动投递 **10 分钟内**的结果、最多自动尝试 **3 次**；更老的用 `/agents bg redeliver` 手动补 |
| 配了 `auto` 却一直是面板卡片 | `herdrStatus().ok=false`（没装 CLI / 不是 Herdr 终端 / pane 读不到） | `/aidoctor` 看「Herdr」诊断行的 `原因：` —— 那里直接写了失败理由 |
| 更新后一直降级 | 不在 Herdr 终端 / `herdr` 不在 PATH | 卡片上会写原因（**v2.5.4 起不再静默降级**）；装好 herdr 并确保在 `PATH` 里，或干脆改用 `panel` |
| 子助理失败后 pane 一直留着 | 失败默认保留（`paneKeepOnError`） | `/pane-close` 一键关；或等 10 分钟自动回收（`paneKeepMinutes`） |
| 按 ESC 停不下来 | 以前只跳出等待 | 现在 ESC 也会停掉 pane 里的进程 |
| 收到「投递未生效」提示 | 流式竞态或主会话忙 | 会自动重试 6 次、退避封顶 60 秒；仍失败看 `/agents bg`，正文用 `/batch <id>` 取 |
| 卡片只有摘要没有正文 | v2.5.6 设计如此 | 正文在 `~/.pi/agent/results/`，用 `/batch <id>` 看 |
| **子助理跑 2 分钟就断、回投只有半句话** | v2.6.0 之前：父进程换代 / `/reload` 会触发 SIGKILL，杀的时候没确认进程真死，半路被抹掉 | **v2.6.0 已修**（杀之前先确认进程真死了，实测 183 秒长任务完整跑完）；如仍出现请贴 `herdr.log` 给作者 |
| **改完代码 `/reload` 了，行为还是旧的** | `/reload` 只重载扩展模块，**已经注册给主会话的工具（`delegate` 等）仍绑在旧模块实例上** —— 今天在这上面白折腾 5 轮 | **改完代码请完整重启 pi**（退出再启动）。判定方法：看新行为有没有出现（如卡片 `✅` / ❌ 变化），别信 `/reload` 提示 |
| 卡片明明成功却显示 ❌ / 「N 降级」 | v2.6.3 之前：`note` 字段把「⚠ 已继承主会话 MCP」这类**提示**当成**降级**（`done && !note` 就判否） | **v2.6.3/2.6.4 已修**：`isDegradedNote()` 区分「降级/卡死」与「纯提示」，提示只挂在行尾 |
| 收到一张很旧的卡、内容对不上现在 | 投递重试把旧卡又投了一次（正文是**当时**写的） | **v2.6.5 起会自带**「⏳ 补投：N 分钟前的结果」；更老的用 `/batch <id>` 看归档 |
| 派活 1 秒就失败，错误是 `xxx is not defined` | 单测只测纯函数，**没走真实回调路径**，作用域 bug 测不出来 | `node scripts/typecheck.mjs` 专抓这类（TS18004/TS2304），已进发版清单；`tsc` 查不到时先确认 pi 的 d.ts 是否可解析 |
| **电脑发卡、pi 空闲也占 20%+ CPU** | v2.6.9 之前：健康采样用 `Get-CimInstance` 查子进程，**611ms/次**，每个运行中任务每 10 秒一次 | **v2.6.9 已修**：改用读会话文件（0.4ms）；如仍高，用任务管理器看是不是别的程序（杀软 / 输入法 / 直播软件） |
| 一天攒了几十个 `shadow/general-*` | 每次派活新建一个影子目录，各带一份当时的扩展代码副本 | **v2.6.6 起 TTL 24h → 2h**；排查「行为不对」前先确认它不是跑的旧快照 |
| 子助理连不上库 / 服务器 | 模板里没写 `mcp:`（默认一个都不连），或名字不在候选池 | 检查是否写了 `mcp:`；想跟主会话一致就写 `mcp: inherit`；改完要**重新派活**（下一次才生效） |

---

## 模块 6 · 自定义 Router 提示词（v2.5.4）

Super Agent 开着时，主会话（Router）会注入一段 `<superagent-router>` 提示词。
除了内置版本，你可以用自己的文件**替换**或**追加**内容 —— 改完**下一轮对话就生效，不用 `/reload`**。

| 语义 | 项目级（优先） | 用户级 |
|---|---|---|
| **替换**内置 | `<项目>/.pi/pi-extensions/router.md` | `~/.pi/agent/pi-extensions/router.md` |
| **追加**在内置之后 | `<项目>/.pi/pi-extensions/router.extra.md` | `~/.pi/agent/pi-extensions/router.extra.md` |

- 项目级存在就用项目级，否则用户级，都没有就用内置
- **追加文件永远生效**，可以和替换文件叠加
- 文件空的（或只有空白）视为不存在；**少于 200 字符会被忽略**并提示（防误建空文件）
- 超过 **12KB** 会截断（末尾标「已截断」）
- 最省事的开始方式：`/ai` → Super Agent → 「生成用户级提示词模板」，再按需改
- 想看当前用的是哪一份：`/aidoctor`（会列出 Herdr 诊断 + Router 提示词来源和字节数）

**它管什么**：派活时机、先派谁、怎么拆并行批次、回执口味、什么时候该停下来问人。
**它不管什么**：Worker 的执行方式（那是各助理 md 里的事）。

> 档位（`blind` / `readonly` / `off`）和提示词是两回事：档位管**工具放行**，提示词管**怎么想**。档位用 `/router` 临时切，本会话有效。

#### 并行与串行

Router 声明计划前会先做**依赖分析**：互不依赖的步骤标 `[并行]`，一批一次派完（每批最多 4 个，
受并发上限限制）；只有「后一步要用前一步结果」才串行。
如果你希望不同的拆分口味，写进自己的 `router.md` / `router.extra.md` 即可。

---

## 上下文成本实测

每轮都会重发的内容，实测（同一句「只回答：好」，deepseek-v4-flash，2026-10-03）：

| 来源 | tokens/轮 | 怎么测的 |
|---|---|---|
| pi 基础（内置提示 + 内置工具） | 3098 | `-ne` 不加载扩展 |
| AGENTS.md（全局 + 项目） | ~1500 | `-nc` 不读上下文文件 |
| **task-board** | **825** | 临时移走那个文件 |
| **delegate** | **327** | `-xt delegate` |
| **ai-config** | **0** | 它不注册工具、不注入任何东西 |
| **MCP（my-db + my-server，9 个工具）** | **0** | `-xt` 掉全部 9 个 MCP 工具后，**一个 token 都没变** |
| **合计** | **~4790** | |

三个反直觉的结论：

1. **MCP 占 0 token。** 两个 server 都配了 `exposure: codemode` —— 工具 schema **根本不发给模型**，只在 codemode 沙箱里可见。所以「MCP 挂多了上下文会涨」是错觉。
2. **task-board 是最贵的插件，** 而且贵在它**每轮往对话里注入一段面板说明**：
   `825 = progress 工具 schema 398 + 每轮注入的说明 ~427`
3. **把三个插件合并成一个，一个 token 都省不了。** 模型看到的是「**注册了哪些工具**」，不是「**代码放在几个文件里**」。合并只是让仓库看着整洁，不是性能优化。

真要省上下文，按性价比排：

| 动作 | 能省 | 难度 |
|---|---|---|
| 缩短 task-board 每轮注入的说明 | ~400/轮 | 小 |
| 精简 delegate 工具描述 | ~100/轮 | 小 |
| 精简 AGENTS.md | 最多 1500/轮 | 中（会影响行为）|
| **合并插件** | **0** | 大（已于 2026-10-03 合并为 `ai-configure/`，纯粹为了整洁）|

---

## 安全须知

- **不要把敏感信息提交进本仓库。** Master 密钥（`CENTER_TOKEN`）只走环境变量或 `/ai token` 的输入框（内存态，不落盘）；`.gitignore` 已经排除 `.env`、`.pi/mcp.json`、`*.local`、`token.txt` 等。
- **项目级应用模式会把连接串（含明文密码）写进你项目的 `.pi/mcp.json`。** 那个文件属于你的项目仓库，务必确认它已被忽略，别提交出去。
- `/ai` 拉回来的 MCP 配置里带着凭据，`/ai status` 只显示状态、不打印密钥。
- **`delegate` 起的助理继承了它 `cwd` 目录下的全部 MCP 凭据**（含写权限）。派活前想一下这个目录该不该让它碰。

---

## 开发 / 同步

```powershell
# 改完源文件 → 同步到生效目录 → 在 pi 里 /reload
.\install.ps1

# 只想看看改了哪个、不写文件
.\install.ps1 -List

# 只同步某一个模块（带 -Name 时会跳过孤儿清理）
.\install.ps1 board
```

### 发版清单（每次发版照做，别漏）

1. **版本号三处**：`package.json`、`ai-configure/package.json`、`README.md` 顶部的「当前版本」。
2. **五套检查全绿**：`node scripts/typecheck.mjs`、`node scripts/unit.mjs`、`node scripts/smoke.mjs`、`node scripts/herdr-finalize-check.mjs`、`node scripts/concurrency-regress.mjs`。
   - `typecheck.mjs` 只抓「引用了不存在的标识符」（TS18004/TS2304）——**这类错单测测不出来，一跑就 ReferenceError**（v2.6.0 派活 1 秒全崩就是这么漏的）。

> 🧪 跑压测 / 收尾检查前先钉死 UI 模式：`$env:PI_SA_UI="panel"`（bash: `export PI_SA_UI=panel`）。
> 默认 `auto` 会让"跑一次派活"变成"真开 Herdr pane"，压测会挂住并留下残留 pane。
3. **同步生效目录**：先清 `PI_CODING_AGENT_DIR`（bash `unset` / PowerShell `Remove-Item Env:`），再跑 `install.ps1`，然后 `diff -r ai-configure ~/.pi/agent/extensions/ai-configure` 必须无输出。
4. **⭐ 追加 CHANGELOG**：在 `CHANGELOG.md` **最上面**加一段 `## <新版本号>`，写成中文、3~6 条、一条一句话，只写「新增 / 修复 / 体验 / 测试」这类重点，**别写成长篇**。
   - 版本标题必须是 `## 2.6.0` 这种三段式（pi 靠这个正则解析：`## \[?(\d+)\.(\d+)\.(\d+)\]?`）
   - 为什么必须写：pi 更新后会读它，在**新会话首屏**显示 `Extension Updates`，用户才知道这版改了什么
   - 漏掉 = 用户升级后什么也看不到
5. **提交 + 打 tag + 双推**：`git commit` → `git tag v<版本>` → `git push origin main --tags`（`origin` 配了两个 pushurl，GitHub 与 Gitee 一次推完）。

> ⚠️ 第 4 步最容易忘。改完代码、测试过了、准备提交前，先翻一眼 `CHANGELOG.md` 最上面的版本号是不是这次要发的版本。

入口是默认导出的工厂函数；各模块导出 `setupXxx`：

```ts
// ai-configure/pi-extensions.ts —— 加新模块就在这里加一行
import { setupConfig } from "./config";
import { setupBoard } from "./board";
import { setupDelegate } from "./delegate";

export default function (api: ExtensionAPI): void {
  setupConfig(api);
  setupBoard(api);
  setupDelegate(api);
  api.registerCommand("aihelp", { … });
}

// ai-configure/board.ts
export function setupBoard(api: ExtensionAPI): void {
  api.registerCommand("board", { … });
  api.registerTool({ name: "progress", … });
}
```

`install.ps1` 的两件事：

1. **同步**：根级 `*.ts` + 含 `index.ts` 的子目录（整棵递归），按 SHA256 比对。
2. **清理孤儿**：目标目录里已不存在于源里的根级 `.ts`/`.js` 和插件目录会被删掉。范围严格限定，不会动无关文件；`-List` 时只打印不删。

参考 pi 自带文档（装在 `@earendil-works/pi-coding-agent` 包里）：`docs/extensions.md`、`docs/mcp.md`、`docs/codemode.md`、`docs/settings.md`、`docs/tui.md`。

### 与 pi 版本的兼容点（改代码前先看这张表）

| pi 版本 | 变更 | 我们怎么适配 |
|---|---|---|
| 1.2.0 | `before_agent_start` 也会为 `pi.sendMessage(..., { triggerTurn: true })` 起的 run 触发（`event.messageType === "custom"`） | `board.ts` 的处理器先 `if (event.messageType === "custom") return`：custom run 不算一轮、不注入看板提示（否则 `turnNo` 虚涨会把「计划已 N 轮没更新」误判成作废） |
| 1.2.0 | `-p` 打印模式：最终回复撞到输出上限时**打印已产出的文本 + stderr 警告 + 退出码 1** | `delegate.ts` 的 `child.on("close")`：非零退出但 `sink.final` 非空 → 按 `done` 收，卡片上补一句「被输出上限截断」；`RunResult.truncated` 用 stderr 里的 `output token limit` 判定 |
| 1.0.4 | `-t/--tools` 默认保留 MCP 工具，只有列了 `mcp__` 条目才过滤 MCP | 删掉「白名单没列 mcp__ 工具 → 直接拒绝派发」那条误报拦截；README 的 `tools` 说明同步改 |
| 1.1.0 | `agent_settled` 带 `aborted`（RPC/JSON 都透传） | 硬收尾不再只靠猜：`rec.aborted !== false` 才算「被我们 abort 打断」→ 追问交卡；否则正常收工。避免了「abort 发出时对方刚好自己跑完」白多发一轮追问 |
| 1.1.0 | `tool_execution_end` 事件、工具渲染上下文带 `durationMs` | 子代理「最慢的几步」改用它（比 `Date.now()` 差值准，不受事件乱序影响）；`progress` 工具行用 `renderResult` 显示耗时 |
| 1.2.0 | `before_agent_start` 的段（`systemPromptOptions.sections`）在 run 首轮工具调用后不会被删了 | 看板的**静态规则**搬进 `<task-board>` 段（只吃一次上下文、变更走 transcript delta），每轮只注入动态的「当前面板」一行 |
| 1.1.0 | run 启动阶段就算 busy：`pi.sendUserMessage()` 必须传 `deliverAs` | 我们现在**空闲时才投**，且**不传 `deliverAs`**（见下面「结果怎么回主会话」）|

## 故障排查

### 启动报 `Tool "progress" conflicts with …`

```
Error: Failed to load extension "…\extensions\ai-configure\index.ts":
  Tool "progress" conflicts with …
```

**成因**：同一个扩展被**两条通道**各装了一份，pi 同时加载，第二个注册 `progress` / `delegate` 时撞名 → 整个扩展加载失败。

| 通道 | 落地路径 | 谁装的 |
|---|---|---|
| A：pi 包（推荐） | `~/.pi/agent/git/github.com/zeke-center/pi-extensions/ai-configure/pi-extensions.ts` | `pi install git:github.com/zeke-center/pi-extensions` |
| B：同步脚本 | `~/.pi/agent/extensions/ai-configure/pi-extensions.ts` | 跑 `install.ps1` |

**怎么判断自己是混装**：下面两条**同时**命中就是混装：

```powershell
Test-Path "$HOME\.pi\agent\extensions\ai-configure"   # 通道 B 在
pi list                                                  # 通道 A 在（会列出 pi-extensions）
```

**修法（留一条、删另一条）**：

```powershell
# 留 A（推荐）：删掉脚本拷的那份
Remove-Item -Recurse -Force "$HOME\.pi\agent\extensions\ai-configure"
# 顺手看一眼有没有旧的单文件形态，有就一起删
Get-ChildItem "$HOME\.pi\agent\extensions" -Filter *.ts

# 留 B：解除包通道
pi remove git:github.com/zeke-center/pi-extensions
```

删完重启 pi（或 `/reload`）。`install.ps1` 现在会**自动检测**包通道并拒绝重复同步扩展（红字提示），除非显式 `-ForceExtensions`。

### 启动报 `Ignored settings` / MCP 字段不生效

如果你装了 `pi-mcp-adapter`（并在 settings 里把它设成 MCP 提供方，如 `"extensions": ["-builtin:mcp"]`），那 `~/.pi/agent/mcp.json` **由 adapter 读取**。adapter 只翻译 pi 原生字段；它**自己的**字段要写 `~/.pi/agent/mcp-adapter.json`：

| 你写在 `mcp.json` 里的 | adapter 认不认 |
|---|---|
| `timeout: 30`（**秒**） | ✅ 翻译成请求超时 30000ms |
| `lifecycle` / `requestTimeoutMs` / `idleTimeout` | ❌ 忽略并启动告警 |

adapter 专属设置挪到 `mcp-adapter.json`：

```json
{ "settings": { "idleTimeout": 10 } }
```

一句话：**能进 pi 原生 `mcp.json` 的只有官方字段（含 `timeout`，单位秒）**；adapter 专属的别往那儿塞。

## 更新日志

### v2.5.0

- 新增：Herdr 分屏 UI（`superagent.ui`: panel/split/tab/auto），主窗口左主右上下两格，溢出 tab `sa:extra#n` 可多个、每个 2×2
- 修复：影子目录缺 bin（启动时联网下载 fd/rg 导致慢/挂起）、槽位分配竞态、pane 卡死无检测、`.bg` 的 delivered 被覆盖导致 reload 重投、pane 收尾丢回执
- 体验：同批任务合并成 1 张汇总卡；槽位满排队等 60s；只自动投递 10 分钟内结果、最多自动尝试 3 次
- 测试：typecheck / unit / smoke / herdr-finalize-check / concurrency-regress

## 许可

MIT —— 见仓库根目录的 `LICENSE`。
