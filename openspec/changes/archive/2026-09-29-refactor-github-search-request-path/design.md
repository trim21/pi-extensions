# Design

## Context

GitHub 读写分两条传输：`gh` CLI 子进程（`ghExec`）与 octokit（`GhClient.search` / `.checks`）。带关键词的搜索必须走 octokit，因为 `gh issue list --search` 的 state 默认 open 会漏 closed/merged；checks 也必须走 octokit，因为 `gh pr checks --json` 恒以 0 退出且缺 check run 的 bucket / event 字段。两条传输的取舍写在 `openspec/specs/gh-readonly/spec.md`。

octokit 那条路径的 client（及其 auth token）缓存在 `createGithubApi` 的闭包里，401 时丢缓存重试一次。`@me` 是 gh CLI 的简写，REST 搜索 API 不认识，所以搜索路径原先自己调了一次 `users.getAuthenticated()` 把它换成 login。

## Goals / Non-Goals

**Goals**

- `GithubApi` 承诺的 client 缓存与 401 重试覆盖搜索请求。
- 不在 SDK 路径维护 `@me` 展开。

**Non-Goals**

- 不支持 REST 搜索里的 `@me`（用户决定：gh CLI 支持算加分项）。
- 不合并 `GhClient` 的两个 octokit 实例（`createGithubSearch` / `createGithubChecks` 各自 `createGithubApi`，因此每个会话有两份 client 与 token 缓存、`gh auth token` 被 spawn 两次）——独立待办。
- 不改传输选择（哪些读走 gh、哪些走 octokit）。

## Decisions

### D1 删掉 SDK 侧的 `@me` 展开

它唯一的用途是把 gh CLI 的简写翻译成 REST 认识的 login，而 REST 搜索里 `@me` 从来不是合法用户名。删掉之后：带关键词搜索里的 `assignee: "@me"` 作为字面量进入查询串（GitHub 返回空结果），无关键词路径仍由 gh 展开。

代价是「关键词 + `@me`」从「能用」变成「静默空结果」。这是本次唯一的行为退化，且是明确接受的取舍（SDK 不维护 gh 的语法糖）。若将来要收敛这个坑，最小做法是在 `createGithubSearch` 入口对「带关键词 + `@me`」直接报错——本次不做，避免超出用户要求的范围。

### D2 请求整体进入 `api.call`

`api.call(fn)` 的语义是「在带缓存与 401 重试的 client 上执行 fn」，所以 `fn` 里应当包含请求本身。原先 `fn` 只是 `getAuthenticated` 的载体，返回 client 供外面使用——那是把 `call` 当成「取 client 的通道」，缓存与重试的语义因此只覆盖了通道内的那一次请求。

`buildSearchQuery` 保持在 `try` 内、`api.call` 之外：

- 它是纯函数，没有理由进重试循环；
- 它抛 `invalid state` / `state=merged is only valid for PR searches`，而这两个错误当前被 `try` 包成 `GithubSearchError`，报错文本被测试与工具输出依赖——把它挪出 `try` 会改变错误类型与报文。

### D3 用 401 序列覆盖重试，而不是断言「在 call 里」

测试不检查实现（`api.call` 是私有的），而是构造一次 401 后 200 的 fetch 序列，断言搜索最终成功且请求发了两次。旧实现下这条用例失败（只发一次请求并抛 `GithubSearchError`），这正是「重试被绕过」的可观测证据。同理，「不触发 `getAuthenticated`」用 fetch 调用序列断言：一次搜索只应产生一次请求。

## Risks / Trade-offs

- **关键词 + `@me` 静默空结果**：模型可能在带关键词时也用 `assignee: "@me"`，拿到「无匹配」而不是错误。工具参数描述（`(@me for yourself)`）此时只对无关键词路径成立，本次不改描述——要改就是一处文案（`list-issues.ts` / `list-prs.ts`）加 spec 同步。
- **`author: "@me"` 同样的坑**：原先只展开 `assignee`，`author` 一直是字面量；本次删除后两者行为一致（都不展开），不存在新增退化。
- **两份 client 缓存**（Non-Goals 那条）仍在：搜索恢复了 401 重试，但它的缓存与 checks 的缓存互相独立，两次 `gh auth token` 的 spawn 依旧。
