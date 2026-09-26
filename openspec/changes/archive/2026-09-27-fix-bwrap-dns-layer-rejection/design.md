# Design

## Context

动机见 `proposal.md` - Why。本设计基于对 mihomo 源码（本地 checkout `/srv/ssd-1/projects/github/metacubex/mihomo`）与实机运行的核查：

- `config.RawDNS`（`config/config.go:221`）没有 `Rules` 字段；全仓 grep 不到 DNS 规则引擎。`dns.rules` 是想象出来的字段，被静默忽略。
- `dns.fake-ip-filter-mode: rule` 只支持 `fake-ip` / `real-ip` 两个动作（`config/config.go:1627` 的报错文案即证据），无法表达拒绝。
- mihomo 支持 `rcode://` 伪 DNS 服务器（`dns/rcode.go`），取值含 `name_error`（NXDOMAIN），不查上游、即时返回。
- DNS 处理链（`dns/middleware.go:233`）：`withHosts` → `withFakeIP`（仅 fake-ip 模式）→ `withMapping`（非 `normal` 模式）→ `withResolver`。`withFakeIP`（`dns/middleware.go:149`）只判断 `skipper.ShouldSkipped(host)`：跳过则交给真实解析，否则**无条件**返回 fake IP。
- `Skipper`（`component/fakeip/skipper.go:20`）：`blacklist` 模式下命中 filter 才跳过；`whitelist` 模式下**未命中** filter 才跳过，即「只有命中 filter 的域名拿到 fake IP」。filter 为空时 whitelist 模式等于「一切都不拿 fake IP」。
- `direct-nameserver`（`hub/executor/executor.go:262` → `resolver.DirectHostResolver`）是 DIRECT 出站按域名解析时使用的那台 DNS。
- 实机验证（本次调查，unsandboxed，allowlist=`["pypi.org","files.pythonhosted.org"]`）：pypi.org 解析得到 `198.18.0.4`（fakeip 生效）；无 SNI 的 TLS 连接成功；`curl https://pypi.org/simple/` 得 200；`example.com` 解析失败（`Could not resolve host`）；未允许裸 IP `1.1.1.1:443` 连接失败；allowlist 为空时连 pypi.org 也解析失败。集成测试「allowlist domain resolves, non-allowlist is blocked」转绿。

## Goals / Non-Goals

**Goals:**

- 让「未允许域名在 DNS 层被拒绝」成为真实行为，客户端错误信息明确（`Could not resolve host`），失败即时、不依赖超时。
- 保住 allowlist 放行的可靠性：域名归属精确、不随 DNS TTL 失效。
- 保持 deny-by-default 不缩水：裸 IP 连接、绕过 DNS 的客户端仍被连接层拒绝。
- 机制描述（spec Implementation、README、代码注释）与真实配置一致。

**Non-Goals:**

- 不改 `src/bwrap/network-stack.ts` 的进程模型、namespace 生命周期或停栈流程。
- 不改 allowlist 语法、端口语义、配置加载或审批。
- 不为「allowlist 域名连接到共享 CDN IP」新增 IP 规则（域名匹配仍由 mihomo 负责）。

## Decisions

**D1：用 `fake-ip-filter-mode: whitelist` 把 fakeip 限定给 allowlist 域名，默认 `nameserver` 设为拒绝。**

```json
"dns": {
  "enable": true,
  "ipv6": false,
  "enhanced-mode": "fake-ip",
  "fake-ip-range": "198.18.0.1/16",
  "fake-ip-filter-mode": "whitelist",
  "fake-ip-filter": ["+.pypi.org", "+.files.pythonhosted.org"],
  "nameserver": ["rcode://name_error"],
  "default-nameserver": ["<配置的 DNS>"],
  "direct-nameserver": ["<配置的 DNS>"]
}
```

allowlist 域名命中 whitelist → 走 fakeip 分支拿合成 IP；其余域名不命中 → 落到 resolver → 默认 nameserver 是 `rcode://name_error` → 即时 NXDOMAIN。一个 filter 决定「谁拿 fake IP」，一个默认值决定「其余全部解析失败」，两边都不需要规则表。

“默认拒绝 + 显式放行”的方向与 deny-by-default 一致，且 fakeip 的归属优势完整保留：fake IP 与域名一一对应，连接到达时凭它还原域名（`tunnel.go` 的 `preHandleMetadata` + fakeip pool 的 `LookBack`），不依赖嗅探、不受 DNS TTL 影响。

**D2：必须显式配置 `direct-nameserver`。**

fakeip 下连接到达时 `metadata.DstIP` 被清空、只留域名，DIRECT 出站要按域名重新解析；若不指定 `direct-nameserver`，这次解析会走 `nameserver`（我们设成了拒绝）或 DNS 服务的 fakeip 分支，前者让 allowlist 出站解析失败，后者拿到 fake IP 再进 TUN 成环——`buildRules` 的既有注释记录的就是这个坑。指向同一组真实 DNS 即可。

**D3：连接层规则保持原样。**

`DOMAIN-SUFFIX,<allowlist>,DIRECT`（带端口用 `AND` 组合）+ 末尾 `MATCH,REJECT` 不动：它继续兜底裸 IP 连接、绕过 DNS 的客户端，以及未被 fakeip 覆盖的连接。DNS 层是新增的真实拒绝，不是替代。

**D4：spec 的 Requirement 只做写实化，不改目标语义。**

spec 本来就要求 DNS 层拒绝，所以 delta 是 MODIFIED（把「立即失败、不返回 fakeip」写清楚 + 补超时场景），而不是新增或反转；机制描述在 Implementation 段与 README 中同步。

### 考虑过的替代方案

- **redir-host + `nameserver-policy` 放行**（本次调查中一度选定）：能满足 DNS 层拒绝，但必须放弃 fakeip，域名归属改由 `withMapping` 的 `IP → 单个域名` 表提供（`dns/middleware.go:99`，4096 条 LRU，后写覆盖，过期时间取 DNS 记录 TTL）。后果：共享 CDN IP 上多个 allowlist 域名会互相覆盖归属，带端口限制的条目可能误拒另一个域名的连接；客户端在自己的 TTL 缓存窗口内、晚于映射过期时间发起连接时会落到 `MATCH,REJECT` 而误拒。这两类误拒都直接损害「allowlist 一定通」这条承诺，因此弃用。
- **把未允许域名指向不可达 DNS（如 `127.0.0.1`）**：失败取决于 ICMP 拒绝还是超时，慢且不确定。
- **保留现有 blacklist 配置，只在文档里承认实际是连接层拒绝**：即现状，用户已否。

## Risks / Trade-offs

- [DIRECT 出站解析依赖 `direct-nameserver` 配置正确] → 与 DNS 服务器同源（就是配置里那组 DNS），配置加载处已有“至少一个 DNS 服务器”的校验；实机验证 allowlist 域名 curl 200。
- [allowlist 域名现在解析成 `198.18.x.x`] → 客户端日志/输出里看到的是合成地址；连接仍由 mihomo 转到真实 IP，证书校验按域名进行。需要真实 IP 的场景（如把解析结果写进白名单）本来就无法在 fakeip 下工作，属于既有语义。
- [未允许域名得到 NXDOMAIN 而不是“不可达”] → 正是 spec 要求的形态；错误信息可直接定位为“被拒”。
- [`rcode://`、`direct-nameserver`、`fake-ip-filter-mode: whitelist` 的可用性] → 三者都在 mihomo 1.19.31 中支持，已核本地源码并实机验证。
- [allowlist 为空时 whitelist 模式的行为] → filter 为空 ⇒ 没有域名命中 ⇒ 一切域名都走默认拒绝；实机验证（allowlist=[] 时 pypi.org 也无法解析）。
- [spec/README 若不同步会再次与代码脱节] → 已列为变更内的任务，随代码同一提交落地。

## Migration Plan

无需配置迁移（`sandbox.json` 的 allowlist 语法与语义不变）。代码随重启 pi agent 生效；回滚即恢复原 dns 段（`dns.rules` 本就是空转）。
