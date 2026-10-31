# Design

## Context

执行层目前有两条路径，分叉点在 `src/bwrap/sandbox.ts` 的 `runInSandbox`：

```ts
const operations = local
  ? withExtraEnv(createLocalBashOperations(), options.env)
  : createBwrapBashOperations(resolved, workspace, stack, options.env);
```

- `createBwrapBashOperations`（`src/bwrap/exec.ts`）经 `buildBwrapInvocation` 构造干净环境，再由 `invocationArgv` 以 `[bwrap, ..., "--", shell, "-lc", command]` 执行。
- `createLocalBashOperations` 来自 `@earendil-works/pi-coding-agent`，实现是 `createLocalShellOperations("bash", () => getShellConfig())`：`args: ["-c"]`，`env` 来自 core 的 `getShellEnv()`（继承 pi 进程环境，再补 `~/.pi/agent/bin`）。

因此两条路径在"变量集合"和"版本解析"两个维度都不同，且 `withExtraEnv` 的注释把这种不一致写成了刻意行为。

## Goals / Non-Goals

**Goals:**

- 沙箱内与本地执行的进程环境逐项相同（只有 bwrap 挂载、netns、审批不同）。
- 两条路径共用同一段环境组装与 spawn 实现，后续改动不会只改一边。
- `personalExtensions.shell.env` 在两条路径上语义一致。

**Non-Goals:**

- 不改变沙箱的 fs / network 策略与审批流程。
- 不改变 bash 工具的输出格式、截断行为、超时与中止语义。
- 不为非 POSIX 平台提供兼容：本地路径不再回退到 core 的实现。

## Decisions

**D1：方向选"两边都用干净环境"，而不是"两边都继承父进程环境"。**
继承父进程环境会让沙箱内的命令拿到 `UV_PUBLISH_TOKEN`、`VSCODE_CLI_REQUIRE_TOKEN`、代理变量等，等于把沙箱从"最小权限环境"降级成"只隔离文件系统"。干净环境 + `bash -lc` 由 profile 重建 `PATH`，工具版本按 cwd 解析，正好是沙箱路径已经验证过的语义。

**D2：把 spawn 主体抽成 `execArgv(argv, env, options)`。**
当前 `execInvocation` 同时承担"拼 argv"和"跑进程"。本地路径的 argv 是 `[shell, "-lc", command]`，与 bwrap 的 argv 形态不同，但超时、中断、进程组 kill、`settle` 这些语义必须完全共用。抽出 `execArgv` 后，`execInvocation` 只负责 bwrap 形态的 argv 组装，本地路径直接调用 `execArgv`。

**D3：基础环境只保留一份，由 `shellBaseEnv(extraEnv?)` 构造。**
`buildBwrapInvocation` 与新的本地实现都调用它，`HOME` 缺失时仍然抛 `HOME is not set; refusing to run bash in a clean environment`。`shell.env` 的合并（覆盖同名基础值）留在这个函数里，`withExtraEnv` 随之删除。

**D4：本地路径同样做 cwd 存在性检查与 `signal?.throwIfAborted()`。**
与 `createBwrapBashOperations` 对齐，避免两条路径在"目录不存在"和"已中断"两个错误场景上给出不同表现。

**D5：不再考虑 Windows。**
`createLocalBashOperations` 的 Windows 兼容（`getBashShellConfig` 对 legacy WSL 用 `-s`）不再需要。若仍有人在 Windows 上使用，本地路径会因为缺少 `bash -lc` 而失效 —— 这是本次明确接受的取舍。

## Risks / Trade-offs

- **非沙箱命令失去父进程环境**：`git push`（SSH agent）、`pnpm publish`、私有 registry 认证会失败。缓解方式是把需要转发的变量显式写进 `personalExtensions.shell.env`（该配置已存在），后续如需自动化再单独提案。
- **父进程 PATH 上的工具不再可达**：`bash -lc` 重建的 `PATH` 只有 profile 的条目，靠 `$GITHUB_PATH` 或其它外部方式注入 `PATH` 的工具（CI 里 pixi 装的 `~/.pixi/bin`、`~/.cargo/bin`）在命令里都找不到。命令要用的工具必须能由 profile 的 `PATH` 解析；CI 上那条用 `rg` 验证管道退出码的用例因此换成基础 `PATH` 上必然存在的 `grep`。
- **两条路径的 profile 可能走不同分支**：profile 里的 hook 若依赖写盘或联网，在沙箱（只读挂载 / 断网）里会走另一条路径，产生变量差异。执行层保证的是交给 shell 的同一份环境与同一条登录 shell 路径；比对两条路径环境的测试用临时 `HOME` 隔离机器自己的 profile，避免把 profile 行为当成执行层回归。
- **每条命令多一次 profile 加载**：`bash -lc` 会读 `/etc/profile` 与 `~/.bash_profile`，约 10–30ms。依赖「命令开跑后极短时间内就有输出」的测试（部分输出 + 20ms 超时/中断）要把窗口放大到能容下 profile 加载，否则断言的是 profile 加载时长而不是执行层行为。
- **Windows 分支失去测试覆盖**：`BwrapRuntime` 里「mock win32 → 无 bwrap → 逐条审批 + 本地执行」那组测试的前提是本地路径沿用父进程环境，本次改造后 mock win32 下解析不到 shell，整组删除。runtime 的 win32 分支本身未改动（不在本次范围），后续若要彻底移除 Windows 支持需单独提案。
- **profile 里的 `cd` 会改工作目录**：若用户的 profile 在登录时 `cd`，命令实际执行目录会偏离 `cwd`。当前机器没有这种 profile；如需防御，可在 `-lc` 之后显式 `cd -- "$PWD"`（本提案暂不做）。
