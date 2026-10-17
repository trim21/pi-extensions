# Spec Delta

## MODIFIED Requirements

### Requirement: 内容提取

HTML 页面提取正文并转 markdown。

#### Scenario: HTML 转 markdown

- **WHEN** 抓取到 `text/html` 页面
- **THEN** 用 Readability 提取主内容并转 markdown（支持流式 SSR 标记解除）；无正文（少于 200 字符）时报错

#### Scenario: 文本/JSON 原样返回

- **WHEN** 抓取到 `text/*`、JSON 或 XML
- **THEN** 返回文本内容，并去掉首尾空白
