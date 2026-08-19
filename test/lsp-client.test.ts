/**
 * LSP 客户端测试：用 mock stdio LSP 服务器（fixtures/mock-lsp-server.mjs）
 * 验证 initialize 握手、didOpen、push 诊断等待与 shutdown。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { create } from "../src/lib/lsp/client.js";

const fixture = fileURLToPath(new URL("fixtures/mock-lsp-server.mjs", import.meta.url));

describe("lsp client", () => {
  it("握手后 didOpen 能等到 push 诊断", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture]);
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      const after = Date.now();
      const version = await client.notify.open({ path: file });
      expect(version).toBe(0);
      await client.waitForDiagnostics({ path: file, version, mode: "document", after });
      const diags = client.diagnostics.get(normalize(file));
      expect(diags).toBeDefined();
      expect(diags?.[0]?.message).toBe("mock error message");
      expect(diags?.[0]?.severity).toBe(1);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("已打开文档再次 touch 走 didChange 且版本递增", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture]);
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      const first = await client.notify.open({ path: file });
      expect(first).toBe(0);
      await writeFile(file, "x = 2\n");
      const second = await client.notify.open({ path: file });
      expect(second).toBe(1);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("didChange 清空旧诊断：等待窗口内服务器未完成重算时，不再残留 edit 前诊断", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture]);
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
      // 等待窗口 200ms < mock 服务器 didChange 重算耗时 300ms
      diagnosticsDocumentWaitTimeoutMs: 200,
    });
    try {
      const first = await client.notify.open({ path: file });
      await client.waitForDiagnostics({
        path: file,
        version: first,
        mode: "document",
        after: Date.now(),
      });
      expect(client.diagnostics.get(normalize(file))?.[0]?.message).toBe("mock error message");

      await writeFile(file, "x = 2\n");
      const after = Date.now();
      const second = await client.notify.open({ path: file });
      await client.waitForDiagnostics({ path: file, version: second, mode: "document", after });
      // 修复前：这里读到 didChange 前的旧诊断；修复后：缓存已清空
      expect(client.diagnostics.get(normalize(file))).toBeUndefined();
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("didChange 后等待窗口充足时，能拿到服务器基于新内容推送的诊断", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture]);
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      const first = await client.notify.open({ path: file });
      await client.waitForDiagnostics({
        path: file,
        version: first,
        mode: "document",
        after: Date.now(),
      });
      await writeFile(file, "x = 2\n");
      const after = Date.now();
      const second = await client.notify.open({ path: file });
      await client.waitForDiagnostics({ path: file, version: second, mode: "document", after });
      expect(client.diagnostics.get(normalize(file))?.[0]?.message).toBe("new error message");
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
