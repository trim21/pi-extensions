# Spec Delta

## MODIFIED Requirements

### Requirement: 提权审批

模型需要全权限（`dangerouslyDisableSandbox: true`）时，命令 MUST 由审批规则集判定：链上任一命令命中 `deny` 规则即整体拒绝；链上所有命令都命中 `allow` 规则才整体自动放行；含写入文件的重定向（`>` / `>>` / `&>` 等）的命令即使规则全匹配也不自动放行；其余情况弹确认框交用户决定。同一条命令同时命中多条规则时，规则数组中靠后的那条决定其动作（项目规则排在全局规则之后）。`/bwrap-deny-request` 生效或运行在固定沙箱时，非沙箱请求直接拒绝，规则与确认框都不参与。

#### Scenario: 命中 allow 规则自动放行

- **WHEN** 命令的每条子命令（含 `$(...)` 与管道两端）都命中 `approvalRules` 中的 `allow` 规则
- **THEN** 直接以全权限执行，不弹确认框

#### Scenario: 链上有一条命令未命中 allow 规则则需确认

- **WHEN** 命令链中有一条子命令没有命中任何 `allow` 规则
- **THEN** 弹出确认框（未允许的命令不会被同链的其他规则带过）

#### Scenario: 命中 deny 规则直接拒绝

- **WHEN** 命令链中任一子命令命中 `approvalRules` 中的 `deny` 规则
- **THEN** 命令被拒绝执行，不弹确认框

#### Scenario: 后写的规则优先

- **WHEN** 同一条命令同时命中先出现的 `allow` 规则与后出现的 `deny` 规则（或反之）
- **THEN** 以数组中靠后的那条规则为准；项目配置的规则排在全局配置的规则之后

#### Scenario: 含输出重定向的命令不自动放行

- **WHEN** 命令含文件输出重定向（`>` / `>>` / `&>` 等）
- **THEN** 即使命令文本匹配 `allow` 规则也不自动放行（防止 `echo *` 类规则被 `echo '' > file` 带过）

#### Scenario: 未命中规则需用户确认

- **WHEN** 命令未命中任何审批规则
- **THEN** 弹出确认框，用户批准后以全权限执行

#### Scenario: 请求被拒绝时规则不参与

- **WHEN** 用户已执行 `/bwrap-deny-request`，或当前运行在固定沙箱（子代理声明的配置）中，且模型请求非沙箱执行
- **THEN** 请求直接按拒绝处理，不弹确认框；即使命令命中 `allow` 规则也不放行

## ADDED Requirements

### Requirement: 审批规则的持久化

用户在审批确认框的子菜单里勾选的命令模式，写入项目配置文件 `.pi/sandbox.json` 的 `approvalRules`（`allow`），并在本会话内立即生效、无需重载配置。写入 MUST 保留该配置文件中与审批规则无关的既有内容，包括本版本不认识的字段。子菜单只列出该命令的候选模式中尚未被 `allow` 规则覆盖的那些；用户在确认框选择「Run this in sandbox」时不写入任何规则。

#### Scenario: 勾选的模式写入项目配置并立即生效

- **WHEN** 用户在确认框勾选 `git status *` 并选择放行
- **THEN** `.pi/sandbox.json` 的 `approvalRules` 追加 `{ "action": "allow", "pattern": "git status *" }`，且本会话内后续同模式命令不再弹确认框

#### Scenario: 写入保留配置文件的其余内容

- **WHEN** 项目配置文件里已有其他字段（如 `fs`、`network` 配置或不认识的字段）
- **THEN** 写入后这些内容原样保留

#### Scenario: 只列出尚未允许的模式

- **WHEN** 命令链中一部分子命令的模式已被 `allow` 规则覆盖
- **THEN** 子菜单只列出未被覆盖的模式，已允许的不重复展示、也不重复写入

#### Scenario: 拒绝提权时不写入规则

- **WHEN** 用户在确认框选择「Run this in sandbox」（拒绝提权、改为沙箱内执行）
- **THEN** 即使之前在子菜单勾选过模式，也不写入任何规则
