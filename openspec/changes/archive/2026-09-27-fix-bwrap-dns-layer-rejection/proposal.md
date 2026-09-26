# Proposal

## Why

spec 承诺未允许域名在 **DNS 层**即被拒绝（客户端报 `Could not resolve host`），但这条要求从未实现过：生成的 mihomo 配置里写的是 `dns.rules`，而 **mihomo 没有这个字段**——`config.RawDNS` 里没有 `Rules`，全仓也没有 DNS 规则引擎，未知字段被静默忽略。于是 `dnsRules`（`DOMAIN-SUFFIX,<allowlist>,DIRECT` + `MATCH,REJECT`）从写下那天起就没有生效过。

实际行为是未允许域名**解析成功**（fakeip 本地应答 `198.18.x.x`）→ 连接被连接层 `MATCH,REJECT` 拒掉 → 客户端看到 `curl: (35) TLS connect error ... unexpected eof while reading`，容易被误读成网络故障。`test/bwrap-netstack-integration.test.ts` 里那条「未允许域名解析失败」的断言就是照 spec 写的，因此一直是红的（该文件默认 skip，只在 `RUN_NETSTACK_INTEGRATION=1` 下手动跑，所以一直没暴露）。

## What Changes

- 把 fakeip 收窄到只服务 allowlist 域名：`fake-ip-filter-mode: whitelist` + `fake-ip-filter` = allowlist 的域名条目。非 allowlist 域名不再命中 fakeip 分支，落到 resolver。
- 默认解析改为拒绝：`dns.nameserver` 设为伪服务器 `rcode://name_error`（即时返回 NXDOMAIN，不查上游、不等超时）。未允许域名因此解析直接失败。
- 新增 `dns.direct-nameserver` = 配置的 DNS 服务器：fake-ip 下连接由「fake IP → 域名」映射还原、DIRECT 出站再按域名解析真实 IP，这次解析必须走真实 DNS，否则会解析回 fake-ip 成环（`buildRules` 的既有注释记录过这个坑）。
- 删除 `dns.rules` 及其构造（`BuiltRules.dnsRules`）——不存在的字段。
- 连接层规则不变：`DOMAIN-SUFFIX,<allowlist>,DIRECT` + `MATCH,REJECT`，继续兜底裸 IP 连接与绕过 DNS 的客户端。
- 同步机制描述：`openspec/specs/bwrap-network/spec.md` 的 Implementation、`src/bwrap/README.md` 的网络路径与设计约束、代码注释。

**关键取舍**：不放弃 fakeip。fake IP 对每个域名是一一对应的专属地址，连接到达时能精确还原域名，且归属不随 DNS TTL 失效——这是 allowlist 放行可靠性的基础。DNS 层拒绝通过「fakeip 集合 = allowlist」+「默认 resolver 拒绝」实现，两者互不干扰（详见 design）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap-network`: 「allowlist 网络访问控制」——把「未允许域名在 DNS 层即被拒绝」写实（MUST 立即失败、MUST NOT 返回任何可连接地址，包括 fakeip 占位地址），并补一条「拒绝不依赖超时」的场景。Requirement 的目标语义不变，改的是它如今才真正成立这件事的量化表述。

## Impact

- 代码：`src/bwrap/mihomo-config.ts`（dns 段、`buildRules`、`MihomoConfig` 类型与注释）。
- 测试：`test/bwrap-mihomo-config.test.ts`（断言新形状）；`test/bwrap-netstack-integration.test.ts` 既有那条 DNS 断言由红转绿（不改断言本身）。
- 规范/文档：`openspec/specs/bwrap-network/spec.md`、`src/bwrap/README.md`。
- 行为变化：未允许域名不再得到 fakeip，而是解析直接失败；allowlist 域名改为解析成 fakeip（此前是真实 IP），连接由 fake IP→域名映射匹配，客户端日志里会看到 `198.18.x.x` 这类地址。
- 不涉及配置格式、公共 API 与依赖变更。
