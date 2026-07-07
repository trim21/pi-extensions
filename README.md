# pi-extensions

[pi](https://github.com/earendil-works/pi-mono) coding-agent 自定义扩展集合。

## 扩展概览

| 扩展                                              | 描述                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| [bwrap](#bwrap)                                   | 基于 bubblewrap 的 OS 级沙箱，提供文件系统和网络隔离         |
| [workspace-guard](#workspace-guard)               | 限制文件写入在 workspace 内，外部写入需用户审批              |
| [opencode-edit](#opencode-edit)                   | 替换内置 edit 工具，使用 opencode 的 schema 和匹配引擎       |
| [bash-default-timeout](#bash-default-timeout)     | 为 bash 工具设置默认超时（180 秒）                           |
| [agents-md-user-message](#agents-md-user-message) | 将项目级 AGENTS.md 移至 user message，避免占用 system prompt |

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
- 外部路径需通过确认对话框由用户审批
- 无需配置

### 使用

```bash
pi -e ./src/workspace-guard.ts
```

---

## opencode-edit

替换内置 `edit` 工具，使用 [opencode](https://github.com/anomalyco/opencode) 的 schema 和模糊匹配引擎。核心 replacer 和 `replace()` 函数直接复制自 opencode，行为与原版完全一致。

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

## agents-md-user-message

将项目级 `AGENTS.md` 从 system prompt 移至 user message，减少 system prompt 占用。

- 项目级 `AGENTS.md` → 放入 user message（仅首次消息注入一次）
- 全局 `~/.pi/agent/AGENTS.md` → 保留在 system prompt

需要配合 `--no-context-files` 参数禁用 pi 默认的上下文文件加载。

### 使用

```bash
pi -e ./src/agents-md-user-message.ts --no-context-files
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
