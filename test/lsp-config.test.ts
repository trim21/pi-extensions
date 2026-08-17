/**
 * lsp.json 配置测试（全局 ~/.pi/agent/lsp.json + 本地 <cwd>/.pi/lsp.json）：
 * - loadLspConfig 解析 / 全局本地合并 / 字段校验
 * - filterAdapters 白名单 / 排除过滤
 * - 集成：配置过滤后未启用的 adapter 不 spawn（mock stdio LSP server 走真实握手）
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { LspServerAdapter } from "../src/lib/lsp/adapter.js";
import { createLspService, filterAdapters, loadLspConfig } from "../src/lib/lsp/lsp.js";

const fixture = fileURLToPath(new URL("fixtures/mock-lsp-server.mjs", import.meta.url));

function plainAdapter(id: string, extensions: readonly string[] = []): LspServerAdapter {
  return {
    id,
    extensions,
    findRoot: async () => "",
    spawn: async () => {
      return;
    },
  };
}

/** 集成测试用：findRoot 指向 root，spawn 启动 mock stdio LSP server。 */
function mockAdapter(
  id: string,
  root: string,
): { adapter: LspServerAdapter; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn(async () => ({ process: spawnProcess(process.execPath, [fixture]) }));
  return {
    adapter: {
      id,
      extensions: [".py"],
      findRoot: async () => root,
      spawn,
    },
    spawn,
  };
}

describe("loadLspConfig", () => {
  it("解析本地配置：超时支持 number 和带单位的字符串", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-config-"));
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "lsp.json"),
      JSON.stringify({
        enabled: ["pyright"],
        initializeTimeoutMs: 10_000,
        diagnosticsDebounceMs: "5s",
      }),
    );
    expect(await loadLspConfig(dir, join(dir, "global.json"))).toEqual({
      enabled: ["pyright"],
      initializeTimeoutMs: 10_000,
      diagnosticsDebounceMs: "5s", // 原始写法保留，换算在 timeoutOptions
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("全局为基底、本地逐字段覆盖", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-config-"));
    const globalFile = join(dir, "global.json");
    await writeFile(
      globalFile,
      JSON.stringify({
        enabled: ["typescript", "pyright"],
        disabled: ["clangd"],
        diagnosticsDocumentWaitTimeoutMs: 3_000,
        initializeTimeoutMs: 60_000,
      }),
    );
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "lsp.json"),
      JSON.stringify({ disabled: ["ruff"], initializeTimeoutMs: 10_000 }),
    );

    expect(await loadLspConfig(dir, globalFile)).toEqual({
      enabled: ["typescript", "pyright"],
      disabled: ["ruff"], // 本地覆盖全局
      diagnosticsDocumentWaitTimeoutMs: 3_000, // 全局保留
      initializeTimeoutMs: 10_000, // 本地覆盖
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("缺配置文件或解析失败时返回空配置（全部启用）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-config-"));
    expect(await loadLspConfig(dir, join(dir, "nope.json"))).toEqual({});

    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "lsp.json"), "not json");
    expect(await loadLspConfig(dir, join(dir, "nope.json"))).toEqual({});

    // typebox 严格验证：字段类型不符 / number 小于 1 都会使整个配置解析失败
    await writeFile(
      join(dir, ".pi", "lsp.json"),
      JSON.stringify({ enabled: 42, initializeTimeoutMs: -1 }),
    );
    expect(await loadLspConfig(dir, join(dir, "nope.json"))).toEqual({});

    await writeFile(
      join(dir, ".pi", "lsp.json"),
      JSON.stringify({ enabled: ["pyright", 1, null], disabled: ["ruff", {}] }),
    );
    expect(await loadLspConfig(dir, join(dir, "nope.json"))).toEqual({});
    await rm(dir, { recursive: true, force: true });
  });
});

describe("filterAdapters", () => {
  const adapters = [plainAdapter("a"), plainAdapter("b"), plainAdapter("c")];

  it("无配置时全部启用", () => {
    expect(filterAdapters(adapters, {}).map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("enabled 白名单只保留列出的", () => {
    expect(filterAdapters(adapters, { enabled: ["a", "b"] }).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("disabled 排除列出的", () => {
    expect(filterAdapters(adapters, { disabled: ["c"] }).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("enabled 与 disabled 同时作用", () => {
    expect(
      filterAdapters(adapters, { enabled: ["a", "b", "c"], disabled: ["b"] }).map((a) => a.id),
    ).toEqual(["a", "c"]);
  });
});

describe("lsp config integration", () => {
  it("超时配置传递到 client（initialize 不应答时按配置快速失败）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-config-"));
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "lsp.json"), JSON.stringify({ initializeTimeoutMs: "200ms" }));
    const file = join(dir, "x.py");
    await writeFile(file, "x = 1\n");

    // spawn 一个不应答 initialize 的进程
    const spawn = vi.fn(async () => ({
      process: spawnProcess(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1000)"]),
    }));
    const adapter: LspServerAdapter = {
      id: "a",
      extensions: [".py"],
      findRoot: async () => dir,
      spawn,
    };

    const service = createLspService([adapter]);
    const start = Date.now();
    await service.touchFile(file, dir);
    expect(Date.now() - start).toBeLessThan(1_000);
    // 启动失败已记入 broken，第二次不再尝试 spawn
    await service.touchFile(file, dir);
    expect(spawn).toHaveBeenCalledOnce();
    await service.shutdownAll();
    await rm(dir, { recursive: true, force: true });
  });

  it("disabled 的 adapter 不被 spawn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-config-"));
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "lsp.json"), JSON.stringify({ disabled: ["b"] }));
    const file = join(dir, "x.py");
    await writeFile(file, "x = 1\n");

    const a = mockAdapter("a", dir);
    const b = mockAdapter("b", dir);

    const service = createLspService([a.adapter, b.adapter]);
    await service.touchFile(file, dir);
    expect(a.spawn).toHaveBeenCalledOnce();
    expect(b.spawn).not.toHaveBeenCalled();
    await service.shutdownAll();
    await rm(dir, { recursive: true, force: true });
  });

  it("enabled 白名单外的 adapter 不被 spawn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-config-"));
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "lsp.json"), JSON.stringify({ enabled: ["a"] }));
    const file = join(dir, "x.py");
    await writeFile(file, "x = 1\n");

    const a = mockAdapter("a", dir);
    const b = mockAdapter("b", dir);

    const service = createLspService([a.adapter, b.adapter]);
    await service.touchFile(file, dir);
    expect(a.spawn).toHaveBeenCalledOnce();
    expect(b.spawn).not.toHaveBeenCalled();
    await service.shutdownAll();
    await rm(dir, { recursive: true, force: true });
  });
});
