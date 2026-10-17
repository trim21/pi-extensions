# Tasks

## 1. spec 同步

- [x] 1.1 `gh-readonly` 的「命令失败契约」删除「请求超时」，明确 REST 请求只响应调用方 `signal`。
- [x] 1.2 注明 `gh` 子进程超时只覆盖 repo 解析与 token 获取，`auth token` 为 10 秒。

## 2. 验证

- [x] 2.1 `openspec validate fix-gh-request-timeout-spec --strict` 通过。
- [x] 2.2 确认本 change 不涉及代码与测试改动。
