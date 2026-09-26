# bwrap 沙箱与网络栈架构

本文档描述 `network: limited` 模式下的进程模型、网络路径与生命周期管理。
基础沙箱（bwrap 文件系统隔离）见 `core.ts` / `sandbox.ts`；本文聚焦网络栈
（`network-stack.ts` / `holder.ts` / `mihomo-config.ts`）。

## 进程模型

`network: limited` 模式下，每条命令的网络栈进程树（宿主侧视角，共 4 个）：

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

每条命令的短命子树（命令结束即退）：

```
nsenter -U -n --preserve-credentials -t <①的pid> \
  -- bwrap --unshare-user --unshare-pid … -- bash -lc '<command>'
```

nsenter 进入 holder 的 userns/netns，bwrap 在里面再嵌套创建自己的 user/pid
ns 跑命令。网络栈是每条命令现建现停（起栈 ~40ms、停栈 ~100ms），不跨命令复用：
allowlist 变更因此即时生效，代价是每条命令重新启动一次 mihomo。

## 网络路径

- **mihomo（③）**：TUN（`auto-route` + `strict-route`）+ **白名单 fakeip** +
  deny-by-default。`network.allowlist` 的域名进 `fake-ip-filter`，配合
  `fake-ip-filter-mode: whitelist` 即「只有这些域名拿 fake IP」；`dns.nameserver`
  是 `rcode://name_error` 伪服务器，未命中白名单的域名（即未允许域名）落到它上面
  即时拿到 NXDOMAIN（客户端报 `Could not resolve host`）；连接层再用 `MATCH,REJECT`
  兜底裸 IP 连接。`dns.direct-nameserver` 必须指向真实 DNS：连接由 fake IP 还原成
  域名后，DIRECT 出站要按域名重新解析，否则会解析回 fake-ip 再进 TUN 成环。
  这样两边都成立：未允许域名在 DNS 层就被拒，allowlist 域名的归属又由 fake IP
  精确给出（不依赖嗅探、不受 DNS TTL 影响）。
- **slirp4netns（④）**：egress NAT。它 fork helper 进 netns 创建 tap0 并把
  tapfd 传回主进程，真正的出站 socket 在宿主 netns。
- **interface-name: tap0**：mihomo 出站静态绑定 slirp 接口。不能用
  `auto-detect-interface` 顶替——启动瞬间 tap0 可能尚未就绪，monitor 事后
  纠正但 DNS 拨号已走错接口，上游查询进自己的 TUN 被 `dns-hijack` 自劫持。
- **mihomo `-d <uuid 目录>`**：cache.db 等落盘位置，放
  `<agentDir>/tmp/mihomo-<uuid>/`，每次启动独立目录避免并发争抢 bbolt 锁；
  停栈时删除，启动失败时保留作诊断材料。

## allowlist 条目

条目形式为「域名 / IPv4 / CIDR（可带 `:port`）」，域名有两档匹配精度——两层
（DNS 白名单与连接层规则）语义严格一致：

| 条目                    | 匹配                                             | 不匹配                               |
| ----------------------- | ------------------------------------------------ | ------------------------------------ |
| `example.com`           | `example.com`                                    | `www.example.com`、`a.b.example.com` |
| `*.example.com`         | `www.example.com`、`a.b.example.com`（任意深度） | `example.com`、`notexample.com`      |
| `example.com:443`       | 精确域名 + 仅 443                                | 其它端口                             |
| `*.example.com:443`     | 子域名 + 仅 443                                  | `example.com`、其它端口              |
| `1.2.3.4`、`10.0.0.0/8` | 对应 IP / 网段                                   | —                                    |

- 裸域名是**精确匹配**（不是子树），需要「域名本身 + 子域名」同时放行时写两条。
- `*.` 必须占据完整的最左标签：`*`、`*example.com`、`a.*.example.com` 都是配置错误；
  通配只对域名有效，IP 范围用 CIDR 表达。
- 端口只约束连接层（DNS 无端口语义）：`example.com:443` 能解析，但只有 443 能连。
- 映射到 mihomo：精确条目在 DNS 侧是裸域名、连接层是 `DOMAIN`；通配条目在 DNS 侧
  是 `.example.com`（dot-wildcard）、连接层是 `DOMAIN-WILDCARD,*.example.com`。

## 生命周期与清理

exit-fd（socketpair）是 slirp4netns 与 holder 之间唯一的生命周期绑定：
读端给 slirp4netns（`-e 3`），写端由 holder 进程持有（network-stack 经
`unshare` 的额外 stdio 传入 fd 3）。Node 对额外 stdio pipe 没有公开的 fd
访问器（`stdio[3].fd` 恒为 undefined），只能经 `_handle.fd` 取原始 fd 再
dup 给 slirp4netns，且仅在子进程存活期间有效。

| 触发                   | 清理链路                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| 正常 `stop()`          | SIGTERM ④（先杀，它 pin 着 netns）→ SIGKILL ① → PDEATHSIG 给 ② SIGTERM → ② 杀 ③ 退出 → 内核清 pid ns |
| pi 进程被 SIGKILL      | stdin 写端关闭 → ② EOF 自杀 → pid ns 清理 → exit-fd 写端关闭 → ④ HUP 自杀 → tapfd 释放 → netns 销毁  |
| 单独 kill ①（SIGKILL） | PDEATHSIG → ② SIGTERM → 同上；① wait 结束退出 → 写端全关 → ④ 退                                      |
| 单独 kill ②            | pid-ns init 死 → 内核清 ③；① 退出 → 写端全关 → ④ 退                                                  |

四条路径下网络栈全部进程收敛、netns 引用归零。注意 `--kill-child` 不是信号转发：
它的实现是 unshare fork 出的子进程给自己设 PDEATHSIG（unshare 死亡时收到 SIGTERM），
所以终止 ① 只能靠 SIGKILL（见「设计约束」第 5 条）。

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
3. **DNS 层拒绝要靠收窄 fakeip，不能靠 DNS 规则**：mihomo 没有 `dns.rules`
   这个字段（`config.RawDNS` 里不存在，写进配置会被静默忽略），`fake-ip` 分支
   也没有按域名拒绝的钩子——命中 fakeip 就直接回合成 IP。要让未允许域名在 DNS
   层失败，只能把它们排除在 fakeip 白名单之外（`fake-ip-filter-mode: whitelist`），
   让查询落到 `nameserver`，再由 `rcode://name_error` 即时回 NXDOMAIN。
   诊断时注意两点：allowlist 域名解析出 `198.18.x.x` 是**正常现象**（fakeip 生效），
   未允许域名则应当**解析失败**而不是解析出 fakeip。
4. **诊断手段**：`pnpm sandbox --verbose` 透传 holder（mihomo/slirp4netns）
   日志；`nsenter -U -n --preserve-credentials -t <holderPid>` 可手动进入
   netns 用 AF_PACKET 抓 tap0 / 检查 `ip rule`（注意：沙盒里看不到宿主机
   进程，宿主机诊断必须在沙盒外做）。
5. **终止 unshare 只能用 SIGKILL**。util-linux 的 unshare 在 fork 前
   `sigprocmask(SIG_BLOCK, {SIGINT, SIGTERM})`，且只在子进程里恢复掩码：
   父进程永久阻塞这两个信号且不装 handler，发给它的 SIGTERM 只会 pending
   永不投递（实测 3s 后仍存活）。曾因此在 `stop()` 里白等 `waitForExit`
   的 2000ms 默认超时，把每条命令的沙箱开销从 ~180ms 抬到 ~2.09s。SIGKILL
   立即生效，PDEATHSIG 再把 SIGTERM 交给 ② 走优雅退出。

## 调试入口

```sh
# 诊断执行（与扩展同一条代码路径）
pnpm sandbox --verbose -- '<command>'
# 修改 holder.ts 后需重新构建构建产物 holder.js
pnpm build:holder
```
