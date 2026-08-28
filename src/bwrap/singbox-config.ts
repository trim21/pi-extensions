const FAKEIP_RANGE = "198.18.0.0/15";
const TUN_ADDRESS = "198.18.0.1/16";
const EGRESS_INTERFACE = "tap0";

export interface SingboxConfigOptions {
  /** 允许直连的条目列表（域名 / IP / CIDR，可带 :port；空列表 = 默认拒绝一切出网）。 */
  readonly allowlist: readonly string[];
  /** 真实 DNS 服务器地址列表（IPv4，UDP 53），按顺序 fallback，至少一个。 */
  readonly dnsServers: readonly string[];
}

interface AllowlistEntry {
  readonly host: string;
  readonly port?: number;
}

interface AllowlistRule {
  readonly domain?: readonly string[];
  readonly ip_cidr?: readonly string[];
  readonly port?: readonly number[];
  readonly outbound: "direct";
}

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/;

function isIp(host: string): boolean {
  return IPV4_PATTERN.test(host) || host.includes(":");
}

/** 单 IP 补掩码为 CIDR（IPv4 /32、IPv6 /128），带掩码原样返回。 */
function toCidr(host: string): string {
  if (host.includes("/")) return host;
  return host.includes(":") ? `${host}/128` : `${host}/32`;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${value}"`);
  }
  return port;
}

/**
 * 解析 allowlist 条目：域名 / IPv4 / CIDR，可带 :port；IPv6 必须用 [] 包裹
 * （如 `[::1]:80`），裸 IPv6 会报错提示补方括号。
 */
function parseAllowlistEntry(entry: string): AllowlistEntry {
  if (entry.startsWith("[")) {
    const match = /^\[(.+)\](?::(\d+))?$/.exec(entry);
    if (match?.[1] === undefined) throw new Error(`Invalid allowlist entry "${entry}"`);
    return { host: match[1], port: match[2] === undefined ? undefined : parsePort(match[2]) };
  }
  const colon = entry.lastIndexOf(":");
  if (colon === -1) {
    if (entry.length === 0) throw new Error(`Invalid allowlist entry ""`);
    return { host: entry };
  }
  const portPart = entry.slice(colon + 1);
  if (!/^\d+$/.test(portPart)) throw new Error(`Invalid allowlist entry "${entry}"`);
  const host = entry.slice(0, colon);
  if (host.length === 0) throw new Error(`Invalid allowlist entry "${entry}"`);
  if (host.includes(":")) {
    throw new Error(`IPv6 addresses must be wrapped in brackets, e.g. "[${host}]:${portPart}"`);
  }
  return { host, port: parsePort(portPart) };
}

function buildAllowlistRules(allowlist: readonly string[]): AllowlistRule[] {
  const noPortDomains: string[] = [];
  const noPortIps: string[] = [];
  const byPort = new Map<number, { domains: string[]; ips: string[] }>();
  for (const entry of allowlist) {
    const { host, port } = parseAllowlistEntry(entry);
    if (port === undefined) {
      (isIp(host) ? noPortIps : noPortDomains).push(host);
    } else {
      const bucket = byPort.get(port) ?? { domains: [], ips: [] };
      (isIp(host) ? bucket.ips : bucket.domains).push(host);
      byPort.set(port, bucket);
    }
  }
  const rules: AllowlistRule[] = [];
  if (noPortDomains.length > 0) rules.push({ domain: noPortDomains, outbound: "direct" });
  if (noPortIps.length > 0) {
    rules.push({ ip_cidr: noPortIps.map((host) => toCidr(host)), outbound: "direct" });
  }
  for (const [port, bucket] of byPort) {
    rules.push({
      outbound: "direct",
      port: [port],
      ...(bucket.domains.length > 0 && { domain: bucket.domains }),
      ...(bucket.ips.length > 0 && { ip_cidr: bucket.ips.map((host) => toCidr(host)) }),
    });
  }
  return rules;
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
        ...buildAllowlistRules(allowlist),
      ],
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
