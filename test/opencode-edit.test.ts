/**
 * Tests for the opencode-aligned edit extension execute():
 * - new-file creation via empty oldString
 * - identical/empty oldString errors
 * - unique match, replaceAll, multiple-match error
 * - BOM and CRLF preservation
 * - abort handling
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import opencodeFileTools from "../src/opencode/files.js";

interface EditParams {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

interface Tool {
  name: string;
  execute: (
    toolCallId: string,
    params: EditParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{
    content: { type: string; text: string }[];
    details: { diff: string; patch: string; firstChangedLine: number };
  }>;
}

function loadTool(): Tool {
  let tool: Tool | undefined;
  opencodeFileTools({
    registerTool: (def: Tool) => {
      if (def.name === "edit") tool = def;
    },
  } as never);
  return tool!;
}

let dir: string;
let target: string;
let ctx: { cwd: string };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-edit-test-"));
  target = join(dir, "sub", "file.txt");
  await mkdir(join(dir, "sub"));
  ctx = { cwd: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("opencode edit execute", () => {
  it("creates a new file when oldString is empty and the file does not exist", async () => {
    const tool = loadTool();
    const result = await tool.execute(
      "id",
      { filePath: target, oldString: "", newString: "hello\n" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toBe("Edit applied successfully.");
    expect(result.details.diff).toBe("");
    expect(await readFile(target, "utf8")).toBe("hello\n");
  });

  it("throws when oldString and newString are identical", async () => {
    const tool = loadTool();
    await expect(
      tool.execute(
        "id",
        { filePath: target, oldString: "a", newString: "a" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/identical/);
  });

  it("throws when oldString is empty and the file already exists", async () => {
    await writeFile(target, "existing\n", "utf8");
    const tool = loadTool();
    await expect(
      tool.execute(
        "id",
        { filePath: target, oldString: "", newString: "new" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/oldString cannot be empty/);
  });

  it("replaces a unique match and reports the diff", async () => {
    await writeFile(target, "one\ntwo\nthree\n", "utf8");
    const tool = loadTool();
    const result = await tool.execute(
      "id",
      { filePath: target, oldString: "two", newString: "TWO" },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("one\nTWO\nthree\n");
    expect(result.details.diff).toContain("-2 two");
    expect(result.details.diff).toContain("+2 TWO");
    expect(result.details.patch.startsWith("--- ")).toBe(true);
    expect(result.details.firstChangedLine).toBe(2);
  });

  it("replaceAll replaces every occurrence", async () => {
    await writeFile(target, "alpha\nbeta\nalpha\n", "utf8");
    const tool = loadTool();
    await tool.execute(
      "id",
      { filePath: target, oldString: "alpha", newString: "gamma", replaceAll: true },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("gamma\nbeta\ngamma\n");
  });

  it("throws when oldString matches multiple times", async () => {
    await writeFile(target, "abc\nabc\n", "utf8");
    const tool = loadTool();
    await expect(
      tool.execute(
        "id",
        { filePath: target, oldString: "abc", newString: "x" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/multiple matches/);
  });

  it("preserves a leading BOM", async () => {
    await writeFile(target, "\uFEFFone\ntwo\n", "utf8");
    const tool = loadTool();
    await tool.execute(
      "id",
      { filePath: target, oldString: "two", newString: "TWO" },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("\uFEFFone\nTWO\n");
  });

  it("preserves CRLF line endings", async () => {
    await writeFile(target, "one\r\ntwo\r\nthree\r\n", "utf8");
    const tool = loadTool();
    await tool.execute(
      "id",
      { filePath: target, oldString: "two", newString: "TWO" },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("accepts CRLF oldString against an LF file", async () => {
    await writeFile(target, "one\ntwo\nthree\n", "utf8");
    const tool = loadTool();
    await tool.execute(
      "id",
      { filePath: target, oldString: "one\r\ntwo", newString: "ONE\r\nTWO" },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("ONE\nTWO\nthree\n");
  });

  it("does not double CR when newString already uses CRLF on a CRLF file", async () => {
    await writeFile(target, "one\r\ntwo\r\n", "utf8");
    const tool = loadTool();
    await tool.execute(
      "id",
      { filePath: target, oldString: "two", newString: "TWO\r\nextra" },
      undefined,
      undefined,
      ctx,
    );
    const written = await readFile(target, "utf8");
    expect(written).toBe("one\r\nTWO\r\nextra\r\n");
    expect(written).not.toContain("\r\r\n");
  });

  it("throws File not found when the path is missing", async () => {
    const tool = loadTool();
    await expect(
      tool.execute(
        "id",
        { filePath: join(dir, "missing.txt"), oldString: "a", newString: "b" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/File .*missing\.txt not found/);
  });

  it("throws when the path is a directory", async () => {
    const tool = loadTool();
    await expect(
      tool.execute(
        "id",
        { filePath: dir, oldString: "a", newString: "b" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/Path is a directory, not a file/);
  });

  it("aborts before touching the file", async () => {
    await writeFile(target, "content\n", "utf8");
    const controller = new AbortController();
    controller.abort();
    const tool = loadTool();
    await expect(
      tool.execute(
        "id",
        { filePath: target, oldString: "content", newString: "changed" },
        controller.signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(await readFile(target, "utf8")).toBe("content\n");
  });
});
