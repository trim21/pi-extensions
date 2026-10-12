/**
 * Tests for bwrap core helpers:
 * - buildMountPlan: writable "." resolves against the workspace argument, so
 *   a per-command workdir can never move the sandbox write boundary.
 */
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  buildMountPlan,
  completeBwrapConfig,
  findBwrap,
  findGitDirs,
  resolveBwrap,
  type ResolvedBwrap,
  type SandboxMount,
} from "../src/bwrap/core.ts";

describe("findBwrap", () => {
  it("throws when the configured bwrapPath does not exist", () => {
    expect(() => findBwrap("/nonexistent/bwrap")).toThrow(/not found at configured path/);
  });

  it("returns an existing configured path", () => {
    expect(findBwrap(process.execPath)).toBe(process.execPath);
  });
});

describe("resolveBwrap", () => {
  it("resolves fs workspace-write with network allow-all", () => {
    const resolved = resolveBwrap({
      fs: {
        mode: "workspace-write",
        writablePaths: [".", "/tmp"],
        extraWritablePaths: [],
        denyPaths: [],
      },
      network: { mode: "allow-all", allowlist: [] },
      extraArgs: [],
    });

    expect(resolved.fs).toBe("workspace-write");
    expect(resolved.network).toBe("allow-all");
    expect(resolved.bwrapEnabled).toBe(true);
    expect(resolved.writablePaths).toEqual([".", "/tmp"]);
  });

  it("resolves fs workspace-write with network block", () => {
    const resolved = resolveBwrap({
      fs: {
        mode: "workspace-write",
        writablePaths: [".", "/tmp"],
        extraWritablePaths: [],
        denyPaths: [],
      },
      network: { mode: "block", allowlist: [] },
      extraArgs: [],
    });

    expect(resolved.bwrapEnabled).toBe(true);
    expect(resolved.network).toBe("block");
  });

  it("resolves fs readonly with network allow-all（旧 mode 矩阵表达不出的组合）", () => {
    const resolved = resolveBwrap({
      fs: { mode: "readonly", writablePaths: [".", "/tmp"], extraWritablePaths: [], denyPaths: [] },
      network: { mode: "allow-all", allowlist: [] },
      extraArgs: [],
    });

    expect(resolved.bwrapEnabled).toBe(true);
    expect(resolved.writablePaths).toEqual([]);
  });

  it("resolves fs allow-all：沙箱内整根可写，但 network block 仍需包裹", () => {
    const resolved = resolveBwrap({
      fs: {
        mode: "allow-all",
        writablePaths: [".", "/tmp"],
        extraWritablePaths: [],
        denyPaths: [],
      },
      network: { mode: "block", allowlist: [] },
      extraArgs: [],
    });

    expect(resolved.bwrapEnabled).toBe(true);
    expect(resolved.writablePaths).toEqual(["/"]);
  });

  it("resolves fs allow-all with network allow-all：完全不经沙箱", () => {
    const resolved = resolveBwrap({
      fs: {
        mode: "allow-all",
        writablePaths: [".", "/tmp"],
        extraWritablePaths: [],
        denyPaths: [],
      },
      network: { mode: "allow-all", allowlist: [] },
      extraArgs: [],
    });

    expect(resolved.bwrapEnabled).toBe(false);
  });
});

describe("completeBwrapConfig", () => {
  it("fills the defaults so callers can pass a minimal config file shape", () => {
    const config = completeBwrapConfig({ fs: { mode: "readonly" } });
    expect(config).toMatchObject({
      fs: {
        mode: "readonly",
        writablePaths: [".", "/tmp"],
        extraWritablePaths: [],
        denyPaths: [],
      },
      network: { mode: "block", allowlist: [] },
      extraArgs: [],
    });
  });

  it("keeps declared extraWritablePaths over the defaults", () => {
    const config = completeBwrapConfig({ fs: { mode: "readonly", extraWritablePaths: ["/tmp"] } });
    expect(config.fs.extraWritablePaths).toEqual(["/tmp"]);
  });
});

/** 取出指定模式的挂载目标路径，便于断言顺序与内容。 */
function targets(mounts: SandboxMount[], mode: SandboxMount["mode"]): string[] {
  return mounts.filter((mount) => mount.mode === mode).map((mount) => mount.path);
}

describe("buildMountPlan", () => {
  const base: ResolvedBwrap = {
    fs: "workspace-write",
    network: "block",
    bwrapEnabled: true,
    writablePaths: [".", "/tmp"],
    extraWritablePaths: [],
    denyPaths: [],
    extraArgs: [],
    networkAllowlist: [],
    approvalRules: [],
  };

  it("binds writable '.' to the workspace argument, not the exec cwd", async () => {
    const plan = await buildMountPlan(base, "/ws");

    // writablePaths 的 "." 解析为 workspace（/ws）；workspace 不存在时无 .git 等保护挂载。
    expect(plan.root).toBe("/");
    expect(plan.mounts).toEqual([
      { path: "/ws", mode: "rw-try" },
      { path: "/tmp", mode: "rw-try" },
      { path: join("/ws", ".pi"), mode: "ro-try" },
      { path: join("/ws", ".agent"), mode: "ro-try" },
    ]);
  });

  it("keeps extra writable paths in order after the writable paths", async () => {
    const plan = await buildMountPlan({ ...base, extraWritablePaths: ["/data/x"] }, "/ws");

    expect(targets(plan.mounts, "rw-try")).toEqual(["/ws", "/tmp", "/data/x"]);
  });

  it("deny paths: trailing slash means dir, otherwise file", async () => {
    const plan = await buildMountPlan(
      { ...base, denyPaths: ["/etc/secret/", "/home/user/.git-credentials"] },
      "/ws",
    );

    expect(targets(plan.mounts, "deny-dir")).toEqual(["/etc/secret/"]);
    expect(targets(plan.mounts, "deny-file")).toEqual(["/home/user/.git-credentials"]);
  });

  it("resolves symlink components in writable paths to their real path", async () => {
    // bwrap 创建挂载点时不跟随 symlink：含 symlink 组件的路径必须先解析成真实路径
    const root = mkdtempSync(join(tmpdir(), "cc-bwrap-link-"));
    mkdirSync(join(root, "real-target", "data"), { recursive: true });
    symlinkSync(join(root, "real-target"), join(root, "link"));

    const plan = await buildMountPlan(
      { ...base, extraWritablePaths: [join(root, "link", "data/")] },
      "/ws",
    );

    const real = join(root, "real-target", "data");
    expect(targets(plan.mounts, "rw-try")).toContain(real);
    expect(plan.mounts.filter((mount) => mount.path.includes("/link/"))).toEqual([]);
  });

  it("resolves symlink components in deny paths to their real path", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-bwrap-deny-link-"));
    mkdirSync(join(root, "real-target", "secret"), { recursive: true });
    symlinkSync(join(root, "real-target"), join(root, "link"));

    const plan = await buildMountPlan(
      { ...base, denyPaths: [`${join(root, "link", "secret")}/`] },
      "/ws",
    );

    expect(targets(plan.mounts, "deny-dir")).toEqual([join(root, "real-target", "secret")]);
  });

  it("protects workspace-internal dot dirs instead of the exec cwd's", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cc-bwrap-args-"));
    mkdirSync(join(workspace, ".git"));
    const plan = await buildMountPlan(base, workspace);

    // 只保护 workspace 下的 dot dirs；exec cwd（/outside）不在保护列表
    expect(targets(plan.mounts, "ro-try")).toEqual([
      join(workspace, ".pi"),
      join(workspace, ".agent"),
      join(workspace, ".git"),
    ]);
  });

  it("fs allow-all：整根可写、不做保护绑定", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cc-bwrap-allowall-"));
    mkdirSync(join(workspace, ".git"));
    const plan = await buildMountPlan(
      { ...base, fs: "allow-all", writablePaths: ["/"] },
      workspace,
    );

    expect(plan.mounts).toContainEqual({ path: "/", mode: "rw-try" });
    expect(targets(plan.mounts, "ro-try")).toEqual([]);
  });

  it("protects only the root .git when the workspace is a git repo", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cc-bwrap-git-"));
    mkdirSync(join(workspace, ".git"));
    mkdirSync(join(workspace, "sub", ".git"), { recursive: true });
    const plan = await buildMountPlan(base, workspace);

    // 根 .git 存在：不递归扫描，嵌套仓库不在保护列表
    expect(targets(plan.mounts, "ro-try").filter((path) => path.endsWith(".git"))).toEqual([
      join(workspace, ".git"),
    ]);
  });

  it("scans for nested .git when the workspace root is not a git repo", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cc-bwrap-nested-"));
    mkdirSync(join(workspace, "sub", ".git"), { recursive: true });
    const plan = await buildMountPlan(base, workspace);

    expect(targets(plan.mounts, "ro-try").filter((path) => path.endsWith(".git"))).toEqual([
      join(workspace, "sub", ".git"),
    ]);
  });
});

describe("findGitDirs", () => {
  it("collects nested .git directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-gitdirs-"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "packages", "a", ".git"), { recursive: true });
    mkdirSync(join(root, "packages", "b", ".git"), { recursive: true });

    const dirs = await findGitDirs(root);
    expect(dirs.toSorted()).toEqual(
      [
        join(root, ".git"),
        join(root, "packages", "a", ".git"),
        join(root, "packages", "b", ".git"),
      ].toSorted(),
    );
  });

  it("skips package directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-gitdirs-skip-"));
    mkdirSync(join(root, "node_modules", "pkg", ".git"), { recursive: true });
    mkdirSync(join(root, ".venv", "proj", ".git"), { recursive: true });
    mkdirSync(join(root, "real", ".git"), { recursive: true });

    expect(await findGitDirs(root)).toEqual([join(root, "real", ".git")]);
  });

  it("does not follow symlinked directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-gitdirs-link-"));
    mkdirSync(join(root, "real", ".git"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "loop"));

    expect(await findGitDirs(root)).toEqual([join(root, "real", ".git")]);
  });
});
