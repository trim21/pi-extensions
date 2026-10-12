# bwrap-network Specification

## Purpose

`network: "limited"` 模式下，Bash 工具的命令运行在独立的 user/network namespace 中：仅 `network.allowlist` 内的网络目标可直连，其余流量在 DNS 层与连接层双重拒绝（deny-by-default）。网络栈的 namespace 生命周期与命令绑定，任何退出路径（正常结束、启动失败、宿主崩溃）下都能释放，不产生僵尸 namespace。

## Requirements

### Requirement: allowlist 网络访问控制

沙箱内命令只能访问配置允许的网络目标（域名 / IP / CIDR，可带端口），其余一律拒绝。

**条目匹配语义**：域名条目分两档——裸域名（`example.com`）MUST 精确匹配该域名本身，不匹配其子域名；`*.` 前缀（`*.example.com`）MUST 匹配该域名的全部子域名（任意深度），MUST NOT 匹配 apex 本身。需要同时放行 apex 与子域名时 MUST 单列两条。端口后缀（`example.com:443`、`*.example.com:443`）MUST 只约束连接层端口，不改变域名匹配语义。含通配的条目 MUST 通过语法校验：`*` 必须占据最左且完整的标签，`*` 单独出现、出现在中间标签、与非空标签拼接（`*example.com`）或用于 IP 条目时 MUST 报配置错误。

**双重拒绝**：未允许的域名在 **DNS 层**即被拒绝——DNS 查询直接失败（表现为 `Could not resolve host`），进程拿不到可连接的地址，效果等同于"该进程没有网络"；即使绕过 DNS（直连 IP），未允许的 IP/端口也会在连接层被拒绝。

**拒绝语义**：未允许域名的解析 MUST 立即失败（不依赖上游超时，也不返回 fakeip 等占位地址）；allowlist 域名的解析 MUST 走配置的 DNS 服务器。连接层 MUST 保留兜底拒绝，覆盖裸 IP 连接与自行解析（如 DoH、内置解析器）的客户端。DNS 白名单与连接层规则 MUST 由同一条目生成等价的目标集合。

#### Scenario: allowlist 域名可直连

- **WHEN** 沙箱内命令访问 allowlist 中的域名
- **THEN** 该域名正常解析且连接成功

#### Scenario: 裸域名精确匹配

- **WHEN** allowlist 含 `example.com`，沙箱内命令访问 `example.com`
- **THEN** 放行；访问 `www.example.com` 或 `a.b.example.com` 时被拒（解析失败，不返回可连接地址）

#### Scenario: 通配条目匹配子域名

- **WHEN** allowlist 含 `*.example.com`，沙箱内命令访问 `www.example.com` 或 `a.b.example.com`
- **THEN** 正常解析且连接成功；访问 `example.com` 本身时被拒

#### Scenario: 通配条目不误伤同后缀域名

- **WHEN** allowlist 含 `*.example.com`，沙箱内命令访问 `notexample.com`
- **THEN** 被拒（匹配按标签边界，不按字符串后缀）

#### Scenario: 未允许域名解析失败

- **WHEN** 沙箱内命令解析不在 allowlist 中的域名
- **THEN** 解析直接失败，不返回可连接的地址（而非连接阶段才报错）

#### Scenario: 未允许域名解析立即失败

- **WHEN** 沙箱内命令解析不在 allowlist 中的域名
- **THEN** 解析在毫秒级失败，不等待上游 DNS 超时；失败原因是解析被拒（NXDOMAIN / 拒绝），不是不可达

#### Scenario: 未允许目标在连接层被拒绝

- **WHEN** 沙箱内命令连接不在 allowlist 中的 IP 或端口
- **THEN** 连接被拒绝

#### Scenario: 带端口的条目精确放行

- **WHEN** allowlist 条目携带端口（如 `example.com:443` 或 `*.example.com:443`）
- **THEN** 仅该域名集合与端口的组合放行，其余端口拒绝

#### Scenario: 通配语法非法时报错

- **WHEN** allowlist 出现 `*`、`*example.com`、`a.*.example.com`、`*.1.2.3.4` 这类条目
- **THEN** 配置校验失败并提示合法写法（`*.` 必须是完整的、位于最左的标签，且只用于域名）

#### Scenario: IPv6 条目要求方括号

- **WHEN** allowlist 条目包含裸 IPv6 地址（未用 `[]` 包裹）
- **THEN** 配置校验失败并提示用方括号包裹

### Requirement: allowlist 的 IP 条目解析

allowlist 里的 IP / CIDR 条目 MUST 经真实地址解析来判定，MUST NOT 按字符形态（正则）判定：形态像 IP 但解析不过的条目 MUST 报配置错误，MUST NOT 被当成合法地址，也 MUST NOT 降级成域名。

#### Scenario: 非法 IP 字面量报错

- **WHEN** allowlist 出现 `999.999.999.999`、`1.2.3.4.5`、`10.0.0.0/33` 这类条目
- **THEN** 配置校验失败，并指出该条目不是合法的 IP 地址或 IP 段

#### Scenario: 合法 IP 与 CIDR 照常接受

- **WHEN** allowlist 出现 `1.2.3.4`、`10.0.0.0/8`、`[::1]`、`[2001:db8::/32]`
- **THEN** 解析成功，并分别生成 IPv4 / IPv6 的连接层规则

### Requirement: 网络栈生命周期管理

网络栈（user/network namespace、egress 通道、流量过滤进程）随命令生命周期创建，并在所有退出路径下释放，不残留进程或 namespace。

**职责边界**：TS 调用方只描述能力（配置解析与校验、fs 挂载计划、审批、策略序列化、输出截断与诊断呈现）；挂载计划到 bwrap 参数的翻译、namespace 创建、网络栈拉起、进程身份与终止、内核级清理由原生执行器负责。

**防僵尸 namespace 的机制**：network namespace 由 pid namespace 的 init（执行器自身）持有，init 以任何方式退出（包括被 SIGKILL 强制终止）时，内核自动终止该 pid namespace 内的全部进程，namespace 引用随之归零——网络栈内的进程无需在每条退出路径手工清理。调用方进程崩溃时，内核关闭宿主持有的执行器 stdin 管道写端（进程退出必然关闭 fd），执行器读到 EOF 即退出，走同一套内核清理。因此网络栈的 namespace 泄漏被系统性杜绝，而非依赖调用方记得清理。

**pid namespace 内的 /proc MUST 是新挂载的 procfs**：执行器作为 pid namespace 的 init，MUST 先把本 mount namespace 的挂载传播设为 private，再挂载新的 procfs——宿主 `/proc` 没有本 pid namespace 的进程视角（`/proc/self` 之类路径会指错），bwrap 这类靠 `/proc/<pid>/ns/*` 操作 namespace 的程序会因此失败；private 传播同时保证新挂载点不会顶掉宿主的 `/proc`。

**终止经进程身份而非 pid**：终止执行器及其子进程 MUST 通过内核持有的进程引用（pidfd）发送信号，MUST NOT 依赖「先检查进程是否已退出、再按 pid 发信号」——检查与发信号之间不是原子的，pid 可能已被内核复用给无关进程。等待退出 MUST 基于进程状态或事件，MUST NOT 用 `kill(pid, 0)` 轮询判活。内核不提供该能力时执行器 MUST 在启动阶段明确失败，MUST NOT 退回到按 pid 发信号。

**终止通道的优先级**：结束一次执行 MUST 优先使用不依赖 pid 的通道——关闭执行器 stdin 触发其自我退出（内核随之清理 pid namespace），slirp4netns 由 exit-fd HUP 自行退出。仅在 fd 通道超时（进程卡死）时才允许对执行器进程强杀作为兜底，兜底路径的残余风险 MUST 在实现中注明。

**停栈幂等**：结束一次执行（正常结束、超时或取消）MUST 幂等——重复触发不得重复终止。

#### Scenario: 命令正常结束

- **WHEN** 沙箱命令完成
- **THEN** 网络栈停止，namespace 引用归零

#### Scenario: 停栈即时完成

- **WHEN** 沙箱命令完成、调用方停止网络栈
- **THEN** 网络栈内各进程在毫秒级退出（1 秒内全部消失），不出现固定 2 秒级的等待

#### Scenario: 网络栈启动失败

- **WHEN** 网络栈启动过程中任一组件失败
- **THEN** 已启动的进程被清理，不残留进程或 namespace；清理同样不等待固定超时

#### Scenario: 宿主进程被强制终止

- **WHEN** 运行沙箱的宿主进程被 SIGKILL 或以其他方式崩溃
- **THEN** 网络栈在毫秒级自动清理（stdin EOF 触发执行器退出 → 内核清 pid namespace），namespace 不泄漏

#### Scenario: 网络栈可重复创建

- **WHEN** 连续多次执行沙箱命令
- **THEN** 每次命令的网络栈独立创建与销毁，前后无进程或 namespace 累积

#### Scenario: 重复停栈不重复终止

- **WHEN** 调用方对同一网络栈重复调用停止方法
- **THEN** 第二次调用直接返回，不做任何重复终止

#### Scenario: 常规停栈不按 pid 发信号

- **WHEN** 调用方停止网络栈，且各进程正常存活（未卡死）
- **THEN** 停栈只关闭 fd 通道让进程自行退出，不向任何 pid 发送信号

#### Scenario: 子进程已自行退出时不再发信号

- **WHEN** 承载网络栈的子进程在调用方停止它之前已自行退出（例如过滤进程崩溃）
- **THEN** 停栈不对该 pid 发信号，仅做收尾

#### Scenario: 终止只作用于本次执行的进程

- **WHEN** 需要终止某次执行（超时或取消）
- **THEN** 信号只发给本次执行器持有的进程引用，不会落到同 pid 的其他进程上

#### Scenario: 内核不支持 pidfd 时明确失败

- **WHEN** 内核不提供 pidfd（低于 Linux 5.3）
- **THEN** 执行器在启动阶段以明确错误结束，调用方看到「内核不支持」类的提示，而不是静默退回到按 pid 发信号

### Requirement: 运行期失败诊断留档

网络栈在命令运行期间异常终止时（执行器在命令结束前退出），MUST 把已收集的诊断输出与失败状态交给调用方；该命令以失败结束时，调用方 MUST 把诊断落盘并把路径呈现给用户。正常结束 MUST NOT 产生这类日志。

#### Scenario: 运行期异常退出留档

- **WHEN** 命令运行期间过滤进程或执行器崩溃、执行器在命令结束前退出
- **THEN** 已收集的诊断输出与退出状态落盘为日志文件，调用方拿到该路径

#### Scenario: 命令失败时用户能看到日志路径

- **WHEN** 网络栈在运行期间异常退出且该命令以失败结束
- **THEN** 呈现给用户的错误信息里带有诊断日志的路径

#### Scenario: 正常结束不落盘

- **WHEN** 命令正常结束
- **THEN** 不产生这类诊断日志文件

### Requirement: 配置无落盘传递

网络过滤配置直接传入过滤进程，不经过文件系统中转。

#### Scenario: 配置编码直传

- **WHEN** 网络栈启动
- **THEN** 过滤配置以 base64 编码直接传给过滤进程，文件系统中不产生临时配置文件

### Requirement: 就绪检测

过滤进程完成网络接管后命令才开始执行。

**egress 接口的就绪前提**：网络栈的 egress 接口（tap0）由宿主侧的 egress 进程创建，过滤进程的出站绑定在该接口上。接口未就绪时 MUST NOT 启动过滤进程：等待接口就绪 MUST 有明确的失败路径，未就绪时 MUST 以带原因的失败结束，使调用方在秒级内看到真实原因（egress 进程未能创建接口），而不是过滤进程的就绪超时。

**就绪信号由执行器给出**：执行器自己判定过滤进程是否完成接管，并给出内部就绪信号。MUST NOT 靠匹配过滤进程的日志文案来判定就绪——那会把就绪判定绑死在第三方程序的日志格式上，升级即失效。

#### Scenario: 就绪后执行命令

- **WHEN** 网络栈启动
- **THEN** 等待过滤进程就绪（TUN 接管完成）后才执行沙箱命令；过滤进程提前退出则这次执行失败

#### Scenario: egress 接口未就绪时立即失败

- **WHEN** egress 进程未能在超时内创建 tap0（版本、参数或权限问题）
- **THEN** 执行器立即以非零码结束并输出原因，调用方在秒级内看到「接口未创建」类的失败，而不是等待过滤进程就绪超时

#### Scenario: 就绪判定不依赖过滤进程日志文案

- **WHEN** 过滤进程升级后改变了日志文案或日志级别
- **THEN** 就绪判定不受影响，网络栈照常可用

### Requirement: 受限网络模式下的沙箱内 DNS

`network: limited` 时，宿主 `/etc/resolv.conf` 里配置的 nameserver 查询 MUST 由网络栈处理：白名单域名 MUST 得到网络栈分配的地址，未允许域名 MUST 在 DNS 层被拒，解析结果 MUST 与连接层规则来自同一条目。

**MUST 覆盖 loopback 形式的解析器**：宿主使用 stub 解析器（如 systemd-resolved 的 `127.0.0.53`）时，发往这类本机地址的查询 MUST 同样由网络栈处理。

**MUST NOT 把 loopback 当作上游**：宿主 `resolv.conf` 里的 loopback 地址在沙箱内指向网络栈自身，MUST NOT 被用作解析上游——否则域名会被解析回网络栈分配的地址，出站连接因此超时。这类地址 MUST 被排除；全部被排除时 MUST 依次回退到宿主系统解析器维护的真实上游列表、egress 通道自带的解析器（它在宿主侧解析）。

该行为 MUST 只作用于受限网络模式：`block` 与 `allow-all` MUST NOT 改变沙箱内的解析行为。

#### Scenario: 宿主解析器是 loopback stub

- **WHEN** 宿主 `/etc/resolv.conf` 的 nameserver 是 loopback 地址（如 `127.0.0.53`），且宿主自身可解析外部域名
- **THEN** 沙箱内仍能解析 allowlist 域名，未允许域名仍在 DNS 层被拒

#### Scenario: 宿主只有 loopback 解析器时仍能建立连接

- **WHEN** 宿主 `/etc/resolv.conf` 只有 loopback 地址（如 `127.0.0.53`）
- **THEN** 沙箱内访问 allowlist 域名能真正连上（而不是解析成网络栈分配的地址后连接超时），未允许域名仍被拒

#### Scenario: 沙箱内的解析配置保持宿主原样

- **WHEN** 受限网络模式启动沙箱
- **THEN** 沙箱内 `/etc/resolv.conf` 与宿主一致，不被改写

#### Scenario: 非受限模式不改变解析行为

- **WHEN** 网络模式是 `block` 或 `allow-all`
- **THEN** 沙箱内的解析行为与宿主一致

### Requirement: 受限网络模式下的沙箱内 DNS

`network: limited` 时，宿主 `/etc/resolv.conf` 里配置的 nameserver 查询 MUST 由网络栈处理：白名单域名 MUST 得到网络栈分配的地址，未允许域名 MUST 在 DNS 层被拒，解析结果 MUST 与连接层规则来自同一条目。

**MUST 覆盖 loopback 形式的解析器**：宿主使用 stub 解析器（如 systemd-resolved 的 `127.0.0.53`）时，发往这类本机地址的查询 MUST 同样由网络栈处理。

**MUST NOT 把 loopback 当作上游**：宿主 `resolv.conf` 里的 loopback 地址在沙箱内指向网络栈自身，MUST NOT 被用作解析上游——否则域名会被解析回网络栈分配的地址，出站连接因此超时。这类地址 MUST 被排除；全部被排除时 MUST 依次回退到宿主系统解析器维护的真实上游列表、egress 通道自带的解析器（它在宿主侧解析）。

该行为 MUST 只作用于受限网络模式：`block` 与 `allow-all` MUST NOT 改变沙箱内的解析行为。

#### Scenario: 宿主解析器是 loopback stub

- **WHEN** 宿主 `/etc/resolv.conf` 的 nameserver 是 loopback 地址（如 `127.0.0.53`），且宿主自身可解析外部域名
- **THEN** 沙箱内仍能解析 allowlist 域名，未允许域名仍在 DNS 层被拒

#### Scenario: 宿主只有 loopback 解析器时仍能建立连接

- **WHEN** 宿主 `/etc/resolv.conf` 只有 loopback 地址（如 `127.0.0.53`）
- **THEN** 沙箱内访问 allowlist 域名能真正连上（而不是解析成网络栈分配的地址后连接超时），未允许域名仍被拒

#### Scenario: 沙箱内的解析配置保持宿主原样

- **WHEN** 受限网络模式启动沙箱
- **THEN** 沙箱内 `/etc/resolv.conf` 与宿主一致，不被改写

#### Scenario: 非受限模式不改变解析行为

- **WHEN** 网络模式是 `block` 或 `allow-all`
- **THEN** 沙箱内的解析行为与宿主一致

## Implementation

网络栈由**原生执行器**（`native/`，Go，单一可执行文件）构建；TS 侧只做命令级编排：配置解析与校验、挂载计划、审批、策略序列化、输出截断与诊断呈现。

```
pi（Bash 工具进程，持有执行器 stdin 写端）
 └─ sandbox run --policy-base64 <能力描述>            ← 执行器（宿主侧 supervisor）
     ├─ clone(CLONE_NEWUSER|NEWPID|NEWNS|NEWNET) → internal-init   ← pid ns 内的 PID 1
     │    ├─ 挂载传播设 private + 重挂 procfs（等价 unshare --mount-proc）
     │    ├─ mihomo -config <base64>                  ← TUN + 白名单 fakeip + DNS 层拒绝
     │    └─ bwrap … -- shell -lc <command>           ← 文件沙箱 + 命令（已在目标 netns 内）
     └─ slirp4netns（宿主 netns，fork 进 init 的 netns 提供 egress）
```

策略是**能力描述**：调用方给 `root` + 有序 `mounts`（`ro` / `ro-try` / `rw-try` / `deny-dir` / `deny-file`，路径已归一化为绝对路径）+ 网络策略 + `command` / `shell` / `cwd` / `env` + 超时，不传 bwrap 命令行；用哪些 bwrap 参数表达由执行器决定（唯一构造点），路径语义（realpath、保护目录、工作区 `.git` 只读）留在调用方。

关键机制：

- **pid namespace 内核清理**：`internal-init` 是 pid ns 的 init，它以任何方式退出（含 SIGKILL）时内核自动终止 pid ns 内全部进程（mihomo），userns/netns 引用随之归零——防僵尸 namespace 的根基，无需在每条退出路径手工清理。slirp4netns 不在该 pid ns 内（它必须在宿主 netns 启动才能让出站走宿主视角），靠 exit-fd 与 init 绑定生命周期。
- **stdin EOF 父进程死亡检测**：调用方 spawn 时 stdin 用 pipe，调用方持有写端；调用方崩溃（含 SIGKILL）时内核关闭 fd，执行器读到 EOF 即退出，走同一套内核清理。比轮询 `kill(pid, 0)` 精确（无延迟、无 pid 复用误判），也不依赖 `prctl(PR_SET_PDEATHSIG)`（它只监控直接父进程）。
- **procfs**：init 作为 pid ns 的 PID 1 必须先把本 mount namespace 的挂载传播设为 private，再重挂 procfs（`unshare --mount-proc` 的等价物）：宿主 `/proc` 没有本 pid namespace 的进程视角，bwrap 这类靠 `/proc/<pid>/ns/*` 操作 namespace 的程序会因此失败；private 传播保证新挂载点不顶掉宿主的 `/proc`。
- **终止走 pidfd**：对 init、slirp4netns、mihomo 的终止一律经 `pidfd_send_signal`，不用「先检查是否已退出、再按 pid 发信号」；pidfd 在启动子进程之后、任何等待之前打开（未 reap 的子进程仍占着 pid 号，映射唯一且稳定）；内核不支持 pidfd（低于 5.3）时启动阶段明确失败，不退回按 pid 发信号。常规结束仍优先走 fd 通道（关 stdin），强杀只作卡死兜底。
- **配置 base64 直传**：mihomo 支持 `-config` 直接接收 base64 JSON，无临时配置文件、无临时工作目录。
- **就绪判定**：init 拉起 lo → 等 tap0（10 秒未出现即 fail fast 并输出原因）→ 起 mihomo → 判定 TUN 接管完成后才执行命令；不匹配第三方程序的日志文案。
- **IP 条目校验**：IP / CIDR 条目用真实的地址解析判定，不按字符形态匹配——`999.999.999.999`、`1.2.3.4.5` 这类条目直接报配置错误，不降级成域名。
- **DNS 两条入口与上游选择**：宿主 `resolv.conf` 指向 loopback stub（systemd-resolved 的 `127.0.0.53`）时，这类查询不出网络设备、进不了 TUN，过滤进程因此额外监听本机地址的 53（`listen: 0.0.0.0:53`）。上游 MUST NOT 用 loopback（netns 内它指向网络栈自身，会把域名解析回 fake IP 成环）：候选值排除 loopback 与 IPv6，全被排除时依次回退到 systemd-resolved 维护的真实上游列表（`/run/systemd/resolve/resolv.conf`）、egress 通道自带的解析器（`10.0.2.3`，在宿主侧解析）。
- **白名单 fakeip**：`fake-ip-filter-mode: whitelist` + `fake-ip-filter`（allowlist 的域名条目）——只有 allowlist 域名拿 fake IP，因此连接到达时能靠「fake IP ↔ 域名」一一对应的映射精确还原域名（不依赖嗅探、不受 DNS TTL 影响）；未命中白名单的域名落到 `nameserver`。
- **DNS 层拒绝**：`nameserver` 设为伪服务器 `rcode://name_error`，未允许域名即时拿到 NXDOMAIN（客户端报 `Could not resolve host`），不查上游、不等超时。mihomo 的 fakeip 分支没有按域名拒绝的钩子，收窄白名单是把拒绝做到 DNS 层的唯一途径；`dns.rules` 不是 mihomo 的字段（会被静默忽略），不要用它表达 DNS 策略。
- **DIRECT 出站解析**：`direct-nameserver` 指向配置的真实 DNS——连接由 fake IP 还原成域名后 DIRECT 要按域名重新解析，不指定会解析回 fake-ip 再进 TUN 成环。
- **条目匹配两档**：裸域名条目在 DNS 侧写裸域名、连接层写 `DOMAIN,<host>`（只匹配该域名）；`*.` 条目在 DNS 侧写 `.example.com`（trie 的 dot-wildcard）、连接层写 `DOMAIN-WILDCARD,*.example.com`（glob 的 `*` 跨点），两者都是「任意深度子域名、不含 apex」。两层由同一个条目生成，保证 DNS 白名单与连接层规则表达同一集合；带端口条目在连接层用 `AND,(<域名规则>),(DST-PORT,<port>,DIRECT),DIRECT` 组合；IPv6 条目的连接层规则用 `IP-CIDR6`，IPv4 用 `IP-CIDR`。
- **失败诊断留档**：执行器在命令结束前异常退出（启动失败 125、内部错误 2、被信号杀死）时把诊断写到 stderr；调用方把诊断落盘到 agent 目录的 tmp 下，并把路径附进错误信息——正常结束不落盘。
- **二进制分发**：Go 源码随仓库（不进 npm 包），交叉编译产物 `bin/native/linux-{x64,arm64}/sandbox` 随包分发，与 TS 包同版本发布。

涉及文件：执行器 `native/{main.go,init.go,bwrap.go,mihomo.go,policy.go,pidfd.go}`（argv 构造只在 `bwrap.go`）；调用方 `src/bwrap/{executor.ts,sandbox.ts,core.ts,runtime.ts}` 与 `bin/sandbox.ts`。
