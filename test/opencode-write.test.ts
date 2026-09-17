/**
 * Tests for the opencode-aligned write extension:
 * - resolveBom: desiredBom = source.bom || next.bom
 * - execute: file creation with parent dirs, BOM preservation, abort
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import opencodeFileTools, { resolveBom } from "../src/opencode/files.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe("resolveBom", () => {
  it("new file without BOM keeps content as-is", () => {
    expect(resolveBom(undefined, "hello")).toEqual({ bom: "", text: "hello" });
  });

  it("new file with BOM keeps the content BOM", () => {
    expect(resolveBom(undefined, "\uFEFFhello")).toEqual({ bom: "\uFEFF", text: "hello" });
  });

  it("existing BOM is preserved even when new content has none", () => {
    expect(resolveBom(UTF8_BOM, "hello")).toEqual({ bom: "\uFEFF", text: "hello" });
  });

  it("existing BOM wins over the new content BOM", () => {
    expect(resolveBom(UTF8_BOM, "\uFEFFhello")).toEqual({ bom: "\uFEFF", text: "hello" });
  });

  it("existing file without BOM falls back to the new content BOM", () => {
    expect(resolveBom(Buffer.from("abc"), "\uFEFFhello")).toEqual({
      bom: "\uFEFF",
      text: "hello",
    });
  });

  it("short existing buffer (no full BOM) falls back to the new content BOM", () => {
    expect(resolveBom(Buffer.from([0xef, 0xbb]), "\uFEFFhello")).toEqual({
      bom: "\uFEFF",
      text: "hello",
    });
  });
});

// ── execute ───────────────────────────────────────────────────────────────────

interface WriteParams {
  filePath: string;
  content: string;
}

interface Tool {
  name: string;
  execute: (
    toolCallId: string,
    params: WriteParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{
    content: { type: string; text: string }[];
    details: unknown;
  }>;
}

interface Harness {
  write: Tool;
  /** 先走一遍 read，用于读取记录的过期校验。 */
  readFirst: (filePath: string) => Promise<void>;
}

function loadTool(): Harness {
  const tools = new Map<string, Tool>();
  opencodeFileTools({
    registerTool: (def: Tool) => {
      tools.set(def.name, def);
    },
    on: vi.fn(),
    registerCommand: vi.fn(),
  } as never);
  const read = tools.get("read")!;
  return {
    write: tools.get("write")!,
    readFirst: async (filePath: string) => {
      await read.execute("id", { filePath } as never, undefined, undefined, ctx);
    },
  };
}

let dir: string;
let target: string;
let ctx: { cwd: string };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-write-test-"));
  target = join(dir, "nested", "file.txt");
  await mkdir(join(dir, "nested"));
  ctx = { cwd: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("opencode write execute", () => {
  it("writes a new file and creates parent directories automatically", async () => {
    const { write: tool } = loadTool();
    const deep = join(dir, "a", "b", "c.txt");
    const result = await tool.execute(
      "id",
      { filePath: deep, content: "hello\n" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toBe("Wrote file successfully.");
    expect(result.details).toMatchObject({ pendant: { subtitle: `./${join("a", "b", "c.txt")}` } });
    expect(await readFile(deep, "utf8")).toBe("hello\n");
  });

  it("overwrites an existing file", async () => {
    await writeFile(target, "old\n", "utf8");
    const { write: tool } = loadTool();
    await tool.execute("id", { filePath: target, content: "new\n" }, undefined, undefined, ctx);
    expect(await readFile(target, "utf8")).toBe("new\n");
  });

  it("preserves an existing BOM when new content has none", async () => {
    await writeFile(target, "\uFEFFold\n", "utf8");
    const { write: tool } = loadTool();
    await tool.execute("id", { filePath: target, content: "new\n" }, undefined, undefined, ctx);
    expect(await readFile(target, "utf8")).toBe("\uFEFFnew\n");
  });

  it("keeps the new content BOM for a new file", async () => {
    const { write: tool } = loadTool();
    await tool.execute(
      "id",
      { filePath: target, content: "\uFEFFfresh\n" },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("\uFEFFfresh\n");
  });

  it("keeps the new content BOM when the existing file has no BOM", async () => {
    await writeFile(target, "plain\n", "utf8");
    const { write: tool } = loadTool();
    await tool.execute(
      "id",
      { filePath: target, content: "\uFEFFbom\n" },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("\uFEFFbom\n");
  });

  it("treats a short existing file as BOM-less and falls back to the new BOM", async () => {
    await writeFile(target, "ab", "utf8");
    const { write: tool } = loadTool();
    await tool.execute(
      "id",
      { filePath: target, content: "\uFEFFlong\n" },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("\uFEFFlong\n");
  });

  it("aborts before writing anything", async () => {
    const controller = new AbortController();
    controller.abort();
    const { write: tool } = loadTool();
    await expect(
      tool.execute("id", { filePath: target, content: "never" }, controller.signal, undefined, ctx),
    ).rejects.toThrow(/aborted/i);
    await expect(readFile(target, "utf8")).rejects.toThrow(/ENOENT/);
  });
});

describe("opencode write read-record staleness", () => {
  it("overwrites a file that was never read", async () => {
    await writeFile(target, "old\n", "utf8");
    const { write } = loadTool();
    await write.execute("id", { filePath: target, content: "new\n" }, undefined, undefined, ctx);
    expect(await readFile(target, "utf8")).toBe("new\n");
  });

  it("overwrites a file that was read and is unchanged", async () => {
    await writeFile(target, "old\n", "utf8");
    const { write, readFirst } = loadTool();
    await readFirst(target);
    await write.execute("id", { filePath: target, content: "new\n" }, undefined, undefined, ctx);
    expect(await readFile(target, "utf8")).toBe("new\n");
  });

  it("refuses to overwrite a file that changed after the read", async () => {
    await writeFile(target, "old\n", "utf8");
    const { write, readFirst } = loadTool();
    await readFirst(target);
    await writeFile(target, "changed by someone else\n", "utf8");

    await expect(
      write.execute("id", { filePath: target, content: "new\n" }, undefined, undefined, ctx),
    ).rejects.toThrow(/File has been modified since read/);
    expect(await readFile(target, "utf8")).toBe("changed by someone else\n");

    // 重新 read 之后可以正常写
    await readFirst(target);
    await write.execute("id", { filePath: target, content: "new\n" }, undefined, undefined, ctx);
    expect(await readFile(target, "utf8")).toBe("new\n");
  });

  it("refuses to write over a file that was read and then deleted", async () => {
    await writeFile(target, "old\n", "utf8");
    const { write, readFirst } = loadTool();
    await readFirst(target);
    await rm(target);

    await expect(
      write.execute("id", { filePath: target, content: "new\n" }, undefined, undefined, ctx),
    ).rejects.toThrow(/File has been modified since read/);
  });

  it("does not require a read for a file created by a previous write", async () => {
    const { write } = loadTool();
    await write.execute("id", { filePath: target, content: "one\n" }, undefined, undefined, ctx);
    await write.execute("id", { filePath: target, content: "two\n" }, undefined, undefined, ctx);
    expect(await readFile(target, "utf8")).toBe("two\n");
  });
});
