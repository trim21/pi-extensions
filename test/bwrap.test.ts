/**
 * Tests for bwrap headless policies:
 * - resolveHeadlessBwrap: sessions without UI force read-only bash regardless
 *   of config (no writable paths, no network, no extra args).
 * - resolveEscalation: request_full_access is denied without UI and requires
 *   the approval dialog when UI is available.
 */
import { describe, expect, it } from "vitest";

import { resolveEscalation, resolveHeadlessBwrap } from "../src/bwrap/index.js";

describe("resolveHeadlessBwrap", () => {
  it("forces read-only regardless of the configured mode", () => {
    const resolved = resolveHeadlessBwrap({
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
    const resolved = resolveHeadlessBwrap({
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
  it("denies escalation in headless sessions without UI", () => {
    const decision = resolveEscalation({ hasUI: false });

    expect(decision.kind).toBe("deny");
  });

  it("requires the approval dialog in interactive sessions", () => {
    const decision = resolveEscalation({ hasUI: true });

    expect(decision.kind).toBe("dialog");
  });
});
