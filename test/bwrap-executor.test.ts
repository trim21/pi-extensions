/**
 * 原生执行器驱动层（src/bwrap/executor.ts）单测：
 * - resolveSandboxBinary：PI_SANDBOX_BINARY 覆盖、平台 / 架构不支持、随包路径缺失
 * - resolveMihomoPath / resolveSlirp4netnsPath：配置覆盖与 PATH 查找
 * - runSandboxExecutor：退出码映射（0 / 命令码 / 124 / 125 / 信号）、stderr 分流、abort
 *
 * 退出码与 abort 用假的 `PI_SANDBOX_BINARY` 脚本驱动，不依赖真实 bwrap / mihomo；
 * 真实执行器的 host 集成行为由 bwrap-netstack-integration.test.ts 覆盖。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  resolveMihomoPath,
  resolveSandboxBinary,
  resolveSlirp4netnsPath,
  runSandboxExecutor,
  type SandboxPolicy,
  TimeoutError,
} from "../src/bwrap/executor.js";

/** 假执行器：只按环境变量回显输出并返回指定退出码，用来验证 TS 侧的映射与分流。 */
const FAKE_SCRIPT = `#!/bin/sh
[ -n "$FAKE_STDOUT" ] && printf '%s' "$FAKE_STDOUT"
[ -n "$FAKE_STDERR" ] && printf '%s\\n' "$FAKE_STDERR" >&2
[ -n "$FAKE_NETSTACK" ] && printf '[netstack] %s\\n' "$FAKE_NETSTACK" >&2
[ "$FAKE_READ_STDIN" = "1" ] && read _line
[ -n "$FAKE_SIGNAL" ] && kill -"$FAKE_SIGNAL" $$
exit "\${FAKE_EXIT:-0}"
`;

const FAKE_KEYS = [
  "FAKE_STDOUT",
  "FAKE_STDERR",
  "FAKE_NETSTACK",
  "FAKE_READ_STDIN",
  "FAKE_SIGNAL",
  "FAKE_EXIT",
];

/** 每个用例一个临时目录：fake 执行器脚本放这里。 */
let dir: string;
let fakeExecutor: string;

beforeAll(() => {
  // 诊断日志落盘到 agent-dir/tmp：测试环境指向可写的临时目录，避免污染真实 agent 目录
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "bwrap-executor-agent-"));
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bwrap-executor-"));
  fakeExecutor = join(dir, "fake-executor");
  writeFileSync(fakeExecutor, FAKE_SCRIPT, { mode: 0o755 });
  chmodSync(fakeExecutor, 0o755);
  process.env.PI_SANDBOX_BINARY = fakeExecutor;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PI_SANDBOX_BINARY;
  for (const key of FAKE_KEYS) {
    delete process.env[key];
  }
});

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    root: "/",
    mounts: [],
    extraArgs: [],
    network: { mode: "block", allowlist: [], dnsServers: [] },
    mihomo: { path: "", mtu: 1500 },
    slirp4netns: { path: "" },
    bwrap: { path: "/usr/bin/bwrap" },
    command: "true",
    shell: "/bin/bash",
    cwd: "/tmp",
    env: {},
    timeoutSeconds: 0,
    ...overrides,
  };
}

async function sandboxLogs(): Promise<string[]> {
  try {
    return (await readdir(join(getAgentDir(), "tmp")))
      .filter((name) => name.startsWith("bwrap-sandbox-"))
      .toSorted();
  } catch {
    return [];
  }
}

/** 从错误信息里取出诊断日志路径。 */
function logPathOf(error: Error): string {
  return /\(sandbox diagnostics: (.+)\)/.exec(error.message)?.[1] ?? "";
}

describe("resolveSandboxBinary", () => {
  it("returns the PI_SANDBOX_BINARY override when it exists", () => {
    expect(resolveSandboxBinary({ env: { PI_SANDBOX_BINARY: fakeExecutor } })).toBe(fakeExecutor);
  });

  it("throws when the PI_SANDBOX_BINARY override is missing", () => {
    expect(() =>
      resolveSandboxBinary({ env: { PI_SANDBOX_BINARY: join(dir, "missing") } }),
    ).toThrow(/PI_SANDBOX_BINARY points to a missing file/);
  });

  it("throws on unsupported platforms", () => {
    expect(() => resolveSandboxBinary({ env: {}, platform: "darwin", arch: "x64" })).toThrow(
      /only supports Linux/,
    );
  });

  it("throws on unsupported architectures", () => {
    expect(() => resolveSandboxBinary({ env: {}, platform: "linux", arch: "riscv64" })).toThrow(
      /does not support the riscv64 architecture/,
    );
  });

  it("looks up the packaged binary for the current linux arch", () => {
    // 仓库不跟踪二进制产物：直接跑测试时它可能不存在，两条路径都断言查找位置。
    const expected = `bin/native/linux-${process.arch === "arm64" ? "arm64" : "x64"}/sandbox`;
    try {
      expect(resolveSandboxBinary({ env: {} })).toContain(expected);
    } catch (error) {
      expect((error as Error).message).toContain(expected);
      expect((error as Error).message).toContain("PI_SANDBOX_BINARY");
    }
  });
});

describe("resolveMihomoPath / resolveSlirp4netnsPath", () => {
  it("throws when the configured path does not exist", () => {
    expect(() => resolveMihomoPath("/nonexistent/mihomo")).toThrow(
      /mihomo not found at configured path/,
    );
    expect(() => resolveSlirp4netnsPath("/nonexistent/slirp4netns")).toThrow(
      /slirp4netns not found at configured path/,
    );
  });

  it("returns a configured existing path", () => {
    expect(resolveMihomoPath(fakeExecutor)).toBe(fakeExecutor);
  });

  it("finds the binary in PATH and reports a missing one", () => {
    const originalPath = process.env.PATH;
    const mihomo = join(dir, "mihomo");
    writeFileSync(mihomo, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      process.env.PATH = dir;
      expect(resolveMihomoPath()).toBe(mihomo);
      process.env.PATH = "";
      expect(() => resolveSlirp4netnsPath()).toThrow(/slirp4netns not found in PATH/);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("runSandboxExecutor exit code mapping", () => {
  it("passes the command exit code through", async () => {
    process.env.FAKE_EXIT = "7";
    await expect(runSandboxExecutor(policy(), { onData: () => {} })).resolves.toEqual({
      exitCode: 7,
    });
  });

  it("resolves 0 on success", async () => {
    await expect(runSandboxExecutor(policy(), { onData: () => {} })).resolves.toEqual({
      exitCode: 0,
    });
  });

  it("maps 124 to TimeoutError", async () => {
    process.env.FAKE_EXIT = "124";
    await expect(
      runSandboxExecutor(policy({ timeoutSeconds: 3 }), { onData: () => {} }),
    ).rejects.toBeInstanceOf(TimeoutError);
    await expect(
      runSandboxExecutor(policy({ timeoutSeconds: 3 }), { onData: () => {} }),
    ).rejects.toThrow(/timeout:3/);
  });

  it("maps 125 to a startup failure with the stderr tail and a diagnostics log", async () => {
    process.env.FAKE_EXIT = "125";
    process.env.FAKE_STDERR = "mihomo: command not found";
    const error = (await runSandboxExecutor(policy(), { onData: () => {} }).catch(
      (error_: unknown) => error_,
    )) as Error;
    expect(error.message).toContain("Sandbox failed to start (executor exit code 125)");
    expect(error.message).toContain("mihomo: command not found");
    const logPath = logPathOf(error);
    expect(logPath).not.toBe("");
    expect(readFileSync(logPath, "utf8")).toContain("mihomo: command not found");
  });

  it("maps an executor killed by a signal to a failure with diagnostics", async () => {
    process.env.FAKE_SIGNAL = "TERM";
    process.env.FAKE_STDERR = "boom";
    const error = (await runSandboxExecutor(policy(), { onData: () => {} }).catch(
      (error_: unknown) => error_,
    )) as Error;
    expect(error.message).toContain("exited before the command finished");
    expect(logPathOf(error)).not.toBe("");
  });

  it("does not write a diagnostics log for a command that exits non-zero", async () => {
    process.env.FAKE_EXIT = "1";
    const before = await sandboxLogs();
    await expect(runSandboxExecutor(policy(), { onData: () => {} })).resolves.toEqual({
      exitCode: 1,
    });
    expect(await sandboxLogs()).toEqual(before);
  });
});

describe("runSandboxExecutor output routing", () => {
  it("forwards stdout and command stderr, and routes [netstack] lines to onDiagnostic", async () => {
    process.env.FAKE_STDOUT = "out";
    process.env.FAKE_STDERR = "err";
    process.env.FAKE_NETSTACK = "tun up";
    let output = "";
    const diagnostics: string[] = [];
    await runSandboxExecutor(policy(), {
      onData: (data) => {
        output += data.toString();
      },
      onDiagnostic: (line) => {
        diagnostics.push(line);
      },
    });
    expect(output).toBe("outerr\n");
    expect(diagnostics).toEqual(["tun up"]);
  });
});

describe("runSandboxExecutor abort", () => {
  it("rejects with the abort reason once the executor exits on stdin close", async () => {
    // 假执行器读到 stdin EOF 后自行退出，走"先关 stdin"的优雅路径
    process.env.FAKE_READ_STDIN = "1";
    const controller = new AbortController();
    const promise = runSandboxExecutor(policy(), {
      onData: () => {},
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
