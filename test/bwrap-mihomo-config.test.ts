import { describe, expect, it } from "vitest";

import {
  generateMihomoConfig,
  type MihomoConfig,
  type MihomoConfigOptions,
} from "../src/bwrap/mihomo-config.js";

function config(options: MihomoConfigOptions): MihomoConfig {
  return generateMihomoConfig(options);
}

describe("generateMihomoConfig", () => {
  it("emits fakeip dns with the configured nameservers", () => {
    const result = config({ allowlist: ["pypi.org"], dnsServers: ["192.168.2.1", "223.5.5.5"] });

    expect(result.mode).toBe("rule");
    expect(result.dns["enhanced-mode"]).toBe("fake-ip");
    expect(result.dns["fake-ip-range"]).toBe("198.18.0.1/16");
    expect(result.dns.nameserver).toEqual(["192.168.2.1", "223.5.5.5"]);
  });

  it("routes allowlist domains to direct via DOMAIN-SUFFIX and blocks everything else", () => {
    const result = config({
      allowlist: ["pypi.org", "files.pythonhosted.org"],
      dnsServers: ["192.168.2.1"],
    });

    expect(result.rules).toContain("DOMAIN-SUFFIX,pypi.org,DIRECT");
    expect(result.rules).toContain("DOMAIN-SUFFIX,files.pythonhosted.org,DIRECT");
    expect(result.rules.at(-1)).toBe("MATCH,REJECT");
  });

  it("rejects non-allowlist domains at the DNS layer instead of via fake-ip", () => {
    const result = config({
      allowlist: ["pypi.org", "192.168.2.18"],
      dnsServers: ["192.168.2.1"],
    });

    // allowlist 域名正常解析；IP 条目不参与 DNS 规则（按域名匹配）
    expect(result.dns.rules).toEqual(["DOMAIN-SUFFIX,pypi.org,DIRECT", "MATCH,REJECT"]);
  });

  it("matches allowlist domain:port entries at the DNS layer by domain only", () => {
    const result = config({ allowlist: ["example.com:443"], dnsServers: ["192.168.2.1"] });

    expect(result.dns.rules).toEqual(["DOMAIN-SUFFIX,example.com,DIRECT", "MATCH,REJECT"]);
  });

  it("puts allowlist domains into fake-ip-filter for real resolution", () => {
    const result = config({
      allowlist: ["pypi.org", "192.168.2.18:8848"],
      dnsServers: ["192.168.2.1"],
    });

    expect(result.dns["fake-ip-filter"]).toEqual(["+.pypi.org"]);
  });

  it("omits fake-ip-filter and allowlist rules when the allowlist is empty", () => {
    const result = config({ allowlist: [], dnsServers: ["192.168.2.1"] });

    expect(result.rules).toEqual(["MATCH,REJECT"]);
    expect(result.dns["fake-ip-filter"]).toBeUndefined();
    // deny-by-default 同样作用于 DNS 层
    expect(result.dns.rules).toEqual(["MATCH,REJECT"]);
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

  it("routes domain:port entries via AND of DOMAIN-SUFFIX and DST-PORT", () => {
    const result = config({ allowlist: ["example.com:443"], dnsServers: ["192.168.2.1"] });

    expect(result.rules).toContain(
      "AND,(DOMAIN-SUFFIX,example.com,DIRECT),(DST-PORT,443,DIRECT),DIRECT",
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

    expect(result.tun).toEqual({
      enable: true,
      stack: "mixed",
      mtu: 1500,
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

  it("rejects an empty nameserver list", () => {
    expect(() => generateMihomoConfig({ allowlist: [], dnsServers: [] })).toThrow(
      /At least one DNS server/,
    );
  });
});
