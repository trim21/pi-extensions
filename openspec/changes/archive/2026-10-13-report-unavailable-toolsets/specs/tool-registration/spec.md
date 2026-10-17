# Spec Delta

## ADDED Requirements

### Requirement: 工具集不可用时的提示

工具集因环境原因不可用时（依赖缺失、平台不支持），入口路径 MUST 在会话启动时提示一次原因，MUST NOT 静默跳过。提示由该工具集的工厂在不可用时返回的模块在注册时发出，因此入口与按路径独立加载两条路径行为一致。

#### Scenario: 依赖缺失

- **WHEN** `gh` 可执行文件不在 PATH
- **THEN** 会话启动时提示一次 GitHub 只读工具已禁用及原因，且不注册这些工具

#### Scenario: 平台不支持

- **WHEN** 当前平台是 Windows（gh / spawn-agent 仅支持 POSIX）
- **THEN** 会话启动时提示一次对应工具集已禁用，且不注册这些工具

#### Scenario: 工具集可用时没有这类提示

- **WHEN** 依赖与平台都满足
- **THEN** 不产生任何不可用提示，工具照常注册
