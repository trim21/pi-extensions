/**
 * Tests for the opencode-aligned edit extension execute():
 * - new-file creation via empty oldString
 * - identical/empty oldString errors
 * - read-before-edit guard (untouched file, external change, write/read accounting)
 * - unique match, replaceAll, multiple-match error
 * - BOM and CRLF preservation
 * - abort handling
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deserializeReads } from "../src/lib/file-reads.js";
import opencodeFileTools from "../src/opencode/files.js";

interface ToolDetails {
  diff?: string;
  patch?: string;
  firstChangedLine?: number;
  reads?: Record<string, unknown>;
}

interface Tool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{ content: { type: string; text: string }[]; details: ToolDetails }>;
}

interface Harness {
  /** edit 工具。 */
  tool: Tool;
  write: Tool;
  /** 先走一遍 read，满足 read-before-edit 守卫；返回该次 read 的 details。 */
  readFirst: (filePath: string) => Promise<ToolDetails>;
  /** 触发 session_start，用给定的分支历史重建 reads 记账。 */
  emitSessionStart: (branch: unknown[]) => Promise<void>;
}

function loadTool(): Harness {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  opencodeFileTools({
    registerTool: (def: Tool) => {
      tools.set(def.name, def);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: vi.fn(),
  } as never);
  const read = tools.get("read")!;
  return {
    tool: tools.get("edit")!,
    write: tools.get("write")!,
    readFirst: async (filePath: string) => {
      const result = await read.execute("id", { filePath }, undefined, undefined, ctx);
      expect(result.details.reads).toBeDefined();
      return result.details;
    },
    emitSessionStart: async (branch: unknown[]) => {
      for (const handler of handlers.get("session_start") ?? []) {
        await handler(
          { type: "session_start", reason: "startup" },
          {
            cwd: ctx.cwd,
            ui: { notify: vi.fn(), setStatus: vi.fn() },
            sessionManager: { getBranch: () => branch },
          },
        );
      }
    },
  };
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
    const { tool } = loadTool();
    const result = await tool.execute(
      "id",
      { filePath: target, oldString: "", newString: "hello\n" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toBe("Edit applied successfully.");
    expect(result.details.diff).toBe("");
    expect(result.details).toMatchObject({ pendant: { subtitle: `./${join("sub", "file.txt")}` } });
    expect(await readFile(target, "utf8")).toBe("hello\n");
  });

  it("throws when oldString and newString are identical", async () => {
    const { tool } = loadTool();
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
    const { tool } = loadTool();
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
    const { tool, readFirst } = loadTool();
    await readFirst(target);
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
    expect(result.details.patch?.startsWith("--- ")).toBe(true);
    expect(result.details.firstChangedLine).toBe(2);
    expect(Object.keys(result.details.reads ?? {})).toHaveLength(1);
  });

  it("replaceAll replaces every occurrence", async () => {
    await writeFile(target, "alpha\nbeta\nalpha\n", "utf8");
    const { tool, readFirst } = loadTool();
    await readFirst(target);
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
    const { tool, readFirst } = loadTool();
    await readFirst(target);
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
    const { tool, readFirst } = loadTool();
    await readFirst(target);
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
    const { tool, readFirst } = loadTool();
    await readFirst(target);
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
    const { tool, readFirst } = loadTool();
    await readFirst(target);
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
    const { tool, readFirst } = loadTool();
    await readFirst(target);
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
    const { tool } = loadTool();
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
    const { tool } = loadTool();
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
    const { tool } = loadTool();
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

describe("opencode edit read-before-edit guard", () => {
  it("rejects an edit of a file that was never read", async () => {
    await writeFile(target, "one\ntwo\n", "utf8");
    const { tool } = loadTool();
    await expect(
      tool.execute(
        "id",
        { filePath: target, oldString: "two", newString: "TWO" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/File has not been read yet\. Read it first before writing to it\./);
    expect(await readFile(target, "utf8")).toBe("one\ntwo\n");
  });

  it("rejects an edit when the file changed after the read", async () => {
    await writeFile(target, "one\ntwo\n", "utf8");
    const { tool, readFirst } = loadTool();
    await readFirst(target);
    await writeFile(target, "one\ntwo\nthree\n", "utf8");
    await expect(
      tool.execute(
        "id",
        { filePath: target, oldString: "two", newString: "TWO" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/File has been modified since read/);
    expect(await readFile(target, "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("refreshes the snapshot after an edit, so consecutive edits need one read", async () => {
    await writeFile(target, "one\ntwo\n", "utf8");
    const { tool, readFirst } = loadTool();
    await readFirst(target);
    await tool.execute(
      "id",
      { filePath: target, oldString: "one", newString: "ONE" },
      undefined,
      undefined,
      ctx,
    );
    await tool.execute(
      "id",
      { filePath: target, oldString: "two", newString: "TWO" },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("ONE\nTWO\n");
  });

  it("allows editing a file that write just created without a read", async () => {
    const { tool, write } = loadTool();
    await write.execute(
      "id",
      { filePath: target, content: "one\ntwo\n" },
      undefined,
      undefined,
      ctx,
    );
    await tool.execute(
      "id",
      { filePath: target, oldString: "two", newString: "TWO" },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("one\nTWO\n");
  });

  it("restores the read snapshot from the session branch", async () => {
    await writeFile(target, "one\ntwo\n", "utf8");
    const first = loadTool();
    const readDetails = await first.readFirst(target);

    // 新扩展实例（进程重启 / /reload）：内存记账为空，只能靠 session 分支恢复
    const second = loadTool();
    await expect(
      second.tool.execute(
        "id",
        { filePath: target, oldString: "two", newString: "TWO" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/File has not been read yet/);

    await second.emitSessionStart([
      {
        type: "message",
        message: { role: "toolResult", toolName: "read", details: readDetails },
      },
    ]);
    await second.tool.execute(
      "id",
      { filePath: target, oldString: "two", newString: "TWO" },
      undefined,
      undefined,
      ctx,
    );
    expect(await readFile(target, "utf8")).toBe("one\nTWO\n");
  });
});

describe("deserializeReads", () => {
  it("keeps valid snapshots and drops malformed data", () => {
    expect(deserializeReads(null)).toEqual(new Map());
    expect(deserializeReads(undefined)).toEqual(new Map());
    expect(deserializeReads([{ digest: "x", textEditable: true }])).toEqual(new Map());
    expect(deserializeReads({ "/a": { digest: "x" } })).toEqual(new Map());
    expect(deserializeReads({ "/a": { digest: "x", textEditable: true } })).toEqual(
      new Map([["/a", { digest: "x", textEditable: true }]]),
    );
  });
});
