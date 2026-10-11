// pidfd：原型的核心差异点。
//
// Node/libuv 只能按 pid 发信号（uv_process_kill → kill(2)），"检查子进程是否已退出"
// 与"发信号"之间不是原子的，pid 被内核复用时会误伤无关进程。pidfd 是内核持有的进程
// 引用：pidfd_open 之后 pidfd_send_signal 永远打在那个进程上，poll 也能精确等待退出。
//
// 这里用裸 syscall（不引第三方依赖）：pidfd_open=434、pidfd_send_signal=424 在
// x86_64/arm64 等主流架构的 syscall 表里编号一致。
package main

import (
	"fmt"
	"syscall"
)

const (
	sysPidfdOpen       = 434
	sysPidfdSendSignal = 424
)

// pidfd 是内核持有的进程引用；Close 只释放我们的引用，不会影响进程本身。
type pidfd struct {
	fd int
}

func pidfdOpen(pid int) (*pidfd, error) {
	fd, _, errno := syscall.Syscall(sysPidfdOpen, uintptr(pid), 0, 0)
	if errno != 0 {
		return nil, fmt.Errorf("pidfd_open(%d): %w", pid, errno)
	}
	return &pidfd{fd: int(fd)}, nil
}

func (p *pidfd) Close() error {
	if p == nil {
		return nil
	}
	return syscall.Close(p.fd)
}

// Send 原子地把信号发给 pidfd 绑定的进程，不存在 pid 复用窗口。
func (p *pidfd) Send(sig syscall.Signal) error {
	if p == nil {
		return fmt.Errorf("pidfd 不可用")
	}
	_, _, errno := syscall.Syscall6(sysPidfdSendSignal, uintptr(p.fd), uintptr(sig), 0, 0, 0, 0)
	if errno != 0 {
		return fmt.Errorf("pidfd_send_signal(%d, %v): %w", p.fd, sig, errno)
	}
	return nil
}

// exited 阻塞最多 timeoutMs 毫秒，返回进程是否已退出（timeoutMs<0 表示不限时）。
func (p *pidfd) exited(timeoutMs int) (bool, error) {
	if p == nil {
		return false, fmt.Errorf("pidfd 不可用")
	}
	epfd, err := syscall.EpollCreate1(syscall.EPOLL_CLOEXEC)
	if err != nil {
		return false, fmt.Errorf("epoll_create1: %w", err)
	}
	defer syscall.Close(epfd)

	event := &syscall.EpollEvent{Events: syscall.EPOLLIN, Fd: int32(p.fd)}
	if err := syscall.EpollCtl(epfd, syscall.EPOLL_CTL_ADD, p.fd, event); err != nil {
		return false, fmt.Errorf("epoll_ctl: %w", err)
	}
	events := make([]syscall.EpollEvent, 1)
	n, err := syscall.EpollWait(epfd, events, timeoutMs)
	if err != nil {
		if err == syscall.EINTR {
			return false, nil
		}
		return false, fmt.Errorf("epoll_wait: %w", err)
	}
	return n > 0, nil
}

// kill 是"终止并用 pidfd 等到它真的退出"的封装：先 SIGTERM，超时后再 SIGKILL。
// 两步都用 pidfd，因此不存在误伤其他进程的可能。
func (p *pidfd) kill(graceMs int) {
	if p == nil {
		return
	}
	if exited, _ := p.exited(0); exited {
		return
	}
	_ = p.Send(syscall.SIGTERM)
	if exited, _ := p.exited(graceMs); exited {
		return
	}
	_ = p.Send(syscall.SIGKILL)
	_, _ = p.exited(2000)
}
