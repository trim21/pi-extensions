# Some of my personal pi extensions

你可以参考本仓库的实现，但不要直接使用：这是我个人自用的扩展集，我会随意做 breaking change，不承诺向后兼容。

[pi](https://github.com/earendil-works/pi-mono) coding-agent 自定义扩展集合。

## 扩展概览

| 扩展                                          | 描述                                                   |
| --------------------------------------------- | ------------------------------------------------------ |
| [bwrap](#bwrap)                               | 基于 bubblewrap 的 OS 级沙箱，提供文件系统和网络隔离   |
| [workspace-guard](#workspace-guard)           | 限制文件写入在 workspace 内，外部写入需用户审批        |
| [opencode-edit](#opencode-edit)               | 替换内置 edit 工具，使用 opencode 的 schema 和匹配引擎 |
| [bash-default-timeout](#bash-default-timeout) | 为 bash 工具设置默认超时（180 秒）                     |
| [vision-agent](#vision-agent)                 | 视觉代理：主模型不支持视觉时，spawn 子 agent 识别图片  |
| [session-name](#session-name)                 | 首个 user prompt 自动生成会话名，模型命名 + 启发式兜底 |
| [todowrite](#todowrite)                       | opencode 风格的任务列表工具，完整列表替换语义          |
| [question](#question)                         | opencode 风格的提问工具，阻塞式询问用户选择            |
| [talk](#talk)                                 | session 间消息传递，SQLite 邮箱 + 双向 ask 时间戳仲裁  |

---

## bwrap

基于 [bubblewrap](https://github.com/containers/bubblewrap) 的 OS 级沙箱，为所有 bash 命令提供文件系统和网络隔离。

**前置条件：** 安装 bubblewrap（`apt install bubblewrap` / `pacman -S bubblewrap` / `dnf install bubblewrap`）。

### 模式

可在运行时切换：

| 模式              | 沙箱 | 网络 | 可写文件系统       | 提权方式 |
| ----------------- | :--: | :--: | ------------------ | -------- |
| `allow-all`       |  关  |  开  | 完整               | 无需     |
| `workspace-write` |  开  |  关  | workspace + `/tmp` | 用户审批 |
| `readonly`        |  开  |  关  | 无                 | 用户审批 |

### 提权机制

bash 工具注册了 `request_full_access` 和 `request_full_access_reason` 参数。模型需要全权限时须说明原因（如需要网络、写入 workspace 外部路径）。

建议模型不确定时先尝试沙箱模式，若因沙箱限制失败，再以完整权限重试。

### 保护目录

`.git`、`.pi`、`.agent` 即使在 `workspace-write` 模式下也始终只读。

### 运行时命令

- `/bwrap` — 显示当前模式和路径配置
- `/bwrap-allow-all` — 切换到 allow-all 模式
- `/bwrap-workspace-write` — 切换到 workspace-write 模式
- `/bwrap-readonly` — 切换到 readonly 模式

### 配置

配置文件（项目优先于全局）：

- `~/.pi/agent/extensions/bwrap.json`（全局）
- `.pi/bwrap.json`（项目）

```jsonc
{
  // "allow-all" | "workspace-write" | "readonly"
  "mode": "workspace-write",
  // 自定义 bwrap 路径（可选）
  "bwrapPath": "/usr/local/bin/bwrap",
  // 可写路径列表，~ 展开为 $HOME，覆盖默认值
  "writablePaths": [".", "/tmp", "~/my-projects"],
  // 额外可写路径，与默认值合并（ro-bind）
  "extraWritablePaths": ["~/.config"],
  // tmpfs 挂载路径（避免写入磁盘）
  "tmpfsPaths": [],
  // 额外 bwrap 参数
  "extraArgs": ["--die-with-parent"],
}
```

### 使用

```bash
pi -e ./src/bwrap/index.ts
# 或通过配置文件注册后自动加载
```

---

## workspace-guard

阻止 `write` 和 `edit` 工具写入 workspace 外部的路径。读取工具（`read`、`ls`、`find`、`grep`）不受限制。

- workspace 内或 `/tmp` 下的路径自动放行
- 外部路径需通过确认对话框由用户审批,对话框内以 ```diff 代码块展示将要发生的变更预览(与 opencode-edit 共享匹配引擎,能定位时显示带行号的真实 patch,否则退化为参数 diff)
- 无需配置

### 使用

```bash
pi -e ./src/workspace-guard.ts
```

---

## opencode-edit

替换内置 `edit` 工具，使用 [opencode](https://github.com/anomalyco/opencode) 的 schema 和模糊匹配引擎。核心 replacer 和 `replace()` 函数直接复制自 opencode，行为与原版完全一致。匹配引擎位于 `src/opencode-edit-engine.ts`，与 workspace-guard 的审批弹窗 diff 预览共享。

支持的匹配策略：

- 精确匹配（SimpleReplacer）
- 行尾空白容差（LineTrimmedReplacer）
- 块首尾锚定（BlockAnchorReplacer）
- 空白规范化（WhitespaceNormalizedReplacer）
- 缩进灵活匹配（IndentationFlexibleReplacer）
- 转义规范化（EscapeNormalizedReplacer）
- 首尾空白修剪（TrimmedBoundaryReplacer）
- 上下文感知匹配（ContextAwareReplacer）
- 多次出现替换（MultiOccurrenceReplacer）

所有匹配策略按顺序尝试，第一个匹配成功即返回。同时自动处理 BOM、CRLF/LF 行尾转换和文件写入队列。

### 使用

```bash
pi -e ./src/opencode-edit.ts
```

---

## bash-default-timeout

为所有 bash 工具调用设置 180 秒默认超时。仅在模型未显式指定 `timeout` 时生效，避免长时间运行的命令无限挂起。

### 使用

```bash
pi -e ./src/bash-default-timeout.ts
```

---

## vision-agent

视觉代理扩展。主模型不支持视觉（如 DeepSeek）时自动启用 `describe_image` 工具；主模型支持视觉时自动隐藏，图片由 pi 原生透传。

`describe_image` 工具只接收本地图片路径（`path`，单个或数组，一次可识别多张），图片直接以 base64 data URL 放进请求体，由视觉模型按顺序逐张描述，中间不经过任何 read 工具或 agent。内置默认 system prompt（图像识别助手），并支持 `prompt` 参数追加具体描述要求（如「图中验证码是什么」「逐字翻译图中的文字」），缺省时自动生成通用描述指令。功能与 [pi-vlm-proxy](https://github.com/lawrencewzen/pi-vlm-proxy) 一致，但配置不单独维护。

### 配置

不需要独立配置文件，直接复用 pi 已有的配置：

```jsonc
// ~/.pi/agent/settings.json —— 指定视觉模型
{
  "defaultProvider": "axonhub",
  "visionConfig": {
    "provider": "axonhub", // 可选，缺省回退到 defaultProvider
    "model": "mimo-v2.5",
  },
}
```

`provider` 的 `baseUrl` / `apiKey` 从 `~/.pi/agent/models.json`（pi 自定义 provider 配置）解析，认证、代理、网络全部复用 pi 自身配置。

**未配置 `visionConfig`（或 provider 缺失）时扩展不会注册 `describe_image` 工具**，agent 看不到也调不到，避免一个必然失败的僵尸工具；配置好后 `/reload` 即可生效。

### 使用

```bash
pi -e ./src/vision-agent.ts
```

**注意：** 本扩展与 pi-vlm-proxy 都注册同名 `describe_image` 工具，启用前请先从 `~/.pi/agent/settings.json` 的 `packages` 中移除 `pi-vlm-proxy`，避免工具注册冲突。

---

## session-name

根据会话的第一个 user prompt 自动生成显示名，在 `/resume` 和 `pi -r` 里更易区分会话。

- **双模式命名**：配置了 `sessionName.model` 时调用命名模型（OpenAI 兼容 API，复用 `~/.pi/agent/models.json` 的 provider 配置）把 prompt 概括成短名；未配置模型、provider 不可解析或模型调用失败时退化为启发式（取首行、去 markdown 装饰、截断到 `maxLength`）。
- **不覆盖已有名字**：`--name`、`/name` 设置过名字的会话不会被改；恢复的已命名会话同样跳过。
- **恢复无名会话**：resume/fork 恢复且无名字的会话，从历史第一条 user 消息生成名字。
- **非阻塞**：命名在后台进行，不拖慢首轮回复；中途切换会话也不会把名字写到错误的 session。
- **无需配置开箱即用**：缺省按启发式命名。

### 配置

```jsonc
// ~/.pi/agent/settings.json
{
  "sessionName": {
    "provider": "axonhub", // 可选，缺省回退 defaultProvider
    "model": "deepseek-v4-flash", // 命名模型；不配置则用启发式
    "maxLength": 30, // 可选，名字最大长度，默认 30
  },
}
```

### 使用

```bash
pi -e ./src/session-name.ts
```

---

## todowrite

opencode 风格的任务列表工具，参数与语义和 opencode 的 [`todowrite`](https://github.com/anomalyco/opencode) 工具一致。取代原 `todo-pendant.ts` 的 widget 输出方式，改用 `details.pendant.markdown` 渲染（与 vision-agent 相同的 pendant 约定）。

- **完整列表替换语义**：模型每次调用都传完整的 todo 列表，工具整体替换当前列表
- **参数**：`todos: Array<{ content, status, priority }>`
  - `status`：`pending` | `in_progress` | `completed` | `cancelled`
  - `priority`：`high` | `medium` | `low`
- **持久化**：列表存进工具结果 `details.todos`，跟随会话分支自动恢复
- **渲染**：每次调用用完整 markdown 列表输出对应的任务（pendant 面板自动展开）

与 pi 内置 `todo` 工具（`create`/`update`/`list`/… 单条动作）不同，本工具没有单条增删改动作，模型必须每次都传完整列表。

### 使用

```bash
pi -e ./src/opencode-todo.ts
```

---

## question

opencode 风格的提问工具，参数与语义和 opencode 的 [`question`](https://github.com/anomalyco/opencode) 工具一致。阻塞式执行：工具调用挂起，等用户作答后才把答案返回给模型。

- **参数**：`questions: Array<{ question, header, options, multiple? }>`
  - `options` 每项为 `{ label, description }`
  - `multiple` 缺省为单选，`true` 时循环用 `ui.select` 逐个勾选直到「✓ Done」
- **自定义答案**：每个问题自动追加 `Type your own answer.` 选项，选中后走 `ui.input` 自由输入
- **返回值**：每个问题一个 label 数组（`Answer = string[]`），跳过的为空数组
- **输出**：与 opencode 一致 —— `User has answered your questions: "q"="a", "q2"="Unanswered"...`

交互全部走 pi 内置的 `ctx.ui.select` / `ctx.ui.input`，不写自定义 TUI 渲染；`option.description` 不显示在对话框里，仅保留在 `details` 中。

### 使用

```bash
pi -e ./src/opencode/question.ts
```

---

## talk

session 间消息传递：不同 pi session（同一台机器）通过一个共享的 SQLite 邮箱互相发送消息、提问并等待回复。

### 架构（三层）

```
storage.ts   —— 存储层：TalkStorage 接口 + SqliteTalkStorage 实现（node:sqlite，零 npm 依赖）
core.ts      —— talk 核心：registry/mailbox/group/policy/format + TalkCore 协调器，只依赖存储层，通过回调 yield 投递/通知
index.ts     —— pi adapter：把 core 接到 pi 的 sendMessage / 生命周期事件 / 工具注册
```

存储层抽象成接口是为了后续可换成 HTTP / remote 后端，talk 核心无需改动。

### 工具（LLM 可见）

| 工具                 | 作用                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `talk-list-sessions` | 列出会话，返回 JSON 数组（`status` / `work_dir` / `id` / `name`，自己带 `self: true`）；只列出同组成员（未入组时只有自己），`status` 区分 live（`idle` / `working` / `waiting-talk-message`）与 `offline` |
| `talk-ask`           | 向某个 session 提问并阻塞等待回复（默认 30 分钟超时）                                                                                                                                                     |
| `talk-send`          | 发送纯文本消息到单个 session（`to` 只接受明确的 session id，不支持广播）                                                                                                                                  |
| `talk-reply`         | 回复一个 ask（`replyTo` 为 ask id，显式关联、不推断）                                                                                                                                                     |

对端消息自动投递（无需主动拉取）：投递方式由 `talk.deliver` 配置，`steer` 在模型工作过程中打断/唤醒，`queue` 排队到 session 下一轮自然 turn 时注入。

**定位只认 session id**：`talk-send` / `talk-ask` / `talk-watch` 的 `to` 只接受 `talk-list-sessions` 返回的 `id`（pi 的 session uuid）精确匹配，不做 name/路径/前缀匹配。

**标记废弃 session**：`/talk-dead` 给 session 打 `offline` 标志并把 `lastSeenAt` 置 0（列表显示为 offline，下次 sweep 无 mail 即回收）：无参标记当前 session，`/talk-dead <sessionId>` 标记指定 session，`/talk-dead --all` 标记所有其他可见 session（同组成员）。

### 关键设计

- **presence 不靠心跳**：presence 由 `offline` 标志 + 进程 pid 存活判定；pid 存活时还校验进程启动时间（`/proc/<pid>/stat`），排除 pid 回卷复用造成的误判。未标记 offline 且进程存活即 live，否则 offline；没有心跳，进程挂死（wedged）与健康空闲不可区分。`status` 在 live 时显示 `working` / `waiting-talk-message`（`talk-ask` 阻塞等待回复中）/ `idle`。
- **定期清理**：进程仍存活的记录永不回收；进程已死且最后活跃超过 24h 且无未投递 mail 的记录会被定期 sweep（30 分钟一次）回收；有 mail 的保留 30 天。resume 后 session 会自动重新注册，无 mail 即无损失。
- **投递成功才消费**：信件只在成功交给 `sendMessage` 后才从 inbox 删除，投递失败留在 inbox 下次重试——不会因 `sendMessage` 吞异常而静默丢信。
- **双向 ask 仲裁**：`talk-ask` 发起前先检查收件箱（有对方消息就先读/先回）；阻塞等待期间若收到对方的 ask（而非 reply），按两个 ask 的 `ts` 字段仲裁——先 ask 者主导继续等，后 ask 者让位并先回复对方。`ts` 是信件内固定字段，双方读到同一对值，结论天然对称；同毫秒碰撞用 `session dir + session id` 字符串比较兜底。
- **typebox runtime 验证**：所有从存储读出的值经 TypeBox schema 校验，损坏/伪造数据被拒绝，不做 `as T` 强转。
- **安全**：纯文本 ≤32KB；10s 去重 / 30s 限速 8 条 / 50 积压上限（防环）；每条投递标注来源（来自另一个 pi session，非用户）。
- **group 可见性**：可见性完全由 group 决定——组内 session 只能看到同组成员，不在任何 group 的 session 只能看到自己。用 `/talk-group-*` 命令建组/入组，见下方「group 可见性」。

### 配置

sqlite 文件路径按优先级取第一个可用值：

1. 环境变量 `PI_TALK_DB`
2. global `~/.pi/agent/settings.json` 里的 `talk.db_path`
3. 默认 `~/.pi/agent/talk.db`

`db_path` 支持 `~` 展开（`~/…` → 用户主目录），相对路径相对 `~/.pi/agent` 解析；绝对路径原样使用。

```jsonc
// ~/.pi/agent/settings.json
{
  "talk": { "db_path": "~/data/talk.db", "deliver": "queue" },
}
```

`talk.deliver` 控制对端消息的投递方式：

- `"steer"`：消息到达时打断当前工作（工具调用间隙注入），空闲 session 被唤醒；
- `"queue"`：消息排队，在 session 下一轮自然 turn（如用户发消息）时注入，不主动唤醒。

默认 `"queue"`。

### group 可见性

可见性完全由 group 决定，不再有路径/workspace 配置：

- 在某个 group 里的 session **只能看到同组成员**；不在任何 group 的 session **只能看到自己**。
- group 是带 uuid 的私有房间：任何 session 都可以凭 uuid 加入任意 group，也可以自由离开，没有 owner。
- 一个 session 只能属于一个 group：加入新 group 自动离开旧 group。
- group 成员关系存在共享的 talk DB 里，每次 list/发送实时读取，加入/离开立即对所有 session 生效（无需重启）。

通过 `/talk-group-*` 命令操作（TUI）：

```
/talk-group-join              # 无参：自动创建一个新 group（uuid 作为组名）并加入
/talk-group-join <name>       # 加入名为 name 的 group；不存在则创建（名字允许字母/数字/-/_）
/talk-group-join-last         # 加入最近创建的 group（方便新开 session 快速归队）
/talk-group-leave             # 离开当前 group（组空了自动删除）
/talk-group-list              # 列出所有 group 及其成员，最新创建的在前
/talk-group-del <name>        # 删除指定 group（成员随之变为未入组）
/talk-group-clear             # 删除所有 group
```

典型用法：在 A session 里 `/talk-group-join`（或 `/talk-group-join mytask`）建组，把组名复制到 B、C session 里 `/talk-group-join <组名>`，此后 A/B/C 互相可见且只见彼此。

| 变量              | 默认                              | 含义                            |
| ----------------- | --------------------------------- | ------------------------------- |
| `PI_TALK_DB`      | settings 或 `~/.pi/agent/talk.db` | SQLite 邮箱数据库路径           |
| `PI_TALK_INBOUND` | `accept`                          | `refuse` 时丢弃所有 peer 消息   |
| `talk.deliver`    | `queue`                           | 消息投递方式：`steer` / `queue` |

### 使用

```bash
pi -e ./src/talk/index.ts
```

---

## 安装

### 通过 npm/git 包

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["github:trim21/pi-extensions"],
}
```

### 命令行加载单个扩展

```bash
pi -e ./src/bwrap/index.ts
pi -e ./src/workspace-guard.ts
```

---

## 开发

```bash
pnpm install        # 安装依赖
pnpm run check      # tsc --noEmit + prettier --check
pnpm run format     # prettier --write
```

### 新增扩展

1. 在 `src/` 下创建扩展文件
2. 在 `package.json` 的 `pi.extensions` 数组中注册
