# Tasks

## 1. mihomo 配置与单测

- [x] 1.1 `src/bwrap/mihomo-config.ts`：dns 段改为 `fake-ip-filter-mode: whitelist` + `fake-ip-filter`（allowlist 域名）+ `nameserver: ["rcode://name_error"]` + `direct-nameserver`（配置的 dnsServers）；删除 `dns.rules` 与 `BuiltRules.dnsRules`、同步 `MihomoConfig` 类型字段；验证：`pnpm exec vitest run test/bwrap-mihomo-config.test.ts`
- [x] 1.2 `test/bwrap-mihomo-config.test.ts` 断言改为新形状：whitelist 模式、filter 只含 allowlist 域名、默认 nameserver 是拒绝伪服务器、direct-nameserver 指向配置的 DNS、allowlist 为空时不产生 filter、连接层规则不变；验证：同上，且断言里不再出现 `dns.rules`
- [x] 1.3 注释改写：`buildRules` 的 DNS 段落与 `generateMihomoConfig` 的说明改为新机制，写清 why（fakeip 分支不可拒绝 ⇒ 用 whitelist 把 fakeip 限定给 allowlist、其余交给默认拒绝；DIRECT 出站必须用 direct-nameserver 否则解析回 fakeip 成环）；验证：`grep -rn "fake-ip\|dns.rules" src/bwrap/` 无过时描述

## 2. 实机集成验证

- [x] 2.1 `RUN_NETSTACK_INTEGRATION=1 NETSTACK_DNS=223.5.5.5 pnpm exec vitest run test/bwrap-netstack-integration.test.ts`（unsandboxed）全部通过——其中「allowlist domain resolves, non-allowlist is blocked」此前一直是红的，是本 change 的回归锚点，断言本身不改
- [x] 2.2 unsandboxed 用真实配置跑一次 `pnpm sandbox -- 'curl -sS -m 10 -o /dev/null -w "%{http_code}" https://pypi.org/simple/'`（期望 200）与未允许域名（期望 `Could not resolve host`），确认耗时与改动前同量级
- [x] 2.3 在同一栈内（脚本直接调 `startNetworkStack`）验证四条边界：allowlist 域名解析得到 `198.18.x.x`（fakeip 生效且只作用于 allowlist）；无 SNI 的 TLS 连接成功（域名归属靠 fake IP，不靠嗅探）；未允许的裸 IP（如 `curl https://1.1.1.1/`）失败；`allowlist: []` 时连 allowlist 之外的域名也无法解析。判定连接是否被拒必须看实际数据往返（curl/openssl 结果），不能用 `bash /dev/tcp` 的退出码——mihomo 用户态 TCP 栈会先完成握手

## 3. 规范与文档同步

- [x] 3.1 `openspec/specs/bwrap-network/spec.md` 的 Implementation：进程树里的 fakeip 条目与 dns.rules/fake-ip-filter 描述改写为 `whitelist` 限定的 fakeip + `rcode://name_error` 默认拒绝 + `direct-nameserver`；验证：逐条与 `mihomo-config.ts` 实际输出对照
- [x] 3.2 `src/bwrap/README.md`：网络路径里 fakeip 那条改写为「fakeip 只服务 allowlist 域名，其余域名在 DNS 层被拒」；设计约束第 3 条（fakeip 短路）改写成新的教训——`dns.rules` 不是 mihomo 的字段（写进配置会被静默忽略），DNS 层拒绝要靠 whitelist 收窄 fakeip + 默认 nameserver 拒绝，且必须配 `direct-nameserver` 否则 DIRECT 出站会解析回 fakeip 成环；验证：README 与代码/配置一致
- [x] 3.3 `pnpm check`、`pnpm lint`、`pnpm test` 全绿

## 4. 收尾

- [x] 4.1 检查最终 diff 无调试残留，`openspec validate fix-bwrap-dns-layer-rejection --strict` 通过，归档 change 并同步 delta 到主 spec
