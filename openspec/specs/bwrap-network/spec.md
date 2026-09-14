# bwrap-network Specification

## Purpose

`net-allowlist` 模式下，Bash 工具的命令运行在独立的 user/network namespace 中：仅 allowlist 内的网络目标可直连，其余流量在 DNS 层与连接层双重拒绝（deny-by-default）。网络栈的 namespace 生命周期与命令绑定，任何退出路径（正常结束、启动失败、宿主崩溃）下都能释放，不产生僵尸 namespace。

## Requirements

### Requirement: allowlist 网络访问控制

沙箱内命令只能访问配置允许的网络目标（域名 / IP / CIDR，可带端口），其余一律拒绝。

**双重拒绝**：未允许的域名在 **DNS 层**即被拒绝——DNS 查询直接失败（表现为 `Could not resolve host`），进程拿不到可连接的地址，效果等同于"该进程没有网络"；即使绕过 DNS（直连 IP），未允许的 IP/端口也会在连接层被拒绝。

#### Scenario: allowlist 域名可直连

- **WHEN** 沙箱内命令访问 allowlist 中的域名
- **THEN** 该域名正常解析且连接成功

#### Scenario: 未允许域名解析失败

- **WHEN** 沙箱内命令解析不在 allowlist 中的域名
- **THEN** 解析直接失败，不返回可连接的地址（而非连接阶段才报错）

#### Scenario: 未允许目标在连接层被拒绝

- **WHEN** 沙箱内命令连接不在 allowlist 中的 IP 或端口
- **THEN** 连接被拒绝

#### Scenario: 带端口的条目精确放行

- **WHEN** allowlist 条目携带端口（如 `example.com:443`）
- **THEN** 仅该域名与端口的组合放行，其余端口拒绝

#### Scenario: IPv6 条目要求方括号

- **WHEN** allowlist 条目包含裸 IPv6 地址（未用 `[]` 包裹）
- **THEN** 配置校验失败并提示用方括号包裹

### Requirement: 网络栈生命周期管理

网络栈（user/network namespace、egress 通道、流量过滤进程）随命令生命周期创建，并在所有退出路径下释放，不残留进程或 namespace。

**防僵尸 namespace 的机制**：network namespace 由 pid namespace 的 init 进程持有，init 以任何方式退出（包括被 SIGKILL 强制终止）时，内核自动终止该 pid namespace 内的全部进程，namespace 引用随之归零——网络栈内的进程无需在每条退出路径手工清理。宿主（pi）进程崩溃时，内核关闭宿主持有的 stdin 管道写端（进程退出必然关闭 fd），holder 读到 EOF 即退出，走同一套内核清理。因此网络栈的 namespace 泄漏被系统性杜绝，而非依赖调用方记得清理。

#### Scenario: 命令正常结束

- **WHEN** 沙箱命令完成
- **THEN** 网络栈停止，namespace 引用归零

#### Scenario: 网络栈启动失败

- **WHEN** 网络栈启动过程中任一组件失败
- **THEN** 已启动的进程被清理，不残留进程或 namespace

#### Scenario: 宿主进程被强制终止

- **WHEN** 运行沙箱的宿主进程被 SIGKILL 或以其他方式崩溃
- **THEN** 网络栈在毫秒级自动清理（stdin EOF 触发 holder 退出 → 内核清 pid namespace），namespace 不泄漏

#### Scenario: 网络栈可重复创建

- **WHEN** 连续多次执行沙箱命令
- **THEN** 每次命令的网络栈独立创建与销毁，前后无进程或 namespace 累积

### Requirement: 配置无落盘传递

网络过滤配置直接传入过滤进程，不经过文件系统中转。

#### Scenario: 配置编码直传

- **WHEN** 网络栈启动
- **THEN** 过滤配置以 base64 编码直接传给过滤进程，文件系统中不产生临时配置文件

### Requirement: 就绪检测

过滤进程完成网络接管后命令才开始执行。

#### Scenario: 就绪后执行命令

- **WHEN** 网络栈启动
- **THEN** 等待过滤进程就绪（TUN 接管完成）后才执行沙箱命令；过滤进程提前退出则命令失败

#### Scenario: 就绪日志跨数据块

- **WHEN** 过滤进程的就绪日志单行被输出流切分为多个数据块
- **THEN** 就绪判定不受数据块边界影响，仍能正确识别

## Implementation

网络栈由以下进程构成：

```
pi（Bash 工具进程，持有 stdin 写端）
 └─ unshare -Urnp --fork --kill-child=SIGTERM
     └─ node holder.js <config-base64> <mihomo> <slirp4netns> <mtu>   ← pid ns 内的 init
         ├─ slirp4netns -c --mtu=1500 --netns-type=pid <hostPid> tap0  ← egress
         └─ mihomo -config <base64>                                    ← TUN + fakeip 过滤
```

命令通过 `nsenter -U -n --preserve-credentials -t <holderPid> -- bwrap ...` 进入 holder 的 userns + netns，再叠一层 bwrap 文件沙箱。

关键机制：

- **pid namespace 内核清理**：holder（node）是 pid ns 的 init，init 以任何方式退出（含 SIGKILL）时内核自动终止 pid ns 内全部进程（slirp4netns / mihomo），userns/netns 引用随之归零——这是防僵尸 namespace 的根基，无需在每条退出路径手工清理。
- **stdin EOF 父进程死亡检测**：pi spawn 时 stdin 用 pipe，pi 持有写端；pi 崩溃（含 SIGKILL）时内核关闭 fd（进程退出必然关 fd），holder 读到 EOF 即退出，走同一套内核清理。比轮询 `kill(pid, 0)` 精确（无延迟、无 pid 复用误判），不依赖 `prctl(PR_SET_PDEATHSIG)`（node 未暴露该 API，且 PDEATHSIG 只监控直接父进程，与 `--fork` 结构不匹配）。
- **--kill-child=SIGTERM**：宿主侧 SIGTERM unshare 时转发给 init 走优雅退出；stop / 失败清理用 `readChildPids` 拿 init 的宿主 pid 做 SIGKILL 兜底（init 超时未退出时）。
- **NSpid 取宿主 pid**：pid ns 内 `/proc` 挂载是宿主的（`-Urnp` 不含 `-m`，`/proc/1` 是宿主 init 而非本 pid ns 的 init），slirp4netns 的 setns 目标必须用 `/proc/self/status` 的 NSpid 第一项（宿主视角 pid）。
- **配置 base64 直传**：mihomo 支持 `-config` 直接接收 base64 JSON，无临时文件；holder 内 `chdir("/")` 防止在宿主 cwd 意外落盘。
- **就绪检测按行匹配**：`waitForMihomoStarted` 用 `src/lib/proc.ts` 的 `forEachLine` 按 `\n` 拼行后匹配 `"Tun adapter listening"`，正确处理跨 data chunk 的行。

涉及文件：`src/bwrap/network-stack.ts`、`src/bwrap/holder.ts`（esbuild 编译为 `holder.js`）、`src/bwrap/mihomo-config.ts`、`src/lib/proc.ts`。
