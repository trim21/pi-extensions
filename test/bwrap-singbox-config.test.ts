import { describe, expect, it } from "vitest";

import { generateSingboxConfig } from "../src/bwrap/singbox-config.js";

interface DnsServer {
  type: string;
  tag: string;
  server?: string;
  server_port?: number;
  inet4_range?: string;
}

interface ParsedConfig {
  dns: {
    servers: DnsServer[];
    rules: Record<string, unknown>[];
    final: string;
  };
  outbounds: { type: string; tag: string; domain_resolver?: string }[];
  route: {
    default_interface: string;
    final: string;
    rules: {
      action?: string;
      protocol?: string;
      domain?: string[];
      ip_cidr?: string[];
      port?: number[];
      outbound?: string;
    }[];
  };
}

function parse(config: string): ParsedConfig {
  return JSON.parse(config) as ParsedConfig;
}

describe("generateSingboxConfig", () => {
  it("emits one udp server per nameserver plus a fakeip server", () => {
    const config = parse(
      generateSingboxConfig({
        allowlist: ["pypi.org"],
        dnsServers: ["192.168.2.1", "223.5.5.5", "119.29.29.29"],
      }),
    );

    expect(config.dns.servers).toEqual([
      { type: "udp", tag: "remote-0", server: "192.168.2.1", server_port: 53 },
      { type: "udp", tag: "remote-1", server: "223.5.5.5", server_port: 53 },
      { type: "udp", tag: "remote-2", server: "119.29.29.29", server_port: 53 },
      { type: "fakeip", tag: "fakeip", inet4_range: "198.18.0.0/15" },
    ]);
    // 最后一个 nameserver 作为兜底 default，前 N-1 个走 ip_accept_any 过滤链
    expect(config.dns.final).toBe("remote-2");
    expect(config.dns.rules).toContainEqual({ query_type: ["A", "AAAA"], server: "fakeip" });
    expect(config.dns.rules).toContainEqual({ server: "remote-0", ip_accept_any: true });
    expect(config.dns.rules).toContainEqual({ server: "remote-1", ip_accept_any: true });
  });

  it("routes allowlist domains to direct and blocks everything else", () => {
    const config = parse(
      generateSingboxConfig({
        allowlist: ["pypi.org", "files.pythonhosted.org"],
        dnsServers: ["192.168.2.1"],
      }),
    );

    expect(config.route.final).toBe("block");
    expect(config.route.rules).toContainEqual({
      domain: ["pypi.org", "files.pythonhosted.org"],
      outbound: "direct",
    });
    expect(config.route.rules).toContainEqual({ action: "sniff" });
    expect(config.route.rules).toContainEqual({ protocol: "dns", action: "hijack-dns" });
  });

  it("omits the allowlist rule when the allowlist is empty", () => {
    const config = parse(generateSingboxConfig({ allowlist: [], dnsServers: ["192.168.2.1"] }));

    expect(config.route.rules.some((rule) => rule.outbound === "direct")).toBe(false);
    expect(config.route.final).toBe("block");
  });

  it("does not set domain_resolver on the direct outbound (fallback needs rules)", () => {
    const config = parse(
      generateSingboxConfig({ allowlist: ["pypi.org"], dnsServers: ["192.168.2.1"] }),
    );

    expect(config.outbounds).toContainEqual({ type: "direct", tag: "direct" });
    expect(config.route.default_interface).toBe("tap0");
  });

  it("routes plain IP and CIDR entries via ip_cidr", () => {
    const config = parse(
      generateSingboxConfig({
        allowlist: ["192.168.2.18", "10.0.0.0/8"],
        dnsServers: ["192.168.2.1"],
      }),
    );

    expect(config.route.final).toBe("block");
    expect(config.route.rules).toContainEqual({
      ip_cidr: ["192.168.2.18/32", "10.0.0.0/8"],
      outbound: "direct",
    });
  });

  it("routes ip:port entries via ip_cidr plus port", () => {
    const config = parse(
      generateSingboxConfig({
        allowlist: ["192.168.2.18:8848"],
        dnsServers: ["192.168.2.1"],
      }),
    );

    expect(config.route.rules).toContainEqual({
      ip_cidr: ["192.168.2.18/32"],
      port: [8848],
      outbound: "direct",
    });
  });

  it("routes domain:port entries via domain plus port", () => {
    const config = parse(
      generateSingboxConfig({
        allowlist: ["example.com:443"],
        dnsServers: ["192.168.2.1"],
      }),
    );

    expect(config.route.rules).toContainEqual({
      domain: ["example.com"],
      port: [443],
      outbound: "direct",
    });
  });

  it("groups same-port hosts into one rule", () => {
    const config = parse(
      generateSingboxConfig({
        allowlist: ["example.com:443", "192.168.2.18:443"],
        dnsServers: ["192.168.2.1"],
      }),
    );

    expect(config.route.rules).toContainEqual({
      domain: ["example.com"],
      ip_cidr: ["192.168.2.18/32"],
      port: [443],
      outbound: "direct",
    });
  });

  it("supports bracketed IPv6 with port", () => {
    const config = parse(
      generateSingboxConfig({
        allowlist: ["[::1]:80", "[0:2:3]:1234"],
        dnsServers: ["192.168.2.1"],
      }),
    );

    expect(config.route.rules).toContainEqual({
      ip_cidr: ["::1/128"],
      port: [80],
      outbound: "direct",
    });
    expect(config.route.rules).toContainEqual({
      ip_cidr: ["0:2:3/128"],
      port: [1234],
      outbound: "direct",
    });
  });

  it("mixes domain and ip rules in one config", () => {
    const config = parse(
      generateSingboxConfig({
        allowlist: ["pypi.org", "192.168.2.18:8848"],
        dnsServers: ["192.168.2.1"],
      }),
    );

    expect(config.route.rules).toContainEqual({
      domain: ["pypi.org"],
      outbound: "direct",
    });
    expect(config.route.rules).toContainEqual({
      ip_cidr: ["192.168.2.18/32"],
      port: [8848],
      outbound: "direct",
    });
  });

  it("rejects invalid allowlist entries", () => {
    expect(() =>
      generateSingboxConfig({ allowlist: ["example.com:abc"], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/example\.com:abc/);
    expect(() =>
      generateSingboxConfig({ allowlist: ["example.com:70000"], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/Invalid port/);
    expect(() =>
      generateSingboxConfig({ allowlist: ["", "pypi.org"], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/Invalid allowlist entry/);
    expect(() =>
      generateSingboxConfig({ allowlist: [":80"], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/Invalid allowlist entry/);
    // 裸 IPv6（无方括号）报错并提示用 [] 包裹
    expect(() =>
      generateSingboxConfig({ allowlist: ["::1"], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/wrapped in brackets/);
    expect(() =>
      generateSingboxConfig({ allowlist: ["2001:db8::1"], dnsServers: ["192.168.2.1"] }),
    ).toThrow(/wrapped in brackets/);
  });

  it("rejects an empty nameserver list", () => {
    expect(() => generateSingboxConfig({ allowlist: [], dnsServers: [] })).toThrow(
      /At least one DNS server/,
    );
  });
});
