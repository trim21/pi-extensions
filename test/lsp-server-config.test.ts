/**
 * 配置驱动 LSP 服务器测试（server-config.ts）：
 * - serverConfigSchema 解析（含未知键透传，不因此拒绝整份配置）
 * - mergeServerRecords 覆盖 / 新增 / 保留
 * - serverRoot：root 计算（workingDir 相对 cwd 解析 / 缺省即 cwd）
 * - matchesInclude：include glob（相对 root/cwd）、`!` 否定排除
 * - ConfigAdapter.spawn：bin 解析（绝对路径 / 项目工作区 / PATH）、
 *   initialization / settings / languageIds 分离
 * - 集成：配置 servers 启动 mock LSP server、include / workingDir 过滤、
 *   per-server 超时、settings 通过 didChangeConfiguration / workspace/configuration 传递
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import { serverRoot } from "../src/lib/lsp/adapter.js";
import { create } from "../src/lib/lsp/client.js";
import { createLspService } from "../src/lib/lsp/lsp.js";
import {
  ConfigAdapter,
  matchesInclude,
  mergeServerRecords,
  serverConfigSchema,
} from "../src/lib/lsp/server-config.js";

const fixture = fileURLToPath(new URL("fixtures/mock-lsp-server.mjs", import.meta.url));
const settingsFixture = fileURLToPath(
  new URL("fixtures/mock-lsp-server-settings.mjs", import.meta.url),
);

function parse(config: unknown) {
  return Value.Parse(serverConfigSchema, config);
}

async function waitForLog(logFile: string, needle: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await readFile(logFile, "utf8").catch(() => "");
    if (content.includes(needle)) return content;
    if (Date.now() > deadline) throw new Error(`log entry not found: ${needle}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("serverConfigSchema", () => {
  it("解析完整配置", () => {
    const config = parse({
      include: ["**/*.go"],
      workingDir: "sdk/go",
      bin: "gopls",
      args: [],
      env: { VIRTUAL_ENV: "/venv" },
      languageIdByExtension: { ".go": "go" },
      startupTimeoutMs: 45_000,
      diagnosticsWaitMs: 1500,
      initializationOptions: {},
      settings: {},
    });
    expect(config.include).toEqual(["**/*.go"]);
    expect(config.env).toEqual({ VIRTUAL_ENV: "/venv" });
    expect(config.initializationOptions).toEqual({});
  });

  it("历史配置残留的 per-server enabled 不影响解析（未知键透传）", () => {
    expect(() => parse({ enabled: false, bin: "x" })).not.toThrow();
  });

  it("非法字段（bin 为数字）被 typebox 拒绝", () => {
    expect(() => parse({ bin: 42 })).toThrow();
  });

  it("kind 接受 language / linter，缺省 undefined（由 ConfigAdapter 补 language）", () => {
    expect(parse({ bin: "x", kind: "language" }).kind).toBe("language");
    expect(parse({ bin: "x", kind: "linter" }).kind).toBe("linter");
    expect(parse({ bin: "x" }).kind).toBeUndefined();
  });

  it("kind 非法值被 typebox 拒绝", () => {
    expect(() => parse({ bin: "x", kind: "formatter" })).toThrow();
    expect(() => parse({ bin: "x", kind: 42 })).toThrow();
  });
});

describe("ConfigAdapter.kind", () => {
  it("缺省为 language，显式配置透传", () => {
    expect(new ConfigAdapter("a", parse({ bin: "x" })).kind).toBe("language");
    expect(new ConfigAdapter("b", parse({ bin: "x", kind: "linter" })).kind).toBe("linter");
  });
});

describe("mergeServerRecords", () => {
  it("无任何 record 时返回 undefined", () => {
    expect(mergeServerRecords()).toBeUndefined();
    expect(mergeServerRecords(undefined, undefined)).toBeUndefined();
  });

  it("同 id 整体覆盖、新 id 追加、未提及的 id 保留", () => {
    const merged = mergeServerRecords(
      { a: parse({ bin: "/global/a", args: ["--x"] }), b: parse({ bin: "/global/b" }) },
      { a: parse({ bin: "/local/a" }), c: parse({ bin: "/local/c" }) },
    );
    expect(merged).toEqual({
      a: parse({ bin: "/local/a" }),
      b: parse({ bin: "/global/b" }),
      c: parse({ bin: "/local/c" }),
    });
  });
});

describe("serverRoot", () => {
  it("workingDir 未配置时 root 即调用 cwd", () => {
    expect(serverRoot(undefined, "/ws")).toBe("/ws");
  });

  it("workingDir 相对路径按 cwd 解析，绝对路径原样", () => {
    expect(serverRoot("sdk/python", "/ws")).toBe(join("/ws", "sdk/python"));
    expect(serverRoot("/abs/root", "/ws")).toBe("/abs/root");
  });
});

describe("matchesInclude", () => {
  it("相对 root 的 pattern，任一候选命中即可", () => {
    expect(matchesInclude(["**/*.go"], "/ws/src/main.go", "/ws", "/ws")).toBe(true);
    expect(matchesInclude(["**/*.go"], "/ws/x.py", "/ws", "/ws")).toBe(false);
  });

  it("支持相对项目根的子路径 pattern", () => {
    expect(matchesInclude(["src/**"], "/ws/src/main.go", "/ws", "/ws")).toBe(true);
    expect(matchesInclude(["src/**"], "/ws/other/main.go", "/ws", "/ws")).toBe(false);
  });

  it("缺省匹配所有文件", () => {
    expect(matchesInclude([], "/ws/a.txt", "/ws", "/ws")).toBe(true);
  });

  it("多 pattern 支持 `!` 否定排除", () => {
    const patterns = ["**/*.go", "!**/*_test.go"];
    expect(matchesInclude(patterns, "/ws/main.go", "/ws", "/ws")).toBe(true);
    expect(matchesInclude(patterns, "/ws/main_test.go", "/ws", "/ws")).toBe(false);
  });
});

describe("ConfigAdapter.spawn", () => {
  it("bin 绝对路径直接使用，settings/languageIds 传递", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const sub = join(dir, "nested");
    await mkdir(sub);

    const adapter = new ConfigAdapter(
      "mock",
      parse({
        bin: process.execPath,
        args: [fixture],
        languageIdByExtension: { ".py": "python" },
        initializationOptions: { pythonPath: "/venv/python" },
        settings: { python: { pythonPath: "/venv/python" } },
      }),
    );
    const handle = await adapter.spawn(sub, dir);
    expect(handle).toBeDefined();
    expect(handle?.process.spawnargs[0]).toBe(process.execPath);
    expect(handle?.initialization).toEqual({ pythonPath: "/venv/python" });
    expect(handle?.settings).toEqual({ python: { pythonPath: "/venv/python" } });
    expect(handle?.languageIds).toEqual({ ".py": "python" });
    handle?.process.kill();
    await new Promise((resolve) => handle!.process.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("bin 是名字时项目工作区优先，PATH 兜底", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    if (process.platform === "win32") {
      // Windows 只能直接执行 .exe/.cmd/.bat；脚本挂起 60s 供 kill 断言
      await writeFile(join(binDir, "my-lsp.cmd"), "@echo off\r\nping -n 60 127.0.0.1 >nul\r\n");
    } else {
      const script = join(binDir, "my-lsp");
      await writeFile(script, "#!/bin/sh\n");
      await chmod(script, 0o755);
    }

    const adapter = new ConfigAdapter("x", parse({ bin: "my-lsp" }));
    vi.stubEnv("PATH", binDir);
    try {
      const handle = await adapter.spawn(dir, dir);
      expect(handle).toBeDefined();
      handle?.process.kill();
      await new Promise((resolve) => handle!.process.once("exit", resolve));
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bin 不存在或缺失时返回 undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const missing = new ConfigAdapter("x", parse({ bin: "definitely-not-a-real-lsp-bin" }));
    expect(await missing.spawn(dir, dir)).toBeUndefined();
    const noBin = new ConfigAdapter("y", parse({}));
    expect(await noBin.spawn(dir, dir)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("env 传给子进程，值支持 {root} / {cwd} 模板与环境变量引用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const logFile = join(dir, "env.json");
    vi.stubEnv("PATH_SUFFIX", "/extra");
    try {
      const script = [
        `require("node:fs").writeFileSync(${JSON.stringify(logFile)}`,
        ` JSON.stringify({VIRTUAL_ENV: process.env.VIRTUAL_ENV`,
        ` PATH_APPEND: process.env.PATH_APPEND`,
        ` FROM_UNDEF: process.env.FROM_UNDEF}))`,
      ].join(",");
      const adapter = new ConfigAdapter(
        "mock",
        parse({
          bin: process.execPath,
          args: ["-e", script],
          env: {
            VIRTUAL_ENV: "{root}/.venv",
            PATH_APPEND: "${PATH_SUFFIX}",
            FROM_UNDEF: "${MOCK_TEST_UNDEF_VAR:-fallback}",
          },
        }),
      );
      const handle = await adapter.spawn(dir, dir);
      await new Promise((resolve) => handle!.process.once("exit", resolve));
      const env = JSON.parse(await readFile(logFile, "utf8"));
      expect(env.VIRTUAL_ENV).toBe(join(dir, ".venv"));
      expect(env.PATH_APPEND).toBe("/extra");
      expect(env.FROM_UNDEF).toBe("fallback");
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("initializationOptions 字符串值做 ${VAR} / ${VAR:-default} 深插值", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    vi.stubEnv("MOCK_TEST_PY", "/stubbed/venv");
    try {
      const adapter = new ConfigAdapter(
        "mock",
        parse({
          bin: process.execPath,
          args: ["-e", "setTimeout(() => {}, 10000)"],
          initializationOptions: {
            pythonPath: "${MOCK_TEST_PY}/bin/python",
            fallback: "${MOCK_TEST_UNDEF_VAR:-/default/venv}",
            unset: "${MOCK_TEST_UNDEF_VAR}",
            nested: { list: ["${MOCK_TEST_PY}"] },
            count: 42,
          },
        }),
      );
      const handle = await adapter.spawn(dir, dir);
      expect(handle?.initialization).toEqual({
        pythonPath: "/stubbed/venv/bin/python",
        fallback: "/default/venv",
        unset: "",
        nested: { list: ["/stubbed/venv"] },
        count: 42,
      });
      handle?.process.kill();
      await new Promise((resolve) => handle!.process.once("exit", resolve));
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("initializationOptions 插值可引用配置 env 里的变量", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const adapter = new ConfigAdapter(
      "mock",
      parse({
        bin: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        env: { MOCK_TEST_CONFIG_ENV: "/config/venv" },
        initializationOptions: { pythonPath: "${MOCK_TEST_CONFIG_ENV}/bin/python" },
      }),
    );
    const handle = await adapter.spawn(dir, dir);
    expect(handle?.initialization).toEqual({ pythonPath: "/config/venv/bin/python" });
    handle?.process.kill();
    await new Promise((resolve) => handle!.process.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("env {sh} 执行命令取 stdout（trim），命令在 spawn cwd 下运行，可被 initializationOptions 引用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const adapter = new ConfigAdapter(
      "mock",
      parse({
        bin: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        env: {
          TOKEN: {
            sh: [
              process.execPath,
              "-e",
              String.raw`require("node:fs").writeFileSync("cwd.txt", process.cwd());console.log(" secret\n")`,
            ],
          },
        },
        initializationOptions: { token: "${TOKEN}" },
      }),
    );
    const handle = await adapter.spawn(dir, dir);
    expect(await readFile(join(dir, "cwd.txt"), "utf8")).toBe(dir);
    expect(handle?.initialization).toEqual({ token: "secret" });
    handle?.process.kill();
    await new Promise((resolve) => handle!.process.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("env {sh} 命令失败（非零退出 / 空输出）时 spawn 抛错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    try {
      const failed = new ConfigAdapter(
        "mock",
        parse({
          bin: process.execPath,
          args: ["-e", "setTimeout(() => {}, 10000)"],
          env: { TOKEN: { sh: [process.execPath, "-e", "console.error('boom');process.exit(3)"] } },
        }),
      );
      await expect(failed.spawn(dir, dir)).rejects.toThrow(/exit code 3: boom/);

      const empty = new ConfigAdapter(
        "mock",
        parse({
          bin: process.execPath,
          args: ["-e", "setTimeout(() => {}, 10000)"],
          env: { TOKEN: { sh: [process.execPath, "-e", "process.exit(0)"] } },
        }),
      );
      await expect(empty.spawn(dir, dir)).rejects.toThrow(/produced empty output/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// 没有内置默认服务器：只写入本次 mock servers，并用空的全局配置路径
// 隔离本机 ~/.pi/agent/lsp.json。
async function withConfig(
  dir: string,
  servers: Record<string, unknown>,
): Promise<ReturnType<typeof createLspService>> {
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(
    join(dir, ".pi", "lsp.json"),
    JSON.stringify({
      version: 1,
      servers,
    }),
  );
  return createLspService(undefined, join(dir, "no-global.json"));
}

describe("config servers integration", () => {
  it("配置 servers 启动 mock LSP server 并产出诊断", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const file = join(dir, "x.py");
    await writeFile(file, "x = 1\n");
    const service = await withConfig(dir, {
      mock: {
        include: ["**/*.py"],
        bin: process.execPath,
        args: [fixture],
        languageIdByExtension: { ".py": "python" },
      },
    });
    try {
      const report = await service.lspDiagnosticsForFile(file, dir);
      expect(report.text).toContain("mock error message");
      expect(report.errorCount).toBe(1);
      expect(report.warningCount).toBe(0);
    } finally {
      await service.shutdownAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("include 不匹配的文件不启动服务器", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const go = join(dir, "y.go");
    await writeFile(go, "package y\n");
    const py = join(dir, "x.py");
    await writeFile(py, "x = 1\n");
    const service = await withConfig(dir, {
      mock: {
        include: ["**/*.go"],
        bin: process.execPath,
        args: [fixture],
        languageIdByExtension: { ".go": "go" },
      },
    });
    try {
      await service.touchFile(go, dir, "document");
      await service.touchFile(py, dir, "document");
      const all = await service.diagnostics();
      expect(all).toHaveProperty(go);
      expect(all).not.toHaveProperty(py);
    } finally {
      await service.shutdownAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("workingDir 限定 root：目录内文件启动服务器，目录外不处理", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const sub = join(dir, "sdk", "python");
    await mkdir(sub, { recursive: true });
    const inner = join(sub, "a.py");
    await writeFile(inner, "x = 1\n");
    const outer = join(dir, "b.py");
    await writeFile(outer, "x = 1\n");
    const service = await withConfig(dir, {
      mock: {
        include: ["**/*.py"],
        workingDir: "sdk/python",
        bin: process.execPath,
        args: [fixture],
        languageIdByExtension: { ".py": "python" },
      },
    });
    try {
      await service.touchFile(inner, dir, "document");
      await service.touchFile(outer, dir, "document");
      const all = await service.diagnostics();
      expect(all).toHaveProperty(inner);
      expect(all).not.toHaveProperty(outer);
    } finally {
      await service.shutdownAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("startupTimeoutMs 覆盖默认 initialize 超时（不应答时快速失败）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const file = join(dir, "x.py");
    await writeFile(file, "x = 1\n");
    const service = await withConfig(dir, {
      mock: {
        include: ["**/*.py"],
        bin: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
        languageIdByExtension: { ".py": "python" },
        startupTimeoutMs: 200,
      },
    });
    try {
      const start = Date.now();
      await service.touchFile(file, dir);
      expect(Date.now() - start).toBeLessThan(1_000);
    } finally {
      await service.shutdownAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("settings 与 initializationOptions 分离：didChangeConfiguration 与 configuration 请求走 settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const logFile = join(dir, "log.jsonl");
    const proc = spawn(process.execPath, [settingsFixture, logFile]);
    const client = await create({
      serverID: "cfg",
      server: {
        process: proc,
        initialization: { pythonPath: "/init/python" },
        settings: { python: { pythonPath: "/venv/python" } },
      },
      root: dir,
      directory: dir,
    });
    try {
      const log = await waitForLog(logFile, "didChangeConfiguration");
      expect(log).toContain('"pythonPath":"/venv/python"');
      expect(log).not.toContain("/init/python");
      const configLog = await waitForLog(logFile, "config-response");
      expect(configLog).toContain('"pythonPath":"/venv/python"');
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
