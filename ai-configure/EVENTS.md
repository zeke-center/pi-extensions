# 埋点事件口径（v1）

> 这份文档定义「插件记录什么、用什么字段、两档粒度各记多少」。
> 代码实现见 `telemetry.ts`；隐私声明见仓库根目录 `PRIVACY.md`。

## 1. 总原则

1. **默认关闭**：`telemetryUpload=false` 时**不采集、不落盘、不上传**。
2. **必须填密钥**：`telemetryKey` 为空时，即使开关打开也不上传（开关会自动回弹）。
3. **只记录使用行为，不记录业务内容**：文件内容、对话正文默认不记（`full` 档才记，且需单独确认）。
4. **失败静默**：埋点任何异常都不影响主流程（不弹窗、不阻塞、不重试超过 3 次）。
5. **可追溯**：每条事件带 `install_id` / `session_id` / `event_id` / `ts`，可重放分析。

## 2. 通用字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `event_id` | string | UUID，幂等去重用 |
| `kind` | string | 事件大类（下表第一列） |
| `name` | string | 事件名，如 `tool_call` |
| `ts` | string | ISO8601 UTC，客户端时间 |
| `install_id` | string | 安装标识（首次生成 UUID，存 `ai-extensions.json`） |
| `session_id` | string | pi 会话 id |
| `turn` | number | 会话内轮次（从 1 开始） |
| `tool` | string? | 工具名（仅工具类事件） |
| `ok` | boolean? | 成败 |
| `duration_ms` | number? | 耗时 |
| `props` | object | 事件专属字段（JSONB 落库） |

上报协议：

```http
POST /api/telemetry/ingest
X-Brain-Token: <MASTER_KEY>
Content-Type: application/json

{ "schema": 1, "install": {...}, "events": [ ... ] }
```

- 单批 ≤ 500 条、≤ 2 MB；
- `event_id` 重复 → 服务端忽略（幂等）；
- 401 = 密钥错（客户端停止重试，等用户改配置）。

## 3. 两档粒度

| | `meta`（默认） | `full`（需单独开启） |
|---|---|---|
| 工具参数 | 键名 + 值截断 200 字 | 全文 ≤ 8 KB |
| 工具返回 | 总字节数 + 前 200 字 | 全文 ≤ 32 KB |
| 模型/用户正文 | 不记，只记字节数 | ≤ 8 KB |
| 思考过程 | 不记，只记字节数 | ≤ 8 KB |
| token / 耗时 / 成败 | 全记 | 全记 |

超出上限：截断 + 记 `truncated: true` 和 `full_bytes`（原始长度）。

## 4. 事件清单

### 4.1 会话与轮次

| kind | 触发 | props |
|---|---|---|
| `install` | 首次上传（每版本一次） | `os`, `os_version`, `pi_version`, `ext_version`, `consent_version`, `consent_at`, `level` |
| `session_start` | 会话开始 | `project`(cwd 哈希), `model`, `ext_version` |
| `session_end` | 会话结束/退出 | `turns`, `duration_ms`, `tokens{input,output,cacheRead,reasoning}`, `tool_calls`, `errors` |
| `turn` | 每次模型请求完成 | `model`, `duration_ms`, `tokens{...}`, `msgs_in`, `tools_in_turn` |

### 4.2 工具调用

| kind | 触发 | props |
|---|---|---|
| `tool_call` | 每次工具调用结束 | `ok`, `duration_ms`, `args`, `args_bytes`, `result`, `result_bytes`, `truncated`, `error` |

> 注意：`args` / `result` 按粒度截断；`bash` 的 `command` 会做密钥样式打码，但**不隐藏命令本身**（分析要用）。

### 4.3 任务看板

| kind | 触发 | props |
|---|---|---|
| `plan_declared` | `progress(action="plan")` | `title`, `steps`, `steps_count`, `skip_confirm` |
| `plan_answer` | 用户对计划的答复 | `answer` (`yes`/`edit`/`no`), `wait_ms`, `edit_text` |
| `plan_step` | `progress(action="step")` | `index`, `status`, `total`, `done` |
| `plan_block` | `progress(action="block")` | `text`, `index`, `total` |
| `plan_clear` | `progress(action="clear")` | `done`, `total`, `duration_ms` |
| `plan_abandoned` | 面板计划被新计划顶掉/长时间未更新 | `reason`, `stale_turns`, `done`, `total` |

### 4.4 临时助理（delegate）

| kind | 触发 | props |
|---|---|---|
| `delegate_dispatch` | 派活 | `assistant`, `tasks_count`, `mode`(sync/async), `resumed` |
| `delegate_result` | 助理返回 | `assistant`, `ok`, `duration_ms`, `card_bytes`, `error` |
| `delegate_timeout` | 超时 | `assistant`, `timeout_ms`, `task_id` |

### 4.5 语音播报

| kind | 触发 | props |
|---|---|---|
| `tts_generated` | 生成口播稿 | `chars`, `tier`(steps/full), `has_code`, `latency_ms` |
| `tts_play` | 实际播放 | `engine`(sapi/doubao), `ok`, `chars`, `duration_ms`, `error` |

### 4.6 其他

| kind | 触发 | props |
|---|---|---|
| `command_used` | 用户执行斜杠命令 | `command`, `args_len` |
| `extension_toggled` | `/ai-ext on/off` 或单项开关 | `on`, `scope` |
| `error` | 扩展内部异常 | `where`, `message`, `stack`(≤2KB), `fatal` |
| `telemetry_state` | 埋点自身状态变更 | `upload`, `level`, `key_set`, `reason` |

## 5. 体积预算（基于真实会话测算）

| 事件 | 单条约 | 一场 750 次工具调用的会话 |
|---|---|---|
| `tool_call`（meta） | 0.5~1.5 KB | ≈ 0.6 MB |
| `tool_call`（full） | 3~10 KB | ≈ 4 MB |
| `turn` | 0.2 KB | ≈ 0.15 MB |
| plan/delegate/tts | 0.3~2 KB | ≈ 0.05 MB |

- 每天 ≤ 20 MB/安装 配额，超了自动降级为 meta 并记 `telemetry_quota`；
- 服务端原始事件保留 **180 天**，之后只留每日聚合。

## 6. 隐私边界

**绝不采集**：任何密钥（`sk-`、`ghp_`、`Bearer`、`X-Brain-Token`、`MASTER_KEY` 值）、环境变量全文、`.env` 内容、密码。

**默认不采集**：文件内容、对话正文、思考过程（这三项只在 `full` 档且用户明确确认后记录）。

声明原文与版本号见 `PRIVACY.md`；`consent_version` 变号后需要重新确认才继续上传。
