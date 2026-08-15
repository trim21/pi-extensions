import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bwrapRuntime } from "../src/bwrap/runtime.js";
import { deserializeReads } from "../src/claude-code/common.js";
import { exactReplace, formatReadOutput } from "../src/claude-code/files.js";
import { sortFilesByMtime, summarizeCountOutput } from "../src/claude-code/grep.js";
import claudeCodeTools from "../src/claude-code/index.js";
import { buildGrepArguments, pageGrepOutput } from "../src/claude-code/search.js";

beforeEach(() => {
  bwrapRuntime.setMode(process.cwd(), "allow-all");
});

afterEach(() => {
  bwrapRuntime.reset();
});

interface RegisteredTool {
  name: string;
  description: string;
  parameters: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  execute: (...args: any[]) => Promise<any>;
}

function loadTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  claudeCodeTools({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    exec: vi.fn(),
  } as never);
  return tools;
}

/** 同 loadTools，额外捕获事件 handler（如 session_start）供测试触发。 */
function loadToolsWithHandlers(): {
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, (...args: any[]) => unknown>;
} {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  claudeCodeTools({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    exec: vi.fn(),
  } as never);
  return { tools, handlers };
}

function context(cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd,
    hasUI: true,
    ui: {
      setWidget: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
    },
    ...overrides,
  };
}

async function call(
  tool: RegisteredTool,
  params: Record<string, unknown>,
  ctx: ReturnType<typeof context>,
  signal?: AbortSignal,
) {
  return tool.execute("call-id", params, signal, undefined, ctx);
}

describe("Claude Code tool registration", () => {
  it("registers the supported synchronous tool set", () => {
    expect([...loadTools().keys()]).toEqual([
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash",
      "TodoWrite",
      "AskUserQuestion",
    ]);
  });

  it("uses Claude Code snake_case schemas", () => {
    const tools = loadTools();
    expect(Object.keys(tools.get("Read")!.parameters.properties!)).toEqual([
      "file_path",
      "offset",
      "limit",
      "pages",
    ]);
    expect(tools.get("Read")!.parameters.required).toEqual(["file_path"]);
    expect(Object.keys(tools.get("Edit")!.parameters.properties!)).toEqual([
      "file_path",
      "old_string",
      "new_string",
      "replace_all",
    ]);
    expect(tools.get("Edit")!.parameters.required).toEqual([
      "file_path",
      "old_string",
      "new_string",
    ]);
  });

  it("does not expose background Bash parameters or task tools", () => {
    const tools = loadTools();
    expect(Object.keys(tools.get("Bash")!.parameters.properties!)).toEqual([
      "command",
      "timeout",
      "description",
      "workdir",
      "dangerouslyDisableSandbox",
    ]);
    expect(tools.has("TaskOutput")).toBe(false);
    expect(tools.has("TaskStop")).toBe(false);
  });
});

describe("Read, Edit, and Write", () => {
  it("formats Read output with cat-n style line numbers and a partial notice", () => {
    expect(formatReadOutput("one\ntwo\nthree\n", 2, 1)).toEqual({
      text: "     2\ttwo\n\n<system-reminder>PARTIAL view: showing lines 2-2 of 3. Use offset and limit to read more.</system-reminder>",
      complete: false,
      totalLines: 3,
    });
  });

  it("performs only exact replacements and enforces uniqueness", () => {
    expect(exactReplace("a b a", "b", "B")).toBe("a B a");
    expect(() => exactReplace("a b a", "a", "A")).toThrow(/2 matches/);
    expect(exactReplace("a b a", "a", "A", true)).toBe("A b A");
    expect(() => exactReplace("hello", " hello", "x")).toThrow(/not found/);
  });

  it("requires a complete Read before Edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-files-"));
    const filePath = join(directory, "note.txt");
    await writeFile(filePath, "hello world\n", "utf8");
    const tools = loadTools();
    const ctx = context(directory);

    await expect(
      call(
        tools.get("Edit")!,
        { file_path: filePath, old_string: "world", new_string: "there" },
        ctx,
      ),
    ).rejects.toThrow(/not been read/);

    await call(tools.get("Read")!, { file_path: filePath }, ctx);
    await call(
      tools.get("Edit")!,
      { file_path: filePath, old_string: "world", new_string: "there" },
      ctx,
    );
    expect(await readFile(filePath, "utf8")).toBe("hello there\n");
  });

  it("allows Edit after a partial Read while still checking the file fingerprint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-partial-"));
    const filePath = join(directory, "large.txt");
    await writeFile(filePath, "one\ntwo\nthree\n", "utf8");
    const tools = loadTools();
    const ctx = context(directory);
    await call(tools.get("Read")!, { file_path: filePath, offset: 2, limit: 1 }, ctx);
    await call(
      tools.get("Edit")!,
      { file_path: filePath, old_string: "three", new_string: "THREE" },
      ctx,
    );
    expect(await readFile(filePath, "utf8")).toBe("one\ntwo\nTHREE\n");
  });

  it("requires a new Read after an external file change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-stale-"));
    const filePath = join(directory, "note.txt");
    await writeFile(filePath, "first\n", "utf8");
    const tools = loadTools();
    const ctx = context(directory);
    await call(tools.get("Read")!, { file_path: filePath }, ctx);
    await writeFile(filePath, "externally changed and longer\n", "utf8");

    await expect(
      call(tools.get("Write")!, { file_path: filePath, content: "overwrite\n" }, ctx),
    ).rejects.toThrow(/modified since read/);
  });

  it("allows Write to create a new file without a prior Read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-write-"));
    const filePath = join(directory, "nested", "new.txt");
    const tools = loadTools();
    await call(tools.get("Write")!, { file_path: filePath, content: "new\n" }, context(directory));
    expect(await readFile(filePath, "utf8")).toBe("new\n");
  });
});

describe("reads state restore on session_start", () => {
  it("deserializes reads snapshots and rejects malformed entries", () => {
    expect(
      deserializeReads({
        "/a.txt": { digest: "abc", textEditable: true },
        "/bad.txt": { digest: "x" },
        "/arr.txt": [{ digest: "y", textEditable: true }],
      }),
    ).toEqual(new Map([["/a.txt", { digest: "abc", textEditable: true }]]));
    expect(deserializeReads(null)).toEqual(new Map());
    expect(deserializeReads([{ digest: "x", textEditable: true }])).toEqual(new Map());
    expect(deserializeReads(undefined)).toEqual(new Map());
  });

  it("lets Edit proceed after restoring a prior Read from session history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-restore-ok-"));
    const filePath = join(directory, "note.txt");
    await writeFile(filePath, "hello world\n", "utf8");
    const { tools, handlers } = loadToolsWithHandlers();
    const ctx = context(directory);

    // 模拟历史会话：之前 Read 过，快照保存在 toolResult details 里
    const readResult = await call(tools.get("Read")!, { file_path: filePath }, ctx);
    const branch = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Read",
          details: { reads: readResult.details.reads },
        },
      },
    ];
    await handlers.get("session_start")!({}, { sessionManager: { getBranch: () => branch } });

    // 新进程没有重新 Read，直接 Edit 应成功
    await call(
      tools.get("Edit")!,
      { file_path: filePath, old_string: "world", new_string: "there" },
      ctx,
    );
    expect(await readFile(filePath, "utf8")).toBe("hello there\n");
  });

  it("still requires a fresh Read when the file changed while the process was gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-restore-stale-"));
    const filePath = join(directory, "note.txt");
    await writeFile(filePath, "first\n", "utf8");
    const { tools, handlers } = loadToolsWithHandlers();
    const ctx = context(directory);

    const readResult = await call(tools.get("Read")!, { file_path: filePath }, ctx);
    const branch = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Read",
          details: { reads: readResult.details.reads },
        },
      },
    ];
    await handlers.get("session_start")!({}, { sessionManager: { getBranch: () => branch } });

    // 进程退出期间文件被外部修改
    await writeFile(filePath, "externally changed and longer\n", "utf8");
    await expect(
      call(tools.get("Write")!, { file_path: filePath, content: "overwrite\n" }, ctx),
    ).rejects.toThrow(/modified since read/);
  });
});

describe("Glob and Grep", () => {
  it("builds ripgrep arguments for Claude Code output modes", () => {
    expect(
      buildGrepArguments(
        {
          pattern: "hello",
          output_mode: "content",
          glob: "*.ts",
          "-i": true,
          context: 2,
          multiline: true,
        },
        "/repo",
      ),
    ).toEqual([
      "--color=never",
      "--hidden",
      "--max-columns",
      "500",
      "--glob",
      "!.git",
      "--glob",
      "!.svn",
      "--glob",
      "!.hg",
      "--glob",
      "!.bzr",
      "--glob",
      "!.jj",
      "--glob",
      "!.sl",
      "--no-heading",
      "--with-filename",
      "--line-number",
      "--context",
      "2",
      "--ignore-case",
      "--glob",
      "*.ts",
      "--multiline",
      "--multiline-dotall",
      "--",
      "hello",
      "/repo",
    ]);
  });

  it("paginates Grep output and reports an out-of-range offset", () => {
    expect(pageGrepOutput("a\nb\nc\n", 1, 1)).toBe("b");
    expect(pageGrepOutput("a\nb\n", 3, 1)).toBe("No entries at this offset");
  });

  it("summarizes count-mode output with an occurrence/file total", () => {
    expect(summarizeCountOutput("/a.ts:3\n/b.ts:2\n")).toBe(
      "/a.ts:3\n/b.ts:2\n\nFound 5 total occurrences across 2 files.",
    );
    expect(summarizeCountOutput("/a.ts:1\n")).toBe(
      "/a.ts:1\n\nFound 1 total occurrence across 1 file.",
    );
  });

  it("sorts files_with_matches output by modification time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-grep-sort-"));
    const older = join(directory, "older.txt");
    const newer = join(directory, "newer.txt");
    await writeFile(older, "x");
    await writeFile(newer, "x");
    await utimes(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
    await expect(sortFilesByMtime(`${newer}\n${older}`)).resolves.toBe(`${newer}\n${older}`);
    await expect(sortFilesByMtime(`${older}\n${newer}`)).resolves.toBe(`${newer}\n${older}`);
  });

  it("sorts and paginates Grep file matches with the default head limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-grep-exec-"));
    const a = join(directory, "a.txt");
    const b = join(directory, "b.txt");
    await writeFile(a, "needle\n");
    await writeFile(b, "needle\n");
    await utimes(b, new Date(2020, 0, 1), new Date(2020, 0, 1)); // b is older than a
    let tool: RegisteredTool | undefined;
    const exec = vi.fn(async () => ({ code: 0, stdout: `${b}\n${a}`, stderr: "" }));
    claudeCodeTools({
      registerTool: (registered: RegisteredTool) => {
        if (registered.name === "Grep") tool = registered;
      },
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      exec,
    } as never);
    const result = await call(
      tool!,
      { pattern: "needle", output_mode: "files_with_matches" },
      context(directory),
    );
    // Most recently modified file first, then the older one.
    expect(result.content[0].text).toBe(`${a}\n${b}`);
    expect(exec).toHaveBeenCalledWith("rg", expect.any(Array), expect.any(Object));
  });
});

describe("Bash", () => {
  it("waits for command completion and returns output", async () => {
    const tools = loadTools();
    const result = await call(
      tools.get("Bash")!,
      { command: "printf done", timeout: 5_000 },
      context(process.cwd()),
    );
    expect(result.content[0].text).toBe("done");
  });

  it("runs commands in the given workdir", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-bash-workdir-"));
    const nested = join(directory, "nested");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(nested));
    const tools = loadTools();
    const ctx = context(directory);
    const result = await call(tools.get("Bash")!, { command: "pwd", workdir: nested }, ctx);
    expect(result.content[0].text).toBe(`${nested}\n`);
  });

  it("rejects a missing workdir", async () => {
    const tools = loadTools();
    await expect(
      call(
        tools.get("Bash")!,
        { command: "pwd", workdir: join(tmpdir(), "cc-bash-missing-workdir") },
        context(process.cwd()),
      ),
    ).rejects.toThrow(/Working directory does not exist/);
  });

  it("waits for shell jobs started with ampersand", async () => {
    const tools = loadTools();
    const startedAt = Date.now();
    const result = await call(
      tools.get("Bash")!,
      { command: "sleep 0.05 & printf started", timeout: 5_000 },
      context(process.cwd()),
    );
    expect(result.content[0].text).toBe("started");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it("uses millisecond timeouts", async () => {
    const tools = loadTools();
    await expect(
      call(tools.get("Bash")!, { command: "sleep 1", timeout: 20 }, context(process.cwd())),
    ).rejects.toThrow(/20 milliseconds/);
  });

  it("force-stops commands that ignore SIGTERM", async () => {
    const tools = loadTools();
    await expect(
      call(
        tools.get("Bash")!,
        { command: "trap '' TERM; while :; do sleep 1; done", timeout: 20 },
        context(process.cwd()),
      ),
    ).rejects.toThrow(/20 milliseconds/);
  });
});

describe("TodoWrite and AskUserQuestion", () => {
  it("uses activeForm for the in-progress widget row", async () => {
    const tools = loadTools();
    const ctx = context(process.cwd());
    await call(
      tools.get("TodoWrite")!,
      {
        todos: [
          { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
          { content: "Build", status: "pending", activeForm: "Building" },
        ],
      },
      ctx,
    );
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("claude-code-todos", [
      "Progress: 0/2 (0%)",
      "- [>] Running tests",
      "- [ ] Build",
    ]);
  });

  it("re-renders the widget from the last TodoWrite on session_start", async () => {
    const { handlers } = loadToolsWithHandlers();
    const setWidget = vi.fn();
    const branch = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "TodoWrite",
          details: {
            todos: [
              { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
              { content: "Build", status: "pending", activeForm: "Building" },
            ],
          },
        },
      },
    ];
    await handlers.get("session_start")!(
      {},
      { sessionManager: { getBranch: () => branch }, ui: { setWidget } },
    );

    expect(setWidget).toHaveBeenCalledWith("claude-code-todos", [
      "Progress: 0/2 (0%)",
      "- [>] Running tests",
      "- [ ] Build",
    ]);
  });

  it("skips a corrupt todo payload when restoring the widget", async () => {
    const { handlers } = loadToolsWithHandlers();
    const setWidget = vi.fn();
    const branch = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "TodoWrite",
          details: {
            todos: [{ content: "Run tests", status: "bogus", activeForm: "Running tests" }],
          },
        },
      },
    ];
    await handlers.get("session_start")!(
      {},
      { sessionManager: { getBranch: () => branch }, ui: { setWidget } },
    );

    expect(setWidget).not.toHaveBeenCalled();
  });

  it("asks a single-choice question and returns the answer", async () => {
    const tools = loadTools();
    const ctx = context(process.cwd());
    ctx.ui.select.mockResolvedValue("Postgres");
    const result = await call(
      tools.get("AskUserQuestion")!,
      {
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres", description: "Relational" },
              { label: "SQLite", description: "Embedded" },
            ],
            multiSelect: false,
          },
        ],
      },
      ctx,
    );
    expect(result.content[0].text).toContain('"Which database?"="Postgres"');
  });

  it("falls back to free text when the Other option is chosen", async () => {
    const tools = loadTools();
    const ctx = context(process.cwd());
    ctx.ui.select.mockResolvedValue("Other");
    ctx.ui.input.mockResolvedValue("  TiDB  ");
    const result = await call(
      tools.get("AskUserQuestion")!,
      {
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres", description: "Relational" },
              { label: "SQLite", description: "Embedded" },
            ],
            multiSelect: false,
          },
        ],
      },
      ctx,
    );
    expect(result.content[0].text).toContain('"Which database?"="TiDB"');
    expect(ctx.ui.input).toHaveBeenCalledWith("Database: Which database?", "Type your answer", {
      signal: undefined,
    });
  });

  it("records Unanswered when Other input is blank or cancelled", async () => {
    const tools = loadTools();
    const ctx = context(process.cwd());
    ctx.ui.select.mockResolvedValue("Other");
    ctx.ui.input.mockResolvedValue(undefined);
    const result = await call(
      tools.get("AskUserQuestion")!,
      {
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres", description: "Relational" },
              { label: "SQLite", description: "Embedded" },
            ],
            multiSelect: false,
          },
        ],
      },
      ctx,
    );
    expect(result.content[0].text).toContain('"Which database?"="Unanswered"');
  });

  it("supports free text in multi-select via Other", async () => {
    const tools = loadTools();
    const ctx = context(process.cwd());
    ctx.ui.select.mockResolvedValueOnce("Postgres").mockResolvedValueOnce("Other");
    ctx.ui.input.mockResolvedValue("  CockroachDB  ");
    const result = await call(
      tools.get("AskUserQuestion")!,
      {
        questions: [
          {
            question: "Which databases?",
            header: "Databases",
            options: [
              { label: "Postgres", description: "Relational" },
              { label: "SQLite", description: "Embedded" },
            ],
            multiSelect: true,
          },
        ],
      },
      ctx,
    );
    expect(result.content[0].text).toContain('"Which databases?"="Postgres, CockroachDB"');
  });
});
