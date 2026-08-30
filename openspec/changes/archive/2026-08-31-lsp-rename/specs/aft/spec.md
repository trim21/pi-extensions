## REMOVED Requirements

### Requirement: 写工具路径级审批

**Reason**: `aft_refactor`（move / extract / inline）与 `aft_import` 整体移除，aft 收敛为纯只读感知工具集，不再有写工具。`move`（跨文件移动符号并更新引用）由基于 LSP rename 的 `lsp-rename` 承接。
**Migration**: 符号改名与跨文件引用更新改用 `lsp-rename`；`extract` / `inline` / import 管理无替代，模型改用普通编辑工具手工完成。

### Requirement: import 管理

**Reason**: `aft_import` 工具移除（与 `aft_refactor` 一并收敛，aft 只保留只读感知工具）。
**Migration**: 添加 / 移除 import 改用普通编辑工具手工完成，import 排序仍交给 lint。
