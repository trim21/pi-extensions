/**
 * 配置驱动 LSP 服务器测试（server-config.ts）：
 * - serverConfigSchema 解析（含未知键透传，不因此拒绝整份配置）
 * - mergeServerRecords 覆盖 / 新增 / 保留
 * - ConfigAdapter.findRoot：include glob（相对 root/cwd）、rootMarkers 查找
 * - ConfigAdapter.spawn：bin 解析（绝对路径 / 项目工作区 / PATH）、cwd 模板、
 *   initialization / settings / languageIds 分离
 * - 集成：配置 servers 启动 mock LSP server、include 过滤、per-server 超时、
 *   settings 通过 didChangeConfiguration / workspace/configuration 传递
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import { create } from "../src/lib/lsp/client.js";
import { createLspService } from "../src/lib/lsp/lsp.js";
import {
  ConfigAdapter,
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
      rootMarkers: ["go.mod"],
      bin: "gopls",
      args: [],
      cwd: "{root}",
      languageIdByExtension: { ".go": "go" },
      startupTimeoutMs: 45_000,
      diagnosticsWaitMs: 1500,
      initializationOptions: {},
      settings: {},
    });
    expect(config.include).toEqual(["**/*.go"]);
    expect(config.initializationOptions).toEqual({});
  });

  it("历史配置残留的 per-server enabled 不影响解析（未知键透传）", () => {
    expect(() => parse({ enabled: false, bin: "x" })).not.toThrow();
  });

  it("非法字段（bin 为数字）被 typebox 拒绝", () => {
    expect(() => parse({ bin: 42 })).toThrow();
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

describe("ConfigAdapter.findRoot", () => {
  it("include 匹配 + rootMarkers 从上级目录找根", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    await writeFile(join(dir, "go.mod"), "module x\n");
    const nested = join(dir, "pkg", "sub");
    await mkdir(nested, { recursive: true });
    const file = join(nested, "main.go");
    await writeFile(file, "package main\n");

    const adapter = new ConfigAdapter(
      "gopls",
      parse({
        include: ["**/*.go"],
        rootMarkers: ["go.mod"],
        bin: "gopls",
      }),
    );
    expect(await adapter.findRoot(file, dir)).toBe(dir);

    const py = join(dir, "x.py");
    await writeFile(py, "x = 1\n");
    expect(await adapter.findRoot(py, dir)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("include 支持相对项目根的 pattern", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    await writeFile(join(dir, "go.mod"), "module x\n");
    const src = join(dir, "src");
    await mkdir(src);
    const file = join(src, "main.go");
    await writeFile(file, "package main\n");

    const adapter = new ConfigAdapter(
      "gopls",
      parse({
        include: ["src/**"],
        rootMarkers: ["go.mod"],
        bin: "gopls",
      }),
    );
    expect(await adapter.findRoot(file, dir)).toBe(dir);
    expect(await adapter.findRoot(join(dir, "other", "main.go"), dir)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("include 缺省匹配所有文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const file = join(dir, "a.txt");
    await writeFile(file, "hi\n");
    const adapter = new ConfigAdapter("x", parse({ bin: "x" }));
    expect(await adapter.findRoot(file, dir)).toBe(dir);
    await rm(dir, { recursive: true, force: true });
  });

  it("include 多 pattern 支持 `!` 否定排除", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    await writeFile(join(dir, "go.mod"), "module x\n");
    const file = join(dir, "main.go");
    await writeFile(file, "package main\n");
    const testFile = join(dir, "main_test.go");
    await writeFile(testFile, "package main\n");

    const adapter = new ConfigAdapter(
      "gopls",
      parse({
        include: ["**/*.go", "!**/*_test.go"],
        rootMarkers: ["go.mod"],
        bin: "gopls",
      }),
    );
    expect(await adapter.findRoot(file, dir)).toBe(dir);
    expect(await adapter.findRoot(testFile, dir)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("ConfigAdapter.spawn", () => {
  it("bin 绝对路径直接使用，cwd 模板与 settings/languageIds 传递", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const sub = join(dir, "nested");
    await mkdir(sub);

    const adapter = new ConfigAdapter(
      "mock",
      parse({
        bin: process.execPath,
        args: [fixture],
        cwd: "{root}",
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
        rootMarkers: [],
        bin: process.execPath,
        args: [fixture],
        cwd: "{root}",
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
        rootMarkers: [],
        bin: process.execPath,
        args: [fixture],
        cwd: "{root}",
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

  it("startupTimeoutMs 覆盖默认 initialize 超时（不应答时快速失败）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-server-config-"));
    const file = join(dir, "x.py");
    await writeFile(file, "x = 1\n");
    const service = await withConfig(dir, {
      mock: {
        include: ["**/*.py"],
        rootMarkers: [],
        bin: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
        cwd: "{root}",
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
