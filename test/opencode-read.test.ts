/**
 * Tests for the opencode-aligned read extension:
 * - readLines: line/byte caps, single-line 2000-char truncation, CRLF/CR,
 *   empty files, trailing-newline handling
 * - execute: text files with line numbers/offset/limit, directory listing,
 *   did-you-mean suggestions, image detection, binary rejection
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import opencodeFileTools, { readLines } from "../src/opencode/files.js";

const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;

describe("readLines", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-readlines-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, content: string | Buffer): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, content);
    return path;
  }

  it("returns all lines when within limits", async () => {
    const path = await write("small.txt", "a\nb\nc");
    const page = await readLines(path, { offset: 1, limit: 2000 });
    expect(page).toMatchObject({ raw: ["a", "b", "c"], count: 3, cut: false, more: false });
  });

  it("does not truncate when line count exactly equals the limit", async () => {
    const path = await write("exact.txt", "a\nb");
    const page = await readLines(path, { offset: 1, limit: 2 });
    expect(page).toMatchObject({ raw: ["a", "b"], count: 2, more: false });
  });

  it("keeps scanning after a line cap so count is the file total", async () => {
    const path = await write("more.txt", "1\n2\n3\n4\n5");
    const page = await readLines(path, { offset: 1, limit: 2 });
    expect(page).toMatchObject({
      raw: ["1", "2"],
      count: 5,
      cut: false,
      more: true,
    });
  });

  it("stops immediately when the byte cap is hit", async () => {
    const path = await write("bytes.txt", "aaaaaa\nbbbbbb");
    const page = await readLines(path, { offset: 1, limit: 2000, maxBytes: 10 });
    expect(page).toMatchObject({
      raw: ["aaaaaa"],
      cut: true,
      more: true,
    });
    expect(page.count).toBe(2);
  });

  it("truncates a single over-long line to MAX_LINE_LENGTH with a suffix", async () => {
    const path = await write("long.txt", "x".repeat(MAX_LINE_LENGTH + 10));
    const page = await readLines(path, { offset: 1, limit: 2000 });
    expect(page.raw).toEqual(["x".repeat(MAX_LINE_LENGTH) + MAX_LINE_SUFFIX]);
    expect(page.more).toBe(false);
    expect(page.count).toBe(1);
  });

  it("does not count a trailing newline as an extra line", async () => {
    const path = await write("trail.txt", "a\nb\n");
    const page = await readLines(path, { offset: 1, limit: 2000 });
    expect(page).toMatchObject({ raw: ["a", "b"], count: 2, more: false });
  });

  it("treats an empty file as 0 lines", async () => {
    const path = await write("empty.txt", "");
    const page = await readLines(path, { offset: 1, limit: 2000 });
    expect(page).toMatchObject({ raw: [], count: 0, more: false, cut: false });
  });

  it("strips CRLF so line contents have no trailing CR", async () => {
    const path = await write("crlf.txt", "one\r\ntwo\r\n");
    const page = await readLines(path, { offset: 1, limit: 2000 });
    expect(page.raw).toEqual(["one", "two"]);
  });

  it("splits on lone CR the same way as LF", async () => {
    const path = await write("cr.txt", "one\rtwo\r");
    const page = await readLines(path, { offset: 1, limit: 2000 });
    expect(page.raw).toEqual(["one", "two"]);
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
  opencodeFileTools({
    registerTool: (def: Tool) => {
      if (def.name === "read") tool = def;
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

  it("reads an empty file as 0 lines", async () => {
    const empty = join(dir, "empty.txt");
    await writeFile(empty, "", "utf8");
    const tool = loadTool();
    const result = await tool.execute("id", { filePath: empty }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("(End of file - total 0 lines)");
  });

  it("throws when offset > 1 for an empty file", async () => {
    const empty = join(dir, "empty-offset.txt");
    await writeFile(empty, "", "utf8");
    const tool = loadTool();
    await expect(
      tool.execute("id", { filePath: empty, offset: 2 }, undefined, undefined, ctx),
    ).rejects.toThrow(/Offset 2 is out of range for this file \(0 lines\)/);
  });

  it("strips CRLF from line contents in the numbered output", async () => {
    const crlf = join(dir, "crlf.txt");
    await writeFile(crlf, "one\r\ntwo\r\n", "utf8");
    const tool = loadTool();
    const result = await tool.execute("id", { filePath: crlf }, undefined, undefined, ctx);
    const text = result.content[0].text;
    expect(text).toContain("1: one\n");
    expect(text).toContain("2: two\n");
    expect(text).not.toContain("\r");
    expect(text).toContain("(End of file - total 2 lines)");
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

  // Windows 无 POSIX 权限位，chmod 0o000 不生效：此用例只在 Unix 上跑。
  // eslint-disable-next-line unicorn/no-optional-chaining-on-undeclared-variable -- process is a Node global at runtime
  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "reports unreadable files",
    async () => {
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
    },
  );
});
