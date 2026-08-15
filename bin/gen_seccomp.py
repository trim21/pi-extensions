"""Generate seccomp BPF bytecode for the bwrap sandbox.

Usage:
    pixi run gen

Produces `seccomp-<arch>.bpf` for the native architecture.
The other arch's file should be generated on-target.

The filter denies syscalls that create or accept connections (socket,
connect, accept, accept4, bind, listen) while allowing all others —
including socketpair (needed by cargo/rustc IPC) and sending on existing
sockets (sendto/sendmsg/sendmmsg).
`connect` is the core containment: it stops Docker-style clients from
reaching host AF_UNIX sockets (/var/run/docker.sock, etc.).
"""

import errno
import sys
from pathlib import Path

import seccomp

OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "bwrap"

# Syscalls to deny.
#   socket/network: blocks creating sockets (socket), establishing
#                   connections (connect), and listening/accepting
#                   (bind, listen, accept, accept4). connect is the core
#                   containment — it stops Docker-style clients from
#                   reaching host AF_UNIX sockets (/var/run/docker.sock, etc.).
#   ptrace/vm:      prevent cross-process memory access / code injection.
#
# sendto/sendmsg/sendmmsg are NOT blocked: they only send data on
# already-existing fds. With socket/connect blocked there is no socket that
# could reach the host, inherited stdio socketpairs are writable via plain
# write() anyway, and sendmsg's msghdr can carry a destination address just
# like sendto — so blocking them adds no containment while breaking tools
# (e.g. node's console.log writes to a socket stdout via sendmsg).
#
# getsockname/getpeername/getsockopt/setsockopt/shutdown are NOT blocked:
# they only query or tune already-existing fds (e.g. Node's stdio socketpair)
# and cannot establish connections, so blocking them just breaks tooling
# (node's spawn uses socketpair stdio pipes and calls these).
#
# socketpair is NOT blocked: process-local IPC (cargo/rustc, node, etc.).
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
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
]


def build_filter() -> bytes:
    """Build a seccomp BPF filter for the native architecture."""
    f = seccomp.SyscallFilter(seccomp.ALLOW)

    for name in BLOCKED_SYSCALLS:
        try:
            f.add_rule(seccomp.ERRNO(errno.EACCES), name)
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
