# Spec Delta

## MODIFIED Requirements

### Requirement: 出网代理

所有出网请求（`web_fetch` 抓取与 `web_search` 搜索）MUST 从共享出网层 `src/lib/egress.ts` 发出，而不是全局 `fetch`。该层读一次代理配置（`~/.pi/agent/proxy.json`，回退 `HTTPS_PROXY` 等环境变量）并同时提供请求用的 `fetch` 与给子进程注入的代理环境变量；未配置代理时就是直连。`web_search` 走全局 `fetch` 时配置了代理也直连，因为 Node 的全局 `fetch` 不认代理环境变量——GitHub 用户附件、Search1API 这类 host 在受限网络下只有经代理才可达。

#### Scenario: 走配置的代理

- **WHEN** `~/.pi/agent/proxy.json` 配了 `proxy`（或环境里有 `HTTPS_PROXY` 等等价值）
- **THEN** 抓取经该代理发出；未配置时就是直连。Node 的全局 `fetch` 不认代理环境变量，GitHub 用户附件这类 host 在受限网络下只有经代理才可达

#### Scenario: web_search 也走配置的代理

- **WHEN** `~/.pi/agent/proxy.json` 配了 `proxy`（或环境里有 `HTTPS_PROXY` 等等价值）
- **THEN** Search1API 请求经该代理发出，而不是全局 `fetch` 直连；未配置时就是直连
