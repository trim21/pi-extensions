// pidfd：原型的核心差异点。
//
// Node/libuv 只能按 pid 发信号（uv_process_kill → kill(2)），"检查子进程是否已退出"
// 与"发信号"之间不是原子的，pid 被内核复用时会误伤无关进程。pidfd 是内核持有的进程
// 引用：pidfd_open 之后 pidfd_send_signal 永远打在那个进程上。
//
// 系统调用封装用 golang.org/x/sys/unix（Go 标准库的 syscall 包不导出这两个调用）。
// 等待退出不需要 pidfd：exec.Cmd.Wait 作用于自己的子进程，本身就精确。
package main

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// pidfd 是内核持有的进程引用；Close 只释放我们的引用，不会影响进程本身。
type pidfd struct {
	fd int
}

// pidfdOpen 只应在「自己刚 spawn 的子进程」上调用，且必须在任何 Wait/reap 之前：
//
//	pidfd_open 是按 pid 查进程，本身有 TOCTOU——但对尚未收尸的子进程是精确的：
//	内核只在 task 完全释放时才归还 pid 号，处于僵尸态的子进程仍然占着号，因此
//	此刻的「号码 → 进程」映射唯一且稳定（实测：未 reap 的子进程 State=Z 时
//	pidfd_open 成功；Wait4 收尸后再 open 返回 ESRCH，若号码已被复用则会打开别人）。
//
// 已收过尸的 pid、或不是自己 spawn 的 pid 都不能这样用。
func pidfdOpen(pid int) (*pidfd, error) {
	fd, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		return nil, fmt.Errorf("pidfd_open(%d): %w", pid, err)
	}
	// PidfdOpen 不带 CLOEXEC：否则 fd 会被后续 spawn 的子进程继承，等于把"对某个进程的
	// 引用"泄露给无关进程
	unix.CloseOnExec(fd)
	return &pidfd{fd: fd}, nil
}

func (p *pidfd) Close() error {
	if p == nil {
		return nil
	}
	return unix.Close(p.fd)
}

// Send 原子地把信号发给 pidfd 绑定的进程，不存在 pid 复用窗口。
func (p *pidfd) Send(sig unix.Signal) error {
	if p == nil {
		return fmt.Errorf("pidfd 不可用")
	}
	if err := unix.PidfdSendSignal(p.fd, sig, nil, 0); err != nil {
		return fmt.Errorf("pidfd_send_signal(%d, %v): %w", p.fd, sig, err)
	}
	return nil
}
