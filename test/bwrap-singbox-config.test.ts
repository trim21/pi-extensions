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

  it("rejects an empty nameserver list", () => {
    expect(() => generateSingboxConfig({ allowlist: [], dnsServers: [] })).toThrow(
      /At least one DNS server/,
    );
  });
});
