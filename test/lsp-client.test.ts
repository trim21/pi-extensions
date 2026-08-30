/**
 * LSP 客户端测试：用 mock stdio LSP 服务器（fixtures/mock-lsp-server.mjs）
 * 验证 initialize 握手、didOpen、push 诊断等待、watchedFiles 通知、
 * watchers 注册、驻留 LRU 与外部改动退场、shutdown。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  create,
  RenameIncompleteError,
  RenameNotPossibleError,
  renameVerificationTiming,
} from "../src/lib/lsp/client.js";

const fixture = fileURLToPath(new URL("fixtures/mock-lsp-server.mjs", import.meta.url));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 启动 mock 服务器并把客户端发来的 notifications（JSONL stderr）收集成数组。 */
function spawnMock(env?: Record<string, string>) {
  const proc = spawn(process.execPath, [fixture], { env: { ...process.env, ...env } });
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  let buffer = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) notifications.push(JSON.parse(line));
    }
  });
  return { proc, notifications };
}

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

describe("lsp client watched files", () => {
  it("notify.watchedFiles：批量合并单条、驻留路径（内容一致 echo）不出现", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const a = join(dir, "a.py");
    const b = join(dir, "b.py");
    const c = join(dir, "c.py");
    await writeFile(a, "x = 1\n");
    await writeFile(b, "y = 2\n");
    const { proc, notifications } = spawnMock();
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      await client.notify.open({ path: a });
      const before = notifications.length;
      await client.notify.watchedFiles([
        { path: a, type: "changed", isDirectory: false }, // 驻留 + 磁盘未变 = echo，忽略
        { path: b, type: "created", isDirectory: false },
        { path: c, type: "deleted", isDirectory: false },
      ]);
      await vi.waitFor(() => {
        expect(
          notifications.slice(before).some((n) => n.method === "workspace/didChangeWatchedFiles"),
        ).toBe(true);
      });
      const slice = notifications.slice(before);
      const watchedFiles = slice.find((n) => n.method === "workspace/didChangeWatchedFiles");
      expect(watchedFiles?.params.changes).toEqual([
        { uri: pathToFileURL(b).href, type: 1 },
        { uri: pathToFileURL(c).href, type: 3 },
      ]);
      // echo 的驻留文档既无 didClose 也不在载荷里
      expect(slice.some((n) => n.method === "textDocument/didClose")).toBe(false);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("registerCapability 记录 watchers glob，重复注册去重", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const { proc } = spawnMock({ MOCK_REGISTER_WATCHERS: "**/*.py,**/*.py,**/*.ts" });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      await vi.waitFor(() =>
        expect(client.watchers()).toContainEqual({ pattern: "**/*.py", kind: 7 }),
      );
      expect(
        client
          .watchers()
          .map((w) => [w.pattern, w.kind] as const)
          .toSorted(),
      ).toEqual([
        ["**/*.py", 7],
        ["**/*.ts", 7],
      ]);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("registerCapability 保留 watcher 的 WatchKind 位，缺省为 7", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const { proc } = spawnMock({ MOCK_REGISTER_WATCHERS: "**/*.py:2,**/*.ts" });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      await vi.waitFor(() =>
        expect(client.watchers()).toContainEqual({ pattern: "**/*.py", kind: 2 }),
      );
      expect(
        client
          .watchers()
          .map((w) => [w.pattern, w.kind] as const)
          .toSorted(),
      ).toEqual([
        ["**/*.py", 2],
        ["**/*.ts", 7],
      ]);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("unregisterCapability 移除对应 registration 的 pattern", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const { proc } = spawnMock({
      MOCK_REGISTER_WATCHERS: "**/*.py,**/*.ts",
      MOCK_UNREGISTER_IDS: "watcher-0",
    });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      await vi.waitFor(() =>
        expect(client.watchers()).toContainEqual({ pattern: "**/*.ts", kind: 7 }),
      );
      await client.notify.open({ path: file });
      await client.connection.sendNotification("textDocument/didClose", {
        textDocument: { uri: pathToFileURL(file).href },
      });
      await vi.waitFor(() =>
        expect(client.watchers()).not.toContainEqual({ pattern: "**/*.py", kind: 7 }),
      );
      expect(client.watchers()).toEqual([{ pattern: "**/*.ts", kind: 7 }]);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("驻留 LRU：容量超限淘汰最早驻留者，被淘汰文件再次 edit 重新 didOpen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const f1 = join(dir, "f1.py");
    const f2 = join(dir, "f2.py");
    await writeFile(f1, "x = 1\n");
    await writeFile(f2, "y = 1\n");
    const { proc, notifications } = spawnMock();
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
      maxOpenDocuments: 1,
    });
    try {
      await client.notify.open({ path: f1 });
      await client.notify.open({ path: f2 });
      await vi.waitFor(() => {
        expect(notifications.filter((n) => n.method === "textDocument/didClose").length).toBe(1);
      });
      const didClose = notifications.find((n) => n.method === "textDocument/didClose");
      expect(didClose?.params.textDocument).toEqual({ uri: pathToFileURL(f1).href });

      // 被淘汰文件再次 edit → 重新 didOpen（version 归 0）
      const version = await client.notify.open({ path: f1 });
      expect(version).toBe(0);
      await vi.waitFor(() => {
        const didOpens = notifications
          .filter((n) => n.method === "textDocument/didOpen")
          .map((n) => (n.params.textDocument as { uri: string }).uri);
        expect(didOpens.filter((uri) => uri === pathToFileURL(f1).href)).toHaveLength(2);
      });
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("驻留文档外部改动：先 didClose 再发 changed 事件；内容一致 echo 零通知", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const { proc, notifications } = spawnMock();
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      await client.notify.open({ path: file });
      await sleep(100);

      // echo：磁盘内容与驻留文本一致 → 完全不发消息
      const before = notifications.length;
      await client.notify.watchedFiles([{ path: file, type: "changed", isDirectory: false }]);
      await sleep(200);
      expect(notifications.slice(before)).toHaveLength(0);

      // 外部改写磁盘 → 一条 didClose + 一条 changed watchedFiles。
      // 两条通知经 mock server 的 stderr JSONL 异步到达，需一起等齐再断言，
      // 只等 didClose 就断言第二条会在 CI 负载下间歇性失败
      await writeFile(file, "x = 999\n");
      const before2 = notifications.length;
      await client.notify.watchedFiles([{ path: file, type: "changed", isDirectory: false }]);
      await vi.waitFor(() => {
        const slice = notifications.slice(before2);
        const didClose = slice.find((n) => n.method === "textDocument/didClose");
        const watchedFiles = slice.find((n) => n.method === "workspace/didChangeWatchedFiles");
        expect(didClose?.params.textDocument).toEqual({ uri: pathToFileURL(file).href });
        expect(watchedFiles?.params.changes).toEqual([{ uri: pathToFileURL(file).href, type: 2 }]);
      });
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("lsp client renameSymbol", () => {
  it("prepare + rename 成功：返回 WorkspaceEdit 与 placeholder，并先同步磁盘内容", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: { ...process.env, MOCK_RENAME_MODE: "ok" },
    });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      const result = await client.renameSymbol({
        path: file,
        line: 0,
        character: 0,
        newName: "y",
      });
      expect(result.placeholder).toBe("mockSymbol");
      const changes = result.edit.changes ?? {};
      const [uri] = Object.keys(changes);
      expect(uri).toBe(pathToFileURL(file).href);
      expect(changes[uri]?.[0]?.newText).toBe("y");
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("服务器无 prepare 能力时跳过 prepare 直接 rename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: { ...process.env, MOCK_RENAME_MODE: "no_prepare" },
    });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      const result = await client.renameSymbol({ path: file, line: 0, character: 0, newName: "y" });
      expect(result.placeholder).toBeUndefined();
      expect(result.edit.changes?.[pathToFileURL(file).href]?.[0]?.newText).toBe("y");
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prepareRename 返回 null 时抛 RenameNotPossibleError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: { ...process.env, MOCK_RENAME_MODE: "null_prepare" },
    });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      await expect(
        client.renameSymbol({ path: file, line: 0, character: 0, newName: "y" }),
      ).rejects.toThrow(RenameNotPossibleError);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rename 返回 null 时抛 RenameNotPossibleError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: { ...process.env, MOCK_RENAME_MODE: "null_rename" },
    });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      await expect(
        client.renameSymbol({ path: file, line: 0, character: 0, newName: "y" }),
      ).rejects.toThrow(RenameNotPossibleError);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("服务器未实现 rename（MethodNotFound）时抛 RenameNotPossibleError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: { ...process.env, MOCK_RENAME_MODE: "unsupported" },
    });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      await expect(
        client.renameSymbol({ path: file, line: 0, character: 0, newName: "y" }),
      ).rejects.toThrow(RenameNotPossibleError);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("references 收敛且 rename 覆盖全部文件：正常返回完整 edit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        MOCK_RENAME_MODE: "ok",
        MOCK_REFERENCES_MODE: "grow_then_settle",
      },
    });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    try {
      const result = await client.renameSymbol({ path: file, line: 0, character: 0, newName: "y" });
      const uris = Object.keys(result.edit.changes ?? {});
      expect(uris).toHaveLength(2);
      expect(uris).toContain(pathToFileURL(file).href);
      expect(uris).toContain(pathToFileURL(join(dir, "extra-a.py")).href);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("references 稳定但 rename 漏文件：预算耗尽抛 RenameIncompleteError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        MOCK_RENAME_MODE: "ok",
        MOCK_REFERENCES_MODE: "stable_mismatch",
      },
    });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
    });
    const savedTiming = { ...renameVerificationTiming };
    renameVerificationTiming.pollMs = 20;
    renameVerificationTiming.budgetMs = 200;
    try {
      try {
        await client.renameSymbol({ path: file, line: 0, character: 0, newName: "y" });
        expect.unreachable("expected renameSymbol to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(RenameIncompleteError);
        expect((error as RenameIncompleteError).message).toContain(join(dir, "extra-a.py"));
        expect((error as RenameIncompleteError).missing).toEqual([join(dir, "extra-a.py")]);
      }
    } finally {
      Object.assign(renameVerificationTiming, savedTiming);
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
