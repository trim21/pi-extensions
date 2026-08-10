"""Generate seccomp BPF bytecode for the bwrap sandbox.

Usage:
    pixi run gen

Produces `seccomp-<arch>.bpf` for the native architecture.
The other arch's file should be generated on-target.

The filter denies socket-related syscalls (socket, connect, accept, accept4,
bind, listen, sendto, sendmsg, sendmmsg, getpeername, getsockname, shutdown)
while allowing all others — including socketpair (needed by cargo/rustc IPC).
"""

import sys
from pathlib import Path

import seccomp

OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "bwrap"

# Syscalls to deny.
#   socket/network: socketpair intentionally excluded for process-local IPC.
#   ptrace/vm:      prevent cross-process memory access / code injection.
#   sockopt:        prevent socket option manipulation.
#
# io_uring (setup/enter/register) is intentionally NOT blocked: Node.js 22+
# uses it for async fs by default, and bwrap's mount/network namespace
# isolation already bounds what io_uring can reach — blocking it would only
# break tooling (e.g. node, npm) without adding meaningful confinement.
BLOCKED_SYSCALLS = [
    "socket",
    "connect",
    "accept",
    "accept4",
    "bind",
    "listen",
    "sendto",
    "sendmsg",
    "sendmmsg",
    "getpeername",
    "getsockname",
    "shutdown",
    "getsockopt",
    "setsockopt",
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
]


def build_filter() -> bytes:
    """Build a seccomp BPF filter for the native architecture."""
    f = seccomp.SyscallFilter(seccomp.ALLOW)

    for name in BLOCKED_SYSCALLS:
        try:
            f.add_rule(seccomp.ERRNO(1), name)
        except RuntimeError as e:
            print(
                f"warning: syscall '{name}' not available, skipping: {e}",
                file=sys.stderr,
            )

    return f.export_bpf_mem()


def main() -> None:
    bytecode = build_filter()

    native_arch = {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}
    import platform

    arch = native_arch.get(platform.machine(), platform.machine())
    out = OUT_DIR / f"seccomp-{arch}.bpf"
    out.write_bytes(bytecode)
    print(f"  {out.name:30s} {arch:8s} {len(bytecode):>4d} bytes")


if __name__ == "__main__":
    main()
