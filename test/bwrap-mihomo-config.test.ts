import { describe, expect, it } from "vitest";

import {
  generateMihomoConfig,
  type MihomoConfig,
  type MihomoConfigOptions,
  TUN_MTU,
} from "../src/bwrap/mihomo-config.js";

function config(options: MihomoConfigOptions): MihomoConfig {
  return generateMihomoConfig(options);
}

function expectEntryRejected(entry: string, pattern: RegExp): void {
  expect(() => generateMihomoConfig({ allowlist: [entry], dnsServers: ["192.168.2.1"] })).toThrow(
    pattern,
  );
}

describe("generateMihomoConfig", () => {
  it("emits whitelist fakeip dns", () => {
    const result = config({ allowlist: ["pypi.org"], dnsServers: ["192.168.2.1", "223.5.5.5"] });

    expect(result.mode).toBe("rule");
    expect(result.dns["enhanced-mode"]).toBe("fake-ip");
    expect(result.dns["fake-ip-range"]).toBe("198.18.0.1/16");
    // whitelist：只有白名单里的域名拿 fake IP
    expect(result.dns["fake-ip-filter-mode"]).toBe("whitelist");
    expect(result.dns["fake-ip-filter"]).toEqual(["pypi.org"]);
  });

  it("rejects non-allowlist domains at the DNS layer via a rejecting nameserver", () => {
    const result = config({ allowlist: ["pypi.org"], dnsServers: ["192.168.2.1"] });

    // 未命中 fake-ip 白名单的域名落到 nameserver；rcode:// 伪服务器即时回 NXDOMAIN
    expect(result.dns.nameserver).toEqual(["rcode://name_error"]);
    expect(result.dns["default-nameserver"]).toEqual(["192.168.2.1"]);
    // DIRECT 出站要按域名重新解析，必须走真实 DNS，否则解析回 fake-ip 成环
    expect(result.dns["direct-nameserver"]).toEqual(["192.168.2.1"]);
  });

  it("matches bare domains exactly and blocks everything else", () => {
    const result = config({
      allowlist: ["pypi.org", "files.pythonhosted.org"],
      dnsServers: ["192.168.2.1"],
    });

    expect(result.rules).toContain("DOMAIN,pypi.org,DIRECT");
    expect(result.rules).toContain("DOMAIN,files.pythonhosted.org,DIRECT");
    expect(result.rules.at(-1)).toBe("MATCH,REJECT");
  });

  it("matches '*.domain' entries as subdomains only", () => {
    const result = config({ allowlist: ["*.example.com"], dnsServers: ["192.168.2.1"] });

    // DNS 侧 dot-wildcard（任意深度子域名，不含 apex）；连接层 glob 同语义
    expect(result.dns["fake-ip-filter"]).toEqual([".example.com"]);
    expect(result.rules).toContain("DOMAIN-WILDCARD,*.example.com,DIRECT");
    expect(result.rules).not.toContain("DOMAIN,example.com,DIRECT");
  });

  it("keeps apex and subdomain entries independent", () => {
    const result = config({
      allowlist: ["example.com", "*.example.com"],
      dnsServers: ["192.168.2.1"],
    });

    expect(result.dns["fake-ip-filter"]).toEqual(["example.com", ".example.com"]);
    expect(result.rules).toContain("DOMAIN,example.com,DIRECT");
    expect(result.rules).toContain("DOMAIN-WILDCARD,*.example.com,DIRECT");
  });

  it("puts domain:port entries into the fake-ip whitelist by domain only", () => {
    const result = config({ allowlist: ["example.com:443"], dnsServers: ["192.168.2.1"] });

    // 端口只约束连接层规则，DNS 层按域名处理
    expect(result.dns["fake-ip-filter"]).toEqual(["example.com"]);
    expect(result.rules).toContain("AND,(DOMAIN,example.com,DIRECT),(DST-PORT,443,DIRECT),DIRECT");
  });

  it("combines subdomain entries with ports", () => {
    const result = config({ allowlist: ["*.example.com:443"], dnsServers: ["192.168.2.1"] });

    expect(result.dns["fake-ip-filter"]).toEqual([".example.com"]);
    expect(result.rules).toContain(
      "AND,(DOMAIN-WILDCARD,*.example.com,DIRECT),(DST-PORT,443,DIRECT),DIRECT",
    );
  });

  it("keeps IP entries out of the fake-ip whitelist", () => {
    const result = config({
      allowlist: ["pypi.org", "192.168.2.18", "192.168.2.18:8848"],
      dnsServers: ["192.168.2.1"],
    });

    expect(result.dns["fake-ip-filter"]).toEqual(["pypi.org"]);
  });

  it("omits the fake-ip whitelist but keeps DNS-layer rejection when the allowlist is empty", () => {
    const result = config({ allowlist: [], dnsServers: ["192.168.2.1"] });

    expect(result.rules).toEqual(["MATCH,REJECT"]);
    // whitelist 模式下没有白名单 = 没有域名拿 fake IP，一切域名都走默认拒绝
    expect(result.dns["fake-ip-filter"]).toBeUndefined();
    expect(result.dns.nameserver).toEqual(["rcode://name_error"]);
  });

  it("routes plain IP and CIDR entries via IP-CIDR with no-resolve", () => {
    const result = config({
      allowlist: ["192.168.2.18", "10.0.0.0/8"],
      dnsServers: ["192.168.2.1"],
    });

    expect(result.rules).toContain("IP-CIDR,192.168.2.18/32,DIRECT,no-resolve");
    expect(result.rules).toContain("IP-CIDR,10.0.0.0/8,DIRECT,no-resolve");
  });

  it("routes ip:port entries via AND of IP-CIDR and DST-PORT", () => {
    const result = config({ allowlist: ["192.168.2.18:8848"], dnsServers: ["192.168.2.1"] });

    expect(result.rules).toContain(
      "AND,(IP-CIDR,192.168.2.18/32,DIRECT,no-resolve),(DST-PORT,8848,DIRECT),DIRECT",
    );
  });

  it("supports bracketed IPv6 with port via IP-CIDR6", () => {
    const result = config({ allowlist: ["[::1]:80"], dnsServers: ["192.168.2.1"] });

    expect(result.rules).toContain(
      "AND,(IP-CIDR6,::1/128,DIRECT,no-resolve),(DST-PORT,80,DIRECT),DIRECT",
    );
  });

  it("configures the tun inbound with routing and dns hijack", () => {
    const result = config({ allowlist: ["pypi.org"], dnsServers: ["192.168.2.1"] });

    expect(TUN_MTU).toBe(1500);
    expect(result.tun).toEqual({
      enable: true,
      stack: "mixed",
      mtu: TUN_MTU,
      "auto-route": true,
      "strict-route": true,
      "auto-detect-interface": true,
      "dns-hijack": ["any:53"],
    });
  });

  it("rejects invalid allowlist entries", () => {
    expect(() =>
      generateMihomoConfig({ allowlist: ["example.com:abc"], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/example\.com:abc/);
    expect(() =>
      generateMihomoConfig({ allowlist: ["example.com:70000"], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/Invalid port/);
    expect(() =>
      generateMihomoConfig({ allowlist: ["", "pypi.org"], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/Invalid allowlist entry/);
    expect(() => generateMihomoConfig({ allowlist: [":80"], dnsServers: ["192.168.2.1"] })).toThrow(
      /Invalid allowlist entry/,
    );
    // 裸 IPv6（无方括号）报错并提示用 [] 包裹
    expect(() => generateMihomoConfig({ allowlist: ["::1"], dnsServers: ["192.168.2.1"] })).toThrow(
      /wrapped in brackets/,
    );
    // 含逗号/括号等规则注入字符的域名报错
    expect(() =>
      generateMihomoConfig({ allowlist: ["a,b.com"], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/Invalid allowlist entry/);
    expect(() =>
      generateMihomoConfig({ allowlist: ["evil.com),("], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/Invalid allowlist entry/);
  });

  it("rejects wildcard entries that are ambiguous or too wide", () => {
    // 单独的 "*" 等于放行一切
    expectEntryRejected("*", /must be followed by a domain/);
    expectEntryRejected("*.", /must be followed by a domain/);
    // "*" 必须占据完整的最左标签
    expectEntryRejected("*example.com", /must occupy the whole leftmost label/);
    expectEntryRejected("a.*.example.com", /only allowed as the leftmost label/);
    expectEntryRejected("*.*.example.com", /only allowed as the leftmost label/);
    // 通配只对域名有效
    expectEntryRejected("*.1.2.3.4", /applies to domains only/);
    expectEntryRejected("*.1.2.3.*", /only allowed as the leftmost label/);
  });

  it("rejects an empty nameserver list", () => {
    expect(() => generateMihomoConfig({ allowlist: [], dnsServers: [] })).toThrow(
      /At least one DNS server/,
    );
  });
});
