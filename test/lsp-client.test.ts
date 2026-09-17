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
  evictionPlan,
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

/**
 * 淘汰计划断言的简写：`order` 是 lruOrder 的迭代序（最久未用在前）；
 * `resident` 缺省表示 order 全部仍驻留，`waiting` 缺省为空。
 */
function plan(order: string[], options: { resident?: string[]; waiting?: string[]; max: number }) {
  return evictionPlan({
    order,
    isResident: (path) => (options.resident ?? order).includes(path),
    isWaiting: (path) => (options.waiting ?? []).includes(path),
    maxOpenDocuments: options.max,
  });
}

describe.concurrent("lsp client", () => {
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

  it("内容未变时不再同步：不发 didChange，也不清空已有结论", async () => {
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
      const first = await client.notify.open({ path: file });
      await client.waitForDiagnostics({
        path: file,
        version: first,
        mode: "document",
        after: Date.now(),
      });

      const second = await client.notify.open({ path: file });
      expect(second).toBe(first);
      expect(notifications.filter((item) => item.method === "textDocument/didOpen")).toHaveLength(
        1,
      );
      expect(notifications.filter((item) => item.method === "textDocument/didChange")).toHaveLength(
        0,
      );
      // 内容没变，服务器不会给出新结论：已有结论依然对应磁盘内容，不该被清掉
      expect(client.diagnostics.get(normalize(file))?.[0]?.message).toBe("mock error message");
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("服务器已对当前内容给出结论后，内容未变的再次等待立刻返回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    // didOpen 推空诊断（本来就干净的文档）、didChange 静默（对齐 tsls 空→空不发布）
    const { proc } = spawnMock({ MOCK_DIDOPEN_EMPTY: "1", MOCK_SILENT_DIDCHANGE: "1" });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
      diagnosticsDocumentWaitTimeoutMs: 30_000,
    });
    try {
      const version = await client.notify.open({ path: file });
      await client.waitForDiagnostics({ path: file, version, mode: "document", after: Date.now() });
      expect(client.diagnostics.get(normalize(file))).toEqual([]);

      const startedAt = Date.now();
      const again = await client.notify.open({ path: file });
      await client.waitForDiagnostics({
        path: file,
        version: again,
        mode: "document",
        after: Date.now(),
      });
      // 修复前：didChange 被重新发出去、缓存被清空，服务器静默 → 等满 30s 窗口
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("上一份结论为空的文档内容变化后，用短安静期结束等待而不是等满窗口", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const { proc } = spawnMock({ MOCK_DIDOPEN_EMPTY: "1", MOCK_SILENT_DIDCHANGE: "1" });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
      diagnosticsDocumentWaitTimeoutMs: 30_000,
      diagnosticsSilentWaitTimeoutMs: 250,
    });
    try {
      const version = await client.notify.open({ path: file });
      await client.waitForDiagnostics({ path: file, version, mode: "document", after: Date.now() });

      await writeFile(file, "x = 2\n");
      const startedAt = Date.now();
      const next = await client.notify.open({ path: file });
      expect(next).toBe(version + 1);
      await client.waitForDiagnostics({
        path: file,
        version: next,
        mode: "document",
        after: startedAt,
      });
      const elapsed = Date.now() - startedAt;
      // 安静期确实是等待而不是立刻放弃（否则会漏掉这次变更新引入的诊断）
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("上一份结论非空时仍等满整个窗口：安静期只用于空结论", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const { proc } = spawnMock({ MOCK_SILENT_DIDCHANGE: "1" });
    const client = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
      diagnosticsDocumentWaitTimeoutMs: 800,
      diagnosticsSilentWaitTimeoutMs: 250,
    });
    try {
      const version = await client.notify.open({ path: file });
      await client.waitForDiagnostics({ path: file, version, mode: "document", after: Date.now() });
      expect(client.diagnostics.get(normalize(file))?.[0]?.message).toBe("mock error message");

      await writeFile(file, "x = 2\n");
      const startedAt = Date.now();
      const next = await client.notify.open({ path: file });
      await client.waitForDiagnostics({
        path: file,
        version: next,
        mode: "document",
        after: startedAt,
      });
      // 有错的文件一旦被改动就可能出错→好或好→坏，服务器会推送，等满窗口兜底
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(700);
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

describe.concurrent("lsp client watched files", () => {
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

describe.concurrent("驻留淘汰：容量上限与等待诊断的文档", () => {
  it("容量内不动任何文档，超出时按使用顺序淘汰最久未用者", () => {
    expect(plan(["a", "b"], { max: 2 })).toEqual({ stale: [], evict: [] });
    expect(plan(["a", "b", "c"], { max: 2 })).toEqual({ stale: [], evict: ["a"] });
    expect(plan(["a", "b", "c"], { max: 1 })).toEqual({ stale: [], evict: ["a", "b"] });
  });

  it("等待诊断的文档不淘汰；可淘汰项不足时宁可少淘汰，绝不重试自旋", () => {
    // 容量 1、3 个驻留、b 在等诊断：跳过 b，淘汰 a 与 c 回到容量
    expect(plan(["a", "b", "c"], { waiting: ["b"], max: 1 })).toEqual({
      stale: [],
      evict: ["a", "c"],
    });
    // 1 个可淘汰项却缺 2 个容量：只淘汰这一个，不做第二轮
    expect(plan(["a", "b", "c"], { waiting: ["b", "c"], max: 1 })).toEqual({
      stale: [],
      evict: ["a"],
    });
    // 全部在等诊断：没有任何可淘汰项（旧实现在这里同步自旋）
    expect(plan(["a", "b", "c"], { waiting: ["a", "b", "c"], max: 2 })).toEqual({
      stale: [],
      evict: [],
    });
  });

  it("回收不在驻留集合里的陈旧 key，且它们不占容量", () => {
    // c 已被 watchedFiles 的 didClose 移出 files：只回收它，不需要淘汰 a、b
    expect(plan(["a", "b", "c"], { resident: ["a", "b"], max: 2 })).toEqual({
      stale: ["c"],
      evict: [],
    });
    // 陈旧 key 不计入容量：删掉 c 之后仍超出 1 个 → 淘汰最久未用的 a
    expect(plan(["a", "b", "c"], { resident: ["a", "b"], max: 1 })).toEqual({
      stale: ["c"],
      evict: ["a"],
    });
  });

  it("等待诊断的文档占满驻留集合时，重新打开同一路径不再挂死", async () => {
    // 旧实现（"跳过等待项，下一轮再淘汰"的 while 循环）会在这条路径上同步自旋，
    // 同一进程内无法用超时中断，故放到子进程里跑并在超时后强杀：被杀 = 回归。
    const driver = fileURLToPath(new URL("fixtures/lsp-evict-driver.mjs", import.meta.url));
    const child = spawn(process.execPath, [driver], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    clearTimeout(killer);
    expect(signal, `驱动进程被强杀，淘汰循环疑似重新自旋：${stderr}`).toBeNull();
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("OK");
  }, 30_000);
});

// 该组保持串行：两个用例临时改写共享的 renameVerificationTiming（轮询间隔 / 预算），
// 并发执行时保存与恢复会互相覆盖，把改后的预算泄漏给组内其他用例。
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

  it("项目仍在加载（references 只报当前文件）时不急着收敛：等首份诊断后拿到完整 edit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    // 模拟 CI 上实测到的时序：项目异步加载期间 references 只返回当前文件，
    // 且这个"残缺答案"能稳定出现两次以上；首份诊断推送（加载完成的信号）
    // 比它晚 800ms。
    const proc = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        MOCK_RENAME_MODE: "ok",
        MOCK_REFERENCES_MODE: "cold_until_push",
        MOCK_PUSH_DELAY_MS: "800",
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

  it("rename 超出 references 且 references 随后追上：回到轮询收敛后成功", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        MOCK_RENAME_MODE: "ok_extra",
        MOCK_REFERENCES_MODE: "catch_up_late",
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
      const result = await client.renameSymbol({ path: file, line: 0, character: 0, newName: "y" });
      const uris = Object.keys(result.edit.changes ?? {});
      expect(uris).toHaveLength(2);
      expect(uris).toContain(pathToFileURL(file).href);
      expect(uris).toContain(pathToFileURL(join(dir, "extra-a.py")).href);
    } finally {
      Object.assign(renameVerificationTiming, savedTiming);
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rename 超出 references 且 references 永不追上：预算耗尽抛 RenameIncompleteError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        MOCK_RENAME_MODE: "ok_extra",
        MOCK_REFERENCES_MODE: "stable_self",
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
        expect((error as RenameIncompleteError).missing).toEqual([]);
        expect((error as RenameIncompleteError).extra).toEqual([join(dir, "extra-a.py")]);
      }
    } finally {
      Object.assign(renameVerificationTiming, savedTiming);
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("references 前 2 次 ContentModified 后重试成功", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        MOCK_RENAME_MODE: "ok",
        MOCK_REFERENCES_MODE: "stable_self",
        MOCK_CONTENT_MODIFIED: "references:2",
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
      expect(result.edit.changes?.[pathToFileURL(file).href]?.[0]?.newText).toBe("y");
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rename 第 1 次 ContentModified 后重试成功", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        MOCK_RENAME_MODE: "ok",
        MOCK_CONTENT_MODIFIED: "rename:1",
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
      expect(result.edit.changes?.[pathToFileURL(file).href]?.[0]?.newText).toBe("y");
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("references 持续 ContentModified 超过重试上限后抛错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-rename-"));
    const file = join(dir, "a.py");
    await writeFile(file, "x = 1\n");
    const proc = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        MOCK_RENAME_MODE: "ok",
        MOCK_REFERENCES_MODE: "stable_self",
        MOCK_CONTENT_MODIFIED: "references:always",
      },
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
      ).rejects.toThrow();
    } finally {
      await client.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("服务器启动即退出时，initialize 失败信息包含退出码与 stderr 尾部", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const proc = spawn(process.execPath, [
      "-e",
      String.raw`process.stderr.write("bad arguments\n"); process.exit(101)`,
    ]);
    const error = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
      initializeTimeoutMs: 500,
    }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("exited with code 101");
    expect((error as Error).message).toContain("stderr: bad arguments");
    await rm(dir, { recursive: true, force: true });
  });

  it("initialize 超时时，失败信息包含超时原因与 stderr 尾部", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
    const proc = spawn(process.execPath, [
      "-e",
      String.raw`process.stderr.write("loading indexes...\n"); setTimeout(() => {}, 10_000)`,
    ]);
    const error = await create({
      serverID: "mock",
      server: { process: proc },
      root: dir,
      directory: dir,
      initializeTimeoutMs: 300,
    }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Timeout after 300ms");
    expect((error as Error).message).toContain("stderr: loading indexes...");
    await rm(dir, { recursive: true, force: true });
  });
});
