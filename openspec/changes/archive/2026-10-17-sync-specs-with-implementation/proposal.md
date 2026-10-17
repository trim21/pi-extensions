# Proposal

## Why

多轮实现变更后，部分主 spec 仍停留在旧行为：有的描述的是已被替换的实现（BashArity 归一、SIGKILL 停栈、NSpid、跨 session bridge 池），有的把已被有意移除的输出写进契约（spawn-agent 的详情载荷、gh 的文本输出），有的数值与当前依赖或代码不一致（aft 引擎版本、walk 上限、talk 积压边界、`suiteId` 命名）。这些偏差会误导后续实现与审查，需要一次性把 spec 对齐到当前真实行为。

## What Changes

- **Implementation 段与文档描述**：更新 aft、bwrap、bwrap-network、lsp、talk、gh-readonly、spawn-agent、tool-registration 的实现说明、字段清单、默认值与文件名。
- **行为契约**：按当前实现修正要求的措辞与场景——codemode 删除「无 `structuredResult` 返回文本」并改嵌套入口名；spawn-agent 的 details 只保留 `pendant`；gh 等待载荷用 `suiteId`、`statuses` 单次取 100 条、`reviews` 串行、`auth token` 错误类型、notify 级别、删除过时的「文本与结构化载荷同源」；talk 的 50 条边界与 policy 方向；web 文本去除首尾空白；tool-registration 的警告粒度与 codemode wasm 例外；claude-code Read 的超限行为；两套文件工具集的 read-before-write 规则。
- **不修改代码与测试**：本次只同步文档。

## Non-Goals

- 不处理 spec 自身矛盾的两处（tool-registration 的 `executeTool` 与 codemode-only 场景、gh 等待超时返回 `pending` 与「任一失败」场景），留给后续定调。
- 不把代码缺陷写成 spec：aft 软失败与 schema、vision-agent provider 门控、gh SIGKILL、lsp 监听器与 setup、codemode active 空列表、session-name 角色过滤、web_fetch 超时边界仍按代码修复处理。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `aft`：引擎版本、bridge 生命周期、callgraph 重试、目录遍历上限、`enabled` 门控。
- `bwrap`：审批匹配不含 BashArity 归一、模块边界、`/bwrap-reload` 语义、配置键与默认值、`/bwrap-allow-request` 与平台降级。
- `bwrap-network`：停栈走 fd 通道、setns 目标取宿主侧 pid。
- `codemode`：删除无结构化结果时的文本兜底、嵌套入口名、store 与 VM 上限说明。
- `spawn-agent`：details 只剩 `pendant`、工具解析顺序、frontmatter 字段、进度模块文件。
- `gh-readonly`：`auth token` 错误类型、`getReleaseAsset`/`listWorkflowRunsForRepo` 的实际调用、`statuses` 分页、`reviews` 串行、文本输出残留。
- `wait-github-pr-checks`：`suiteId` 命名、`statuses` 取数方式。
- `wait-github-commit-checks`：删除不存在的调用上下文标识。
- `talk`：积压边界、policy 方向、存储与投递配置。
- `lsp`：`lsp.json` 字段与诊断等待的安静期。
- `web`：文本返回的首尾空白处理。
- `tool-registration`：非法条目警告粒度、codemode wasm 例外。
- `claude-code-tools`：Read 超限行为、read-before-write。
- `opencode-tools`：read-before-write 与 stale-read 守卫。

## Impact

- 规范：`openspec/specs/` 下上述 capability 的主 spec。
- 无代码、测试、配置或依赖变更。
