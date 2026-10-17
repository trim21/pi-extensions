# Spec Delta

## MODIFIED Requirements

### Requirement: edit 编辑文件

按 opencode 的 schema 与匹配引擎编辑文件。目标文件 MUST 已在本会话读过且读后未变。

#### Scenario: 多策略匹配

- **WHEN** 在文件中查找待替换内容
- **THEN** 按顺序尝试 8 种匹配策略（精确、行尾空白容差、块锚定、空白规范化、缩进灵活、边界修剪、上下文感知、多次出现），第一个匹配成功即替换；上游的转义规范化策略（`EscapeNormalizedReplacer`）有意省略（反转义 `\n` / `\t` 会把字面反斜杠序列改错）

#### Scenario: 编码规范化

- **WHEN** 编辑含 BOM 或 CRLF/LF 行尾的文件
- **THEN** 自动处理 BOM 与行尾转换，替换成功后恢复原格式

#### Scenario: 未读或读后被改动时拒绝

- **WHEN** 目标文件未在本会话读过，或读取后磁盘内容发生变化
- **THEN** 拒绝编辑，提示先读或重读，文件不变

### Requirement: write 写入文件

创建或覆盖文件；覆盖已存在文件时 MUST 要求该文件已在本会话读过且读后未变。

#### Scenario: 创建与覆盖

- **WHEN** 写入文件
- **THEN** 文件不存在则创建（自动建父目录），存在则覆盖；写入受写保护约束（workspace 边界）

#### Scenario: 读后被改动时拒绝

- **WHEN** 文件已被读过，但磁盘内容在读取后发生变化或被删除
- **THEN** 拒绝写入，提示重读，文件不变
