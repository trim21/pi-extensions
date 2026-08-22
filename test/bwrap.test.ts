/**
 * Tests for bwrap headless policies:
 * - resolveHeadlessBwrap: sessions without UI force read-only bash regardless
 *   of config (no writable paths, no network, no extra args).
 * - resolveEscalation: request_full_access is denied without UI and requires
 *   the approval dialog when UI is available.
 * - buildBwrapArgs: writable "." resolves against the workspace argument, so
 *   a per-command workdir can never move the sandbox write boundary.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildBwrapArgs,
  findBwrap,
  resolveBwrap,
  type ResolvedBwrap,
  resolveHeadlessBwrap,
} from "../src/bwrap/core.ts";
import { resolveEscalation } from "../src/bwrap/runtime.ts";

describe("findBwrap", () => {
  it("throws when the configured bwrapPath does not exist", () => {
    expect(() => findBwrap("/nonexistent/bwrap")).toThrow(/not found at configured path/);
  });

  it("returns an existing configured path", () => {
    expect(findBwrap(process.execPath)).toBe(process.execPath);
  });
});

describe("resolveBwrap", () => {
  it("resolves allow-net with sandbox on and network on", () => {
    const resolved = resolveBwrap({
      mode: "allow-net",
      writablePaths: [".", "/tmp"],
      extraWritablePaths: [],
      tmpfsPaths: [],
      extraArgs: [],
    });

    expect(resolved.mode).toBe("allow-net");
    expect(resolved.bwrapEnabled).toBe(true);
    expect(resolved.network).toBe(true);
    expect(resolved.writablePaths).toEqual([".", "/tmp"]);
  });

  it("resolves workspace-write with network off", () => {
    const resolved = resolveBwrap({
      mode: "workspace-write",
      writablePaths: [".", "/tmp"],
      extraWritablePaths: [],
      tmpfsPaths: [],
      extraArgs: [],
    });

    expect(resolved.bwrapEnabled).toBe(true);
    expect(resolved.network).toBe(false);
  });
});

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

describe("buildBwrapArgs", () => {
  const base: ResolvedBwrap = {
    mode: "workspace-write",
    bwrapEnabled: true,
    network: false,
    writablePaths: [".", "/tmp"],
    extraWritablePaths: [],
    tmpfsPaths: [],
    extraArgs: [],
    approvalRules: [],
  };

  it("binds writable '.' to the workspace argument, not the exec cwd", () => {
    const args = buildBwrapArgs(base, "/ws");

    // writablePaths 的 "." 解析为 workspace（/ws）；workspace 不存在时无 .git 等保护挂载
    expect(args).toEqual([
      "--new-session",
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--bind",
      "/ws",
      "/ws",
      "--bind",
      "/tmp",
      "/tmp",
      "--unshare-net",
    ]);
  });

  it("keeps extra writable paths as-is", () => {
    const args = buildBwrapArgs({ ...base, extraWritablePaths: ["/data/x"] }, "/ws");

    // 顺序：writable binds → extra binds → unshare-net
    const bindsEnd = args.indexOf("--unshare-net");
    expect(args.slice(0, bindsEnd)).toEqual([
      "--new-session",
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--bind",
      "/ws",
      "/ws",
      "--bind",
      "/tmp",
      "/tmp",
      "--bind",
      "/data/x",
      "/data/x",
    ]);
  });

  it("protects workspace-internal dot dirs instead of the exec cwd's", () => {
    const workspace = mkdtempSync(join(tmpdir(), "cc-bwrap-args-"));
    mkdirSync(join(workspace, ".git"));
    const args = buildBwrapArgs(base, workspace);

    // 只保护 workspace 下实际存在的 .git；exec cwd（/outside）不在保护列表
    const roBindTargets = args.flatMap((value, index) =>
      value === "--ro-bind" ? [args[index + 1]] : [],
    );
    expect(roBindTargets).toEqual([join(workspace, ".git")]);
  });
});
