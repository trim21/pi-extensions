# pi-extensions

[pi](https://github.com/earendil-works/pi-mono) coding-agent 自定义扩展集合。

## 扩展概览

| 扩展                                          | 描述                                                   |
| --------------------------------------------- | ------------------------------------------------------ |
| [bwrap](#bwrap)                               | 基于 bubblewrap 的 OS 级沙箱，提供文件系统和网络隔离   |
| [workspace-guard](#workspace-guard)           | 限制文件写入在 workspace 内，外部写入需用户审批        |
| [opencode-edit](#opencode-edit)               | 替换内置 edit 工具，使用 opencode 的 schema 和匹配引擎 |
| [bash-default-timeout](#bash-default-timeout) | 为 bash 工具设置默认超时（180 秒）                     |
| [vision-agent](#vision-agent)                 | 视觉代理：主模型不支持视觉时，spawn 子 agent 识别图片  |
| [todowrite](#todowrite)                       | opencode 风格的任务列表工具，完整列表替换语义          |
| [question](#question)                         | opencode 风格的提问工具，阻塞式询问用户选择            |

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
pi -e ./src/todowrite.ts
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
pi -e ./src/question.ts
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
