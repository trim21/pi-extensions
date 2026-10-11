# Tasks

## 1. 策略与 CLI 接口（解耦）

- [x] 1.1 `native/policy.go`：策略 JSON 类型（fs 绑定 / 网络模式与 allowlist / 外部命令路径 / uid-gid / shell / env / 超时）、`--policy` 的三种写法（JSON、`@file`、`-`）、`--policy-base64`、未知键报错、默认值填充与校验。
- [x] 1.2 `native/main.go`：`sandbox run` 的 flag 解析、`--print-args`（打印 bwrap 命令行，可与 TS 版对拍）、`--timeout`、`--verbose`、用法说明。

## 2. pidfd 与进程管理

- [x] 2.1 `native/pidfd.go`：裸 syscall 封装 `pidfd_open`(434) / `pidfd_send_signal`(424) / `poll`（epoll）等待退出；`kill(grace)` 先 SIGTERM 再 SIGKILL，全部走 pidfd。
- [x] 2.2 supervisor 对 init 与 slirp4netns 各持一个 pidfd；超时/收尾的终止都经 pidfd，不用 `kill(2)`、不用 pid 字面量。

## 3. 网络栈与执行

- [x] 3.1 `native/main.go`：`clone(CLONE_NEWUSER|NEWPID|NEWNS|NEWNET)` + uid/gid 映射启动 `internal-init`（新 ns 的 PID 1），自建 pipe 转发 stdout/stderr，`ExtraFiles` 传 exit-fd（init 持写端、slirp4netns 持读端，父进程关闭副本）。
- [x] 3.2 `native/init.go`：拉起 lo、等 tap0、起 mihomo、等就绪后打印 `sandbox: network stack ready`（宿主侧不再依赖 mihomo 的日志文案）、在目标 netns 内直接执行 bwrap（不需要 nsenter）、把命令退出码透传。
- [x] 3.3 停栈语义：stdin EOF（优雅）→ 内核清理 pid namespace → exit-fd HUP → slirp4netns 自行退出；卡死/超时才 pidfd 强杀。
- [x] 3.4 输出分流：命令的 stderr 原样转发；网络栈自身日志加 `[netstack] ` 前缀，仅 `--verbose` 时展示；slirp4netns 输出默认丢弃（verbose 时转发）。

## 4. 配置生成

- [x] 4.1 `native/mihomo.go`：allowlist 条目解析（域名 / `*.domain` / `:port` / IP / CIDR / `[v6]:port`）与 mihomo 配置生成（TUN + 白名单 fakeip + `MATCH,REJECT`），base64 直传。
- [x] 4.2 `native/bwrap.go`：argv 组装（readonly → `--ro-bind-try`、readwrite → `--bind-try`、deny 目录 → `--tmpfs`、deny 文件 → `/dev/null`）+ `--print-args` 的可复制渲染。

## 5. 验证

- [x] 5.1 `go vet ./...` 与 `gofmt -l` 干净；`go build` 产出单文件（约 4.7MB，零第三方依赖）。
- [x] 5.2 宿主上实测三个用例：allowlist 域名 `200`、非 allowlist `curl: (6) Could not resolve host`（退出码 6）、`--timeout 3` 的 `sleep 30` 以 124 退出且提示明确。
- [x] 5.3 停栈后无残留（`pgrep -f "mihomo -d|slirp4netns"` 无匹配）；起停开销实测 `--command true` 约 0.15s。
- [x] 5.4 仓库原有检查不受影响：`pnpm run check`、`pnpm run lint`、`pnpm test` 全绿（`native/` 不进 npm 包 `files`，不参与 TS 检查）。
- [x] 5.5 `native/README.md` 记录构建、用法、已验证行为与"接入时需补齐"的差异清单。
