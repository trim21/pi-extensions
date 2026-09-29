/**
 * file-reads 记账模块：记账 key 的解析（含 symlink 与尚未落盘的文件）、记账片段
 * 的产出、两个守卫（严格 requireCurrentRead / 宽松 requireUnchangedRead）的判定
 * 与文案。
 */
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createReadsState,
  readStateKey,
  recordRead,
  recordReads,
  requireCurrentRead,
  requireUnchangedRead,
  snapshotOf,
} from "../src/lib/file-reads.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "file-reads-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readStateKey", () => {
  it("resolves an existing file to its real path", async () => {
    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello\n", "utf8");
    expect(await readStateKey(filePath)).toBe(await realpath(filePath));
  });

  // Windows 上创建目录 symlink 需要特权/开发者模式，且 realpath 语义不同：只跑 Unix。
  it.skipIf(process.platform === "win32")(
    "resolves a not-yet-written file the same way as after it exists",
    async () => {
      const realDir = join(dir, "real");
      await mkdir(realDir);
      const linkDir = join(dir, "link");
      await symlink(realDir, linkDir, "dir");
      // 经 symlink 路径指向一个还不存在的文件：此刻 realpath 会 ENOENT
      const filePath = join(linkDir, "new.txt");
      const beforeWrite = await readStateKey(filePath);

      await writeFile(filePath, "new\n", "utf8");

      expect(beforeWrite).toBe(await readStateKey(filePath));
      expect(beforeWrite).toBe(join(await realpath(realDir), "new.txt"));
    },
  );

  it("resolves through the deepest existing ancestor when parent dirs are missing", async () => {
    const filePath = join(dir, "deep", "nested", "new.txt");
    expect(await readStateKey(filePath)).toBe(
      join(await realpath(dir), "deep", "nested", "new.txt"),
    );
  });
});

describe("recordRead / recordReads", () => {
  it("records under the resolved key and returns the details fragment", async () => {
    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello\n", "utf8");
    const state = createReadsState();

    const reads = await recordRead(state, filePath, snapshotOf("hello\n"));

    expect(reads).toEqual({ [await realpath(filePath)]: snapshotOf("hello\n") });
    expect(state.reads).toEqual(new Map([[await realpath(filePath), snapshotOf("hello\n")]]));
  });

  // 片段是持久化形状（对象，见 recordReads 注释）：Map 序列化进 details 会变 {}。
  it("merges several files into one JSON fragment", async () => {
    const first = join(dir, "a.txt");
    const second = join(dir, "b.txt");
    const state = createReadsState();

    const reads = await recordReads(state, [
      { path: first, snapshot: snapshotOf("a\n") },
      { path: second, snapshot: snapshotOf("b\n") },
    ]);

    expect(reads).toEqual({
      [await readStateKey(first)]: snapshotOf("a\n"),
      [await readStateKey(second)]: snapshotOf("b\n"),
    });
    expect(state.reads).toEqual(new Map(Object.entries(reads)));
  });
});

describe("requireCurrentRead", () => {
  it("rejects a file that was never read", async () => {
    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello\n", "utf8");
    const state = createReadsState();

    await expect(requireCurrentRead(state, filePath, "hello\n")).rejects.toThrow(
      "File has not been read yet. Read it first before writing to it.",
    );
  });

  it("rejects a binary read even when the content matches", async () => {
    const filePath = join(dir, "blob.bin");
    const bytes = Buffer.from([0x00, 0x01, 0x02]);
    await writeFile(filePath, bytes);
    const state = createReadsState();
    await recordRead(state, filePath, snapshotOf(bytes, false));

    await expect(requireCurrentRead(state, filePath, bytes)).rejects.toThrow(
      `Cannot edit or overwrite a binary file with a text tool: ${filePath}`,
    );
  });

  it("rejects a file that changed after the read", async () => {
    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello\n", "utf8");
    const state = createReadsState();
    await recordRead(state, filePath, snapshotOf("hello\n"));

    await expect(requireCurrentRead(state, filePath, "hello world\n")).rejects.toThrow(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
  });

  it("accepts a read whose snapshot still matches", async () => {
    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello\n", "utf8");
    const state = createReadsState();
    await recordRead(state, filePath, snapshotOf("hello\n"));

    await expect(requireCurrentRead(state, filePath, "hello\n")).resolves.toBeUndefined();
  });

  // 记账与校验的路径写法不同（symlink 目录 vs 真实目录）也要对上：两边都走 realpath。
  it.skipIf(process.platform === "win32")(
    "accepts a read recorded through a symlinked path",
    async () => {
      const realDir = join(dir, "real");
      await mkdir(realDir);
      await writeFile(join(realDir, "note.txt"), "hello\n", "utf8");
      const linkDir = join(dir, "link");
      await symlink(realDir, linkDir, "dir");
      const state = createReadsState();
      await recordRead(state, join(linkDir, "note.txt"), snapshotOf("hello\n"));

      await expect(
        requireCurrentRead(state, join(realDir, "note.txt"), "hello\n"),
      ).resolves.toBeUndefined();
    },
  );
});

describe("requireUnchangedRead", () => {
  it("passes for a file that was never read (blind write allowed)", async () => {
    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello\n", "utf8");
    const state = createReadsState();

    await expect(requireUnchangedRead(state, filePath)).resolves.toBeUndefined();
  });

  it("rejects a file that changed after the read", async () => {
    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello\n", "utf8");
    const state = createReadsState();
    const [record] = Object.entries(await recordRead(state, filePath, snapshotOf("hello\n")));
    expect(record).toBeDefined();
    await writeFile(filePath, "hello world\n", "utf8");

    await expect(requireUnchangedRead(state, filePath)).rejects.toThrow(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
  });

  it("rejects when the recorded file no longer exists", async () => {
    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello\n", "utf8");
    const state = createReadsState();
    await recordRead(state, filePath, snapshotOf("hello\n"));
    await rm(filePath);

    await expect(requireUnchangedRead(state, filePath)).rejects.toThrow(/modified since read/);
  });

  it("passes when the content still matches", async () => {
    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello\n", "utf8");
    const state = createReadsState();
    await recordRead(state, filePath, snapshotOf("hello\n"));

    await expect(requireUnchangedRead(state, filePath)).resolves.toBeUndefined();
    expect(await readFile(filePath, "utf8")).toBe("hello\n");
  });
});
