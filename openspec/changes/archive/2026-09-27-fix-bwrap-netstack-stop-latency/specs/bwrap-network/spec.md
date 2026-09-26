# Spec Delta

## MODIFIED Requirements

### Requirement: 网络栈生命周期管理

网络栈（user/network namespace、egress 通道、流量过滤进程）随命令生命周期创建，并在所有退出路径下释放，不残留进程或 namespace。

**防僵尸 namespace 的机制**：network namespace 由 pid namespace 的 init 进程持有，init 以任何方式退出（包括被 SIGKILL 强制终止）时，内核自动终止该 pid namespace 内的全部进程，namespace 引用随之归零——网络栈内的进程无需在每条退出路径手工清理。宿主（pi）进程崩溃时，内核关闭宿主持有的 stdin 管道写端（进程退出必然关闭 fd），holder 读到 EOF 即退出，走同一套内核清理。因此网络栈的 namespace 泄漏被系统性杜绝，而非依赖调用方记得清理。

**停止信号的约束**：持有 network namespace 的包装进程（`unshare`）会永久阻塞 SIGINT/SIGTERM，停止网络栈 MUST NOT 依赖它响应这类信号，也 MUST NOT 为此设置固定等待超时；应以不可被阻塞或忽略的信号终止包装进程，由包装进程把终止传递给 pid namespace 的 init，再由 init 优雅停止过滤进程。

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
