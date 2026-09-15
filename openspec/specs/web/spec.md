# web Specification

## Purpose

网页抓取与搜索工具：`web_fetch` 抓取 URL 并提取正文为 markdown（带 SSRF 防护与大小限制），给出 `output_path` 时把响应体原样落盘（图片、附件、release 资产这类不能当正文读的东西），`web_search` 通过 Search1API 搜索并返回结构化结果。出网统一走共享代理层，所以 shell 沙箱够不到的 host 仍然能抓。

## Requirements

### Requirement: web_fetch SSRF 防护

抓取目标解析后必须是公网地址，防止访问内网。

#### Scenario: 私有地址拒绝

- **WHEN** 目标域名解析出的任一地址是私有 / 保留地址（如 10/8、192.168/16、127/8、组播等，IPv4 与 IPv6 均校验）
- **THEN** 抓取被拒绝；非 IP 地址一律拒绝

#### Scenario: 重定向逐跳校验

- **WHEN** 目标重定向
- **THEN** 手动跟随并逐跳重新做 SSRF 校验，上限 5 跳，每跳只允许 http / https 协议

### Requirement: 抓取限制

抓取受大小与时长限制。

#### Scenario: 超限中止

- **WHEN** 正文模式（提取 markdown / 返回文本）的响应超过 5MB，或单次抓取超过 30 秒
- **THEN** 抓取中止并报错

#### Scenario: markdown 输出截断

- **WHEN** 提取的 markdown 超过 100KB
- **THEN** 截断并标注

### Requirement: 内容提取

HTML 页面提取正文并转 markdown。

#### Scenario: HTML 转 markdown

- **WHEN** 抓取到 `text/html` 页面
- **THEN** 用 Readability 提取主内容并转 markdown（支持流式 SSR 标记解除）；无正文（少于 200 字符）时报错

#### Scenario: 文本/JSON 原样返回

- **WHEN** 抓取到 `text/*`、JSON 或 XML
- **THEN** 原样返回文本

### Requirement: 文件落盘下载

给出 `output_path` 时，`web_fetch` 是下载器而不是阅读器：响应体原样写进该文件，正文不进上下文。用于 GitHub issue/PR 正文里的用户附件、release 资产、raw 文件与图片——这些既不是 HTML 也常常不是文本，走正文提取只会被毁掉。

#### Scenario: 原样写字节

- **WHEN** 调用带 `output_path`
- **THEN** 不看 content-type 白名单、不做 Readability/Turndown、不解码、不截断，把响应体逐字节写进目标文件；返回 JSON 摘要 `{url, file_path, content_type, bytes}`（`url` 是跟随重定向后的最终地址），不回显内容

#### Scenario: 大小上限

- **WHEN** 落盘的文件超过 200MB（`content-length` 声明超限直接拒绝，实际流出的字节超限同样中止）
- **THEN** 报错，不静默写一半

#### Scenario: 失败不留半截文件

- **WHEN** 下载中途出错（网络断开、超时、超上限）
- **THEN** 已创建的目标文件被删除——半截文件比失败更危险，它看起来是个完整文件

#### Scenario: 路径解析与写入审批

- **WHEN** `output_path` 是相对路径或带 `~`
- **THEN** 相对会话 cwd 解析、`~` 展开；父目录自动创建；已存在的文件被覆盖
- **AND** 目标在工作区与 `/tmp` 之外时，走与其他写文件工具相同的审批门（无 UI 时直接拒绝）

### Requirement: 出网代理

`web_fetch` 的请求从共享代理层发出，而不是全局 `fetch`。

#### Scenario: 走配置的代理

- **WHEN** `~/.pi/agent/proxy.json` 配了 `proxy`（或环境里有 `HTTPS_PROXY` 等等价值）
- **THEN** 抓取经该代理发出；未配置时就是直连。Node 的全局 `fetch` 不认代理环境变量，GitHub 用户附件这类 host 在受限网络下只有经代理才可达

### Requirement: web_search 搜索

通过 Search1API 执行搜索，返回结构化结果。

#### Scenario: 搜索与多查询合并

- **WHEN** 提供 `query` 或 `queries`（最多 4 个）
- **THEN** 并行搜索后按 URL 去重合并；`numResults` 默认 5、钳制 1-50

#### Scenario: 过滤参数

- **WHEN** 提供 `domainFilter`（`-` 前缀表示排除）、`recencyFilter`、`searchService`
- **THEN** 过滤语义生效（排除站点、时间范围、搜索服务）

#### Scenario: 内联正文

- **WHEN** 设置 `includeContent`
- **THEN** 内联抓取前几条结果正文（最多 5 条）

#### Scenario: key 缺失

- **WHEN** 未配置 `SEARCH1API_KEY` 且 `~/.pi/web-search.json` 无 key
- **THEN** 返回明确的配置错误

## Implementation

- **web_fetch**（`src/web/fetch.ts`）：SSRF 防护在发起请求前对 hostname 做 DNS 预解析，任一地址落入私有 / 保留地址黑名单即拒绝（IPv4 含 0/8、10/8、127/8、169.254/16、172.16/12、192.168/16、100.64/10、198.18/15、192.0.0/24、组播；IPv6 含 `::`、`::1`、`fc00::/7`、`fe80::/10`、`::ffff:` 映射，非 IP 一律拒绝）；重定向手动跟随、逐跳重新校验，上限 5 跳、只许 http/https。HTML 用 Readability 提取主内容（含 React 19 流式 SSR 的 `<div hidden id="S:N">` 解除）→ Turndown 转 markdown；30 秒超时、5MB 响应上限、markdown 100KB 截断；失败统一 `isError` + `抓取失败: ...`。
- **两种模式的分工**：`openResponse` 负责「URL 合法 → 逐跳重定向 → 2xx」，正文模式（`fetchPage`）在其上加 content-type 白名单（`text/*` / JSON / XML / HTML，其余报「不支持的内容类型」）与 UTF-8 解码；落盘模式（`saveUrlToFile`）不加任何白名单，直接把响应流写进 `output_path`，上限 200MB，任何一步失败删掉半成品。最终地址由重定向循环自己给出（手动重定向下不依赖 `response.url`）。落盘位置的审批复用 `src/lib/write-guard.ts`（工作区与 `/tmp` 放行，其余问用户，无 UI 拒绝），审批放在 try 之外——用户拒绝不是「抓取失败」。请求经 `src/lib/proxy.ts` 的 `createHttpProxy().fetch` 发出。
- **web_search**（`src/web/search.ts`）：POST `https://api.search1api.com/search`（Bearer 认证），key 从 `SEARCH1API_KEY` 或 `~/.pi/web-search.json` 的 `search1apiApiKey` 读取；`queries` 最多 4 个并行搜索后按 URL 去重合并；`includeContent` 内联抓取前几条正文（`crawl_results` 上限 5）；响应经 typebox schema 校验，无 AI 预消化。
- 配置：`src/web/config.ts`；出网代理 `~/.pi/agent/proxy.json`（`src/lib/proxy.ts`，与 gh-readonly 共用）。

涉及文件：`src/web/fetch.ts`、`src/web/search.ts`、`src/web/config.ts`、`src/lib/proxy.ts`。
