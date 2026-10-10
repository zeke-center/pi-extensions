# pi-extensions

我在用的 pi 编码 agent 扩展。**一个目录式插件 `ai-configure/`（里面 8 个模块）**，外加一份助理模板。全部是「本地 TypeScript」：pi 用 jiti 直接加载，**不需要编译、不需要 npm install**。

```bash
pi install git:github.com/zeke-center/pi-extensions   # 在终端里敲，不是在 pi 聊天框里
```

装完就能用 `/board`、`/ai`、`/assistants`、`/resume-agent`、`/agent-resume-back`、`/agents`，以及一个能直接派的**通用助理**。

| 文件 | 功能 | 入口 |
|---|---|---|
| `ai-configure/pi-extensions.ts` | 入口：装配下面七个模块 + 注册 `/aihelp` | — |
| `ai-configure/config.ts` | **AI 配置中心** | `/ai` |
| `ai-configure/board.ts` | **任务进度看板** | `/board` + `progress` 工具 |
| `ai-configure/delegate.ts` | **派活给临时助理** | `/assistants` + `delegate` 工具 |
| `ai-configure/live.ts` | 子代理实时状态机（把 JSON 事件流翻成可画的行） | — |
| `ai-configure/panel.ts` | 子代理实时面板（看板正上方整宽，默认） | `/agents` |
| `ai-configure/mcp-pool.ts` | MCP 候选池 + 影子目录（`mcp` 隔离的底层） | — |
| `ai-configure/form.ts` | 弹窗面板（表单 + 多选，`new`/`edit` 共用） | — |
| `ai-configure/help.ts` | 说明书文案（`/aihelp` 与 `/ai help` 共用一份）| — |

```text
pi-extensions/
├── ai-configure/        # 一个插件，8 个模块
│   ├── package.json     # 内层清单：显式声明入口（显示名 = pi-extensions，不叫 index）
│   ├── pi-extensions.ts # 入口：装配下面七个 + 注册 /aihelp
│   ├── config.ts        # 连接台账 → MCP（/ai）
│   ├── board.ts         # 进度看板（/board + progress 工具）
│   ├── delegate.ts      # 派活给临时助理（/assistants + delegate 工具）
│   ├── live.ts          # 子代理实时状态机（JSON 事件流 → 可画的行）
│   ├── panel.ts         # 子代理实时面板（/agents，看板正上方整宽）
│   ├── mcp-pool.ts      # MCP 候选池 + 影子 agentDir
│   ├── form.ts          # 弹窗面板（表单 + 多选）
│   └── help.ts          # /aihelp 的说明书文案
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

本地跑测试（需已装 pi，它自带 esbuild）：`node scripts/smoke.mjs && node scripts/unit.mjs`

### 为什么是「目录插件」而不是一个大文件

pi 原生支持两种扩展形态，**两种都会加载**：

| 形态 | 例子 |
|---|---|
| 根级单文件 | `extensions/foo.ts` |
| 目录式插件 | `extensions/foo/index.ts`（整棵目录，支持相对 `import`）|

合并前是三个各 700~830 行的独立文件（共 2036 行）。挤进一个 `.ts` 要处理 **7 处顶层重名**（`STATUS_KEY`、`McpEntry`、`pi`、`lastCtx`、`padTo`、`refreshStatus`、`timer`），而且**一处笔误带下水全部功能**。分模块就没这些问题 —— 每个文件还是独立作用域。

⚠️ 要注意的反面：**两种形态都加载** —— 旧单文件没删干净就会和新目录同时生效，**同一个工具被注册两遍**。`install.ps1` 的「清理孤儿」就是为这件事准备的。

---

## 命令总览（忘了就敲 `/aihelp`）

| 命令 | 子命令 | 干什么 |
|---|---|---|
| **`/ai`** | （无参数） | 拉取连接台账，选完在本会话注册成 MCP server |
| | `status` | 看状态：密钥 / 会话级连接 / 项目级连接 |
| | `token` | 设置 API 密钥 |
| | `off` | 关掉本会话拉进来的连接 |
| | `project off` \| `project clear` | 关掉 / 清空项目级连接 |
| | `help`（`?` / `h` 也行） | 打印全部功能与参数 |
| **`/aihelp`** | — | 同上（`/ai help` 的快捷别名） |
| **`/board`** | `on` \| `off` | 开 / 关面板 |
| | `clear` | 清空任务列表 |
| | `above` \| `below` | 面板放输入框上方 / 下方 |
| | `right` \| `mid` | 显示 / 隐藏右区（MCP / 插件 / 助理）/ 中栏 |
| **`/assistants`** | — | 列出所有助理模板（分「可派发 / 基础模板 / 示例模板」三组） |
| | `show <key>` | 展开全部字段 + 继承链 + 提示词正文 |
| | `edit <key>` | 弹面板改（**基础模板 / MCP / 超时 / AGENTS.md / 存哪儿 / 正文**）。底座只读，会被拒 |
| | `mcp <key>` | 同上，只是光标直接落在 MCP 那行 |
| | `new <key>` | 弹同一个面板新建（面板里「基础模板」那行选底座） |
| | `new <key> <底座>` | **从底座一键派生**：自动挂 `extends: <底座>`，并预勾上底座带的 MCP |
| | `open <key>` | 用系统默认程序打开那个 `.md` |
| **`/resume-agent`** | — | 翻看助理的**历次会话**（它们**不在 `/resume` 里**），选中直接切过去看 |
| | `<key>` | 只看某个助理的（例 `/resume-agent db`） |
| **`/agent-resume-back`** | — | 从助理会话**一键返回主会话**。切进助理会话后 `/resume` 只扫助理目录、看不到主会话，用这个回来 |
| **`/delegate-mode`** | （无参数） | 看 delegate 默认是同步还是异步 |
| | `async` | 默认**异步**：派完就走，后台跑，完成自动回投主会话（不打断） |
| | `sync` | 默认**同步**：派完等结果才继续（老行为） |
| **`/agents`** | （无参数） | 开**子代理实时面板**（派活时本来就会自动出现；手动敲=重新叫回） |
| | `off` | 关掉（下次派活也不再自动弹） |
| | `detail` | 展开 / 折叠它的思考过程 |
| | `widget` \| `float` | 换成看板正上方的整宽面板（默认） / 换成右侧浮层 |
| | `text` | 把当前状态打印成纯文本（RPC / 调试用） |
| | `bg` | 看**后台任务**状态：`已投` / `待投` / `未投(已放弃)`、重试次数、失败原因、属于哪个会话 |
| | `bg redeliver` | 把**没投回主会话的立刻重投一次**（主对话卡住时的救急口） |

**两个工具** —— 不是命令，你**不用打**，模型按需自己调：

| 工具 | 参数 | 干什么 |
|---|---|---|
| `progress` | `action`（必填：`plan`/`step`/`block`/`clear`）、`title`、`steps`、`index`、`status`、`text`、`skipConfirm` | 更新输入框上方那个面板 |
| `delegate` | `assistant`（必填）、`task` \| `tasks`、`resume`、`timeoutMs`、`wait` | 派活给临时助理（另起独立 pi 进程）；`wait` 默认 false=异步派完就走、完成自动回投，true=同步等结果 |

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
> 只有 `/ai`（从你自己的台账批量生成 MCP）才需要额外配 `CENTER_API` 和密钥。

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

pi 默认从 `~/.pi/agent/extensions/` 加载扩展。用脚本把扩展和助理模板同步过去：

```powershell
.\install.ps1
```

脚本用 **SHA256 比对**，所以会告诉你哪个文件真的变了，没变就不白写：

```text
pi 扩展同步
  源    F:\AI\My_Center\pi-extensions
  目标  C:\Users\zeke\.pi\agent

  [新增] ai-configure\index.ts
  [新增] ai-configure\config.ts
  [更新] ai-configure\board.ts  （2026-10-03 20:04 → 2026-10-03 20:17）
  [最新] ai-configure\delegate.ts
  [最新] ai-configure\help.ts

  [清理] ai-config.ts         ← 旧单文件，现在已不存在于源里
  [清理] task-board.ts
  [清理] delegate.ts

  [最新] backend.md
  [最新] db.md

扩展：5 个文件（1 更新, 2 新增, 2 未变）
2 个助理模板：0 更新, 0 新增, 2 未变
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
  "extensions": ["F:/AI/My_Center/pi-extensions"]
}
```

> ⚠️ **本仓库是「源」，`~/.pi/agent/extensions/` 里的是「生效副本」。** 两份是独立文件、不会自动同步。改了源之后要跑一遍 ``.\install.ps1`` 再 `/reload`（或者用 `-List` 先确认差异）；用方式 B 就没这个问题。

---

## 模块 1 · config.ts（AI 配置中心）

把「连接台账」翻译成 pi 能用的 MCP 配置。台账里只存**账面信息**（类型、连接串、只读/可写），翻译成本扩展负责。

### 命令

| 命令 | 作用 |
|---|---|
| `/ai` | 拉取台账 → 多选连接 → 选应用方式 → 生效 |
| `/ai token` | 手动输入 Master 密钥（**只存内存，不落盘**） |
| `/ai off` | 撤销本次会话级注册 |
| `/ai project off` | 从当前项目的 `.pi/mcp.json` 移除本扩展写入的条目 |
| `/ai status` | 查看当前状态 |

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CENTER_TOKEN` | 无 | Master 密钥。不设的话 `/ai` 时会弹框让你输 |
| `CENTER_API` | **必填** | 你的配置中心地址，例 `https://api.example.com`（末尾斜杠自动去掉）。**没设 → `/ai` 直接报错，不会连任何服务器** |

流程：`GET {CENTER_API}/api/ai/connectors`（带密钥）→ 过滤 `enabled` → 按 `kind` 翻译。

### 两种「应用方式」

| 方式 | 写入位置 | 何时生效 |
|---|---|---|
| **会话级** | 不落盘，走 `pi.registerMcpServer()` | **立即生效**，退出 pi 即消失 |
| **项目级** | 当前项目的 `.pi/mcp.json` | 需要 `/reload` 或重开 pi |

### 支持的连接类型

| `kind` | 生成的 MCP server |
|---|---|
| `postgres` | `npx -y mcp-postgres-server`，env 里给 `DATABASE_URL` 和 `PG_ALLOW_WRITE` |
| `sqlite` | `npx -y @modelcontextprotocol/server-sqlite <db 路径>` |
| `ssh` | `npx -y @fangjunjie/ssh-mcp-server`，带 `--host/--port/--username/--password`，可选 `--privateKey`、`--passphrase` |

其他 `kind` 会在多选列表里标注「暂未支持」并被跳过。

### 关键行为（权限控制）

- **所有生成的 server 都是 `exposure: "codemode"`** —— 工具默认**不声明给模型**，要由 `codemode` 脚本用 `searchTools()` / `describeTool()` 去找。这样几十个 MCP 工具不会撑爆上下文。
- **台账 `access: "read"`（只读）时会额外收紧**：
  - `postgres` → `PG_ALLOW_WRITE=false`
  - `ssh` → 追加 `--whitelist`，只放行读类命令（`ls/cat/grep/find/ps/systemctl status/journalctl/docker ps/git status…`）
  - 任何类型 → 名字像写操作的 MCP 工具被设成 `hidden`（`write_*`、`insert_*`、`update_*`、`delete_*`、`drop_*`、`create_*`、`alter_*`、`truncate*`、`upload*`、`execute` 等）
- `ssh` 一律加 `--pty false`：否则 `systemctl status` / `journalctl` 会起分页器卡住。
- 用 `postgres` 时选的是 `mcp-postgres-server` 而**不是**官方 `server-postgres`——后者只有只读查询，体现不了台账里的「可修改」。
- **密钥只管「能不能看到连接串」**：`GET /api/ai/connectors` 不带密钥也返回 `200`（前端的只读模式要用它），但 **`conn` 一律给空字符串** —— 主机 / 端口 / 库名一个都不下发；带了正确密钥才给明文。插件侧反过来更严：拿不到明文（`reveal: false`）就**直接拒绝**，不会拿半截台账去连。

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
| `/board mid` | 显示 / 隐藏**中栏**（现在 / 本轮 / 会话）|

### 面板分栏

**左栏（任务）固定最左；右边是几栏会话信息**：

| 栏 | 宽度 | 内容 |
|---|---|---|
| 左（任务） | 自适应，**保底 28** | 任务进度：标题、步骤（最多显示 **8** 步）、卡点、以及**自动跟踪的当前动作**（由 `tool_call` 事件推出，如「读取文件」「执行命令」） |
| 中（运行） | 24 | `现在` / `本轮` / `会话`。**面板总宽 ≥ 110 列才出现**，窄终端自动收起 |
| MCP | 平分剩余（上限 26 / 下限 9） | **MCP 服务**（区分 session / project / global 三级） |
| 插件 | 同上 | **已加载插件** |
| 助理 | 同上 | **助理**（`delegate` 现在能派谁） |

> **窄终端自动降级**：面板总宽 **< 88 列**时，MCP / 插件 / 助理 会**叠回一栏**（就是改之前的样子）。
> 名字按**实际栏宽**截断（带 `…`）。所以是 **4 栏**（总宽 < 110）还是 **5 栏**（总宽 ≥ 110）取决于你的终端宽度。

长这样（总宽 100 → 4 栏）：

```text
▛ 任务 看板拆成四栏 · 1/5   │ MCP 7                 │ 插件 3                │ 助理 3
  ✓ 1 拆右栏为三个独立栏    │ ● 全局 my-db          │ ● ai-configure        │ ● 业务数据库助理
  ⠋ 2 渲染改成多栏          │ ● 项目 my-server      │ ● pi-mcp-adapter      │ ● 业务服务器助理
     ▸ 读取文件 board.ts    │ ○ 全局 some-server…   │ ● some-plugin         │ ● 通用助理
  ○ 3 无头预览各宽度        │ ● 会话 dev-radius     │                       │ ○ 6 个不可派
```

> 面板**曾**有「模型 / token 用量 / git 分支」一行，已删 —— 一是你不想看，二是它每 2.4s 要跑一次 `git branch` 子进程。想看 token 用量和成本，用内置的 **`/session`**。

#### 「助理」一栏

```
助理 2
 ● 业务数据库助理
 ● 业务服务器助理
 ○ 6 个不可派
```

只列**能派的**（名字就是你传给 `delegate` 的 `assistant`）。
`base`（底座）和 `demo`（样板）派了会被拒，所以只数个数、不列名 —— 否则白白占两行。
数据来自 `delegate.ts` 导出的 `loadTemplates(cwd)`，跟 MCP / 插件一起在同一个低频刷新点更新（**不是每帧扫盘**）。

> 代价：新增/改名助理后最多 **2.4s** 才出现在「助理」栏；派发本身不缓存，随时改随时生效。

### 其他

- **状态会持久化**：每次更新都 `pi.appendEntry("task-board", …)`，所以 `/resume`、`/tree`、fork 之后看板还在。
- 监听的事件：`session_start`、`tool_call`、`turn_start`、`turn_end`、`agent_end`、`model_select`、`mcp_servers_change`、`before_agent_start`、`session_shutdown`。
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

### 命名规则

每次派发都会开一个**会话**，名字分两种：

| | 格式 | 例子 |
|---|---|---|
| **显示名**（`/resume-agent` 里看到的） | `<主进程名>-<代理名><序号>` | `修复登录bug-数据库助理1` |
| **会话 ID**（ASCII，机器用） | `<slug>-<年月日>-<时分秒>-<序号>` | `db-20261003-195122-1` |

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
目录    F:/AI/My_Center
任务    查 records 表有多少行
耗时    6s
找回    /resume-agent 里挑，或 pi --session "C:\...\assistant-sessions\db\<时间戳>_db-20261003-195122-1.jsonl"
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

#### 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `cwd` | | **在哪儿干活**。文件读写、相对路径、项目 `AGENTS.md` 都看它。**省略 = 跟随主进程当前所在的项目目录**（所以模板能跨机器复用，别在里面写死绝对路径） |
| `name` | | 显示名（中文也行）。省掉用文件名 |
| `desc` | | **什么时候该叫我**。不只是给人看的 —— 主 pi 就是靠这句话决定派谁，所以写「什么时候用我」，别写「我是谁」 |
| `mcp` | | 要挂的 MCP 名字，逗号分隔（`mcp: my-db, my-server`）。**留空 = 一个都不挂** |
| `timeout` | | 默认超时，如 `10m` / `90s` / `1.5h`。省掉 = 5 分钟 |
| `model` | | 省掉继承默认 |
| `mcp_exposure` | | `codemode`（默认）/ `direct`（专职助理更省事）/ `deferred` |
| `agents_md` | | `false` = 不带全局 `AGENTS.md`，每次省约 1500 token |
| `extends` | | 继承父模板，见下 |
| `base` | | `true` = **只给 extends 用，不能直接派**（拿来写公共规矩） |
| `demo` | | `true` = **示例模板：能看 / 能 show / 能 extends，但绝对不能派** |
| `enabled` | | `false` = 列表里不显示、也派不了 |
| `tools` | | **工具白名单**（精确匹配，逗号分隔）。写了就**只给这些工具**。⚠️ MCP 工具名是 `mcp__<server>__<tool>`，用白名单时必须逐个列出，否则那台 MCP 的工具会不可用（派发时会硬拦并提示） |
| `deny_tools` | | 额外禁用的工具，逗号分隔（追加到默认的 `delegate,progress` 黑名单） |
| `isolate_env` | | `true` = **环境变量隔离**：子进程只拿一份白名单（系统必需变量 + `PI_*`/`NODE_*`/`npm_*`）。默认 `false`（继承全部）。⚠️ 模型 key 若只放在环境变量里，要用 `env_passthrough` 显式保留 |
| `env_passthrough` | | `isolate_env: true` 时额外保留的环境变量名，逗号分隔（如 `ANTHROPIC_API_KEY`） |

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
│   工作目录         F:/AI/My_Center     (在哪儿干活：文件读写 / 项目 AGENTS.md) │
│   模型             (空)               (留空 = 继承默认)                    │
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
| 本地目录 | `~/.pi/agent/mcp-catalog.json` | 自己手写的兜底清单。**不会被任何会话自动加载**，只当候选 |
| 用户级 | `~/.pi/agent/mcp.json` | 所有会话都加载的那种 |
| 项目级 | `<cwd>/.pi/mcp.json` | `/ai` 从配置中心拉的线上连接会落到这里 |

`/assistants edit <key>` 里那个多选框列的就是这三处合起来的候选池，并标注每个是从哪来的。文件不存在会自动建空壳。

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
- ⚠️ 同时最多跑 **4 个助理**（`delegate.ts` 的 `MAX_CONCURRENT_RUNS`），超出的**排队** —— 防一次 `tasks` 派太多把机器 / 额度打爆。
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
 ▛ 任务 记忆中心上 VM 并接入中心 · 8/8
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

## 许可

MIT —— 见仓库根目录的 `LICENSE`。
