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

## Implementation

写保护在 `src/lib/write-guard.ts` 的 `guardWriteAccess` 实现，内置在各写工具（opencode `write`/`edit`、Claude Code `Write`/`Edit`、aft refactor/import）内部。

- **边界判定**：workspace 内或 `/tmp` 下的路径自动放行；外部路径进入审批流程。
- **审批交互**：外部写入弹确认对话框，用 diff 代码块展示变更预览——与 opencode-edit 共享匹配引擎（`src/opencode/edit-engine.ts`），能定位时显示带行号的真实 patch，否则退化为参数 diff。
- **headless**：无 UI 会话直接拒绝外部写入，不走审批交互。
- 读取工具不受写保护约束。

涉及文件：`src/lib/write-guard.ts`。
