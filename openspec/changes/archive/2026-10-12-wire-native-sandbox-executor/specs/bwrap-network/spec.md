# Spec Delta

## ADDED Requirements

### Requirement: allowlist 的 IP 条目解析

allowlist 里的 IP / CIDR 条目 MUST 经真实地址解析来判定，MUST NOT 按字符形态（正则）判定：形态像 IP 但解析不过的条目 MUST 报配置错误，MUST NOT 被当成合法地址，也 MUST NOT 降级成域名。

#### Scenario: 非法 IP 字面量报错

- **WHEN** allowlist 出现 `999.999.999.999`、`1.2.3.4.5`、`10.0.0.0/33` 这类条目
- **THEN** 配置校验失败，并指出该条目不是合法的 IP 地址或 IP 段

#### Scenario: 合法 IP 与 CIDR 照常接受

- **WHEN** allowlist 出现 `1.2.3.4`、`10.0.0.0/8`、`[::1]`、`[2001:db8::/32]`
- **THEN** 解析成功，并分别生成 IPv4 / IPv6 的连接层规则

## REMOVED Requirements

### Requirement: 临时工作目录不残留

**Reason**: 原生执行器把过滤配置以 base64 直接传给 mihomo（`-config`），启动过程中不再创建临时工作目录，该 requirement 描述的对象已不存在。

**Migration**: 无需迁移。失败现场由「运行期失败诊断留档」落盘的日志承担，不再有需要删除的目录。

## MODIFIED Requirements

### Requirement: 网络栈生命周期管理

网络栈（user/pid/mount/net namespace、egress 通道、流量过滤进程）由**原生执行器**持有：调用方每次要求执行一条命令时创建，随该次执行结束释放，所有退出路径都不残留进程或 namespace。

**职责边界**：TS 调用方只描述能力（配置解析与校验、fs 挂载计划、审批、策略序列化、输出截断与诊断呈现）；挂载计划到 bwrap 参数的翻译、namespace 创建、网络栈拉起、进程身份与终止、内核级清理由原生执行器负责。

**防僵尸 namespace 的机制**：network namespace 由 pid namespace 的 init（执行器自身）持有，init 以任何方式退出（包括被 SIGKILL 强制终止）时内核自动终止该 pid namespace 内的全部进程，namespace 引用随之归零。调用方进程崩溃时，内核关闭它持有的执行器 stdin 管道写端，执行器读到 EOF 即退出，走同一套内核清理。

**pid namespace 内的 /proc MUST 是新挂载的 procfs**：执行器作为 pid namespace 的 init，MUST 先把本 mount namespace 的挂载传播设为 private，再挂载新的 procfs——宿主 `/proc` 没有本 pid namespace 的进程视角（`/proc/self` 之类路径会指错），bwrap 这类靠 `/proc/<pid>/ns/*` 操作 namespace 的程序会因此失败；private 传播同时保证新挂载点不会顶掉宿主的 `/proc`。

**终止经进程身份而非 pid**：终止执行器及其子进程 MUST 通过内核持有的进程引用（pidfd）发送信号，MUST NOT 依赖「先检查进程是否已退出、再按 pid 发信号」——检查与发信号之间不是原子的，pid 可能已被内核复用给无关进程。等待退出 MUST 基于进程状态或事件，MUST NOT 用 `kill(pid, 0)` 轮询判活。内核不提供该能力时执行器 MUST 在启动阶段明确失败，MUST NOT 退回到按 pid 发信号。

#### Scenario: 命令正常结束

- **WHEN** 沙箱命令完成
- **THEN** 网络栈停止，namespace 引用归零

#### Scenario: 停栈即时完成

- **WHEN** 沙箱命令完成、调用方结束本次执行
- **THEN** 网络栈内各进程在毫秒级退出（1 秒内全部消失），不出现固定 2 秒级的等待

#### Scenario: 网络栈启动失败

- **WHEN** 网络栈启动过程中任一组件失败
- **THEN** 已启动的进程被清理，不残留进程或 namespace；执行器以区分的退出码结束并输出失败原因，调用方在错误信息里带上该诊断

#### Scenario: 宿主进程被强制终止

- **WHEN** 运行沙箱的宿主进程被 SIGKILL 或以其他方式崩溃
- **THEN** 网络栈在毫秒级自动清理（stdin EOF 触发执行器退出 → 内核清 pid namespace），namespace 不泄漏

#### Scenario: 网络栈可重复创建

- **WHEN** 连续多次执行沙箱命令
- **THEN** 每次命令的网络栈独立创建与销毁，前后无进程或 namespace 累积

#### Scenario: 终止只作用于本次执行的进程

- **WHEN** 需要终止某次执行的网络栈（超时或取消）
- **THEN** 信号只发给本次执行器持有的进程引用，不会落到同 pid 的其他进程上

#### Scenario: 内核不支持 pidfd 时明确失败

- **WHEN** 内核不提供 pidfd（低于 Linux 5.3）
- **THEN** 执行器在启动阶段以明确错误结束，调用方看到「内核不支持」类的提示，而不是静默退回到按 pid 发信号

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
