# Proposal

## Why

allowlist 里的裸域名条目目前是**子树**语义：`example.com` 实际授权 `example.com` 及其任意深度子域名。这是 mihomo 的现状实现（DNS 侧 fakeip 白名单写 `+.example.com`，连接层写 `DOMAIN-SUFFIX,example.com`，两者都是 apex + 全部子域名），但它既没有写进任何文档，也不符合「允许 example.com」的字面理解——用户会以为只放行了这一个域名。

需要的是可选的两种精度：只想放行某个域名本身时能精确匹配，需要覆盖 CDN / API 子域名时能显式表达子树，而不是被隐式授予整棵子树。

## What Changes

- **BREAKING**：裸域名条目收窄为**精确匹配**——`example.com` 只放行 `example.com` 本身。
- 新增子域名语法 `*.example.com`：放行该域名的**所有子域名（任意深度，不含 apex）**。需要连 apex 一起放行时写两条：`example.com` 与 `*.example.com`。
- 端口后缀对两种形式都可用：`*.example.com:443`。
- 两层语义严格一致：DNS 侧 fakeip 白名单与连接层规则按同一套语义生成，避免「能解析但连不上」或「连接层比 DNS 宽」。
- IP / CIDR 条目不受影响（原样走 `IP-CIDR`）；通配语法只对域名有效。
- 校验明确拒绝歧义/过宽写法：`*`（等于放行一切）、`*example.com`、`a.*.example.com`、`*.*.example.com`、`*.1.2.3.4`。
- spec 的 allowlist requirement 补上匹配语义（精确 / 子域名）与校验场景；README 与配置 schema 的描述同步，并给出迁移提示（要子树就加 `*.`）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap-network`: 「allowlist 网络访问控制」——明确条目匹配语义：裸域名精确匹配、`*.` 前缀匹配全部子域名（不含 apex）、端口后缀只约束连接层，并补通配语法校验场景。现状的隐式子树语义被替换，属于行为收窄。

## Impact

- 代码：`src/bwrap/mihomo-config.ts`（`parseAllowlistEntry` 的语法解析与校验、`buildRules` 的两层规则生成）、`src/bwrap/core.ts`（allowlist 的 schema description）。
- 规范/文档：`openspec/specs/bwrap-network/spec.md`、`src/bwrap/README.md`。
- 测试：`test/bwrap-mihomo-config.test.ts`（语法与规则生成）、`test/bwrap-netstack-integration.test.ts`（实机验证精确与通配的边界）。
- **迁移**：现有配置若依赖子树语义（如只写 `github.com` 却需要 `api.github.com`），要么补 `*.github.com`，要么接受收窄。本机 `~/.pi/agent/sandbox.json` 现有条目（`pypi.org`、`files.pythonhosted.org`、`registry.npmjs.org`、`conda.anaconda.org`、`goproxy.cn`）都是直接访问 apex，收窄后仍然可用；是否要额外覆盖子域名由用户决定。
