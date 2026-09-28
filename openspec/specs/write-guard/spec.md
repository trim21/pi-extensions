# write-guard Specification

## Purpose

所有写工具（write / edit）内置写入边界保护：workspace 内与 `/tmp` 下的路径自动放行，workspace 外部的路径需经用户审批，headless（无 UI）会话直接拒绝外部写入。

## Requirements

### Requirement: workspace 内写入自动放行

写工具对 workspace 内与 `/tmp` 下的路径直接放行，不打断流程。

#### Scenario: 写 workspace 内文件

- **WHEN** 写工具写入 workspace 内或 `/tmp` 下的路径
- **THEN** 写入直接执行，无需审批

#### Scenario: 读工具不受限

- **WHEN** 使用读工具（read / ls / find / grep）访问任意路径
- **THEN** 不受写保护限制

### Requirement: 外部路径审批

workspace 外部的写入需经确认对话框由用户审批，对话框展示变更预览。

#### Scenario: 外部写入弹审批框

- **WHEN** 写工具尝试写入 workspace 外部的路径
- **THEN** 弹出确认对话框，用户批准后写入，拒绝则中止

#### Scenario: 审批框展示 diff 预览

- **WHEN** 外部写入触发审批
- **THEN** 对话框以 diff 代码块展示变更预览（能定位时显示带行号的真实 patch，否则退化为参数 diff）

### Requirement: headless 会话拒绝外部写入

无 UI 会话中不存在审批交互，外部写入直接拒绝。

#### Scenario: headless 下外部写入被拒

- **WHEN** 会话处于 headless 模式且写工具尝试外部写入
- **THEN** 写入被拒绝，不弹确认框

### Requirement: 审批预览即落盘内容

审批对话框展示的变更预览 SHALL 由「这次写入将要落盘的内容」直接算出：写入工具先读盘并算出最终内容，把变更前后的完整文件内容交给写保护模块，模块据此渲染 diff 并审批；用户批准后写入的就是这份内容。因此不存在两份计算，也不存在「预览算得出、写入写不了」的中间态。

#### Scenario: 预览即写入内容

- **WHEN** 写入工具把变更前后的完整内容交给写保护模块，且路径位于 workspace 外部触发审批
- **THEN** 对话框展示的 patch 由这两份内容生成，批准后落盘的就是其中的「变更后内容」

#### Scenario: 改动算不出时先报错再审批

- **WHEN** 写入工具读盘或匹配失败（未命中、多重匹配、文件不存在、未读过的文件、超过可编辑大小）
- **THEN** 工具直接报错，不展示审批对话框

#### Scenario: 审批期间文件被改动则拒写

- **WHEN** 用户在对话框上停留期间文件被外部改动，批准时磁盘内容与审批所用的「变更前内容」不一致
- **THEN** 写入被拒绝并提示重新读取，不用旧内容覆盖这次改动

#### Scenario: 无变更内容时只按路径审批

- **WHEN** 写入工具无法提供变更前后内容（流式落盘，内容不进内存）
- **THEN** 对话框只展示工具名、路径与审批选项，不展示 diff 预览

## Implementation

写保护在 `src/lib/write-guard.ts` 的 `guardWriteAccess` 实现，内置在各写工具（opencode `write`/`edit`、Claude Code `Write`/`Edit`、`lsp-rename`、`web_fetch` 的 `output_path` 落盘）内部。

- **边界判定**：workspace 内或 `/tmp` 下的路径自动放行；外部路径进入审批流程。
- **审批交互**：外部写入弹确认对话框，用 diff 代码块展示变更预览——预览由 `renderMutationPreview` 从调用方给的「变更前后完整内容」直接算出（`FileMutation { contentOld, contentNew }`），因此预览即将要写入的内容；模块不读盘、不持有匹配引擎，匹配与读盘都在各写工具里先行完成（匹配失败在读盘之后、弹窗之前就报错）。
- **批准后的复查**：用户从看到 diff 到点批准之间文件可能被外部改动，批准时重新取一次磁盘指纹（`digestIfExists`，文件不存在视作空内容）与审批所用的变更前内容比对，不一致则拒写并提示重新读取。
- **headless**：无 UI 会话直接拒绝外部写入，不走审批交互。
- 读取工具不受写保护约束。

涉及文件：`src/lib/write-guard.ts`。
