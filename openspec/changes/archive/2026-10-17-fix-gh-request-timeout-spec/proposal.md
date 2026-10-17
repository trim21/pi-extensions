# Proposal

## Why

`gh-readonly` 的「命令失败契约」仍写「请求超时」，但取数已经全部改为 octokit / `rawFetch` 直连 GitHub，没有应用层请求超时；实际只有调用方的 `signal` 能取消请求。`gh` 子进程只剩 repo 解析与 token 获取两个短命令，`runGh` 的默认 10 分钟预算只覆盖它们（`auth token` 实际用 10 秒）。继续保留「请求超时」会误导实现和审查。

## What Changes

- 明确 REST 请求只响应调用方中止信号，没有应用层超时。
- 把 `gh` 子进程超时限定为 `gh repo view` 与 `gh auth token`，注明 `auth token` 的 10 秒预算。
- 不修改代码与测试。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `gh-readonly`：「命令失败契约」删除不存在的「请求超时」，明确中止与 `gh` 子进程超时的适用范围。

## Impact

- 规范：`openspec/specs/gh-readonly/spec.md`。
- 无代码、测试、配置或依赖变更。
