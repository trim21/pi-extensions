# Spec Delta

## MODIFIED Requirements

### Requirement: 文件工具

读取、编辑、写入文件。

#### Scenario: Read 读取

- **WHEN** 读取文本文件
- **THEN** 返回文件内容并支持 `offset` / `limit` 分段；未指定 `limit` 且文件超过 256KB 或估算超过 25K tokens 时报错，要求用 `offset` / `limit` 读取指定范围；图片作为附件

#### Scenario: Edit 编辑

- **WHEN** 在文件中替换内容
- **THEN** 按匹配策略替换，自动处理 BOM 与行尾转换；目标文件 MUST 已在本会话读过且读后未变，否则拒绝

#### Scenario: Write 写入

- **WHEN** 写入文件
- **THEN** 不存在则创建（自动建父目录）；覆盖已存在文件时 MUST 要求该文件已在本会话读过且读后未变；受写保护约束
