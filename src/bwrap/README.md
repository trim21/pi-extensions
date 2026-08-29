# bwrap 沙箱与网络栈架构

本文档描述 `net-allowlist` 模式下的进程模型、网络路径与生命周期管理。
基础沙箱（bwrap 文件系统隔离）见 `core.ts` / `sandbox.ts`；本文聚焦网络栈
（`network-stack.ts` / `holder.ts` / `mihomo-config.ts`）。

## 进程模型

`net-allowlist` 模式下，一个沙箱 session 的常驻进程树（宿主侧视角，共 4 个）：

```
pi 进程（network-stack.ts）
├─ ① unshare -Urnp --fork --kill-child=SIGTERM -- node holder.js …
│    创建 user+net+pid 三个 ns；--fork 后由子进程 exec node；
│    自己留在原地 wait；--kill-child=SIGTERM 给 ② 设 PDEATHSIG。
│    持 exit-fd 写端（fd 3）。
│    └─ ② node holder.js    （pid-ns 的 init，即该 pid-ns 里的 PID 1）
│         读 stdin（EOF 自杀）、等 tap0、拉起 ③；持 exit-fd 写端 fd 3。
│         └─ ③ mihomo       （netns 内：TUN "Meta" + 策略路由 + fakeip DNS）
└─ ④ slirp4netns -c --userns-path=…/ns/user --netns-type=pid <①的pid> tap0 -e 3
     必须在宿主 netns 启动（原因见「设计约束」）；持 exit-fd 读端 + tapfd。
```

每条命令的短命子树（命令结束即退，与常驻栈无关）：

```
nsenter -U -n --preserve-credentials -t <①的pid> \
  -- bwrap --unshare-user --unshare-pid … -- bash -lc '<command>'
```

nsenter 进入 holder 的 userns/netns，bwrap 在里面再嵌套创建自己的 user/pid
ns 跑命令。一个 session 内 N 条命令复用同一套常驻栈。

## 网络路径

- **mihomo（③）**：TUN（`auto-route` + `strict-route`）+ fakeip +
  deny-by-default。allowlist 域名进 `fake-ip-filter`（真实解析），DNS 层
  `DOMAIN-SUFFIX,…,DIRECT`；连接层未命中 allowlist 的流量 `MATCH,REJECT`。
  注意：fakeip 对不在 filter 里的域名**直接本地应答**，不会走到
  `dns.rules` 的 REJECT——未允许域名是先拿 fakeip、连接层再被拒。
- **slirp4netns（④）**：egress NAT。它 fork helper 进 netns 创建 tap0 并把
  tapfd 传回主进程，真正的出站 socket 在宿主 netns。
- **interface-name: tap0**：mihomo 出站静态绑定 slirp 接口。不能用
  `auto-detect-interface` 顶替——启动瞬间 tap0 可能尚未就绪，monitor 事后
  纠正但 DNS 拨号已走错接口，上游查询进自己的 TUN 被 `dns-hijack` 自劫持。
- **mihomo `-d <uuid 目录>`**：cache.db 等落盘位置，放
  `<agentDir>/tmp/mihomo-<uuid>/`，每次启动独立目录避免并发争抢 bbolt 锁。

## 生命周期与清理

exit-fd（socketpair）是 slirp4netns 与 holder 之间唯一的生命周期绑定：
读端给 slirp4netns（`-e 3`），写端由 holder 进程持有（network-stack 经
`unshare` 的额外 stdio 传入 fd 3）。Node 对额外 stdio pipe 没有公开的 fd
访问器（`stdio[3].fd` 恒为 undefined），只能经 `_handle.fd` 取原始 fd 再
dup 给 slirp4netns，且仅在子进程存活期间有效。

| 触发              | 清理链路                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| 正常 `stop()`     | SIGTERM ④（先杀，它 pin 着 netns）→ SIGTERM ① → `--kill-child` 转发给 ② → ② 杀 ③ 退出 → 内核清 pid ns |
| pi 进程被 SIGKILL | stdin 写端关闭 → ② EOF 自杀 → pid ns 清理 → exit-fd 写端关闭 → ④ HUP 自杀 → tapfd 释放 → netns 销毁   |
| 单独 kill ①       | PDEATHSIG → ② SIGTERM → 同上；① wait 结束退出 → 写端全关 → ④ 退                                       |
| 单独 kill ②       | pid-ns init 死 → 内核清 ③；① 退出 → 写端全关 → ④ 退                                                   |

四条路径下常驻进程全部收敛、netns 引用归零。

## 设计约束与教训

1. **slirp4netns 必须在宿主 netns 启动**。它的 egress socket 决定出站视角；
   若留在沙盒 netns 里（holder 内启动），出站流量会被 mihomo 的 TUN 策略
   路由 + `dns-hijack any:53` 自劫持成环：上游 DNS 查询自己劫自己，
   mihomo 对劫持查询回 SERVFAIL（源 IP 伪装成原目的地址），allowlist 域名
   全部 `ENOTFOUND`，而未 allowlist 域名反而"正常"（fakeip 本地应答）。
   宿主侧启动后必须用 exit-fd 绑定生命周期，否则 holder 死后 slirp4netns
   持 tapfd 泄漏 netns。
2. **tap fd pin 住 netns**：slirp4netns 持有 tapfd 期间 netns 不会销毁，
   所以任何架构下 slirp4netns 的终止都必须显式保证（stop() / exit-fd）。
3. **fakeip 短路**：`dns.rules` 的 REJECT 拦不住 fakeip 应答，deny-by-default
   实际由连接层 `MATCH,REJECT` 兜底。诊断时不要把"未允许域名能解析出
   198.18.x.x"当成 DNS 层放行。
4. **诊断手段**：`pnpm sandbox --verbose` 透传 holder（mihomo/slirp4netns）
   日志；`nsenter -U -n --preserve-credentials -t <holderPid>` 可手动进入
   netns 用 AF_PACKET 抓 tap0 / 检查 `ip rule`（注意：沙盒里看不到宿主机
   进程，宿主机诊断必须在沙盒外做）。

## 调试入口

```sh
# 诊断执行（与扩展同一条代码路径）
pnpm sandbox --verbose -- '<command>'
# 修改 holder.ts 后需重新构建构建产物 holder.js
pnpm build:holder
```
