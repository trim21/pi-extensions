/**
 * Tests for bwrap subagent policies:
 * - resolveSubagentBwrap: subagent sessions force read-only bash regardless
 *   of config (no writable paths, no network, no extra args).
 * - resolveEscalation: request_full_access is denied in subagent and other
 *   headless sessions, and requires the approval dialog in interactive ones.
 */
import { describe, expect, it } from "vitest";

import { resolveEscalation, resolveSubagentBwrap } from "../src/bwrap/index.js";

describe("resolveSubagentBwrap", () => {
  it("forces read-only regardless of the configured mode", () => {
    const resolved = resolveSubagentBwrap({
      mode: "allow-all",
      writablePaths: [".", "/tmp"],
      extraWritablePaths: [],
      tmpfsPaths: [],
      extraArgs: [],
    });

    expect(resolved.mode).toBe("readonly");
    expect(resolved.bwrapEnabled).toBe(true);
    expect(resolved.network).toBe(false);
    expect(resolved.writablePaths).toEqual([]);
  });

  it("drops configured writable paths, tmpfs mounts and extra args", () => {
    const resolved = resolveSubagentBwrap({
      mode: "workspace-write",
      writablePaths: [".", "/tmp"],
      extraWritablePaths: ["~/.cache", "~/go/pkg"],
      tmpfsPaths: ["/tmp/scratch"],
      extraArgs: ["--bind", "/x", "/x"],
    });

    expect(resolved.mode).toBe("readonly");
    expect(resolved.writablePaths).toEqual([]);
    expect(resolved.extraWritablePaths).toEqual([]);
    expect(resolved.tmpfsPaths).toEqual([]);
    expect(resolved.extraArgs).toEqual([]);
  });
});

describe("resolveEscalation", () => {
  it("denies escalation in subagent sessions even when UI exists", () => {
    const decision = resolveEscalation({ hasUI: true, isSubagentChild: true });

    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toContain("subagent");
    }
  });

  it("denies escalation in headless sessions without UI", () => {
    const decision = resolveEscalation({ hasUI: false, isSubagentChild: false });

    expect(decision.kind).toBe("deny");
  });

  it("requires the approval dialog in interactive sessions", () => {
    const decision = resolveEscalation({ hasUI: true, isSubagentChild: false });

    expect(decision.kind).toBe("dialog");
  });
});
