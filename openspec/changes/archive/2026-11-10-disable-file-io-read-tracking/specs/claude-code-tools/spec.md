# claude-code-tools Delta

## MODIFIED Requirements

### Requirement: 文件工具

读取、编辑、写入文件。`fileIoReadTracking` 生效时，编辑与写入 MUST 要求目标文件已在本会话读过且读后未变。

#### Scenario: Read 读取

- **WHEN** 读取文本文件
- **THEN** 返回文件内容并支持 `offset` / `limit` 分段；未指定 `limit` 且文件超过 256KB 或估算超过 25K tokens 时报错，要求用 `offset` / `limit` 读取指定范围；图片作为附件

#### Scenario: Edit 编辑

- **WHEN** 在文件中替换内容
- **THEN** 按匹配策略替换，自动处理 BOM 与行尾转换；`fileIoReadTracking` 生效时目标文件 MUST 已在本会话读过且读后未变，否则拒绝

#### Scenario: Write 写入

- **WHEN** 写入文件
- **THEN** 不存在则创建（自动建父目录）；覆盖已存在文件时，`fileIoReadTracking` 生效时 MUST 要求该文件已在本会话读过且读后未变；受写保护约束

#### Scenario: 关闭已读记账后的读写

- **WHEN** `personalExtensions.fileIoReadTracking` 为 `false`，Edit / Write 操作一个本会话没读过、或读后被外部修改过的文件
- **THEN** 不因「未读」或「读后已变」被拒绝，写保护审批照常；Read / Edit / Write 的工具结果都不带 `details.reads`，LSP rename 落盘的文件也不标记为已读
