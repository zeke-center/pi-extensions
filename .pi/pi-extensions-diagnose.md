# pi-extensions 自检报告（供 AI 排障用）

> **给读这份报告的 AI**：这是一个 pi 编码 agent 插件（`@zeke-center/pi-extensions`）的运行时快照。
> 报告由插件自己生成（`/aidoctor export`），事实优先、未经人工修饰；
> 敏感值（密码 / token / api key）已自动替换成 `***`，**键名保留**，所以你能判断「配了哪一项」但看不到值。
> 建议阅读顺序：结论 → 助理 → MCP → 影子目录 → 最近任务 → 日志尾巴。
> 需要更多信息时，看最后一节「还需要用户提供什么」。

生成时间：2026-11-26T03:10:47.094Z
插件版本：2.9.0　pi：1.5.2　node：v24.14.0
系统：win32 10.0.26200　项目目录（cwd）：F:\AI\My_Center\pi-extensions

## 1. 结论

❌ 严重问题 **2** 个（会导致派活失败 / 配置不生效）
⚠ 需要注意 **3** 个

- ❌ 助理「db」要连的 MCP「my-db」在候选池里找不到 → 派发会被拒或工具挂不上
  - 修法：把定义加到 ~/.pi/agent/mcp-catalog.json，或改助理的 mcp 行
- ❌ 助理「server」要连的 MCP「my-server」在候选池里找不到 → 派发会被拒或工具挂不上
  - 修法：把定义加到 ~/.pi/agent/mcp-catalog.json，或改助理的 mcp 行
- ⚠ 助理「db」配置矛盾：声明连 MCP（my-db）但 net=none：MCP 是子进程且要联网，会被拦掉 → 一个工具都挂不上。要连就把 net 设成 allow
- ⚠ 助理「server」配置矛盾：声明连 MCP（my-server）但 net=none：MCP 是子进程且要联网，会被拦掉 → 一个工具都挂不上。要连就把 net 设成 allow
- ⚠ 最近 20 次派活里有 1 次失败/空跑（详见「最近任务」段）

补充说明（不影响使用）：

- MCP「center-pg」是 exposure=codemode → 它的工具**不会**以 mcp__center-pg__* 出现，要用 codemode 里的 searchTools 找（别误判成「没注入」）
- MCP「nas-ubuntu24」是 exposure=codemode → 它的工具**不会**以 mcp__nas-ubuntu24__* 出现，要用 codemode 里的 searchTools 找（别误判成「没注入」）

## 2. 环境与路径

```
插件版本        2.9.0
pi 版本         1.5.2
node            v24.14.0
系统            win32 10.0.26200
项目目录 cwd    F:\AI\My_Center\pi-extensions
agentDir        C:\Users\zeke\.pi\agent
项目信任状态    已信任 true
Herdr           可用（pane 6 个，term=herdr）
影子目录        2 个，最新 9 分钟前（assistant-1cx6p4r-qhwekl）
```

已装的 pi 扩展（`~/.pi/agent/extensions/`）：

- ai-configure
- herdr-agent-state.ts

## 3. 关键文件清单

| 文件 | 存在 | 大小 | 修改时间 | 说明 |
|---|---|---|---|---|
| `C:\Users\zeke\.pi\agent\ai-extensions.json` | ✅ | 1215 | 2026-11-25 03:26:19 | 全局配置 |
| `F:\AI\My_Center\pi-extensions\.pi\ai-extensions.json` | ❌ | - | - | 项目配置（覆盖全局） |
| `C:\Users\zeke\.pi\agent\trust.json` | ✅ | 56 | 2026-10-24 12:40:40 | pi 的项目信任记录 |
| `C:\Users\zeke\.pi\agent\mcp-catalog.json` | ✅ | 749 | 2026-11-20 09:33:51 | MCP 候选池 |
| `C:\Users\zeke\.pi\agent\mcp.json` | ✅ | 260 | 2026-10-08 17:00:28 | 用户级 MCP（会被影子覆盖） |
| `F:\AI\My_Center\pi-extensions\.pi\mcp.json` | ❌ | - | - | 项目级 MCP（需已信任） |
| `C:\Users\zeke\.pi\agent\settings.json` | ✅ | 317 | 2026-11-12 02:20:51 | pi 全局设置 |
| `C:\Users\zeke\.pi\agent\extensions` | ✅ | 0 | 2026-10-21 07:02:25 | 已装扩展目录 |
| `C:\Users\zeke\.pi\agent\assistants` | ✅ | 0 | 2026-10-10 03:25:20 | 全局助理目录 |
| `F:\AI\My_Center\pi-extensions\.pi\assistants` | ❌ | - | - | 项目级助理目录 |
| `F:\AI\My_Center\pi-extensions\guard.log` | ❌ | - | - | 守卫日志（本项目的） |
| `C:\Users\zeke\.pi\agent\herdr.log` | ✅ | 270 | 2026-11-25 08:05:12 | Herdr 探测日志 |
| `C:\Users\zeke\.pi\agent\crashes.json` | ✅ | 5169 | 2026-11-20 02:06:23 | 崩溃记录 |

## 4. 配置（已脱敏）

全局 `<agentDir>/ai-extensions.json`：

```json
{
  "voiceTalk": false,
  "voiceSilenceMs": 1500,
  "assistantLingerMs": 45000,
  "voiceClip": false,
  "voiceHud": false,
  "voiceClipTriggerMode": "silent",
  "voiceTts": false,
  "voicePlanAuto": true,
  "voicePlanTimeout": 120,
  "voicePlanTimeoutRun": false,
  "voicePopup": false,
  "voiceClipGuess": false,
  "voiceResult": false,
  "telegram": {
    "token": "***",
    "offset": 904383242,
    "chats": [
      {
        "chatId": 8824594937,
        "label": "zhao qiukai",
        "boundTo": "DESKTOP-UMN065D:F:\\AI\\My_Center",
        "at": 1792132127769
      }
    ]
  },
  "voiceLocalVoice": 51,
  "voiceDoubaoToken": "***",
  "voiceDoubaoVoice": "zh_male_wennuanahu_uranus_bigtts",
  "voiceDoubaoKey": "376620de-7ad6-45e7-b16e-7f97f36406e8",
  "voiceLevel": "steps",
  "voiceAck": true,
  "voiceEngine": "doubao",
  "voiceTone": "off",
  "telemetryInstallId": "235f8dc0-b1df-42f6-b630-97c4526ecdaa",
  "telemetryUpload": true,
  "telemetryConsentVersion": 1,
  "telemetryConsentAt": "2026-10-18T06:10:34.155Z",
  "superagent": {
    "enabled": true,
    "ui": "auto",
    "router": "readonly",
    "batchLive": true
  }
}
```

项目 `<cwd>/.pi/ai-extensions.json`（无则空对象）：

```json
{}
```

> 注意：项目级会**覆盖**全局同名项（`superagent.enabled` 等）；所以「全局关了但项目里开着」是正常现象。

## 5. 助理（子代理）逐个说明

### 5.1 `backend` — 后端助理

```
来源        全局
文件        C:\Users\zeke\.pi\agent\assistants\backend.md
类型        示例（demo，不能派）
extends     role-dev
描述        改后端代码、修后端 bug、加/改接口、跑后端迁移时用我。会改后端仓库里的文件，不碰前端。互相独立的多件活可以一次并行派给我。
工作目录    F:\AI\My_Center\pi-extensions
权限        只读 · 不执行 · 无网
MCP         (不连，默认隔离)
模型        (继承主会话)
超时        15 分钟
轮数上限    (用全局配置)
```

**它能做 / 不能做（由权限推导）**：

能做：
- 读文件：任意路径

不能做：
- 改文件：完全不能（fs=read）
- 跑命令：完全不能（exec=none）
- 联网：不允许 —— 联网类工具被摘掉，bash 里的 psql/curl/wget/ssh/git push/npm install 会被拦
- MCP：若模板写了 mcp:，需要 net=allow 才能起得来

原始 frontmatter（脱敏）：

```yaml
---
name: 后端助理
desc: 改后端代码、修后端 bug、加/改接口、跑后端迁移时用我。会改后端仓库里的文件，不碰前端。互相独立的多件活可以一次并行派给我。
demo: true
extends: role-dev
timeout: 15m
---
```

正文开头（400 字，脱敏）：

```
你是后端修理工。你负责后端仓库，不碰前端和其它仓库。

额外的规矩：
1. 只动后端目录，不碰前端目录。
2. **建表/改表结构走「部署后端」这条路**（后端启动时会自动跑 schema.sql），不要手工在库里改结构。
3. 要改线上数据走后端 API（带上认证头），别直连数据库写。
4. 改完要能说清"哪个接口的行为变了、怎么验证的"。
```

### 5.2 `db` — 数据库助理

```
来源        全局
文件        C:\Users\zeke\.pi\agent\assistants\db.md
类型        示例（demo，不能派）
extends     role-ops
描述        连数据库查数据、验证数据、探表结构时用我。默认只读，不主动改数据。互相独立的多件查询可以一次并行派给我。
工作目录    F:\AI\My_Center\pi-extensions
权限        只读 · 不执行 · 无网
MCP         my-db
模型        (继承主会话)
超时        5 分钟
轮数上限    (用全局配置)
```

**它能做 / 不能做（由权限推导）**：

能做：
- 读文件：任意路径

不能做：
- 改文件：完全不能（fs=read）
- 跑命令：完全不能（exec=none）
- 联网：不允许 —— 联网类工具被摘掉，bash 里的 psql/curl/wget/ssh/git push/npm install 会被拦
- MCP：若模板写了 mcp:，需要 net=allow 才能起得来

**配置问题**：

- ⚠ [mcp-net] 声明连 MCP（my-db）但 net=none：MCP 是子进程且要联网，会被拦掉 → 一个工具都挂不上。要连就把 net 设成 allow

原始 frontmatter（脱敏）：

```yaml
---
name: 数据库助理
desc: 连数据库查数据、验证数据、探表结构时用我。默认只读，不主动改数据。互相独立的多件查询可以一次并行派给我。
demo: true
extends: role-ops
mcp: my-db
---
```

正文开头（400 字，脱敏）：

```
你是数据查询员。

额外的规矩：
1. 只碰业务库，别去查系统库或别的库。
2. 表名/字段名拿不准就先探结构，别瞎猜字段。
3. 报数的时候把口径写清楚（哪张表、什么条件、时间范围），否则主进程没法用它。
```

### 5.3 `frontend` — 前端助理

```
来源        全局
文件        C:\Users\zeke\.pi\agent\assistants\frontend.md
类型        示例（demo，不能派）
extends     role-dev
描述        改前端页面/组件/样式、修前端 bug、调接口对接时用我。会改前端仓库里的文件，推送后自动上线。互相独立的多件活可以一次并行派给我。
工作目录    F:\AI\My_Center\pi-extensions
权限        只读 · 不执行 · 无网
MCP         (不连，默认隔离)
模型        (继承主会话)
超时        15 分钟
轮数上限    (用全局配置)
```

**它能做 / 不能做（由权限推导）**：

能做：
- 读文件：任意路径

不能做：
- 改文件：完全不能（fs=read）
- 跑命令：完全不能（exec=none）
- 联网：不允许 —— 联网类工具被摘掉，bash 里的 psql/curl/wget/ssh/git push/npm install 会被拦
- MCP：若模板写了 mcp:，需要 net=allow 才能起得来

原始 frontmatter（脱敏）：

```yaml
---
name: 前端助理
desc: 改前端页面/组件/样式、修前端 bug、调接口对接时用我。会改前端仓库里的文件，推送后自动上线。互相独立的多件活可以一次并行派给我。
demo: true
extends: role-dev
timeout: 15m
---
```

正文开头（400 字，脱敏）：

```
你是前端修理工。你负责前端仓库，不碰后端和其它仓库。

额外的规矩：
1. 别动后端代码；需要后端改接口时，写清楚"需要后端做什么"，让主进程去派后端助理。
2. 改完要能说清"用户在页面上会看到什么变化"。
3. 前端推到远端就等于上线了 —— **不要自己 push**，除非主进程明确让你推。
```

### 5.4 `general` — 通用助理

```
来源        全局
文件        C:\Users\zeke\.pi\agent\assistants\general.md
类型        可派发
extends     (无)
描述        只做杂活：查资料、读代码、跑命令、做小改动。数据库找 db、服务器找 server、前端找 frontend、后端找 backend —— 有专才就别派我。
工作目录    F:\AI\My_Center\pi-extensions
权限        可写 1 个目录 · 命令不限 · 可联网
MCP         (不连，默认隔离)
模型        (继承主会话)
超时        10 分钟
轮数上限    (用全局配置)
```

**它能做 / 不能做（由权限推导）**：

能做：
- 改文件：仅限 ${cwd}（相对工作目录）
- 跑命令：不限
- 联网：允许（MCP / psql / curl 等都可能连）

不能做：
- (无)

原始 frontmatter（脱敏）：

```yaml
---
name: 通用助理
desc: 只做杂活：查资料、读代码、跑命令、做小改动。数据库找 db、服务器找 server、前端找 frontend、后端找 backend —— 有专才就别派我。
timeout: 10m
# 权限（Super Agent 模式生效）
#   fs/paths —— 只能写自己项目目录（${cwd}）；~/.pi/agent、.git、插件源码一律硬保护
#   exec any —— dev 角色要跑 build/commit/push，命令白名单对 node/powershell 等于没限；
#              与其给假的安全感，不如靠 guard 记日志（exec 硬拦开关 execHardBlock，默认关）
#   net allow —— 要跑 curl / 拉依赖排障
fs: write
paths: ${cwd}
exec: any
net: allow
---
```

正文开头（400 字，脱敏）：

```
你是主进程派来的临时助理。规矩：

1. **先想再做**：动手前先明确要查什么、改什么，一次只做一件事。
2. **只做被要求的事**：不顺手重构、不改无关文件、不扩大范围。
3. **必须自验**：改完自己跑一遍；查完给证据（命令 / 文件 / 行号）。
4. **到点交半成品**：时间不够就停下，写清「已完成什么、还差什么」，别硬撑。

交卡格式：

状态: 完成 / 卡住 / 需要信息
结论: 一句话
证据: 最多 3 行
```

### 5.5 `role-dev` — 开发助理（底座）

```
来源        全局
文件        C:\Users\zeke\.pi\agent\assistants\role-dev.md
类型        底座（base，只读，只能被 extends）
extends     (无)
描述        开发类助理的公共底座，只给其它模板 extends 用，不能直接派。
工作目录    F:\AI\My_Center\pi-extensions
权限        只读 · 不执行 · 无网
MCP         (不连，默认隔离)
模型        (继承主会话)
超时        10 分钟
轮数上限    (用全局配置)
```

**它能做 / 不能做（由权限推导）**：

能做：
- 读文件：任意路径

不能做：
- 改文件：完全不能（fs=read）
- 跑命令：完全不能（exec=none）
- 联网：不允许 —— 联网类工具被摘掉，bash 里的 psql/curl/wget/ssh/git push/npm install 会被拦
- MCP：若模板写了 mcp:，需要 net=allow 才能起得来

原始 frontmatter（脱敏）：

```yaml
---
name: 开发助理（底座）
desc: 开发类助理的公共底座，只给其它模板 extends 用，不能直接派。
base: true
agents_md: true
timeout: 10m
---
```

正文开头（400 字，脱敏）：

```
你是修理工。动手之前先想清楚，动手之后必须自验。

规矩：
1. **动手前先把「要改哪些文件、怎么改」说清楚**（这一步不能省）。改动要小，一次别贪多。
2. 改完必须自己验证：跑一遍、查一遍，或者至少把 diff 看一遍。没验证不许说"完成"。
3. 结论必须写清三件事：改了哪些文件、改了什么、你怎么验证的。有遗留问题就明说。
4. 拿不准就停下来说拿不准，不要硬改、不要猜。
5. 只在你的工作目录里动手，别碰别的仓库。
```

### 5.6 `role-doc` — 文档助理（底座）

```
来源        全局
文件        C:\Users\zeke\.pi\agent\assistants\role-doc.md
类型        底座（base，只读，只能被 extends）
extends     (无)
描述        写文档 / 总结 / 整理结论类助理的公共底座，只给其它模板 extends 用，不能直接派。
工作目录    F:\AI\My_Center\pi-extensions
权限        只读 · 不执行 · 无网
MCP         (不连，默认隔离)
模型        (继承主会话)
超时        10 分钟
轮数上限    (用全局配置)
```

**它能做 / 不能做（由权限推导）**：

能做：
- 读文件：任意路径

不能做：
- 改文件：完全不能（fs=read）
- 跑命令：完全不能（exec=none）
- 联网：不允许 —— 联网类工具被摘掉，bash 里的 psql/curl/wget/ssh/git push/npm install 会被拦
- MCP：若模板写了 mcp:，需要 net=allow 才能起得来

原始 frontmatter（脱敏）：

```yaml
---
name: 文档助理（底座）
desc: 写文档 / 总结 / 整理结论类助理的公共底座，只给其它模板 extends 用，不能直接派。
base: true
agents_md: true
timeout: 10m
---
```

正文开头（400 字，脱敏）：

```
你是文书。你的产出是「能直接粘进文档」的东西，不是聊天回复。

规矩：
1. **只写文档**：不改代码、不改配置、不改数据。需要改就写进结论，让主进程决定。
2. **先看再写**：动笔前把相关文件 / 代码 / 数据读一遍，别凭印象编。
3. **不编**：拿不准的地方明确标出来（写成 `TODO(待确认)`），不要写得像已经确定。
4. **能直接粘**：给 Markdown，标题层级 / 代码块 / 表格都用对；不要写「我可以帮你…」这类客套正文。
5. 结论写清三件事：写了/改了哪个文件或哪一段、依据是什么、哪里还不确定。
```

### 5.7 `role-ops` — 查询/运维助理（底座）

```
来源        全局
文件        C:\Users\zeke\.pi\agent\assistants\role-ops.md
类型        底座（base，只读，只能被 extends）
extends     (无)
描述        只读类助理的公共底座，只给其它模板 extends 用，不能直接派。
工作目录    F:\AI\My_Center\pi-extensions
权限        只读 · 不执行 · 无网
MCP         (不连，默认隔离)
模型        (继承主会话)
超时        5 分钟
轮数上限    (用全局配置)
```

**它能做 / 不能做（由权限推导）**：

能做：
- 读文件：任意路径

不能做：
- 改文件：完全不能（fs=read）
- 跑命令：完全不能（exec=none）
- 联网：不允许 —— 联网类工具被摘掉，bash 里的 psql/curl/wget/ssh/git push/npm install 会被拦
- MCP：若模板写了 mcp:，需要 net=allow 才能起得来

原始 frontmatter（脱敏）：

```yaml
---
name: 查询/运维助理（底座）
desc: 只读类助理的公共底座，只给其它模板 extends 用，不能直接派。
base: true
timeout: 5m
mcp_exposure: direct
---
```

正文开头（400 字，脱敏）：

```
你是查证员。你只做一件事：把主进程要的事实查清楚、说清楚。

规矩：
1. **只读**。不执行任何写操作（INSERT/UPDATE/DELETE/CREATE/ALTER/DROP），也不改文件。
2. 动手前先一句话说明你要查什么、怎么查。
3. 试错随便试（多查几条、换几个口径对比都行），但**不要把中间过程写进结论**。
4. 结论里必须带上"你是怎么确认的"——用了什么表/什么命令、什么条件、什么关键输出。
5. 查不到就说查不到，不要猜。结果和预期不符时如实说，不要圆回来。
```

### 5.8 `role-review` — 审查助理（底座）

```
来源        全局
文件        C:\Users\zeke\.pi\agent\assistants\role-review.md
类型        底座（base，只读，只能被 extends）
extends     (无)
描述        代码审查 / 复核改动 / 找问题类助理的公共底座，只给其它模板 extends 用，不能直接派。
工作目录    F:\AI\My_Center\pi-extensions
权限        只读 · 不执行 · 无网
MCP         (不连，默认隔离)
模型        (继承主会话)
超时        10 分钟
轮数上限    (用全局配置)
```

**它能做 / 不能做（由权限推导）**：

能做：
- 读文件：任意路径

不能做：
- 改文件：完全不能（fs=read）
- 跑命令：完全不能（exec=none）
- 联网：不允许 —— 联网类工具被摘掉，bash 里的 psql/curl/wget/ssh/git push/npm install 会被拦
- MCP：若模板写了 mcp:，需要 net=allow 才能起得来

原始 frontmatter（脱敏）：

```yaml
---
name: 审查助理（底座）
desc: 代码审查 / 复核改动 / 找问题类助理的公共底座，只给其它模板 extends 用，不能直接派。
base: true
agents_md: true
timeout: 10m
---
```

正文开头（400 字，脱敏）：

```
你是审查员。你只挑毛病，不动手。

规矩：
1. **只读**：绝不改文件、不改数据库、不提交。发现问题写进结论，别顺手修。
2. **每条都要给证据**：`文件:行号` + 关键代码几行，别只给判断。
3. **按严重度排序**：❌ 会挂 / ⚠️ 有隐患 / 💡 可以更好 —— 严重的先说。
4. **不凑数**：没发现真问题就说「没发现」，不要为了显得有用硬编几条。
5. **区分事实和口味**：纯风格偏好明确标成「口味」，别混进真 bug。
```

### 5.9 `server` — 服务器助理

```
来源        全局
文件        C:\Users\zeke\.pi\agent\assistants\server.md
类型        示例（demo，不能派）
extends     role-ops
描述        看服务器状态、翻日志、查进程/磁盘/端口、排查服务为什么挂了时用我。默认只读，不重启服务、不改服务器上的文件。
工作目录    F:\AI\My_Center\pi-extensions
权限        只读 · 不执行 · 无网
MCP         my-server
模型        (继承主会话)
超时        8 分钟
轮数上限    (用全局配置)
```

**它能做 / 不能做（由权限推导）**：

能做：
- 读文件：任意路径

不能做：
- 改文件：完全不能（fs=read）
- 跑命令：完全不能（exec=none）
- 联网：不允许 —— 联网类工具被摘掉，bash 里的 psql/curl/wget/ssh/git push/npm install 会被拦
- MCP：若模板写了 mcp:，需要 net=allow 才能起得来

**配置问题**：

- ⚠ [mcp-net] 声明连 MCP（my-server）但 net=none：MCP 是子进程且要联网，会被拦掉 → 一个工具都挂不上。要连就把 net 设成 allow

原始 frontmatter（脱敏）：

```yaml
---
name: 服务器助理
desc: 看服务器状态、翻日志、查进程/磁盘/端口、排查服务为什么挂了时用我。默认只读，不重启服务、不改服务器上的文件。
demo: true
extends: role-ops
mcp: my-server
timeout: 8m
---
```

正文开头（400 字，脱敏）：

```
你是巡检员。你负责那台服务器，只看看、只报告。

额外的规矩：
1. **不许改服务器状态**：不重启/不停止服务、不写文件、不装包、不删东西。要动就写进结论，让主进程决定。
2. 给结论时带上原始证据（命令 + 关键输出几行），别只给判断。
3. 日志太长就只摘相关的那几段，不要把整份日志抄回来。
```

## 6. MCP（候选池 + 实际注入）

候选池来源：`<agentDir>/mcp-catalog.json` 与 `<cwd>/.pi/mcp.json`（后者要项目已信任）。

| server | exposure | command | args | env 键名 | 备注 |
|---|---|---|---|---|---|
| `center-pg` | codemode | npx | -y mcp-postgres-server | DATABASE_URL, PG_ALLOW_WRITE | Center 中枢库 |
| `nas-ubuntu24` | codemode | npx | -y @fangjunjie/ssh-mcp-server --host 192.168.0.103 --port 22 --username zhaoqiukai --password *** --pty false | - | NAS-ubuntu虚拟机 |
| `memory-center-team` | (默认) | - | - | - |  |

**关于 exposure**：`direct` 的 MCP 工具会以 `mcp__<名字>__<工具>` 出现在工具清单里；
`codemode` 的**不会**直接出现，要通过 `codemode` 里的 `searchTools()` / `describeTool()` 访问 —— **别把「没有 mcp__* 工具」当成「MCP 没注入」**。

最近一个影子目录里**实际写入**的 `mcp.json`（这就是 Worker 真正会加载的）：

```json
{
  "mcpServers": {
    "center-pg": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-postgres-server"
      ],
      "env": {
        "DATABASE_URL": "***",
        "PG_ALLOW_WRITE": "true"
      },
      "exposure": "codemode",
      "description": "Center 中枢库"
    }
  }
}
```

影子里的 `permissions.json`（L3 守卫读的就是这个）：

```json
{
  "fs": "read",
  "paths": [],
  "exec": "any",
  "cmds": [],
  "net": "none"
}
```

## 7. 影子目录（Worker 的 PI_CODING_AGENT_DIR）

共 2 个；每个 Worker 一个，带自己的一份 `mcp.json` / `permissions.json` / `settings.json`。

最新那个的文件清单：

- `AGENTS.md`
- `auth.json`
- `bin`
- `extensions`
- `guard-config.json`
- `mcp.json`
- `models-store.json`
- `models.json`
- `permissions.json`
- `settings.json`

## 8. 最近任务（.bg 记录，最多 20 条）

| id | 状态 | 判定原因 | 耗时 | 提示 | 最后一次错误 |
|---|---|---|---|---|---|
| `1cx6p4-20261126-110140522-1-j33grx` | empty | - | - | - | - |
| `a6tffv-20261126-094756089-1-d23oon` | done | - | - | - | - |
| `batch-mwvx7k00-ol0flf:item:3` | done | - | - | - | 主会话正在跑，等它空闲再投（不排队，避免被 clearQueue 吞掉） |
| `batch-mwvx7k00-ol0flf:item:2` | done | - | - | - | 主会话正在跑，等它空闲再投（不排队，避免被 clearQueue 吞掉） |
| `batch-mwvx7k00-ol0flf:item:1` | done | - | - | - | 主会话正在跑，等它空闲再投（不排队，避免被 clearQueue 吞掉） |
| `batch-mwvx7k00-ol0flf:item:0` | done | - | - | - | 主会话正在跑，等它空闲再投（不排队，避免被 clearQueue 吞掉） |
| `batch-mwvx7k00-ol0flf` | done | - | - | - | 主会话正在跑，等它空闲再投（不排队，避免被 clearQueue 吞掉） |
| `batch-mwvx2dae-wazpal:item:3` | done | - | - | - | 主会话正在跑，等它空闲再投（不排队，避免被 clearQueue 吞掉） |
| `batch-mwvx2dae-wazpal:item:2` | done | - | - | - | 主会话正在跑，等它空闲再投（不排队，避免被 clearQueue 吞掉） |
| `batch-mwvx2dae-wazpal:item:1` | done | - | - | - | - |
| `batch-mwvx2dae-wazpal:item:0` | done | - | - | - | - |
| `batch-mwvx2dae-wazpal` | done | - | - | - | - |
| `a6tffv-20261125-162617308-4-76prin` | done | - | - | - | 主会话正在跑，等它空闲再投（不排队，避免被 clearQueue 吞掉） |
| `a6tffv-20261125-162433562-3-vczc6n` | done | - | - | - | - |
| `a6tffv-20261125-162834518-5-5d4rut` | done | - | - | - | - |
| `a6tffv-20261125-162349449-2-uxledz` | done | - | - | - | - |
| `a6tffv-20261125-162209906-1-ird8ht` | done | - | - | - | - |
| `a6tffv-20261125-161917199-4-5moos1` | done | - | - | - | - |
| `a6tffv-20261125-161811921-3-trddd3` | done | - | - | - | - |
| `batch-mwvul4vc-cfh61b:item:1` | done | - | - | - | - |

## 9. 日志尾巴（已脱敏）

`guard.log`（最近 200 行）：

```
(空)
```

`herdr.log`（最近 100 行）：

```
2026-11-25T03:50:37.763Z PANE_STOPPED w2:p6G
2026-11-25T07:51:25.506Z PANE_STOPPED w2:p77
2026-11-25T07:51:25.730Z PANE_STOPPED w2:p78
2026-11-25T07:51:41.379Z PANE_STOPPED w2:p79
2026-11-25T07:56:37.346Z PANE_STOPPED w2:p7A
2026-11-25T08:05:12.171Z PANE_STOPPED w2:p7B
```

崩溃记录（`<agentDir>/crashes.json`）：

```
共 3 条，最近：? overlay.component.invalidate is not a function
```

## 11. 还需要用户提供什么（给对面的 AI）

- **具体现象**：点哪个命令 / 派了哪个助理 / 期望什么 / 实际看到什么（越具体越好，比如卡片原文）
- **是否重启过 pi**：`/reload` 对已注册的工具不生效，改完代码必须重启进程
- **失败那次的会话 ID**（卡片上的 `sessionId`）：可以 `/resume-agent` 看过程，或 `/batch <id>` 看归档正文
- **如果涉及 MCP**：那个 server 的 command 能不能在终端里手动跑起来（这决定是「注入问题」还是「server 本身起不来」）
- **如果涉及网络/数据库**：目标地址是否可达、凭据是否有效（**不要贴密码**，只说「能否连通」）

---
本报告由插件自动生成；密码 / token 已打码，项目路径与库名按原样保留。
