# Proposal

## Why

沙箱内与不经沙箱的本地执行走了两套环境构造方式：

- 沙箱路径（`src/bwrap/exec.ts`）：执行层自己的干净环境 `HOME` / `SHELL` / `TERM` / `LANG` / `PATH=/usr/local/bin:/usr/bin:/bin`，再用 `bash -lc` 由 profile 重建 `PATH`。
- 本地路径（`src/bwrap/sandbox.ts` 的 `withExtraEnv(createLocalBashOperations(), ...)`）：继承 pi 进程的完整环境，用 `bash -c`，不读任何 profile。

结果是同一条命令在两条路径下看到的工具版本和变量集合都不同。实测：同一个工作区里，沙箱内 `node -v` 是项目 `mise.toml` pin 的 `24.19.0`，沙箱外是全局 `latest` 的 `26.13.0` —— 继承来的 `PATH` 把 mise 的全局安装目录排在 `shims` 前面，而 `bash -c` 不会按 cwd 重新解析版本。

沙箱是权限边界，不该顺带成为环境边界。两条路径的差别应当只有权限（bwrap 的只读挂载、netns、逐条审批），环境必须一致。

## What Changes

- 非沙箱路径改为与沙箱路径相同的构造：同一份干净环境 + `bash -lc`。
- `exec.ts` 抽出共享的基础环境构造与 spawn 实现，两条路径共用同一段组装，避免再次漂移。
- 删除 `sandbox.ts` 的 `withExtraEnv`：它存在的唯一理由是为本地路径补 `shell.env`，本地路径改用同一份环境后由共享构造统一合并。
- 明确不再考虑 Windows 支持：本地路径不再回退到 core 的 `createLocalBashOperations`，非 POSIX 平台不在支持范围内。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap`：`命令执行环境` 要求改为"沙箱内与本地执行共用同一份干净环境，差异只在权限"，并删除"本地路径的环境与不注入时完全相同"这一场景。

## Impact

- 代码：`src/bwrap/exec.ts`、`src/bwrap/sandbox.ts`。
- 测试：`test/bwrap.test.ts`（新增两条路径环境一致的断言）。
- 行为变化：非沙箱命令不再继承父进程环境，`SSH_AUTH_SOCK`、`GIT_*`、`UV_PUBLISH_TOKEN`、代理变量等都不再可见 —— `git push`（SSH agent）、`pnpm publish`、私有 registry 认证这类命令在非沙箱路径会失败。这是选"两边都用干净环境"的既定代价，换来的是两条路径行为一致。
