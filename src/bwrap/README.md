# bwrap 沙箱接入层（TS）

`src/bwrap/` 只负责**命令级编排**：配置加载与校验、审批、fs 挂载计划、策略组装、
输出截断与诊断呈现。namespace 创建、网络栈（mihomo + slirp4netns）生命周期、
bwrap argv 构造与进程终止都在**原生执行器** `bin/native/<platform>-<arch>/sandbox` 里
（源码 `native/`，进程模型与网络路径见 `native/README.md`）。

| 文件            | 职责                                                                      |
| --------------- | ------------------------------------------------------------------------- |
| `core.ts`       | 配置 schema / 合并、fs 模式解析、`buildMountPlan`（挂载计划）、二进制查找 |
| `executor.ts`   | 定位执行器二进制、序列化策略、spawn、stderr 分流、退出码映射、取消        |
| `sandbox.ts`    | 加载配置 → 组装策略 → 驱动执行器；不经沙箱时走 pi 的本地执行              |
| `runtime.ts`    | 审批 UI、模式切换、`sandboxHint`、输出截断/落盘                           |
| `approval-*.ts` | 审批规则与 pattern 建议                                                   |

## 策略（能力描述）

TS 把"要什么能力"序列化成 JSON（base64 后经 `run --policy-base64` 传给执行器），
执行器决定"用哪些 bwrap 参数与系统调用表达"：

```json
{
  "root": "/",
  "mounts": [
    { "path": "/home/me/project", "mode": "rw-try" },
    { "path": "/home/me/project/.git", "mode": "ro-try" },
    { "path": "/home/me/.ssh/", "mode": "deny-dir" }
  ],
  "network": { "mode": "limited", "allowlist": ["pypi.org"], "dnsServers": ["223.5.5.5"] },
  "mihomo": { "path": "/path/to/mihomo", "mtu": 1500 },
  "slirp4netns": { "path": "/path/to/slirp4netns" },
  "bwrap": { "path": "/path/to/bwrap" },
  "command": "curl -sS https://pypi.org/simple/",
  "shell": "/bin/bash",
  "cwd": "/home/me/project",
  "env": { "HOME": "/home/me", "PATH": "/usr/local/bin:/usr/bin:/bin" },
  "uid": 1000,
  "gid": 1000,
  "timeoutSeconds": 30
}
```

- `mounts` 是有序能力列表（`ro` / `ro-try` / `rw-try` / `deny-dir` / `deny-file`），
  靠后的覆盖靠前的。路径语义（realpath 归一化、`.` / `~` 展开、`PROTECTED_DIRS`
  与工作区 `.git` 的识别）全部在 `core.ts` 的 `buildMountPlan` 完成，执行器不做推断。
- `env` 是命令的完整环境（不继承）；`network.mode` 为 `limited` 时执行器建网络栈，
  `block` / `allow-all` 不建栈。
- allowlist / mihomo 规则语义见 `native/README.md`。

## 退出码与取消

| 情况                  | 执行器退出码               | TS 侧映射                            |
| --------------------- | -------------------------- | ------------------------------------ |
| 命令正常结束          | 命令退出码（信号 → 128+n） | 原样返回                             |
| 超时                  | 124                        | `TimeoutError`（`timeout:N`）        |
| 网络栈/执行器启动失败 | 125                        | 启动失败错误（附 stderr 尾部与日志） |
| 用法/内部错误         | 2                          | 内部错误                             |

- **超时**由执行器内部用 pidfd 终止，不留残留进程。
- **取消（AbortSignal）**：TS 先关执行器 stdin（执行器读到 EOF 走内核级清理），
  到点再 `SIGTERM`，最后 `SIGKILL`；为什么可以按 pid 发信号见 `executor.ts` 注释。
- 执行器异常退出（125 / 2 / 被信号杀死）时，TS 把收集到的诊断落盘到
  `agent-dir/tmp/bwrap-sandbox-<uuid>.log`，并把路径附进错误信息。

## 调试入口

```sh
# 构建原生执行器（两个架构）到 bin/native/
pnpm run build:native

# 与扩展同一条代码路径地执行一条命令
pnpm sandbox --verbose -- '<command>'

# 开发期指向 go build 的产物
PI_SANDBOX_BINARY=/tmp/sandbox pnpm sandbox -- '<command>'
```

`pnpm sandbox` 只打印配置摘要与执行结果；网络栈日志用 `--verbose` 透传
（执行器诊断行带 `[netstack] ` 前缀）。
