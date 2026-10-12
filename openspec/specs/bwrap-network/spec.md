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

### Requirement: 网络栈生命周期管理

网络栈（user/network namespace、egress 通道、流量过滤进程）随命令生命周期创建，并在所有退出路径下释放，不残留进程或 namespace。

**防僵尸 namespace 的机制**：network namespace 由 pid namespace 的 init 进程持有，init 以任何方式退出（包括被 SIGKILL 强制终止）时，内核自动终止该 pid namespace 内的全部进程，namespace 引用随之归零——网络栈内的进程无需在每条退出路径手工清理。宿主（pi）进程崩溃时，内核关闭宿主持有的 stdin 管道写端（进程退出必然关闭 fd），holder 读到 EOF 即退出，走同一套内核清理。因此网络栈的 namespace 泄漏被系统性杜绝，而非依赖调用方记得清理。

**停止信号的约束**：持有 network namespace 的包装进程（`unshare`）会永久阻塞 SIGINT/SIGTERM，停止网络栈 MUST NOT 依赖它响应这类信号，也 MUST NOT 为此设置固定等待超时；应以不可被阻塞或忽略的信号终止包装进程，由包装进程把终止传递给 pid namespace 的 init，再由 init 优雅停止过滤进程。

**终止通道的约束**：终止网络栈 MUST 优先使用不依赖 pid 的通道——关闭 holder 的 stdin 写端触发其自我退出（内核随之清理 pid namespace），slirp4netns 由 exit-fd HUP 自行退出。MUST NOT 把「先检查子进程是否已退出、再按 pid（或子进程句柄）发信号」当作常规终止手段：检查与发信号之间不是原子的，子进程可能在检查通过后退出、其 pid 被内核复用，信号会落到无关进程上（Node 的子进程句柄同样最终按 pid 调用 `kill(2)`，无法消除该窗口）。等待子进程退出 MUST 基于子进程状态或事件，MUST NOT 用 `kill(pid, 0)` 轮询判活。仅在 fd 通道超时（进程卡死）时才允许用子进程句柄强杀作为兜底，兜底路径的残余风险 MUST 在实现中注明。

**停栈的幂等与兜底注销**：停止网络栈 MUST 幂等——重复调用不得重复终止。用于「调用方忘记停栈」的 GC 兜底 MUST 在正常停栈时注销，且该兜底 MUST 只走 fd 通道：对象被回收时记下的 pid 可能早已被内核复用给无关进程，兜底路径 MUST NOT 按 pid 发信号。

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
- **THEN** 网络栈在毫秒级自动清理（stdin EOF 触发 holder 退出 → 内核清 pid namespace），namespace 不泄漏

#### Scenario: 网络栈可重复创建

- **WHEN** 连续多次执行沙箱命令
- **THEN** 每次命令的网络栈独立创建与销毁，前后无进程或 namespace 累积

#### Scenario: 重复停栈不重复终止

- **WHEN** 调用方对同一网络栈重复调用停止方法
- **THEN** 第二次调用直接返回，不做任何重复终止

#### Scenario: 常规停栈不按 pid 发信号

- **WHEN** 调用方停止网络栈，且各进程正常存活（未卡死）
- **THEN** 停栈只关闭 fd 通道让进程自行退出，不向任何 pid 发送信号

#### Scenario: 停栈后兜底已注销

- **WHEN** 网络栈正常停止后，其句柄对象被回收
- **THEN** GC 兜底不再触发任何终止（它只关闭 fd 通道，且已注销），临时目录与正常停栈时一致地已删除

#### Scenario: 子进程已自行退出时不再发信号

- **WHEN** 承载网络栈的子进程在调用方停止它之前已自行退出（例如过滤进程崩溃）
- **THEN** 停栈不对该 pid 发信号，仅做收尾

### Requirement: 运行期失败诊断留档

网络栈在命令运行期间异常终止时（承载进程在调用方停止它之前已自行退出），MUST 把已收集的子进程输出与失败原因落盘，并把日志路径交给调用方；该命令以失败结束时，调用方 MUST 把日志路径呈现给用户。正常停栈 MUST NOT 产生这类日志。

#### Scenario: 运行期异常退出留档

- **WHEN** 命令运行期间过滤进程或 holder 崩溃，holder 在调用方停栈前已退出
- **THEN** 已收集的子进程输出与退出状态落盘为日志文件，停栈结果里带有该路径

#### Scenario: 命令失败时用户能看到日志路径

- **WHEN** 网络栈在运行期间异常退出且该命令以失败结束
- **THEN** 呈现给用户的错误信息里带有网络栈日志的路径

#### Scenario: 正常停栈不落盘

- **WHEN** 命令正常结束、调用方主动停止网络栈
- **THEN** 不产生网络栈日志文件，停栈结果里没有日志路径

### Requirement: 临时工作目录不残留

网络栈启动时为流量过滤进程创建独立的工作目录（每次启动一个，避免并发实例争抢同一份锁文件）。该目录 MUST 在网络栈正常停止时删除；启动失败时 MUST NOT 删除——失败路径本就要落盘诊断日志（holder / slirp 输出与错误本身），工作目录属于同一批现场材料，保留以便事后排查。目录内容只是过滤进程的运行时缓存，删除失败不影响命令结果。

#### Scenario: 命令结束后目录被删除

- **WHEN** 沙箱命令完成、调用方停止网络栈
- **THEN** 本次启动创建的临时工作目录已不存在

#### Scenario: 启动失败保留现场

- **WHEN** 网络栈启动过程中任一组件失败
- **THEN** 本次创建的临时工作目录被保留（与落盘的诊断日志一起供排查），不被清理

#### Scenario: 多次执行不累积目录

- **WHEN** 连续多次执行沙箱命令
- **THEN** 每次命令各自创建并在结束时删除自己的临时工作目录，成功路径不在磁盘上累积

#### Scenario: 删除失败不改变命令结果

- **WHEN** 临时工作目录删除失败（如被其他进程占用、权限变化）
- **THEN** 停栈仍然成功返回，命令结果不受影响

### Requirement: 配置无落盘传递

网络过滤配置直接传入过滤进程，不经过文件系统中转。

#### Scenario: 配置编码直传

- **WHEN** 网络栈启动
- **THEN** 过滤配置以 base64 编码直接传给过滤进程，文件系统中不产生临时配置文件

### Requirement: 就绪检测

过滤进程完成网络接管后命令才开始执行。

**egress 接口的就绪前提**：网络栈的 egress 接口（tap0）由宿主侧的 egress 进程创建，过滤进程的出站绑定在该接口上。接口未就绪时 MUST NOT 启动过滤进程：等待接口就绪 MUST 有明确的失败路径，未就绪时 MUST 立即以带原因的失败结束，使调用方在秒级内看到真实原因（egress 进程未能创建接口），而不是过滤进程的就绪超时。

#### Scenario: 就绪后执行命令

- **WHEN** 网络栈启动
- **THEN** 等待过滤进程就绪（TUN 接管完成）后才执行沙箱命令；过滤进程提前退出则命令失败

#### Scenario: 就绪日志跨数据块

- **WHEN** 过滤进程的就绪日志单行被输出流切分为多个数据块
- **THEN** 就绪判定不受数据块边界影响，仍能正确识别

#### Scenario: egress 接口未就绪时立即失败

- **WHEN** egress 进程未能在超时内创建 tap0（版本、参数或权限问题）
- **THEN** holder 立即以非零码退出并输出原因，调用方在秒级内看到「接口未创建」类的失败，而不是等待过滤进程就绪超时

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

网络栈由以下进程构成：

```
pi（Bash 工具进程，持有 stdin 写端）
 ├─ unshare -Urnp --fork --kill-child=SIGTERM          ← 包装进程，永久阻塞 SIGINT/SIGTERM
 │   └─ node holder.js <config-base64> <mihomo> <mtu> <mihomo-home>   ← pid ns 内的 init
 │       └─ mihomo -d <mihomo-home> -config <base64>   ← TUN + 白名单 fakeip + DNS 层拒绝
 └─ slirp4netns -c --mtu=1500 --userns-path=/proc/<holderPid>/ns/user \
       --netns-type=pid <holderPid> tap0 -e 3          ← egress（宿主 netns），fd 3 是 exit-fd 读端
```

命令通过 `nsenter -U -n --preserve-credentials -t <holderPid> -- bwrap ...` 进入 holder 的 userns + netns，再叠一层 bwrap 文件沙箱。这条命令行由执行层（`src/bwrap/exec.ts`）组装：网络栈对外只提供 holder pid 与停止，不参与 bwrap 参数怎么拼。

关键机制：

- **pid namespace 内核清理**：holder（node）是 pid ns 的 init，init 以任何方式退出（含 SIGKILL）时内核自动终止 pid ns 内全部进程（mihomo），userns/netns 引用随之归零——这是防僵尸 namespace 的根基，无需在每条退出路径手工清理。slirp4netns 不在该 pid ns 内（它必须在宿主 netns 启动才能让出站走宿主视角），不受这套内核清理覆盖，靠 exit-fd 与 holder 绑定生命周期。
- **stdin EOF 父进程死亡检测**：pi spawn 时 stdin 用 pipe，pi 持有写端；pi 崩溃（含 SIGKILL）时内核关闭 fd（进程退出必然关 fd），holder 读到 EOF 即退出，走同一套内核清理。比轮询 `kill(pid, 0)` 精确（无延迟、无 pid 复用误判），也不依赖 `prctl(PR_SET_PDEATHSIG)`（node 未暴露该 API；且 PDEATHSIG 只监控直接父进程，而 holder 的直接父进程是 unshare 而非 pi）。
- **停止信号**：holder 是 `unshare` 包装进程，util-linux 的 unshare 在 fork 前 `sigprocmask(SIG_BLOCK, {SIGINT, SIGTERM})` 且只在子进程里恢复掩码，父进程永久阻塞这两个信号——发给它的 SIGTERM 只会 pending 永不投递。停止网络栈必须对其用 SIGKILL（不可阻塞），unshare 立即退出后 init 经 `--kill-child=SIGTERM` 的 PDEATHSIG 收到 SIGTERM，优雅停 mihomo 后退出。
- **--kill-child=SIGTERM**：语义是「unshare 死亡时子进程收到 SIGTERM」（util-linux 在 fork 出的子进程里 `prctl(PR_SET_PDEATHSIG, SIGTERM)`，并用 pidfd 处理 fork 后父进程已死的竞态），不是信号转发；stop / 失败清理用 `readChildPids` 拿 init 的宿主 pid 做 SIGKILL 兜底（PDEATHSIG 未生效时）。
- **NSpid 取宿主 pid**：pid ns 内 `/proc` 挂载是宿主的（`-Urnp` 不含 `-m`，`/proc/1` 是宿主 init 而非本 pid ns 的 init），slirp4netns 的 setns 目标必须用 `/proc/self/status` 的 NSpid 第一项（宿主视角 pid）。
- **配置 base64 直传**：mihomo 支持 `-config` 直接接收 base64 JSON，无临时文件；holder 内 `chdir("/")` 防止在宿主 cwd 意外落盘。
- **就绪检测按行匹配**：`waitForMihomoStarted` 用 `src/lib/proc.ts` 的 `forEachLine` 按 `\n` 拼行后匹配 `"Tun adapter listening"`，正确处理跨 data chunk 的行。
- **DNS 两条入口**：宿主 `resolv.conf` 指向 loopback stub（systemd-resolved 的 `127.0.0.53`）时，这类查询不出网络设备、进不了 TUN，过滤进程因此额外监听本机地址的 53（`listen: 0.0.0.0:53`）。上游 MUST NOT 用 loopback（netns 内它指向网络栈自身，会把域名解析回 fake IP 成环）：候选值排除 loopback 与 IPv6，全被排除时依次回退到 systemd-resolved 维护的真实上游列表、egress 通道自带的解析器（`10.0.2.3`，在宿主侧解析）。
- **白名单 fakeip**：`fake-ip-filter-mode: whitelist` + `fake-ip-filter`（allowlist 的域名条目）——只有 allowlist 域名拿 fake IP，因此连接到达时能靠「fake IP ↔ 域名」一一对应的映射精确还原域名（不依赖嗅探、不受 DNS TTL 影响）；未命中白名单的域名落到 `nameserver`。
- **DNS 层拒绝**：`nameserver` 设为伪服务器 `rcode://name_error`，未允许域名即时拿到 NXDOMAIN（客户端报 `Could not resolve host`），不查上游、不等超时。mihomo 的 fakeip 分支没有按域名拒绝的钩子，收窄白名单是把拒绝做到 DNS 层的唯一途径；`dns.rules` 不是 mihomo 的字段（会被静默忽略），不要用它表达 DNS 策略。
- **DIRECT 出站解析**：`direct-nameserver` 指向配置的真实 DNS——连接由 fake IP 还原成域名后 DIRECT 要按域名重新解析，不指定会解析回 fake-ip 再进 TUN 成环。
- **条目匹配两档**：裸域名条目在 DNS 侧写裸域名、连接层写 `DOMAIN,<host>`（只匹配该域名）；`*.` 条目在 DNS 侧写 `.example.com`（trie 的 dot-wildcard）、连接层写 `DOMAIN-WILDCARD,*.example.com`（glob 的 `*` 跨点），两者都是「任意深度子域名、不含 apex」。两层由同一个条目生成，保证 DNS 白名单与连接层规则表达同一集合；带端口条目在连接层用 `AND,(<域名规则>),(DST-PORT,<port>,DIRECT),DIRECT` 组合。

- **终止走 fd 通道**：停栈不按 pid 发信号，而是关闭 holder 的 stdin 写端——holder 读到 EOF 退出（`holder.ts` 的 stdin 监听），内核清理其 pid namespace（mihomo 随之消失），unshare waitpid 后退出，holder 持有的 exit-fd 写端关闭，slirp4netns 收到 HUP 自行退出。检查「子进程是否已退出」再发信号不是原子的（Node 的子进程 kill 最终按 pid 调 `kill(2)`），因此只作兜底：`waitForChildExit` 超时（进程卡死）才用句柄强杀，残余窗口在 `killChild` 注释里注明；等待退出用 `exit` 事件 + `AbortSignal.timeout`，不用 `kill(pid, 0)` 轮询。GC 兜底同样只关 fd（`FinalizationRegistry` 回调里不能 await，也绝不按 pid 发信号），正常停栈会注销它。
- **运行期异常退出的留档**：holder 把 mihomo 的退出码作为自己的退出码；`stop()` 在关 fd 之前发现 holder 已自行退出即记 `exitedEarly`，此时把缓冲的 holder/slirp 输出落盘为 `agent-dir/tmp/bwrap-netstack-*.log`，路径经 `SandboxRunResult.networkStackLog` 交给调用方，运行时层把它附进 `sandboxHint`。
- **egress 接口 fail fast**：holder 等 tap0 满 10 秒未出现时打印 `slirp4netns did not create tap0 within 10s` 并以退出码 1 退出，宿主侧的 exit 监听立即把它变成一条可诊断的启动失败，不再呈现为过滤进程就绪超时。

涉及文件：`src/bwrap/network-stack.ts`、`src/bwrap/holder.ts`（esbuild 编译为 `holder.js`）、`src/bwrap/mihomo-config.ts`、`src/lib/proc.ts`；命令经 netns 执行的前缀由 `src/bwrap/exec.ts` 组装。
