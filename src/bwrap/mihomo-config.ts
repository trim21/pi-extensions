const FAKEIP_RANGE = "198.18.0.1/16";
/** TUN 与 slirp4netns tap0 共用；不对齐时大包会在 slirp NAT 后 PMTU blackhole。 */
export const TUN_MTU = 1500;

export interface MihomoConfigOptions {
  /** 允许直连的条目列表（域名 / IP / CIDR，可带 :port；空列表 = 默认拒绝一切出网）。 */
  readonly allowlist: readonly string[];
  /** 真实 DNS 服务器地址列表（IPv4，UDP 53），按顺序 fallback，至少一个。 */
  readonly dnsServers: readonly string[];
}

interface AllowlistEntry {
  readonly host: string;
  readonly port?: number;
}

/** mihomo 配置以 JSON 序列化输出（JSON 是 YAML 子集，-f 加载无差别）。 */
export interface MihomoConfig {
  "mixed-port": 0;
  mode: "rule";
  "log-level": "info";
  ipv6: false;
  dns: {
    enable: true;
    ipv6: false;
    "enhanced-mode": "fake-ip";
    "fake-ip-range": string;
    nameserver: string[];
    "default-nameserver": string[];
    "fake-ip-filter"?: string[];
    /** 域名级 DNS 规则（mihomo >= 1.18）：allowlist 域名 DIRECT，其余 REJECT。 */
    rules: string[];
  };
  tun: {
    enable: true;
    stack: "mixed";
    mtu: number;
    "auto-route": true;
    "strict-route": true;
    "auto-detect-interface": true;
    "dns-hijack": string[];
  };
  rules: string[];
}

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/;
/** 合法 DNS 主机名（标签 1-63 字符，字母数字加连字符，不得以连字符开头/结尾）。 */
const DOMAIN_PATTERN =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
/** IP/CIDR 的字符集校验（IPv4/IPv6），防止非法字符进入规则。 */
const IP_CHARS_PATTERN = /^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/;

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
  let host: string;
  let port: number | undefined;
  if (entry.startsWith("[")) {
    const match = /^\[(.+)\](?::(\d+))?$/.exec(entry);
    if (match?.[1] === undefined) throw new Error(`Invalid allowlist entry "${entry}"`);
    host = match[1];
    port = match[2] === undefined ? undefined : parsePort(match[2]);
  } else {
    const colon = entry.lastIndexOf(":");
    if (colon === -1) {
      if (entry.length === 0) throw new Error(`Invalid allowlist entry ""`);
      host = entry;
    } else {
      const portPart = entry.slice(colon + 1);
      if (!/^\d+$/.test(portPart)) throw new Error(`Invalid allowlist entry "${entry}"`);
      host = entry.slice(0, colon);
      if (host.length === 0) throw new Error(`Invalid allowlist entry "${entry}"`);
      if (host.includes(":")) {
        throw new Error(`IPv6 addresses must be wrapped in brackets, e.g. "[${host}]:${portPart}"`);
      }
      port = parsePort(portPart);
    }
  }
  if (isIp(host)) {
    if (!IP_CHARS_PATTERN.test(host)) throw new Error(`Invalid allowlist entry "${entry}"`);
  } else if (!DOMAIN_PATTERN.test(host)) {
    throw new Error(`Invalid allowlist entry "${entry}"`);
  }
  return { host, port };
}

/** IP 条目的 mihomo 规则（IPv6 用 IP-CIDR6；no-resolve 跳过反向解析）。 */
function ipRule(host: string): string {
  const cidr = toCidr(host);
  const kind = cidr.includes(":") ? "IP-CIDR6" : "IP-CIDR";
  return `${kind},${cidr},DIRECT,no-resolve`;
}

interface BuiltRules {
  rules: string[];
  fakeIpFilter: string[];
  /** DNS 层规则：allowlist 域名正常解析，未允许域名直接拒绝（解析失败而非 fake-ip 后连接失败）。 */
  dnsRules: string[];
}

/**
 * allowlist 条目 → mihomo 规则：
 * - 域名（含 :port 条目里的域名）进 fake-ip-filter，真实解析避免 DIRECT 出站
 *   拿到 fakeip 再进 TUN 形成环（loopback detector 会拒绝）；
 * - 无端口条目直接匹配；带端口条目用 AND 组合（域名/IP + DST-PORT）精确放行；
 * - 最后以 MATCH,REJECT 兜底实现 deny-by-default。
 * dns.rules 同步构建：allowlist 域名 DIRECT，其余 MATCH,REJECT——未允许域名
 * 在 DNS 层即被拒绝（curl 报 Could not resolve host），而不是先拿 fake-ip、
 * 到连接层才断（报 TLS decode error，容易误判为网络故障）。
 */
function buildRules(allowlist: readonly string[]): BuiltRules {
  const rules: string[] = [];
  const fakeIpFilter: string[] = [];
  const dnsRules: string[] = [];
  for (const entry of allowlist) {
    const { host, port } = parseAllowlistEntry(entry);
    if (!isIp(host)) {
      fakeIpFilter.push(`+.${host}`);
      // DNS 层按域名放行（端口无关）；连接层规则保留端口语义
      dnsRules.push(`DOMAIN-SUFFIX,${host},DIRECT`);
      if (port === undefined) {
        rules.push(`DOMAIN-SUFFIX,${host},DIRECT`);
      } else {
        rules.push(`AND,(DOMAIN-SUFFIX,${host},DIRECT),(DST-PORT,${port},DIRECT),DIRECT`);
      }
    } else if (port === undefined) {
      rules.push(ipRule(host));
    } else {
      rules.push(`AND,(${ipRule(host)}),(DST-PORT,${port},DIRECT),DIRECT`);
    }
  }
  rules.push("MATCH,REJECT");
  dnsRules.push("MATCH,REJECT");
  return { rules, fakeIpFilter, dnsRules };
}

/**
 * 生成 mihomo（Clash Meta）配置对象：TUN + fakeip + deny-by-default allowlist。
 *
 * - auto-detect-interface 让 mihomo 出站绑定 slirp4netns 的 tap0，否则它自己的
 *   DNS 查询会被 auto_route 送回 TUN 形成环；
 * - TUN mtu 与 slirp4netns `--mtu` 共用 TUN_MTU，避免依赖各自默认值；
 * - allowlist 域名走 fake-ip-filter 真实解析（见 buildRules 注释）。
 */
export function generateMihomoConfig(options: MihomoConfigOptions): MihomoConfig {
  const { allowlist, dnsServers } = options;
  if (dnsServers.length === 0) {
    throw new Error("At least one DNS server is required");
  }
  const { rules, fakeIpFilter, dnsRules } = buildRules(allowlist);
  return {
    "mixed-port": 0,
    mode: "rule",
    "log-level": "info",
    ipv6: false,
    dns: {
      enable: true,
      ipv6: false,
      "enhanced-mode": "fake-ip",
      "fake-ip-range": FAKEIP_RANGE,
      nameserver: [...dnsServers],
      "default-nameserver": [...dnsServers],
      ...(fakeIpFilter.length > 0 && { "fake-ip-filter": fakeIpFilter }),
      rules: dnsRules,
    },
    tun: {
      enable: true,
      stack: "mixed",
      mtu: TUN_MTU,
      "auto-route": true,
      "strict-route": true,
      "auto-detect-interface": true,
      "dns-hijack": ["any:53"],
    },
    rules,
  };
}
