const FAKEIP_RANGE = "198.18.0.0/15";
const TUN_ADDRESS = "198.18.0.1/16";
const EGRESS_INTERFACE = "tap0";

export interface SingboxConfigOptions {
  /** 允许直连的域名列表（空列表 = 默认拒绝一切出网）。 */
  readonly allowlist: readonly string[];
  /** 真实 DNS 服务器地址列表（IPv4，UDP 53），按顺序 fallback，至少一个。 */
  readonly dnsServers: readonly string[];
}

/**
 * 生成 sing-box 1.13 配置：TUN + fakeip + deny-by-default allowlist。
 *
 * - 出站绑定到 slirp4netns 的 tap0，避免 auto_route 把 sing-box 自身出站
 *   流量（尤其 DNS 解析）重新路由回 TUN 形成环。
 * - 真实解析不设 domain_resolver（它只接受单个 server 且绕过规则），而是
 *   用 DNS rules 的顺序 fallback 链：前 N-1 个 nameserver 带 ip_accept_any
 *   过滤（响应不合格时落到下一条），最后一个作为 dns.final 兜底。
 *   该用法在 1.13 已标记 deprecated，运行需设置
 *   ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER=true。
 */
export function generateSingboxConfig(options: SingboxConfigOptions): string {
  const { allowlist, dnsServers } = options;
  const lastServer = dnsServers.at(-1);
  if (!lastServer) {
    throw new Error("At least one DNS server is required");
  }
  const config = {
    log: { level: "info", timestamp: false },
    dns: {
      servers: [
        ...dnsServers.map((server, index) => ({
          type: "udp",
          tag: `remote-${index}`,
          server,
          server_port: 53,
        })),
        { type: "fakeip", tag: "fakeip", inet4_range: FAKEIP_RANGE },
      ],
      rules: [
        { query_type: ["A", "AAAA"], server: "fakeip" },
        ...dnsServers.slice(0, -1).map((_, index) => ({
          server: `remote-${index}`,
          ip_accept_any: true,
        })),
      ],
      final: `remote-${dnsServers.length - 1}`,
      strategy: "prefer_ipv4",
      independent_cache: true,
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        stack: "gvisor",
        address: [TUN_ADDRESS],
        auto_route: true,
        strict_route: true,
      },
    ],
    outbounds: [
      { type: "direct", tag: "direct" },
      { type: "block", tag: "block" },
    ],
    route: {
      default_interface: EGRESS_INTERFACE,
      final: "block",
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        ...(allowlist.length > 0 ? [{ domain: [...allowlist], outbound: "direct" }] : []),
      ],
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
