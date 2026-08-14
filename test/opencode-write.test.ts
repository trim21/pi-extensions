/**
 * Tests for the opencode-aligned write extension:
 * - resolveBom: desiredBom = source.bom || next.bom
 * - execute: file creation with parent dirs, BOM preservation, abort
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import opencodeWrite, { resolveBom } from "../src/opencode/write.js";

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

function loadTool(): Tool {
  let tool: Tool | undefined;
  opencodeWrite({
    registerTool: (def: Tool) => {
      tool = def;
    },
  } as never);
  return tool!;
}

let dir: string;
let target: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-write-test-"));
  target = join(dir, "nested", "file.txt");
  await mkdir(join(dir, "nested"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = { cwd: dir! };

describe("opencode write execute", () => {
  it("writes a new file and creates parent directories automatically", async () => {
    const tool = loadTool();
    const deep = join(dir, "a", "b", "c.txt");
    const result = await tool.execute(
      "id",
      { filePath: deep, content: "hello\n" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toBe("Wrote file successfully.");
    expect(await readFile(deep, "utf8")).toBe("hello\n");
  });

  it("overwrites an existing file", async () => {
    await writeFile(target, "old\n", "utf8");
    const tool = loadTool();
    await tool.execute("id", { filePath: target, content: "new\n" }, undefined, undefined, ctx);
    expect(await readFile(target, "utf8")).toBe("new\n");
  });

  it("preserves an existing BOM when new content has none", async () => {
    await writeFile(target, "\uFEFFold\n", "utf8");
    const tool = loadTool();
    await tool.execute("id", { filePath: target, content: "new\n" }, undefined, undefined, ctx);
    expect(await readFile(target, "utf8")).toBe("\uFEFFnew\n");
  });

  it("keeps the new content BOM for a new file", async () => {
    const tool = loadTool();
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
    const tool = loadTool();
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
    const tool = loadTool();
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
    const tool = loadTool();
    await expect(
      tool.execute("id", { filePath: target, content: "never" }, controller.signal, undefined, ctx),
    ).rejects.toThrow(/Operation aborted/);
    await expect(readFile(target, "utf8")).rejects.toThrow(/ENOENT/);
  });
});
