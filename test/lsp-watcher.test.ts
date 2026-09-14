/**
 * 工作区文件监听器测试（watcher.ts）：
 * - created / changed / deleted 三类映射
 * - 新建子目录内文件可见、目录删除上报 isDirectory
 * - 去抖合并成单批、忽略规则、超限截断只提示一次
 * - stop() 后不再回调
 */
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type FileChange, type WatchOptions, watchWorkspace } from "../src/lib/lsp/watcher.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const itLinux = process.platform === "linux" ? it : it.skip;

/** 从 /proc/self/fdinfo 收集所有 inotify watch 的 inode（内核 fdinfo 以十六进制打印）。 */
async function inotifyWatchedInodes(): Promise<Set<number>> {
  const inodes = new Set<number>();
  let entries: string[];
  try {
    entries = await readdir("/proc/self/fdinfo");
  } catch {
    return inodes;
  }
  for (const entry of entries) {
    let content: string;
    try {
      content = await readFile(join("/proc/self/fdinfo", entry), "utf8");
    } catch {
      continue;
    }
    for (const match of content.matchAll(/ino:([0-9a-f]+)/g)) {
      inodes.add(Number.parseInt(match[1], 16));
    }
  }
  return inodes;
}

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
      // 递归 watcher 异步挂载新目录；立刻写文件会丢失 created 的 rename 事件，
      // 只留下内容写入的 change 事件（被 classify 报成 changed）
      await sleep(100);
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

  it("忽略目录在监听期间新建子树不产生事件，监听器保持运行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    const { watcher, batches } = await collect(dir, { debounceMs: 50, flushMs: 200 });
    try {
      // 模拟 git / venv 在监听期间写入忽略目录（含新建子目录与文件）
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(dir, ".git"), { recursive: true });
      await sleep(150);
      await writeFile(join(dir, "node_modules", "pkg", "x.js"), "x");
      await writeFile(join(dir, ".git", "index.lock"), "x");
      await sleep(250);
      // 非 ignored 路径事件照常投递，证明监听器仍在工作
      await writeFile(join(dir, "normal.txt"), "x");
      await sleep(250);
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

  it("追加目录形态 ignore 在内核层生效（新建嵌套子树无事件）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    const { watcher, batches } = await collect(dir, {
      debounceMs: 50,
      flushMs: 200,
      ignore: ["extra/**"],
    });
    try {
      await mkdir(join(dir, "extra", "inner"), { recursive: true });
      await sleep(150);
      await writeFile(join(dir, "extra", "inner", "f.txt"), "x");
      await writeFile(join(dir, "keep.txt"), "x");
      await sleep(250);
      await watcher.stop();
      const all = batches.flat();
      expect(all.filter((c) => c.path.includes("extra"))).toHaveLength(0);
      expect(all).toContainEqual({
        path: join(dir, "keep.txt"),
        type: "created",
        isDirectory: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  itLinux(
    "忽略目录不创建内核 watch（inotify fdinfo inode 断言）",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
      const ignoredDir = join(dir, "node_modules");
      const ignoredFile = join(ignoredDir, "a.js");
      const keepDir = join(dir, "keep");
      const keepFile = join(keepDir, "a.txt");
      await mkdir(ignoredDir, { recursive: true });
      await mkdir(keepDir, { recursive: true });
      await writeFile(ignoredFile, "x");
      await writeFile(keepFile, "x");
      const { watcher, batches } = await collect(dir, { debounceMs: 50, flushMs: 200 });
      try {
        await sleep(300);
        const watched = await inotifyWatchedInodes();
        const inoOf = async (path: string) => (await lstat(path)).ino;
        expect(watched.has(await inoOf(ignoredFile))).toBe(false);
        expect(watched.has(await inoOf(ignoredDir))).toBe(false);
        // sanity：非 ignored 子目录确有内核 watch，证明断言管道有效
        expect(watched.has(await inoOf(keepDir))).toBe(true);
        expect(batches.flat()).toHaveLength(0);
      } finally {
        await watcher.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it("超限截断只提示一次", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-"));
    let truncated = 0;
    const { watcher, batches } = await collect(dir, {
      // parcel inotify 后端按块投递（实测 ~5ms / ~55ms 两批），去抖窗口须覆盖块间隔
      debounceMs: 100,
      flushMs: 300,
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
