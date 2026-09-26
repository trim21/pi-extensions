# Tasks

## 1. 条目解析与规则生成

- [x] 1.1 `src/bwrap/mihomo-config.ts`：`AllowlistEntry` 带上匹配档位（精确 / 子域名），`parseAllowlistEntry` 解析最左 `*.` 前缀并按 D3 校验（`*` 单独、中间标签、与非空标签拼接、用于 IP 时都报错，错误信息给出合法写法）；验证：`pnpm exec vitest run test/bwrap-mihomo-config.test.ts`
- [x] 1.2 `buildRules` 按 design 的映射表生成两层：精确 → DNS `example.com` + 连接层 `DOMAIN,example.com,DIRECT`；子域名 → DNS `.example.com` + 连接层 `DOMAIN-WILDCARD,*.example.com,DIRECT`；端口用 `AND` 组合；IP/CIDR 分支不变；验证：单测断言四种形态（精确/通配 × 有无端口）与 `MATCH,REJECT` 兜底
- [x] 1.3 `src/bwrap/core.ts` 的 allowlist schema description 补上语法说明（精确 / `*.` 子域名 / 可带端口）；验证：与 README、spec 的措辞一致

## 2. 单测

- [x] 2.1 `test/bwrap-mihomo-config.test.ts` 覆盖：裸域名生成精确规则与精确 fake-ip 白名单条目；`*.` 生成通配规则与 `.` 白名单条目；端口与两种档位的 `AND` 组合；IP/CIDR 不受影响；非法通配条目报错（含错误信息可自答写法）；验证：`pnpm exec vitest run test/bwrap-mihomo-config.test.ts`

## 3. 实机集成验证

- [x] 3.1 在 `test/bwrap-netstack-integration.test.ts` 增加用例（unsandboxed，`RUN_NETSTACK_INTEGRATION=1`）：allowlist=`["pypi.org","*.pypi.org"]` 时 apex 与子域名都能解析/连接；只写 `["pypi.org"]` 时子域名被拒；只写 `["*.pypi.org"]` 时 apex 被拒；`notexample.com` 类边界不被误放行
- [x] 3.2 `RUN_NETSTACK_INTEGRATION=1 NETSTACK_DNS=223.5.5.5 pnpm exec vitest run test/bwrap-netstack-integration.test.ts` 全绿（含原有三条）；另跑一次 `pnpm sandbox` 的 allowlist 域名与非允许域名，确认行为与耗时同量级

## 4. 规范与文档同步

- [x] 4.1 `openspec/specs/bwrap-network/spec.md` 的 Implementation 与新场景同步（如有机制描述需要补充）；`src/bwrap/README.md` 的 allowlist 说明改成两档语义并给出迁移提示（要子树就加 `*.`）；验证：文档与 `mihomo-config.ts` 生成结果逐条对照
- [x] 4.2 `pnpm check`、`pnpm lint`、`pnpm test` 全绿

## 5. 收尾

- [x] 5.1 检查 diff 无调试残留，`openspec validate allowlist-exact-and-subdomain-matching --strict` 通过，归档 change 并同步 delta 到主 spec
