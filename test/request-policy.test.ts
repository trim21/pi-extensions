/**
 * 非沙盒请求策略的实例语义：每个扩展入口一份（pi 给每个入口单独建 jiti 实例，
 * 模块级状态不跨入口共享），传入 pi.events 的实例之间靠广播保持同步。
 */
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createRequestPolicy, REQUEST_POLICY_CHANNEL } from "../src/lib/request-policy.js";

describe("createRequestPolicy", () => {
  it("allows non-sandbox requests by default", () => {
    expect(createRequestPolicy().deniesRequests()).toBe(false);
  });

  it("keeps instances independent when no event bus is given", () => {
    const owner = createRequestPolicy();
    const other = createRequestPolicy();

    owner.setDenyRequests(true);

    expect(owner.deniesRequests()).toBe(true);
    expect(other.deniesRequests()).toBe(false);
  });

  it("mirrors changes to every instance sharing the event bus", () => {
    const bus = createEventBus();
    const bwrap = createRequestPolicy(bus);
    const webFetch = createRequestPolicy(bus);

    bwrap.setDenyRequests(true);
    expect(webFetch.deniesRequests()).toBe(true);

    bwrap.setDenyRequests(false);
    expect(webFetch.deniesRequests()).toBe(false);
  });

  it("accepts a valid broadcast from another entry", () => {
    const bus = createEventBus();
    const policy = createRequestPolicy(bus);

    bus.emit(REQUEST_POLICY_CHANNEL, { denyRequests: true });

    expect(policy.deniesRequests()).toBe(true);
  });

  it("ignores malformed broadcasts", () => {
    const bus = createEventBus();
    const policy = createRequestPolicy(bus);
    policy.setDenyRequests(true);

    for (const payload of [null, 42, "deny", {}, { denyRequests: "yes" }]) {
      bus.emit(REQUEST_POLICY_CHANNEL, payload);
    }

    expect(policy.deniesRequests()).toBe(true);
  });
});
