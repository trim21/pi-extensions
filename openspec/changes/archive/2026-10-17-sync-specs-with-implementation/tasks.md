# Tasks

## 1. spec 同步

- [x] 1.1 aft：引擎版本、bridge 生命周期、callgraph 重试、walk 上限、`enabled` 门控。
- [x] 1.2 bwrap / bwrap-network：审批匹配、模块边界、reload 语义、配置默认值、停栈与 pid 描述。
- [x] 1.3 codemode：删除文本兜底、嵌套入口名、store 与 VM 上限。
- [x] 1.4 spawn-agent：details、工具解析、frontmatter、进度模块。
- [x] 1.5 gh-readonly / wait：错误类型、notify 级别、octokit 调用、`suiteId`、分页与串行取数。
- [x] 1.6 talk / lsp / web / tool-registration / claude-code / opencode / write-guard：边界、字段清单与行为描述。

## 2. 验证

- [x] 2.1 `openspec validate sync-specs-with-implementation --strict` 无 error。
- [x] 2.2 `pnpm check` 通过。
- [x] 2.3 确认工作区只有 spec 变更，没有代码与测试改动。
