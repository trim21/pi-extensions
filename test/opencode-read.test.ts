/**
 * Tests for the opencode-aligned read extension:
 * - truncateHead: line cap, byte cap, single-line 2000-char truncation,
 *   trailing-newline handling, no-truncation fast path
 * - execute: text files with line numbers/offset/limit, directory listing,
 *   did-you-mean suggestions, image detection, binary rejection
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import opencodeRead, { truncateHead } from "../src/opencode/read.js";

const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;

describe("truncateHead", () => {
  it("returns content unchanged when within limits", () => {
    const result = truncateHead("a\nb\nc", 2000, 50 * 1024);
    expect(result).toMatchObject({
      content: "a\nb\nc",
      truncated: false,
      truncatedBy: null,
      totalLines: 3,
      outputLines: 3,
    });
  });

  it("does not truncate when line count exactly equals maxLines", () => {
    const result = truncateHead("a\nb", 2, 50 * 1024);
    expect(result.truncated).toBe(false);
    expect(result.outputLines).toBe(2);
  });

  it("truncates by lines when exceeding maxLines", () => {
    const result = truncateHead("1\n2\n3\n4\n5", 2, 50 * 1024);
    expect(result).toMatchObject({
      content: "1\n2",
      truncated: true,
      truncatedBy: "lines",
      totalLines: 5,
      outputLines: 2,
    });
  });

  it("truncates by bytes before the offending line", () => {
    // 每行 6 字节 + 换行 1 字节；maxBytes=10 → 第二行累计 13 > 10
    const result = truncateHead("aaaaaa\nbbbbbb", 2000, 10);
    expect(result).toMatchObject({
      content: "aaaaaa",
      truncated: true,
      truncatedBy: "bytes",
      outputLines: 1,
    });
  });

  it("truncates a single over-long line to MAX_LINE_LENGTH with a suffix", () => {
    const longLine = "x".repeat(MAX_LINE_LENGTH + 10);
    const result = truncateHead(longLine, 2000, 50 * 1024);
    expect(result.content).toBe("x".repeat(MAX_LINE_LENGTH) + MAX_LINE_SUFFIX);
    expect(result.truncated).toBe(false); // 单行截断不算整体截断
    expect(result.outputLines).toBe(1);
  });

  it("counts lines without the trailing empty line from a final newline", () => {
    const result = truncateHead("a\nb\n", 2000, 50 * 1024);
    expect(result).toMatchObject({ totalLines: 2, outputLines: 2, truncated: false });
  });

  it("handles empty content", () => {
    const result = truncateHead("", 2000, 50 * 1024);
    expect(result).toMatchObject({ content: "", truncated: false, outputLines: 0 });
  });
});

// ── execute ───────────────────────────────────────────────────────────────────

interface ReadParams {
  filePath: string;
  offset?: number;
  limit?: number;
}

interface Tool {
  name: string;
  execute: (
    toolCallId: string,
    params: ReadParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{
    content: { type: string; text: string; data?: string; mimeType?: string }[];
    details: unknown;
  }>;
}

function loadTool(): Tool {
  let tool: Tool | undefined;
  opencodeRead({
    registerTool: (def: Tool) => {
      tool = def;
    },
  } as never);
  return tool!;
}

let dir: string;
let textFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-read-test-"));
  textFile = join(dir, "sample.txt");
  await writeFile(textFile, "one\ntwo\nthree\nfour\nfive\n", "utf8");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = { cwd: dir! };

describe("opencode read execute", () => {
  it("reads a text file with line-number prefixes", async () => {
    const tool = loadTool();
    const result = await tool.execute("id", { filePath: textFile }, undefined, undefined, ctx);
    const text = result.content[0].text;
    expect(text).toContain("<type>file</type>");
    expect(text).toContain("1: one");
    expect(text).toContain("2: two");
    expect(text).toContain("(End of file - total 5 lines)");
  });

  it("respects limit and reports a continue hint", async () => {
    const tool = loadTool();
    const result = await tool.execute(
      "id",
      { filePath: textFile, limit: 2 },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content[0].text;
    expect(text).toContain("1: one");
    expect(text).toContain("2: two");
    expect(text).not.toContain("3: three");
    expect(text).toContain("Showing lines 1-2 of 5. Use offset=3 to continue.");
  });

  it("supports a 1-based offset", async () => {
    const tool = loadTool();
    const result = await tool.execute(
      "id",
      { filePath: textFile, offset: 3 },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content[0].text;
    expect(text).toContain("3: three");
    expect(text).toContain("5: five");
    expect(text).not.toContain("1: one");
  });

  it("treats offset 0 as 1", async () => {
    const tool = loadTool();
    const result = await tool.execute(
      "id",
      { filePath: textFile, offset: 0 },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toContain("1: one");
  });

  it("throws when the offset is out of range", async () => {
    const tool = loadTool();
    await expect(
      tool.execute("id", { filePath: textFile, offset: 99 }, undefined, undefined, ctx),
    ).rejects.toThrow(/Offset 99 is out of range/);
  });

  it("reads an empty file with default offset", async () => {
    const empty = join(dir, "empty.txt");
    await writeFile(empty, "", "utf8");
    const tool = loadTool();
    const result = await tool.execute("id", { filePath: empty }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("(End of file - total 1 lines)");
  });

  it("lists directory entries with a / suffix, sorted", async () => {
    const listing = join(dir, "listing");
    await mkdir(listing);
    await writeFile(join(listing, "zeta.txt"), "z", "utf8");
    await writeFile(join(listing, "alpha.txt"), "a", "utf8");
    await mkdir(join(listing, "subdir"));
    const tool = loadTool();
    const result = await tool.execute("id", { filePath: listing }, undefined, undefined, ctx);
    const text = result.content[0].text;
    expect(text).toContain("<type>directory</type>");
    const entries = text.split("\n").filter((l) => l.endsWith(".txt") || l.endsWith("subdir/"));
    expect(entries).toEqual(["alpha.txt", "subdir/", "zeta.txt"]);
    expect(text).toContain("(3 entries)");
  });

  it("paginates directory listings with offset/limit", async () => {
    const listing = join(dir, "listing");
    const tool = loadTool();
    const result = await tool.execute(
      "id",
      { filePath: listing, offset: 2, limit: 1 },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content[0].text;
    expect(text).toContain(
      "(Showing 1 of 3 entries. Use 'offset' parameter to read beyond entry 3)",
    );
  });

  it("suggests similarly-named files when the path is missing", async () => {
    const tool = loadTool();
    const result = await tool.execute(
      "id",
      { filePath: join(dir, "sample.tx") },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content[0].text;
    expect(text).toContain("File not found");
    expect(text).toContain("Did you mean one of these?");
    expect(text).toContain("sample.txt");
  });

  it("rejects files with binary extensions", async () => {
    const bin = join(dir, "archive.zip");
    await writeFile(bin, "not really binary\n", "utf8");
    const tool = loadTool();
    const result = await tool.execute("id", { filePath: bin }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Cannot read binary file");
  });

  it("rejects binary content by sample sniffing", async () => {
    const bin = join(dir, "weird.dat");
    await writeFile(bin, Buffer.from([0x61, 0x00, 0x62, 0x0a]), "utf8");
    const tool = loadTool();
    const result = await tool.execute("id", { filePath: bin }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Cannot read binary file");
  });

  it("serves images as base64 attachments", async () => {
    const img = join(dir, "photo.jpg");
    await writeFile(img, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x02]), "utf8");
    const tool = loadTool();
    const result = await tool.execute("id", { filePath: img }, undefined, undefined, ctx);
    expect(result.content[0].text).toBe("Image read successfully");
    const imagePart = result.content[1];
    expect(imagePart.type).toBe("image");
    expect(imagePart.mimeType).toBe("image/jpeg");
    expect(imagePart.data).toBe(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x02]).toString("base64"),
    );
  });

  // eslint-disable-next-line unicorn/no-optional-chaining-on-undeclared-variable -- process is a Node global at runtime
  it.skipIf(process.getuid?.() === 0)("reports unreadable files", async () => {
    const locked = join(dir, "locked.txt");
    await writeFile(locked, "secret\n", "utf8");
    await chmod(locked, 0o000);
    try {
      const tool = loadTool();
      const result = await tool.execute("id", { filePath: locked }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain("File not readable");
    } finally {
      await chmod(locked, 0o600);
    }
  });
});
