/**
 * 沙箱执行层（src/bwrap/sandbox.ts）测试：
 * - loadSandboxConfig：单文件配置、fs/network 覆盖、"." 归一化、缺失文件报错
 * - runInSandbox / runSandboxCommand：本地（不经沙箱）执行路径
 * - runInSandbox（原生执行器）：工作区可写 / 只读 / deny、symlink 挂载
 *
 * 真实沙箱用例需要随包分发的原生执行器 + 可用的 unprivileged user namespace：
 * 先用一个最小策略实跑探测，探测不通过则整组跳过（macOS、缺二进制或受限 CI 环境
 * 不应报假失败）。开发期可用 PI_SANDBOX_BINARY 指向 go build 的产物。
 */
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type BwrapConfigFile } from "../src/bwrap/core.js";
import { loadSandboxConfig, runInSandbox, runSandboxCommand } from "../src/bwrap/sandbox.js";
import { nativeSandboxUsable } from "./bwrap-native-probe.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "bwrap-sandbox-"));
}

/** 写一份配置文件并返回路径（字段缺省由 core 的默认值补齐）。 */
function config(directory: string, overrides: BwrapConfigFile): string {
  const path = join(directory, "sandbox.json");
  writeFileSync(path, `${JSON.stringify(overrides, null, 2)}\n`);
  return path;
}

const sandbox = nativeSandboxUsable();

describe("loadSandboxConfig", () => {
  it("只读显式配置文件，并把 '.' 归一化成绝对工作区", () => {
    const directory = workspace();
    const file = config(directory, {
      fs: {
        mode: "workspace-write",
        writablePaths: [".", "/tmp"],
        denyPaths: ["/etc/shadow"],
      },
    });

    const strategy = loadSandboxConfig({ workspace: directory, configPath: file });

    expect(strategy.fs).toBe("workspace-write");
    expect(strategy.bwrapEnabled).toBe(true);
    expect(strategy.network).toBe("block");
    expect(strategy.writablePaths).toEqual([directory, "/tmp"]);
    expect(strategy.denyPaths).toEqual(["/etc/shadow"]);
  });

  it("fsMode / networkMode 参数覆盖配置文件", () => {
    const directory = workspace();
    const file = config(directory, { fs: { mode: "readonly" } });

    expect(loadSandboxConfig({ workspace: directory, configPath: file }).fs).toBe("readonly");
    expect(
      loadSandboxConfig({ workspace: directory, configPath: file, fsMode: "allow-all" }).fs,
    ).toBe("allow-all");
    expect(
      loadSandboxConfig({ workspace: directory, configPath: file, networkMode: "limited" }).network,
    ).toBe("limited");
  });

  it("显式配置文件不存在时直接报错，不静默回落到默认值", () => {
    const directory = workspace();

    expect(() =>
      loadSandboxConfig({ workspace: directory, configPath: join(directory, "missing.json") }),
    ).toThrow(/configuration file not found/);
  });
});

describe("runInSandbox（不经 bwrap）", () => {
  it("unsandboxed 走本地执行：流式输出与退出码", async () => {
    const directory = workspace();
    const strategy = loadSandboxConfig({
      workspace: directory,
      configPath: config(directory, { fs: { mode: "readonly" } }),
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

  it("unsandboxed 走登录 shell：profile 导出的变量对命令可见", async () => {
    const directory = workspace();
    const home = workspace();
    writeFileSync(join(home, ".bash_profile"), "export LOGIN_MARKER=from-profile\n");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    let output = "";

    try {
      const result = await runInSandbox(
        loadSandboxConfig({ workspace: directory, configPath: config(directory, {}) }),
        {
          workspace: directory,
          command: 'printf %s "$LOGIN_MARKER"',
          unsandboxed: true,
          onData: (data) => {
            output += data.toString();
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(output).toBe("from-profile");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("unsandboxed 不继承父进程环境与 PATH", async () => {
    const directory = workspace();
    const fakeBin = workspace();
    const originalPath = process.env.PATH;
    const originalSecret = process.env.PI_TEST_SECRET;
    process.env.PI_TEST_SECRET = "leak";
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    let output = "";

    try {
      const result = await runInSandbox(
        loadSandboxConfig({ workspace: directory, configPath: config(directory, {}) }),
        {
          workspace: directory,
          command: 'printf "%s\\n%s" "${PI_TEST_SECRET-unset}" "$PATH"',
          unsandboxed: true,
          onData: (data) => {
            output += data.toString();
          },
        },
      );

      expect(result.exitCode).toBe(0);
      const [secret, path] = output.split("\n", 2);
      expect(secret).toBe("unset");
      expect(path).not.toContain(fakeBin);
    } finally {
      process.env.PATH = originalPath;
      if (originalSecret === undefined) {
        delete process.env.PI_TEST_SECRET;
      } else {
        process.env.PI_TEST_SECRET = originalSecret;
      }
    }
  });

  it("unsandboxed 路径同样注入额外环境变量", async () => {
    const directory = workspace();
    const strategy = loadSandboxConfig({
      workspace: directory,
      configPath: config(directory, { fs: { mode: "readonly" } }),
    });
    let output = "";

    const result = await runInSandbox(strategy, {
      workspace: directory,
      command: 'printf %s "$GIT_EDITOR"',
      unsandboxed: true,
      env: { GIT_EDITOR: "true" },
      onData: (data) => {
        output += data.toString();
      },
    });

    expect(result.exitCode).toBe(0);
    expect(output).toBe("true");
  });

  it("fs 与 network 均 allow-all 时无需显式 unsandboxed 即可执行", async () => {
    const directory = workspace();
    let output = "";

    const result = await runSandboxCommand({
      workspace: directory,
      command: "printf allow-all",
      configPath: config(directory, { fs: { mode: "allow-all" }, network: { mode: "allow-all" } }),
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
          configPath: config(directory, {
            fs: { mode: "allow-all" },
            network: { mode: "allow-all" },
          }),
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

  it("命令执行目录不存在时给出明确错误", async () => {
    const directory = workspace();
    const strategy = loadSandboxConfig({
      workspace: directory,
      configPath: config(directory, { fs: { mode: "readonly" } }),
    });

    await expect(
      runInSandbox(strategy, {
        workspace: directory,
        commandCwd: join(directory, "missing"),
        command: "true",
        onData: () => {},
      }),
    ).rejects.toThrow(/Working directory does not exist/u);
  });
});

describe.skipIf(!sandbox)("runInSandbox（原生执行器）", () => {
  it("workspace-write：工作区可写，输出与退出码回传", async () => {
    const directory = workspace();
    let output = "";

    const result = await runSandboxCommand({
      workspace: directory,
      command: "printf written > note.txt && cat note.txt",
      configPath: config(directory, { fs: { mode: "workspace-write", writablePaths: ["."] } }),
      onData: (data) => {
        output += data.toString();
      },
    });

    expect(result.exitCode).toBe(0);
    expect(output).toContain("written");
    expect(readFileSync(join(directory, "note.txt"), "utf8")).toBe("written");
  }, 60000);

  it("沙箱内命令拿到注入的环境变量", async () => {
    const directory = workspace();
    let output = "";

    const result = await runInSandbox(
      loadSandboxConfig({
        workspace: directory,
        configPath: config(directory, { fs: { mode: "workspace-write", writablePaths: ["."] } }),
      }),
      {
        workspace: directory,
        command: 'printf %s "$GIT_EDITOR"',
        env: { GIT_EDITOR: "true" },
        onData: (data) => {
          output += data.toString();
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output).toBe("true");
  }, 60000);

  it("两条路径的探针环境逐项相同", async () => {
    const directory = workspace();
    const strategy = loadSandboxConfig({
      workspace: directory,
      configPath: config(directory, { fs: { mode: "workspace-write", writablePaths: ["."] } }),
    });
    // 临时 HOME 隔离机器自己的 profile：两条路径读到的 profile 相同，剩下的差异只能来自
    // 执行层。机器 profile 里按「能否写盘 / 能否联网」分支的 hook 会在沙箱里走另一条路，
    // 那不是执行层行为。
    const home = workspace();
    writeFileSync(join(home, ".bash_profile"), "export LOGIN_MARKER=1\n");
    const originalHome = process.env.HOME;
    const originalParentOnly = process.env.PI_TEST_PARENT_ONLY;
    process.env.HOME = home;
    process.env.PI_TEST_PARENT_ONLY = "leak";

    // 只比执行层负责的变量：PATH 交给 shell 后会被 profile 按宿主环境重建（CI 上 profile
    // 会把 pixi 的 env bin 拼进去），不属于执行层保证的范围；它交给 shell 时的取值由
    // shellBaseEnv 的用例覆盖。
    const probeKeys = [
      "HOME",
      "SHELL",
      "TERM",
      "LANG",
      "GIT_EDITOR",
      "PI_TEST_INJECTED",
      "LOGIN_MARKER",
      "PI_TEST_PARENT_ONLY",
    ];

    const probeEnv = async (unsandboxed: boolean): Promise<string[]> => {
      let output = "";
      const result = await runInSandbox(strategy, {
        workspace: directory,
        command: "env",
        unsandboxed,
        env: { GIT_EDITOR: "true", PI_TEST_INJECTED: "injected" },
        onData: (data) => {
          output += data.toString();
        },
      });
      expect(result.exitCode).toBe(0);
      const seen = new Map(
        output
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      return probeKeys.map((key) => `${key}=${seen.get(key) ?? "<absent>"}`);
    };

    try {
      const localEnv = await probeEnv(true);
      expect(localEnv).toEqual(await probeEnv(false));
      expect(localEnv).toEqual([
        `HOME=${home}`,
        "SHELL=/bin/bash",
        "TERM=dumb",
        "LANG=C.UTF-8",
        "GIT_EDITOR=true",
        "PI_TEST_INJECTED=injected",
        "LOGIN_MARKER=1",
        "PI_TEST_PARENT_ONLY=<absent>",
      ]);
    } finally {
      process.env.HOME = originalHome;
      if (originalParentOnly === undefined) {
        delete process.env.PI_TEST_PARENT_ONLY;
      } else {
        process.env.PI_TEST_PARENT_ONLY = originalParentOnly;
      }
    }
  }, 60000);

  it("readonly：读得到宿主文件，写不进去", async () => {
    const directory = workspace();
    const readable = join(directory, "exists.txt");
    writeFileSync(readable, "host-content");
    const configPath = config(directory, { fs: { mode: "readonly" } });

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
      configPath: config(directory, { fs: { mode: "workspace-write", writablePaths: ["."] } }),
      onData: () => {},
    });

    expect(result.exitCode).not.toBe(0);
    expect(() => readFileSync(join(outside, "nope.txt"), "utf8")).toThrow();
  }, 60000);

  it("含绝对 symlink 组件的可写路径仍能挂载并写入（bwrap 不跟随挂载点路径里的 symlink）", async () => {
    const directory = workspace();
    const target = join(directory, "real-target", "data");
    mkdirSync(target, { recursive: true });
    symlinkSync(join(directory, "real-target"), join(directory, "link"));

    const result = await runSandboxCommand({
      workspace: directory,
      command: `printf ok > ${join(directory, "link", "data", "note.txt")}`,
      configPath: config(directory, {
        fs: {
          mode: "workspace-write",
          writablePaths: ["."],
          extraWritablePaths: [`${join(directory, "link", "data")}/`],
        },
      }),
      onData: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(target, "note.txt"), "utf8")).toBe("ok");
  }, 60000);
});
