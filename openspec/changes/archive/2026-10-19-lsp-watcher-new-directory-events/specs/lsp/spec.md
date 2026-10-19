# Spec Delta

## ADDED Requirements

### Requirement: 新建目录与移入子树的文件事件

目录创建事件（包括整棵目录树被 move 进监听范围）到达后，系统 MUST 补投该目录内已存在文件的事件，并 MUST 保证移入子树内的后续变更继续产生事件。

#### Scenario: 新目录内已存在的文件补投

- **WHEN** 监听范围内目录被创建，且在其子路径的内核 watch 生效之前已有文件写入
- **THEN** 这些文件仍以 created 事件（type 1）投递，不得因内核事件缺失而静默丢弃

#### Scenario: 整树移入补投

- **WHEN** 一棵已包含文件的目录树被整体 move 进监听范围
- **THEN** 树内已存在的文件按 created 事件投递，目录结构本身不单独投递

#### Scenario: 移入子树的后续变更

- **WHEN** 整树移入后，其嵌套目录内的文件被创建、修改或删除
- **THEN** 仍正常产生 created / changed / deleted 事件，不得因只有顶层目录被监听而丢失

#### Scenario: 扫描遵循忽略规则

- **WHEN** 补扫遇到内置忽略目录、配置 `ignore` 命中路径或 `ignoreDirs` 中的目录
- **THEN** 不扫描该子树、不投递其中路径，与现有事件层忽略语义一致

#### Scenario: 重复事件

- **WHEN** 同一路径同时被补扫与内核事件观察到
- **THEN** 允许重复投递同一路径的事件，不要求去重

#### Scenario: 监听停止

- **WHEN** 监听器停止
- **THEN** 为移入子树建立的监听一并停止，不再投递任何事件
