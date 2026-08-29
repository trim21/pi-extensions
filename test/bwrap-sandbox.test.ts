/**
 * 沙箱执行层（src/bwrap/sandbox.ts）测试：
 * - loadSandboxConfig：单文件配置、mode 覆盖、headless 策略、"." 归一化、缺失文件报错
 * - previewSandboxCommand：打印的 argv/环境 与实际执行语义一致（bind、--unshare-net、nsenter 包裹）
 * - runInSandbox / runSandboxCommand：本地（不经沙箱）与真实 bwrap 两条执行路径
 *
 * 真实 bwrap 用例需要可用的 unprivileged user namespace：先用一次最小 bwrap 探测，
 * 探测不通过则整组跳过（macOS、无 bubblewrap 或受限 CI 环境不应报假失败）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type BwrapConfigFile, findBwrap } from "../src/bwrap/core.js";
import {
  loadSandboxConfig,
  previewSandboxCommand,
  runInSandbox,
  runSandboxCommand,
} from "../src/bwrap/sandbox.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "bwrap-sandbox-"));
}

/** 写一份配置文件并返回路径（字段缺省由 core 的默认值补齐）。 */
function config(directory: string, overrides: BwrapConfigFile): string {
  const path = join(directory, "bwrap.json");
  writeFileSync(path, `${JSON.stringify(overrides, null, 2)}\n`);
  return path;
}

function bwrapUsable(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  let binary: string;
  try {
    binary = findBwrap();
  } catch {
    return false;
  }
  const probe = spawnSync(
    binary,
    [
      "--ro-bind",
      "/",
      "/",
      "--unshare-user",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--",
      "/bin/true",
    ],
    { timeout: 20000 },
  );
  return probe.status === 0;
}

const sandbox = bwrapUsable();

describe("loadSandboxConfig", () => {
  it("只读显式配置文件，并把 '.' 归一化成绝对工作区", () => {
    const directory = workspace();
    const file = config(directory, {
      mode: "workspace-write",
      writablePaths: [".", "/tmp"],
      denyPaths: ["/etc/shadow"],
    });

    const strategy = loadSandboxConfig({ workspace: directory, configPath: file });

    expect(strategy.mode).toBe("workspace-write");
    expect(strategy.bwrapEnabled).toBe(true);
    expect(strategy.network).toBe(false);
    expect(strategy.writablePaths).toEqual([directory, "/tmp"]);
    expect(strategy.denyPaths).toEqual(["/etc/shadow"]);
  });

  it("mode 参数覆盖配置文件", () => {
    const directory = workspace();
    const file = config(directory, { mode: "readonly" });

    expect(loadSandboxConfig({ workspace: directory, configPath: file }).mode).toBe("readonly");
    expect(
      loadSandboxConfig({ workspace: directory, configPath: file, mode: "allow-net" }).mode,
    ).toBe("allow-net");
  });

  it("headless 策略强制 readonly 且无可写路径", () => {
    const directory = workspace();
    const file = config(directory, {
      mode: "net-allowlist",
      writablePaths: [".", "/tmp"],
      networkAllowlist: ["pypi.org"],
    });

    const strategy = loadSandboxConfig({ workspace: directory, configPath: file, headless: true });

    expect(strategy.mode).toBe("readonly");
    expect(strategy.writablePaths).toEqual([]);
    expect(strategy.network).toBe(false);
  });

  it("显式配置文件不存在时直接报错，不静默回落到默认值", () => {
    const directory = workspace();

    expect(() =>
      loadSandboxConfig({ workspace: directory, configPath: join(directory, "missing.json") }),
    ).toThrow(/configuration file not found/);
  });
});

describe("previewSandboxCommand", () => {
  it("workspace-write：绑定工作区、禁网、命令落在 shell -lc 尾部", async () => {
    const directory = workspace();
    const strategy = loadSandboxConfig({
      workspace: directory,
      configPath: config(directory, { mode: "workspace-write" }),
    });

    const preview = await previewSandboxCommand(strategy, {
      workspace: directory,
      command: "echo 1",
    });

    expect(preview.needsNetworkStack).toBe(false);
    expect(preview.argv.slice(0, 3)).toEqual([expect.any(String), "--ro-bind", "/"]);
    expect(preview.argv).toEqual(
      expect.arrayContaining(["--bind-try", directory, directory, "--unshare-net"]),
    );
    expect(preview.argv.slice(-4)).toEqual([
      "--",
      expect.stringMatching(/bash$/u),
      "-lc",
      "echo 1",
    ]);
  });

  it("干净环境只带 5 个变量，不继承父进程 PATH", async () => {
    const directory = workspace();
    const strategy = loadSandboxConfig({
      workspace: directory,
      configPath: config(directory, { mode: "workspace-write" }),
    });

    const preview = await previewSandboxCommand(strategy, {
      workspace: directory,
      command: "true",
    });

    expect(Object.keys(preview.env).toSorted()).toEqual(["HOME", "LANG", "PATH", "SHELL", "TERM"]);
    expect(preview.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });

  it("net-allowlist：命令包在 nsenter 之内", async () => {
    const directory = workspace();
    const strategy = loadSandboxConfig({
      workspace: directory,
      configPath: config(directory, {
        mode: "net-allowlist",
        networkAllowlist: ["pypi.org"],
      }),
    });

    const withoutHolder = await previewSandboxCommand(strategy, {
      workspace: directory,
      command: "curl -sS https://pypi.org/simple/",
    });
    const withHolder = await previewSandboxCommand(strategy, {
      workspace: directory,
      command: "curl -sS https://pypi.org/simple/",
      holderPid: 4242,
    });

    expect(withoutHolder.needsNetworkStack).toBe(true);
    expect(withoutHolder.argv.slice(0, 6)).toEqual([
      "nsenter",
      "-U",
      "-n",
      "--preserve-credentials",
      "-t",
      "$HOLDER_PID",
    ]);
    expect(withHolder.argv[5]).toBe("4242");
    expect(withHolder.argv).not.toContain("--unshare-net");
  });
});

describe("runInSandbox（不经 bwrap）", () => {
  it("unsandboxed 走本地执行：流式输出与退出码", async () => {
    const directory = workspace();
    const strategy = loadSandboxConfig({
      workspace: directory,
      configPath: config(directory, { mode: "readonly" }),
    });
    let output = "";

    const result = await runInSandbox(strategy, {
      workspace: directory,
      command: "printf local-path; exit 7",
      unsandboxed: true,
      onData: (data) => {
        output += data.toString();
      },
    });

    expect(output).toContain("local-path");
    expect(result.exitCode).toBe(7);
  });

  it("allow-all 模式无需显式 unsandboxed 即可执行", async () => {
    const directory = workspace();
    let output = "";

    const result = await runSandboxCommand({
      workspace: directory,
      command: "printf allow-all",
      configPath: config(directory, { mode: "allow-all" }),
      onData: (data) => {
        output += data.toString();
      },
    });

    expect(result.exitCode).toBe(0);
    expect(output).toContain("allow-all");
  });

  it("超时抛出 TimeoutError", async () => {
    const directory = workspace();

    await expect(
      runInSandbox(
        loadSandboxConfig({
          workspace: directory,
          configPath: config(directory, { mode: "allow-all" }),
        }),
        {
          workspace: directory,
          command: "sleep 5",
          timeout: 1,
          unsandboxed: true,
          onData: () => {},
        },
      ),
    ).rejects.toThrow(/timeout:1/u);
  });
});

describe.skipIf(!sandbox)("runInSandbox（真实 bwrap）", () => {
  it("workspace-write：工作区可写，输出与退出码回传", async () => {
    const directory = workspace();
    let output = "";

    const result = await runSandboxCommand({
      workspace: directory,
      command: "printf written > note.txt && cat note.txt",
      configPath: config(directory, { mode: "workspace-write", writablePaths: ["."] }),
      onData: (data) => {
        output += data.toString();
      },
    });

    expect(result.exitCode).toBe(0);
    expect(output).toContain("written");
    expect(readFileSync(join(directory, "note.txt"), "utf8")).toBe("written");
  }, 60000);

  it("readonly：读得到宿主文件，写不进去", async () => {
    const directory = workspace();
    const readable = join(directory, "exists.txt");
    writeFileSync(readable, "host-content");
    const configPath = config(directory, { mode: "readonly" });

    const read = await runSandboxCommand({
      workspace: directory,
      command: `cat ${readable}`,
      configPath,
      onData: () => {},
    });
    expect(read.exitCode).toBe(0);

    let output = "";
    const write = await runInSandbox(loadSandboxConfig({ workspace: directory, configPath }), {
      workspace: directory,
      command: `printf nope > ${join(directory, "nope.txt")}`,
      onData: (data) => {
        output += data.toString();
      },
    });
    expect(write.exitCode).not.toBe(0);
    expect(output).toMatch(/Read-only file system|Operation not permitted/u);
    expect(() => readFileSync(join(directory, "nope.txt"), "utf8")).toThrow();
  }, 60000);

  it("workspace-write 下宿主工作区之外的路径仍然只读", async () => {
    const directory = workspace();
    const outside = workspace();

    const result = await runSandboxCommand({
      workspace: directory,
      command: `printf nope > ${join(outside, "nope.txt")}`,
      configPath: config(directory, { mode: "workspace-write", writablePaths: ["."] }),
      onData: () => {},
    });

    expect(result.exitCode).not.toBe(0);
    expect(() => readFileSync(join(outside, "nope.txt"), "utf8")).toThrow();
  }, 60000);
});
