/**
 * 工作区文件监听器测试（watcher.ts）：
 * - created / changed / deleted 三类映射
 * - 新建子目录内文件可见、目录删除上报 isDirectory
 * - 去抖合并成单批、忽略规则、超限截断只提示一次
 * - stop() 后不再回调
 */
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type FileChange, type WatchOptions, watchWorkspace } from "../src/lib/lsp/watcher.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function collect(dir: string, options?: WatchOptions) {
  const batches: FileChange[][] = [];
  const watcher = await watchWorkspace(
    dir,
    (batch) => {
      batches.push(batch);
    },
    options,
  );
  return { watcher, batches };
}

describe("workspace watcher", () => {
  it("映射 created / changed / deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    const file = join(dir, "a.txt");
    const { watcher, batches } = await collect(dir, { debounceMs: 50, flushMs: 200 });
    try {
      await writeFile(file, "x");
      await sleep(150);
      await writeFile(file, "y");
      await sleep(150);
      await unlink(file);
      await sleep(150);
      await watcher.stop();
      const all = batches.flat();
      expect(all).toContainEqual({ path: file, type: "created", isDirectory: false });
      expect(all).toContainEqual({ path: file, type: "changed", isDirectory: false });
      expect(all).toContainEqual({ path: file, type: "deleted", isDirectory: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("新建子目录内的文件事件可见", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    const { watcher, batches } = await collect(dir, { debounceMs: 50, flushMs: 200 });
    try {
      const sub = join(dir, "sub");
      const file = join(sub, "b.txt");
      await mkdir(sub);
      await writeFile(file, "x");
      await sleep(250);
      await watcher.stop();
      expect(batches.flat()).toContainEqual({ path: file, type: "created", isDirectory: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("watcher 见过的目录被删除时上报 isDirectory: true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    const { watcher, batches } = await collect(dir, { debounceMs: 50, flushMs: 200 });
    try {
      const sub = join(dir, "subdir");
      await mkdir(sub);
      await sleep(150);
      await rm(sub, { recursive: true });
      await sleep(150);
      await watcher.stop();
      expect(batches.flat()).toContainEqual({ path: sub, type: "deleted", isDirectory: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("去抖合并成单批", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    const { watcher, batches } = await collect(dir, { debounceMs: 100, flushMs: 500 });
    try {
      for (let i = 0; i < 5; i++) {
        await writeFile(join(dir, `f${i}.txt`), "x");
      }
      await sleep(300);
      await watcher.stop();
      // fs.watch 对一次写入可能产生重复事件，断言合并为单批且全部路径出现
      expect(batches.length).toBe(1);
      const paths = new Set(batches[0].map((c) => c.path));
      expect(paths.size).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("node_modules / .git 被忽略", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    const { watcher, batches } = await collect(dir, { debounceMs: 50, flushMs: 200 });
    try {
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await mkdir(join(dir, ".git"), { recursive: true });
      await writeFile(join(dir, "node_modules", "x.js"), "x");
      await writeFile(join(dir, ".git", "HEAD"), "ref");
      await writeFile(join(dir, "normal.txt"), "x");
      await sleep(300);
      await watcher.stop();
      const all = batches.flat();
      expect(all.filter((c) => c.path.includes("node_modules"))).toHaveLength(0);
      expect(all.filter((c) => c.path.includes(".git"))).toHaveLength(0);
      expect(all).toContainEqual({
        path: join(dir, "normal.txt"),
        type: "created",
        isDirectory: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("追加 ignore glob 生效", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    const { watcher, batches } = await collect(dir, {
      debounceMs: 50,
      flushMs: 200,
      ignore: ["**/*.log"],
    });
    try {
      await writeFile(join(dir, "a.log"), "x");
      await writeFile(join(dir, "b.txt"), "x");
      await sleep(250);
      await watcher.stop();
      const all = batches.flat();
      expect(all.filter((c) => c.path.endsWith("a.log"))).toHaveLength(0);
      expect(all).toContainEqual({ path: join(dir, "b.txt"), type: "created", isDirectory: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("超限截断只提示一次", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    let truncated = 0;
    const { watcher, batches } = await collect(dir, {
      debounceMs: 50,
      flushMs: 200,
      maxBatch: 3,
      onTruncated: () => {
        truncated += 1;
      },
    });
    try {
      for (let i = 0; i < 10; i++) {
        await writeFile(join(dir, `f${i}.txt`), "x");
      }
      await sleep(300);
      await watcher.stop();
      expect(truncated).toBe(1);
      expect(batches.flat()).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stop 后不再回调", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    const { watcher, batches } = await collect(dir, { debounceMs: 30, flushMs: 100 });
    try {
      await writeFile(join(dir, "a.txt"), "x");
      await sleep(150);
      await watcher.stop();
      const count = batches.flat().length;
      await writeFile(join(dir, "b.txt"), "y");
      await sleep(150);
      expect(batches.flat().length).toBe(count);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
