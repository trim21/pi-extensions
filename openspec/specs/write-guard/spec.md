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

### Requirement: 审批预览与落盘同语义

审批对话框展示的变更预览 SHALL 由触发这次审批的写入工具自己的匹配实现算出：写入工具把「这次改动如何应用」交给写保护模块，模块本身不内置任何匹配引擎。因此预览展示的 diff 与其后真正写入的内容 SHALL 一致。

#### Scenario: 精确匹配的工具不用模糊匹配预览

- **WHEN** 使用精确匹配语义的写入工具（Claude Code 的 Edit）触发 workspace 外部路径的审批
- **THEN** 预览按精确匹配计算；精确匹配命不中（未命中或多重匹配）时退化为参数 diff，而不是展示一次只有模糊匹配才成立的替换

#### Scenario: 预览由写入方提供的匹配实现决定

- **WHEN** 调用方给出的匹配实现报告了改动的前后文本
- **THEN** 对话框展示的 patch 由这份前后文本生成，而不是由写保护模块自己重新定位 `old_text`

#### Scenario: 无法定位时退化为参数 diff

- **WHEN** 写入工具提供的匹配实现抛出错误（未命中、多重匹配、文件不存在）
- **THEN** 对话框退化为 `old_text` / `new_text` 的逐行参数 diff，不阻塞审批流程

#### Scenario: 整文件写入不需要匹配实现

- **WHEN** 写入工具声明这次改动是整文件写入（无 `old_text`）
- **THEN** 预览是完整的增删 patch，不要求调用方提供匹配实现

## Implementation

写保护在 `src/lib/write-guard.ts` 的 `guardWriteAccess` 实现，内置在各写工具（opencode `write`/`edit`、Claude Code `Write`/`Edit`、`lsp-rename`、`web_fetch` 的 `output_path` 落盘）内部。

- **边界判定**：workspace 内或 `/tmp` 下的路径自动放行；外部路径进入审批流程。
- **审批交互**：外部写入弹确认对话框，用 diff 代码块展示变更预览——定位由调用方注入的匹配实现负责（各写工具给出自己落盘时用的那一套：Claude Code `Edit` 是精确匹配、opencode `edit` 是模糊匹配、`lsp-rename` 是已展开的整文件编辑），因此预览与落盘同语义；能定位时显示带行号的真实 patch，否则退化为参数 diff。模块本身不内置匹配引擎。
- **headless**：无 UI 会话直接拒绝外部写入，不走审批交互。
- 读取工具不受写保护约束。

涉及文件：`src/lib/write-guard.ts`。
