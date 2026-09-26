const FAKEIP_RANGE = "198.18.0.1/16";
/** mihomo 的拒绝伪 DNS 服务器：即时返回 NXDOMAIN，不查上游、不等超时。 */
const REJECT_NAMESERVER = "rcode://name_error";
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
  /** 出站静态绑定 slirp 接口（固定名 tap0）。 */
  "interface-name": string;
  dns: {
    enable: true;
    ipv6: false;
    "enhanced-mode": "fake-ip";
    "fake-ip-range": string;
    /** whitelist：只有 fake-ip-filter 命中的域名才拿 fake IP，其余走 nameserver。 */
    "fake-ip-filter-mode": "whitelist";
    /** fake IP 白名单：allowlist 里的域名（带端口条目的域名也进）。 */
    "fake-ip-filter"?: string[];
    /** 默认解析服务器：拒绝伪服务器，未命中白名单的域名（即未允许域名）即时 NXDOMAIN。 */
    nameserver: string[];
    "default-nameserver": string[];
    /** DIRECT 出站按域名解析用；不指定会解析回 fake-ip 再进 TUN 成环。 */
    "direct-nameserver": string[];
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
  if (host.includes("/")) {
    return host;
  }
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
    if (match?.[1] === undefined) {
      throw new Error(`Invalid allowlist entry "${entry}"`);
    }
    host = match[1];
    // 端口组 (?::(\d+))? 可选：无端口时 at(2) 是 undefined
    const portPart = match.at(2);
    port = portPart === undefined ? undefined : parsePort(portPart);
  } else {
    const colon = entry.lastIndexOf(":");
    if (colon === -1) {
      if (entry.length === 0) {
        throw new Error(`Invalid allowlist entry ""`);
      }
      host = entry;
    } else {
      const portPart = entry.slice(colon + 1);
      if (!/^\d+$/.test(portPart)) {
        throw new Error(`Invalid allowlist entry "${entry}"`);
      }
      host = entry.slice(0, colon);
      if (host.length === 0) {
        throw new Error(`Invalid allowlist entry "${entry}"`);
      }
      if (host.includes(":")) {
        throw new Error(`IPv6 addresses must be wrapped in brackets, e.g. "[${host}]:${portPart}"`);
      }
      port = parsePort(portPart);
    }
  }
  if (isIp(host)) {
    if (!IP_CHARS_PATTERN.test(host)) {
      throw new Error(`Invalid allowlist entry "${entry}"`);
    }
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
  /** 拿 fake IP 的域名：只有它们会进 fakeip 分支，其余域名落到默认解析（拒绝）。 */
  fakeIpWhitelist: string[];
}

/**
 * allowlist 条目 → mihomo 规则：
 * - 域名（含 :port 条目里的域名）进 fake-ip-filter（配合 filter-mode: whitelist，
 *   即「只有这些域名拿 fake IP」）：fake IP 与域名一一对应，连接到达时凭它精确还原
 *   域名再匹配规则，不依赖嗅探、也不受 DNS TTL 影响；
 * - 无端口条目直接匹配；带端口条目用 AND 组合（域名/IP + DST-PORT）精确放行；
 * - 最后以 MATCH,REJECT 兜底实现 deny-by-default（裸 IP 连接、绕过 DNS 的客户端）。
 *
 * 未进白名单的域名（即未允许域名）不拿 fake IP，直接落到 nameserver，被
 * rcode://name_error 即时拒绝（客户端报 Could not resolve host）——mihomo 的 fakeip
 * 分支本身没有按域名拒绝的钩子，收窄白名单是唯一能让拒绝发生在 DNS 层的办法。
 */
function buildRules(allowlist: readonly string[]): BuiltRules {
  const rules: string[] = [];
  const fakeIpWhitelist: string[] = [];
  for (const entry of allowlist) {
    const { host, port } = parseAllowlistEntry(entry);
    if (!isIp(host)) {
      fakeIpWhitelist.push(`+.${host}`);
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
  return { rules, fakeIpWhitelist };
}

/**
 * 生成 mihomo（Clash Meta）配置对象：TUN + 白名单 fakeip + deny-by-default allowlist。
 *
 * - auto-detect-interface 让 mihomo 出站绑定 slirp4netns 的 tap0，否则它自己的
 *   DNS 查询会被 auto_route 送回 TUN 形成环；
 * - TUN mtu 与 slirp4netns `--mtu` 共用 TUN_MTU，避免依赖各自默认值；
 * - fakeip 只服务 allowlist 域名（filter-mode: whitelist，见 buildRules 注释）：
 *   域名归属因此精确且不随 TTL 失效；
 * - direct-nameserver 必须指向真实 DNS：连接由 fake IP 还原成域名后，DIRECT 出站要
 *   按域名重新解析，不指定就会解析回 fake-ip 再进 TUN 成环。
 */
export function generateMihomoConfig(options: MihomoConfigOptions): MihomoConfig {
  const { allowlist, dnsServers } = options;
  if (dnsServers.length === 0) {
    throw new Error("At least one DNS server is required");
  }
  const { rules, fakeIpWhitelist } = buildRules(allowlist);
  return {
    "mixed-port": 0,
    mode: "rule",
    "log-level": "info",
    ipv6: false,
    // 静态绑定 tap0：auto-detect-interface 在启动瞬间可能探测到未就绪的接口
    //（tap0 尚由 slirp4netns 创建），monitor 事后纠正但 DNS 拨号已经走错接口，
    // 上游查询进自己的 TUN 被 dns-hijack 自劫持形成回环（allowlist 域名全部
    // SERVFAIL）。slirp 接口名固定是 tap0，直接写死最可靠。
    "interface-name": "tap0",
    dns: {
      enable: true,
      ipv6: false,
      "enhanced-mode": "fake-ip",
      "fake-ip-range": FAKEIP_RANGE,
      "fake-ip-filter-mode": "whitelist",
      ...(fakeIpWhitelist.length > 0 && { "fake-ip-filter": fakeIpWhitelist }),
      nameserver: [REJECT_NAMESERVER],
      "default-nameserver": [...dnsServers],
      "direct-nameserver": [...dnsServers],
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
