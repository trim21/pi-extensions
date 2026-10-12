/**
 * 上游 DNS 选择（`src/bwrap/network-stack.ts` 的 `routableDnsServers`）：loopback 在沙箱内
 * 指向网络栈自身、不能当上游；IPv6 无法通过只提供 IPv4 的 egress 通道。
 */
import { describe, expect, it } from "vitest";

import { routableDnsServers } from "../src/bwrap/network-stack.js";

describe("routableDnsServers", () => {
  it("保留可路由的 IPv4 nameserver 与顺序", () => {
    expect(routableDnsServers(["223.5.5.5", "192.168.2.1"])).toEqual(["223.5.5.5", "192.168.2.1"]);
  });

  it("排除 loopback：在沙箱内它指向网络栈自身", () => {
    expect(routableDnsServers(["127.0.0.53", "223.5.5.5"])).toEqual(["223.5.5.5"]);
    expect(routableDnsServers(["localhost", "1.1.1.1"])).toEqual(["1.1.1.1"]);
    // 宿主只有 stub 时整份都会被排除，调用方再回退到真实上游或 egress 解析器
    expect(routableDnsServers(["127.0.0.53"])).toEqual([]);
  });

  it("排除 IPv6：egress 通道只提供 IPv4", () => {
    expect(routableDnsServers(["240e:58::1", "8.8.8.8"])).toEqual(["8.8.8.8"]);
    expect(routableDnsServers(["::1"])).toEqual([]);
  });
});
