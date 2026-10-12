# Design

## Context

见 `proposal.md` 的 Why 与上一个 change 的 design：沙箱内的命令已经能拿到网络栈分配的地址，问题出在网络栈**自己**的上游选择上。

## Goals / Non-Goals

- 目标：stub 环境下 allowlist 域名不仅能解析，还能真正连上。
- 非目标：不改写沙箱内的解析配置；不变更 DNS 白名单/拒绝语义。

## Decisions

### 上游候选值的排除与回退顺序

- **排除 loopback**：netns 内的 `127.0.0.0/8` 指向网络栈自身（本机 53 上就是我们的监听），作为上游只会把域名解析回网络栈分配的地址形成回环。
- **优先宿主真实上游**：systemd-resolved 把实际使用的上游写在 `/run/systemd/resolve/resolv.conf`，读它比要求用户改 `resolv.conf` 更贴近系统现状。
- **最后回退 egress 解析器**：slirp4netns 的内置 DNS（`10.0.2.3`）在宿主侧解析，无论宿主怎么配置都能工作——宿主实测把它作为上游时 `curl https://pypi.org/simple/` 返回 200。
- 继续排除 IPv6：egress 通道只提供 IPv4。

## Risks / Trade-offs

- 读 systemd 的文件依赖发行版约定；文件不存在时回退到 egress 解析器，不会失败。
- egress 解析器是最后兜底：它不继承宿主 `resolv.conf` 的搜索域等细节，但沙箱内的解析本就完全由网络栈决定。
