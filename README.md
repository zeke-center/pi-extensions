# pi-extensions

我在用的 pi 编码 agent 扩展合集。两个单文件扩展，全部是「本地 TypeScript」形式：pi 用 jiti 直接加载，**不需要编译、不需要 npm install**。

| 文件 | 扩展 | 一句话 |
|---|---|---|
| `ai-config.ts` | **AI 配置中心** · `/ai` | 从 Center 后端拉「连接台账」，选完立刻在本会话注册成 MCP server |
| `task-board.ts` | **任务进度看板** · `/board` + `progress` 工具 | 输入框上方常驻双/三栏面板：左任务进度、右会话信息 |

```text
pi-extensions/
├── ai-config.ts     # 扩展 1：连接台账 → MCP
├── task-board.ts    # 扩展 2：进度看板 + 会话信息栏
├── install.ps1      # 同步脚本：源 → ~/.pi/agent/extensions/（Windows）
├── .gitignore
└── README.md
```

---

## 安装

### 方式 A：同步脚本（推荐，Windows）

pi 默认从 `~/.pi/agent/extensions/` 加载扩展。用脚本把两个 `.ts` 同步过去：

```powershell
.\install.ps1
```

脚本用 **SHA256 比对**，所以会告诉你哪个文件真的变了，没变就不白写：

```text
pi 扩展同步
  源    F:\AI\My_Center\pi-extensions
  目标  C:\Users\zeke\.pi\agent\extensions

  [更新] ai-config.ts  （2026-10-02 20:48 → 2026-10-02 20:49）
  [最新] task-board.ts

2 个扩展：1 更新, 0 新增, 1 未变
→ 在 pi 里执行 /reload 生效
```

| 用法 | 作用 |
|---|---|
| `.\install.ps1` | 同步全部扩展 |
| `.\install.ps1 ai-config` | 只同步指定的（可写多个，不带 `.ts`） |
| `.\install.ps1 -List` | **只对比、不写文件**，用来检查两份是否一致 |
| `.\install.ps1 -Force` | 跳过错比对，无条件覆盖 |

目标目录取 `$env:PI_CODING_AGENT_DIR`，没设就用默认的 `~\.pi\agent`；目录不存在会自动创建。

若 PowerShell 拦执行策略，用 `powershell -ExecutionPolicy Bypass -File .\install.ps1`。

### 方式 A′：手动复制（macOS / Linux）

```bash
cp pi-extensions/*.ts ~/.pi/agent/extensions/
```

无论哪种方式，同步完在 pi 里执行 `/reload`（或重开 pi）。依赖 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox` 都由 **pi 宿主提供**，不用自己装。

### 方式 B：用 settings 指向本目录

不想复制、想直接编辑本仓库的，在 `~/.pi/agent/settings.json` 里加路径（用户设置的相对路径以 agent 目录为基准，绝对路径和 `~` 也支持）：

```json
{
  "extensions": ["F:/AI/My_Center/pi-extensions"]
}
```

> ⚠️ **本仓库是「源」，`~/.pi/agent/extensions/` 里的是「生效副本」。** 两份是独立文件、不会自动同步。改了源之后要跑一遍 ``.\install.ps1`` 再 `/reload`（或者用 `-List` 先确认差异）；用方式 B 就没这个问题。

---

## 扩展 1 · ai-config（AI 配置中心）

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
| `CENTER_API` | `https://api.zeke0419.top` | 后端地址（末尾斜杠会自动去掉） |

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

---

## 扩展 2 · task-board（任务进度看板）

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
| `/board right` | 显示 / 隐藏**右栏** |
| `/board mid` | 显示 / 隐藏**中栏** |

### 三栏内容

| 栏 | 宽度 | 内容 |
|---|---|---|
| 左 | 自适应 | 任务进度：标题、步骤（最多显示 **8** 步）、卡点、以及**自动跟踪的当前动作**（由 `tool_call` 事件推出，如「读取文件」「执行命令」） |
| 中 | 24 | `现在` / `本轮` / `会话`。**面板总宽 ≥ 110 列才显示**，窄终端自动收起 |
| 右 | 26 | 会话信息：模型、token 用量、git 分支、MCP 服务（区分 session / project / global 三级）、已加载插件 |

### 其他

- **状态会持久化**：每次更新都 `pi.appendEntry("task-board", …)`，所以 `/resume`、`/tree`、fork 之后看板还在。
- 监听的事件：`session_start`、`tool_call`、`turn_start`、`turn_end`、`agent_end`、`model_select`、`mcp_servers_change`、`before_agent_start`、`session_shutdown`。
- 顶栏的 spinner 会随 agent 运行状态动。

---

## 安全须知

- **不要把敏感信息提交进本仓库。** Master 密钥（`CENTER_TOKEN`）只走环境变量或 `/ai token` 的输入框（内存态，不落盘）；`.gitignore` 已经排除 `.env`、`.pi/mcp.json`、`*.local`、`token.txt` 等。
- **项目级应用模式会把连接串（含明文密码）写进你项目的 `.pi/mcp.json`。** 那个文件属于你的项目仓库，务必确认它已被忽略，别提交出去。
- `/ai` 拉回来的 MCP 配置里带着凭据，`/ai status` 只显示状态、不打印密钥。

---

## 开发 / 同步

```powershell
# 改完源文件 → 同步到生效目录 → 在 pi 里 /reload
.\install.ps1

# 只想看看改了哪个、不写文件
.\install.ps1 -List
```

单个扩展就是一个默认导出的工厂函数：

```ts
export default function (api: ExtensionAPI): void {
  api.registerCommand("board", { … });
  api.registerTool({ name: "progress", … });
}
```

参考 pi 自带文档（装在 `@earendil-works/pi-coding-agent` 包里）：`docs/extensions.md`、`docs/mcp.md`、`docs/codemode.md`、`docs/settings.md`、`docs/tui.md`。

## 许可

私人自用，未附许可。
