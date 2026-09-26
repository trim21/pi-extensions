# Design

## Context

动机见 `proposal.md` - Why。影响方案的现状（均已核对源码）：

- 现状生成：`buildRules` 对每个域名条目写 `+.${host}`（fakeip 白名单）+ `DOMAIN-SUFFIX,${host},DIRECT`（连接层），两者都是「apex + 任意深度子域名」。
- mihomo 的 DNS 侧白名单（`fake-ip-filter`，走 domain trie，`component/trie/domain.go`）：
  - `example.com` → 精确（只匹配该域名）；
  - `.example.com`（dot-wildcard）→ 任意深度子域名，**不含** apex；
  - `+.example.com` → `Insert` 把它展开成「`example.com`」+「`.example.com`」，即 apex + 任意深度子域名（[domain.go:111](/srv/ssd-1/projects/github/metacubex/mihomo/component/trie/domain.go:111)）。
- mihomo 的连接层规则：
  - `DOMAIN,example.com` → 精确；
  - `DOMAIN-SUFFIX,example.com` → `HasSuffix("."+suffix) || ==`（[domain_suffix.go:19](/srv/ssd-1/projects/github/metacubex/mihomo/rules/common/domain_suffix.go:19)），apex + 任意深度；
  - `DOMAIN-WILDCARD,*.example.com` → glob 匹配，`*` 可跨点（`component/wildcard`），因此是任意深度子域名、不含 apex。
- 条目解析与校验集中在 `parseAllowlistEntry`（`src/bwrap/mihomo-config.ts`）：目前只认「域名 / IPv4 / CIDR + 可选 `:port`」，IPv6 要求方括号；schema 层（`src/bwrap/core.ts` 的 `networkConfigProperties.allowlist`）只校验是字符串数组，语义校验在这一处。
- 两层必须语义一致：DNS 层决定谁能拿到地址，连接层决定谁能连。两者不一致会同时产生「能解析但连不上」和「连接层比 DNS 宽」（后者可被裸 IP 连接利用，绕过 DNS）。

## Goals / Non-Goals

**Goals:**

- 裸域名 = 精确匹配，只授权该域名本身。
- 提供显式的子域名语法，表达「该域名的所有子域名」。
- DNS 白名单与连接层规则按同一条目生成**等价**的匹配集合；端口后缀仍只约束连接层（DNS 无端口语义）。
- 语法错误有明确提示，且拒绝会产生过宽授权的写法。

**Non-Goals:**

- 不引入正则、关键字匹配、多级通配（`**.`）、否定条目（`!`）等更复杂的 DSL。
- 不改 fakeip 白名单 + `rcode://name_error` 的拒绝机制（前一个 change 已定）。
- 不改端口条目与 IP/CIDR 条目的既有语义。

## Decisions

**D1：语法只有两档，`*.` 前缀表示子域名，且**不含** apex。**

| 条目                | 含义                                                            |
| ------------------- | --------------------------------------------------------------- |
| `example.com`       | 精确：只匹配 `example.com`                                      |
| `*.example.com`     | `example.com` 的所有子域名（任意深度，不含 `example.com` 本身） |
| `example.com:443`   | 上者的精确形式 + 仅 443 端口（连接层）                          |
| `*.example.com:443` | 上者的通配形式 + 仅 443 端口（连接层）                          |

需要 apex 与子域名同时放行时写两条（`example.com` 与 `*.example.com`）。理由：`*` 的传统含义就是「一个或多个标签」（TLS 证书、nginx、k8s 都不含 apex），让 `*.x` 成为 `x` 的超集会与直觉相反，也会掩盖「用户以为只放行了子域名，其实连 apex 一起放行」这类过宽授权。显式写两条没有歧义。

考虑过的替代方案：

- _`*.example.com` 含 apex_（少写一条）：`*` 语义与主流约定不符，且通配成为裸条目的超集，读者难以判断两者关系。
- _额外支持 clash 风格的 `+.example.com`_：多一套语法，`+` 不是通用约定；两档已能表达全部所需集合。
- _`*.example.com` 只匹配一层（TLS 语义）_：DNS 侧的 dot-wildcard 本身就是任意深度，做成一层需要改走正则，且 allowlist 场景下多一层更有用（如 `a.b.example.com`）。
- _保留现状（裸域名即子树）+ 只补文档_：用户明确要求改成精确匹配。

**D2：两层的映射表。**

| 条目                | DNS（fakeip 白名单） | 连接层                                                                    |
| ------------------- | -------------------- | ------------------------------------------------------------------------- |
| `example.com`       | `example.com`        | `DOMAIN,example.com,DIRECT`                                               |
| `*.example.com`     | `.example.com`       | `DOMAIN-WILDCARD,*.example.com,DIRECT`                                    |
| `example.com:443`   | `example.com`        | `AND,(DOMAIN,example.com,DIRECT),(DST-PORT,443,DIRECT),DIRECT`            |
| `*.example.com:443` | `.example.com`       | `AND,(DOMAIN-WILDCARD,*.example.com,DIRECT),(DST-PORT,443,DIRECT),DIRECT` |

左侧进 `fake-ip-filter`（只有这些域名拿 fake IP，其余落到 `rcode://name_error` 被拒）；右侧进连接层 `rules`（末尾仍是 `MATCH,REJECT`）。IP / CIDR 条目不变。

两套原语是否严格等价需要在实现时用实机集成测试验证，重点边界：`a.b.example.com`（应通过）、`example.com`（通配条目下应被拒）、`notexample.com`（两种条目都应被拒，`DOMAIN-WILDCARD` 的 glob 与 trie 都不能只靠后缀匹配）。

**D3：语法校验（`parseAllowlistEntry`）。**

- 通配只允许出现在最左标签且占据整个标签：`*.example.com` ✔；`*`（等于放行一切）、`*example.com`、`a.*.example.com`、`*.*.example.com`、`*.` ✘，均报错并提示允许的写法。
- 通配只对域名有效：`*.1.2.3.4`、`1.2.3.*` ✘（IP 场景用 CIDR 表达范围）。
- 其余校验沿用：端口 1–65535、IPv6 必须方括号包裹、域名沿用字符集与标签规则（拒绝逗号/括号等规则注入字符）。
- 单条错误信息要能自答「该怎么写」：例如 `allowlist entry "a.*.example.com": "*" is only allowed as the leftmost label, e.g. "*.example.com"`。

**D4：BREAKING 迁移。**

裸域名从子树收窄为精确。文档层面：spec 的 requirement 写清两档语义与「apex 需单列」，README 给一句迁移提示（要覆盖子域名就加 `*.`）。仓库内不需要改动 agent 自己的配置；用户全局 `~/.pi/agent/sandbox.json` 的条目是否补 `*.` 由用户决定（现有条目都直接访问 apex，收窄后仍可用）。

## Risks / Trade-offs

- [两层原语不等价（例如 glob 的 `*` 跨点行为与 trie 的 dot-wildcard 有差异）] → 实现时用实机集成测试覆盖 `a.b.example.com` / `example.com` / `notexample.com` 三个边界；不等价则以收紧的一侧为准并记录。
- [收窄后既有配置静默失效（子域名访问被拒）] → 属于有意的 BREAKING；错误形态是解析失败（`Could not resolve host`）而不是超时，容易被识别；文档给出迁移写法。
- [通配条目让 allowlist 变宽] → `*.` 是显式选择，且不含 apex；`*` 单独出现被校验拒绝，不会出现「一键放行一切」。
- [端口 + 通配组合的规则拼接出错] → 单测覆盖 `AND` 组合的四种形态（精确/通配 × 有无端口）。

## Migration Plan

配置迁移：需要子域名时把 `example.com` 改为/补上 `*.example.com`。代码随重启 pi agent 生效；回滚即恢复 `+.host` + `DOMAIN-SUFFIX` 的生成。
