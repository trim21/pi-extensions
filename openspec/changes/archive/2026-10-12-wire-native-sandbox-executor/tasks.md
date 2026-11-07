# Tasks

## 1. 原生执行器适配接入形态

- [x] 1.1 `native/policy.go`：策略改为能力描述——`root` + 有序 `mounts`（`ro`/`ro-try`/`rw-try`/`deny-dir`/`deny-file`）、`extraArgs`、网络策略（mode/allowlist/dnsServers）、`command`/`shell`/`cwd`/`env`、`uid`/`gid`、mihomo/slirp4netns/bwrap 路径、超时；路径 MUST 为绝对路径（语义在 TS 侧）。
- [x] 1.2 `native/bwrap.go`：把挂载计划翻译成 bwrap 参数（`--ro-bind`/`--ro-bind-try`/`--bind-try`/`--tmpfs`/`/dev/null`）并按原顺序组装 argv（`--new-session --die-with-parent --unshare-user --unshare-pid --uid --gid` → 挂载 → `--unshare-net`（block）→ extraArgs → `--dev/--proc` → `-- shell -lc command`）；`main.go` 保留 `--policy`/`--policy-base64`/`--timeout`/`--verbose`，不做 `print-args`（预览功能删除）。
- [x] 1.3 `native/init.go`：执行 `buildBwrapArgv(policy, policy.Bwrap.Path)` 产出的命令行，并按 `policy.env` 设置命令环境；保持 lo 拉起、tap0 等待、mihomo 就绪、stdin EOF、退出码透传。
- [x] 1.4 探测 `pidfd_open`：不支持则启动阶段明确失败（删除按 pid 的降级分支）；给 pidfd 设 `CLOEXEC`；init 内的 mihomo 同样改走 pidfd；等待退出用 `exec.Cmd.Wait`（不再需要 epoll/poll 胶水）。
- [x] 1.5 `go vet` / `go build` / `gofmt` 通过，`native/README.md` 更新为能力描述形态、pidfd 不变量与最低内核版本（5.3）；宿主上实测 allowlist 放行（200）、非 allowlist 拒绝（`Could not resolve host`，退出码 6）、超时（124）、无残留进程。

- [x] 1.6 `native/init.go`：作为 pid namespace 的 init，先把挂载传播设为 private 再重新挂载 procfs（等价 util-linux 的 `unshare --mount-proc`）——否则 bwrap 的 `--unshare-net` 会因读宿主 `/proc` 的 ns 链接而失败（宿主集成测试实测复现过）；同时确认宿主 `/proc` 未被顶掉。

## 2. TS 侧接入

- [x] 2.1 新增 `src/bwrap/executor.ts`：定位包内二进制（`bin/native/linux-<arch>/sandbox`，允许 `PI_SANDBOX_BINARY` 覆盖）、序列化 policy、spawn、转发 stdout/stderr、按 `[netstack] ` 前缀分流诊断、映射退出码（124 → `TimeoutError`、125 → 启动失败、2 → 内部错误）、abort 时先关 stdin 再 SIGTERM/SIGKILL。
- [x] 2.2 `src/bwrap/sandbox.ts`：`runInSandbox` 改为驱动执行器；保留 `SandboxRunResult`、`onData` 语义；删除预览相关导出（`previewSandboxCommand`、`HOLDER_PID_PLACEHOLDER`）与其测试；诊断通道改名为 `ExecutorDiagnostics.diagnostic`，删掉不再赋值的 `networkStackLog`。
- [x] 2.3 `src/bwrap/core.ts`：删除 `createNetworkStack`、`findMihomo`、`findSlirp4netns`、`buildBwrapArgs`；新增 `buildMountPlan`（`root` + 有序 `mounts`：绝对路径 + `ro`/`ro-try`/`rw-try`/`deny-dir`/`deny-file`）；`findExecutable` 导出给执行器层复用。
- [x] 2.4 `src/bwrap/runtime.ts`：`findMihomo` → `resolveMihomoPath`；删掉已失效的 `withNetworkStackLog`（诊断路径现在附在错误信息里）。
- [x] 2.5 `bin/sandbox.ts`：跟随新路径；删除 `--print-args`（预览功能移除），其余 flag 与输出格式不变。

## 3. 删除旧实现

- [x] 3.1 删除 `src/bwrap/network-stack.ts`、`src/bwrap/holder.ts`、`src/bwrap/holder.js`、`src/bwrap/exec.ts`、`src/bwrap/mihomo-config.ts`、`package.json` 的 `build:holder` 脚本。
- [x] 3.2 `exec.ts` 整体删除（`nsenter` 前缀、进程 spawn、`buildBwrapInvocation`、`invocationArgv` 都在其中；argv 构造移入执行器的 `bwrap.go`）。
- [x] 3.3 全仓搜索残留引用（`holder`、`nsenter`、`createNetworkStack`、`HOLDER_PID_PLACEHOLDER`、`previewSandboxCommand`）并清理：`.husky/pre-commit`、`.prettierignore`、`eslint.config.mjs` 里的 `holder.js` 条目一并删除。

## 4. 测试改造

- [x] 4.1 `test/bwrap-netstack-integration.test.ts`：改为通过 TS 公开接口驱动原生执行器（用 `nativeSandboxUsable()` 探测环境），覆盖 allowlist 放行/拒绝、超时终止、无残留进程、正常结束不落盘、block 模式断网。
- [x] 4.2 `test/bwrap-mihomo-config.test.ts` 删除，配置生成改由 Go 侧测试覆盖（`native/mihomo_test.go`），并按被删的 TS 实现语义补齐 IPv6（`IP-CIDR6`）、方括号 IPv6 条目、非法/注入条目拒绝等差异；IP / CIDR 条目改用 `net/netip` 真实解析（`999.999.999.999`、`1.2.3.4.5` 这类形态像 IP 的条目直接拒绝，不再按字符形态匹配、也不降级成域名）。
- [x] 4.3 新增单测：`test/bwrap-executor.test.ts`（二进制查找、退出码映射、stderr 分流、abort）与 `test/bwrap-native-probe.ts`（环境探测）。
- [x] 4.4 回归：`test/bwrap*.test.ts` 中策略与审批相关用例保持通过；预览相关用例随功能删除。

## 5. 分发与 CI

- [x] 5.1 `package.json`：`files` 增加 `bin/native`，新增 `build:native`（`CGO_ENABLED=0 GOOS=linux GOARCH={amd64,arm64} go build -trimpath -ldflags "-s -w"`），`.gitignore` 忽略构建产物。
- [x] 5.2 `ci.yml`：新增独立的 `native` job（`actions/setup-go` + `go vet` + `go build` + `go test`）并加入 `all-checks` 依赖；test job 里构建执行器供集成用例探测。
- [x] 5.3 `release.yaml`：触发路径增加 `native/**`；发布前交叉编译两个架构到 `bin/native/linux-{x64,arm64}/sandbox`，再 `npm publish`。
- [x] 5.4 校验发布包内容：`npm pack --dry-run` 里包含两个二进制、不含 Go 源码（Go 源码随仓库，不进包）。

## 6. 验证

- [x] 6.1 `pnpm run lint`、`pnpm run check`、`pnpm test` 全绿（`HOME` 可写时 gh 相关用例亦通过）。
- [x] 6.2 宿主上手工验证：allowlist 放行、非 allowlist 拒绝、超时 124、取消后无残留进程。
- [x] 6.3 `RUN_NETSTACK_INTEGRATION=1` 的集成用例在宿主上全部通过（4 passed，含 block 模式与 procfs 修复后的回归）。
- [x] 6.4 归档：delta 合并进 `openspec/specs/bwrap-network/spec.md`（含 Implementation 段重写为原生执行器架构：能力描述策略、procfs 挂载、pidfd 终止、二进制分发），change 移入 `archive/`。
