# Proposal

## Why

`2026-10-12-codemode-timeout-and-approval` 已把 codemode 的审批语义定为「脚本内需要人工授权的调用一律直接失败」，代码随后通过 `unapprovable: true` 实现（`fs.write` 工作区外、`Bash` 申请沙箱外执行都不再弹框）。但那次 change 的 spec delta 只更新了「脚本接口」「嵌套调用的执行」「中止」，主 spec 的 Purpose 和「脚本文件原语」仍写 `fs.write` 复用 write-guard 审批、工作区外弹框并给出 diff，与当前行为和其他 Requirement 矛盾。

## What Changes

- 主 spec 的 Purpose 去掉「含各自的审批」，改为需要授权的调用在脚本内直接失败。
- delta MODIFIED「脚本文件原语」：`fs.write` 工作区外 MUST 以 `CallFailedError` 直接失败，不弹审批、不产生副作用；错误信息说明需要授权并建议直接调用写类工具。
- Scenario 由「写入沿用 write-guard 审批」改为「工作区外写入直接失败」；「受策略与平台约束」保留。
- 不修改代码与测试：当前实现已符合目标行为。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `codemode`：「脚本文件原语」的 `fs.write` 路径检查改为工作区外直接失败；Purpose 同步。

## Impact

- 规范：`openspec/specs/codemode/spec.md`。
- 无代码、测试、配置或依赖变更。
