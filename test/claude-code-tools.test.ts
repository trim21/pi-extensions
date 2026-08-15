import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Bash 输出运行时落盘到 agent-dir/tmp：测试环境指向可写的临时目录
beforeAll(() => {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cc-tools-agent-dir-"));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

import { type BwrapRuntime, createBwrapRuntime } from "../src/bwrap/runtime.js";
import {
  deserializeReads,
  didYouMean,
  findSimilarFile,
  suggestPathUnderCwd,
} from "../src/claude-code/common.js";
import { exactReplace, formatReadOutput } from "../src/claude-code/files.js";
import { globFiles } from "../src/claude-code/glob.js";
import { sortFilesByMtime, summarizeCountOutput } from "../src/claude-code/grep.js";
import claudeCodeTools from "../src/claude-code/index.js";
import { buildGrepArguments, pageGrepOutput } from "../src/claude-code/search.js";
import { registerShellTools } from "../src/claude-code/shell.js";

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

/** 用注入的 runtime 单独注册 Bash 工具，测试可预置沙箱模式。 */
function loadBashTool(runtime: BwrapRuntime): RegisteredTool {
  let bashTool: RegisteredTool | undefined;
  registerShellTools(
    {
      registerTool(tool: RegisteredTool) {
        if (tool.name === "Bash") bashTool = tool;
      },
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      exec: vi.fn(),
    } as never,
    runtime,
  );
  return bashTool!;
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
  it("formats Read output with tab-prefixed line numbers and no partial notice", () => {
    expect(formatReadOutput("one\ntwo\nthree\n", 2, 1)).toEqual({
      text: "2\ttwo",
      totalLines: 4,
    });
    // limit 未指定时读取全部
    expect(formatReadOutput("one\ntwo\nthree\n", 2)).toEqual({
      text: "2\ttwo\n3\tthree\n4\t",
      totalLines: 4,
    });
  });

  it("matches Claude Code line handling: BOM, CRLF, trailing empty line", () => {
    // 尾随换行产生一个尾随空行（totalLines 比编辑器行数多 1）
    expect(formatReadOutput("one\ntwo\n")).toEqual({
      text: "1\tone\n2\ttwo\n3\t",
      totalLines: 3,
    });
    // 无尾随换行同样补一个尾随空行（对齐 readFileInRange 的尾部 fragment）
    expect(formatReadOutput("one\ntwo")).toEqual({
      text: "1\tone\n2\ttwo\n3\t",
      totalLines: 3,
    });
    // CRLF 剥离 \r
    expect(formatReadOutput("one\r\ntwo\r\n")).toEqual({
      text: "1\tone\n2\ttwo\n3\t",
      totalLines: 3,
    });
    // UTF-8 BOM 剥离
    expect(formatReadOutput("\uFEFFone\ntwo\n")).toEqual({
      text: "1\tone\n2\ttwo\n3\t",
      totalLines: 3,
    });
  });

  it("uses Claude Code warning wording for empty and out-of-range reads", () => {
    expect(formatReadOutput("")).toEqual({
      text: "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
      totalLines: 0,
    });
    expect(formatReadOutput("one\n", 5, 1)).toEqual({
      text: "<system-reminder>Warning: the file exists but is shorter than the provided offset (5). The file has 2 lines.</system-reminder>",
      totalLines: 2,
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

  it("distinguishes create vs update wording for Write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-write-wording-"));
    const filePath = join(directory, "note.txt");
    const tools = loadTools();
    const ctx = context(directory);

    const created = await call(tools.get("Write")!, { file_path: filePath, content: "x\n" }, ctx);
    expect(created.content[0].text).toBe(`File created successfully at: ${filePath}`);

    const updated = await call(tools.get("Write")!, { file_path: filePath, content: "y\n" }, ctx);
    expect(updated.content[0].text).toBe(`The file ${filePath} has been updated successfully.`);
  });

  it("uses Claude Code wording for no-op, unmatched, and multi-match edits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-edit-wording-"));
    const filePath = join(directory, "note.txt");
    await writeFile(filePath, "a b a\n", "utf8");
    const tools = loadTools();
    const ctx = context(directory);
    await call(tools.get("Read")!, { file_path: filePath }, ctx);

    await expect(
      call(
        tools.get("Edit")!,
        { file_path: filePath, old_string: "same", new_string: "same" },
        ctx,
      ),
    ).rejects.toThrow(/No changes to make: old_string and new_string are exactly the same\./);

    await expect(
      call(tools.get("Edit")!, { file_path: filePath, old_string: "nope", new_string: "x" }, ctx),
    ).rejects.toThrow(/String to replace not found in file\.\nString: nope/);

    await expect(
      call(tools.get("Edit")!, { file_path: filePath, old_string: "a", new_string: "x" }, ctx),
    ).rejects.toThrow(
      /Found 2 matches of the string to replace, but replace_all is false\. To replace all occurrences, set replace_all to true\. To replace only one occurrence, please provide more context to uniquely identify the instance\.\nString: a/,
    );
  });

  it("reports all-occurrence wording when replace_all is set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-edit-replace-all-"));
    const filePath = join(directory, "note.txt");
    await writeFile(filePath, "a b a\n", "utf8");
    const tools = loadTools();
    const ctx = context(directory);
    await call(tools.get("Read")!, { file_path: filePath }, ctx);

    const result = await call(
      tools.get("Edit")!,
      { file_path: filePath, old_string: "a", new_string: "x", replace_all: true },
      ctx,
    );
    expect(result.content[0].text).toBe(
      `The file ${filePath} has been updated. All occurrences were successfully replaced.`,
    );
    expect(await readFile(filePath, "utf8")).toBe("x b x\n");
  });

  it("creates and fills files with an empty old_string edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-edit-create-"));
    const newFile = join(directory, "nested", "created.txt");
    const emptyFile = join(directory, "empty.txt");
    await writeFile(emptyFile, "", "utf8");
    const tools = loadTools();
    const ctx = context(directory);

    const created = await call(
      tools.get("Edit")!,
      { file_path: newFile, old_string: "", new_string: "content\n" },
      ctx,
    );
    expect(await readFile(newFile, "utf8")).toBe("content\n");
    expect(created.content[0].text).toBe(`The file ${newFile} has been updated successfully.`);

    await call(
      tools.get("Edit")!,
      { file_path: emptyFile, old_string: "", new_string: "filled\n" },
      ctx,
    );
    expect(await readFile(emptyFile, "utf8")).toBe("filled\n");

    // 非空文件上用空 old_string 拒绝
    const nonEmpty = join(directory, "non-empty.txt");
    await writeFile(nonEmpty, "existing\n", "utf8");
    await expect(
      call(tools.get("Edit")!, { file_path: nonEmpty, old_string: "", new_string: "x" }, ctx),
    ).rejects.toThrow(/Cannot create new file - file already exists\./);
  });

  it("matches curly quotes via normalization and preserves their style", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-edit-quotes-"));
    const filePath = join(directory, "quote.txt");
    await writeFile(filePath, "He said \u201Chello\u201D world\n", "utf8");
    const tools = loadTools();
    const ctx = context(directory);
    await call(tools.get("Read")!, { file_path: filePath }, ctx);

    await call(
      tools.get("Edit")!,
      { file_path: filePath, old_string: '"hello"', new_string: '"goodbye"' },
      ctx,
    );
    expect(await readFile(filePath, "utf8")).toBe("He said \u201Cgoodbye\u201D world\n");
  });

  it("matches old_string without CR in CRLF files and preserves line endings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-edit-crlf-"));
    const filePath = join(directory, "crlf.txt");
    await writeFile(filePath, "one\r\ntwo\r\nthree\r\n", "utf8");
    const tools = loadTools();
    const ctx = context(directory);
    await call(tools.get("Read")!, { file_path: filePath }, ctx);

    await call(
      tools.get("Edit")!,
      { file_path: filePath, old_string: "two", new_string: "TWO" },
      ctx,
    );
    expect(await readFile(filePath, "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("rejects editing Jupyter notebooks and reports missing files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-edit-misc-"));
    const notebook = join(directory, "notebook.ipynb");
    await writeFile(notebook, "{}", "utf8");
    const tools = loadTools();
    const ctx = context(directory);
    await call(tools.get("Read")!, { file_path: notebook }, ctx);

    await expect(
      call(tools.get("Edit")!, { file_path: notebook, old_string: "{", new_string: "[]" }, ctx),
    ).rejects.toThrow(/File is a Jupyter Notebook\. Use the NotebookEditTool to edit this file\./);

    const missing = join(directory, "missing.txt");
    await expect(
      call(tools.get("Edit")!, { file_path: missing, old_string: "x", new_string: "y" }, ctx),
    ).rejects.toThrow(/File does not exist\. Note: your current working directory is /);
  });

  it("suggests a same-base different-extension file for a missing edit target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-edit-similar-"));
    await writeFile(join(directory, "note.js"), "x");
    const tools = loadTools();
    const missing = join(directory, "note.ts");
    await expect(
      call(
        tools.get("Edit")!,
        { file_path: missing, old_string: "a", new_string: "b" },
        context(directory),
      ),
    ).rejects.toThrow(`Did you mean note.js?`);
  });

  it("rejects whole reads over 256 KB but allows limited reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-read-size-"));
    const filePath = join(directory, "large.txt");
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}-${"x".repeat(90)}`);
    await writeFile(filePath, lines.join("\n") + "\n", "utf8");
    const tools = loadTools();
    const ctx = context(directory);

    await expect(call(tools.get("Read")!, { file_path: filePath }, ctx)).rejects.toThrow(
      /exceeds maximum allowed size/,
    );
    const partial = await call(tools.get("Read")!, { file_path: filePath, limit: 10 }, ctx);
    expect(partial.content[0].text).toContain("1\tline-0-");
  });

  it("rejects reads exceeding the token estimate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-read-token-"));
    const filePath = join(directory, "dense.txt");
    await writeFile(filePath, "x".repeat(110 * 1024), "utf8");
    const tools = loadTools();
    await expect(
      call(tools.get("Read")!, { file_path: filePath }, context(directory)),
    ).rejects.toThrow(/exceeds maximum allowed tokens/);
  });

  it("suggests a similar file when reading a missing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-read-similar-"));
    await writeFile(join(directory, "note.js"), "x");
    const tools = loadTools();
    const missing = join(directory, "note.ts");
    await expect(
      call(tools.get("Read")!, { file_path: missing }, context(directory)),
    ).rejects.toThrow(
      /File does not exist\. Note: your current working directory is .*Did you mean note\.js\?/,
    );
  });
});

describe("did-you-mean suggestions", () => {
  it("suggests a same-base different-extension file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-similar-"));
    await writeFile(join(directory, "foo.js"), "x");
    await writeFile(join(directory, "bar.ts"), "x");
    expect(findSimilarFile(join(directory, "foo.ts"))).toBe("foo.js");
    expect(findSimilarFile(join(directory, "missing.ts"))).toBe(undefined);
  });

  it("suggests a corrected path under cwd (dropped repo folder)", async () => {
    const base = await mkdtemp(join(tmpdir(), "cc-suggest-"));
    const repo = join(base, "repo");
    await mkdir(repo);
    await writeFile(join(repo, "foobar.txt"), "x");
    // 请求 base/foobar.txt（不存在），但 repo/foobar.txt 存在
    await expect(suggestPathUnderCwd(join(base, "foobar.txt"), repo)).resolves.toBe(
      join(repo, "foobar.txt"),
    );
    // cwd 内的缺失路径不建议
    await expect(suggestPathUnderCwd(join(repo, "missing.txt"), repo)).resolves.toBe(undefined);
  });

  it("prefers cwd relocation over same-base suggestion", async () => {
    const base = await mkdtemp(join(tmpdir(), "cc-dym-"));
    const repo = join(base, "repo");
    await mkdir(repo);
    await writeFile(join(repo, "target.ts"), "x");
    await expect(didYouMean(join(base, "target.ts"), repo)).resolves.toBe(join(repo, "target.ts"));
  });

  it("suggests a corrected path in Grep and Glob errors", async () => {
    const base = await mkdtemp(join(tmpdir(), "cc-search-dym-"));
    const repo = join(base, "repo");
    const sub = join(repo, "sub");
    await mkdir(sub, { recursive: true });
    await writeFile(join(repo, "x.txt"), "needle\n");
    await writeFile(join(sub, "y.txt"), "needle\n");
    const tools = loadTools();
    const ctx = context(repo);

    // 请求 repo 父目录下的 x.txt（不存在）→ 建议 repo/x.txt
    const missingFile = join(base, "x.txt");
    await expect(
      call(tools.get("Grep")!, { pattern: "needle", path: missingFile }, ctx),
    ).rejects.toThrow(`Did you mean ${join(repo, "x.txt")}?`);

    // 请求 base/sub（不存在）→ 建议 repo/sub
    const missingDir = join(base, "sub");
    await expect(
      call(tools.get("Glob")!, { pattern: "*.txt", path: missingDir }, ctx),
    ).rejects.toThrow(`Did you mean ${join(repo, "sub")}?`);
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
      "--multiline",
      "--multiline-dotall",
      "--glob",
      "*.ts",
      "hello",
      "/repo",
    ]);
  });

  it("uses -c for count mode and splits comma/space globs like Claude Code", () => {
    expect(buildGrepArguments({ pattern: "hello", output_mode: "count" }, "/repo")).toEqual([
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
      "-c",
      "hello",
      "/repo",
    ]);
    expect(buildGrepArguments({ pattern: "hello", glob: "*.js,*.ts src/**" }, "/repo")).toContain(
      "--glob",
    );
    const globArgs = buildGrepArguments({ pattern: "hello", glob: "*.js,*.ts src/**" }, "/repo");
    expect(globArgs.filter((arg) => arg === "--glob").length).toBe(6 + 3);
    expect(globArgs).toContain("*.js");
    expect(globArgs).toContain("*.ts");
    expect(globArgs).toContain("src/**");
    // pattern 以 - 开头时用 -e 显式声明
    expect(buildGrepArguments({ pattern: "-foo" }, "/repo")).toEqual([
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
      "--files-with-matches",
      "-e",
      "-foo",
      "/repo",
    ]);
  });

  it("paginates Grep output with applied limit/offset like Claude Code", () => {
    expect(pageGrepOutput("a\nb\nc\n", 1, 1)).toEqual({
      lines: ["b"],
      appliedLimit: 1,
      appliedOffset: 1,
    });
    expect(pageGrepOutput("a\nb\nc\n", 0, 0)).toEqual({
      lines: ["a", "b", "c"],
      appliedLimit: undefined,
      appliedOffset: undefined,
    });
    expect(pageGrepOutput("a\nb\nc\n", 1, 0)).toEqual({
      lines: ["b", "c"],
      appliedLimit: undefined,
      appliedOffset: 1,
    });
    expect(pageGrepOutput("a\nb\n", 3, 1)).toEqual({
      lines: [],
      appliedLimit: undefined,
      appliedOffset: 3,
    });
  });

  it("summarizes count-mode output with an occurrence/file total", () => {
    expect(summarizeCountOutput("/a.ts:3\n/b.ts:2\n")).toBe(
      "/a.ts:3\n/b.ts:2\n\nFound 5 total occurrences across 2 files.",
    );
    expect(summarizeCountOutput("/a.ts:1\n")).toBe(
      "/a.ts:1\n\nFound 1 total occurrence across 1 file.",
    );
    expect(summarizeCountOutput("/a.ts:3\n", "limit: 1")).toBe(
      "/a.ts:3\n\nFound 3 total occurrences across 1 file. with pagination = limit: 1",
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

  it("globs via ripgrep: oldest first, hidden files included, absolute patterns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-glob-rg-"));
    const older = join(directory, "older.txt");
    const dot = join(directory, ".hidden.txt");
    const newer = join(directory, "newer.txt");
    await writeFile(older, "x");
    await utimes(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
    // 连续 writeFile 的 mtime 可能落在同一时间片，rg 对并列 mtime 的排序不稳定；
    // 创建时错开时间，保证 mtime 严格递增：older < dot < newer
    await sleep(50);
    await writeFile(dot, "x");
    await sleep(50);
    await writeFile(newer, "x");

    // 最旧在前（rg --sort=modified 升序）
    const { files, truncated } = await globFiles("*.txt", directory);
    expect(files).toEqual([older, dot, newer]);
    expect(truncated).toBe(false);

    // --hidden 包含隐藏文件，绝对 pattern 提取 baseDir 后同样生效
    const absolute = await globFiles(join(directory, "*.txt"), directory);
    expect(absolute.files).toEqual(files);
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
    // Most recently modified file first, then the older one; paths relative to cwd.
    expect(result.content[0].text).toBe("Found 2 files\na.txt\nb.txt");
    expect(exec).toHaveBeenCalledWith("rg", expect.any(Array), expect.any(Object));
  });
});

describe("Bash", () => {
  let bashTool: RegisteredTool;

  beforeEach(() => {
    // 直接执行命令，不走沙箱
    const runtime = createBwrapRuntime();
    runtime.setMode(process.cwd(), "allow-all");
    bashTool = loadBashTool(runtime);
  });

  it("waits for command completion and returns output", async () => {
    const result = await call(
      bashTool,
      { command: "printf done", timeout: 5_000 },
      context(process.cwd()),
    );
    expect(result.content[0].text).toBe("done");
  });

  it("runs commands in the given workdir", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-bash-workdir-"));
    const nested = join(directory, "nested");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(nested));
    const ctx = context(directory);
    const result = await call(bashTool, { command: "pwd", workdir: nested }, ctx);
    expect(result.content[0].text).toBe(`${nested}\n`);
  });

  it("rejects a missing workdir", async () => {
    await expect(
      call(
        bashTool,
        { command: "pwd", workdir: join(tmpdir(), "cc-bash-missing-workdir") },
        context(process.cwd()),
      ),
    ).rejects.toThrow(/Working directory does not exist/);
  });

  it("waits for shell jobs started with ampersand", async () => {
    const startedAt = Date.now();
    const result = await call(
      bashTool,
      { command: "sleep 0.05 & printf started", timeout: 5_000 },
      context(process.cwd()),
    );
    expect(result.content[0].text).toBe("started");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it("uses millisecond timeouts", async () => {
    await expect(
      call(bashTool, { command: "sleep 1", timeout: 20 }, context(process.cwd())),
    ).rejects.toThrow(/20 milliseconds/);
  });

  it("force-stops commands that ignore SIGTERM", async () => {
    await expect(
      call(
        bashTool,
        { command: "trap '' TERM; while :; do sleep 1; done", timeout: 20 },
        context(process.cwd()),
      ),
    ).rejects.toThrow(/20 milliseconds/);
  });

  it("fails any non-zero exit with Exit code N, without command semantics", async () => {
    // grep 无匹配（exit 1）在 CC 里是"正常"，但我们不做语义化特判，一律报错
    await expect(
      call(
        bashTool,
        { command: "grep definitely-not-present /dev/null", timeout: 5_000 },
        context(process.cwd()),
      ),
    ).rejects.toThrow(/^Exit code 1$/);
  });

  it("includes the full output for failed commands", async () => {
    await expect(
      call(
        bashTool,
        { command: "sh -c 'echo boom; exit 4'", timeout: 5_000 },
        context(process.cwd()),
      ),
    ).rejects.toThrow(/^Exit code 4\nboom\n$/);
  });

  it("reports the exit code of the last command in a pipeline", async () => {
    await expect(
      call(
        bashTool,
        { command: "printf x | rg definitely-not-present", timeout: 5_000 },
        context(process.cwd()),
      ),
    ).rejects.toThrow(/^Exit code 1$/);
  });

  it("streams large output to a file and returns only the truncated tail", async () => {
    const result = await call(
      bashTool,
      { command: "seq 1 3000", timeout: 5_000 },
      context(process.cwd()),
    );
    const text = result.content[0].text;
    // 行数超限（3000 > 2000）→ 返回尾部 + 完整输出落盘
    expect(text).toMatch(/\[Showing lines 1001-3000 of 3000\. Full output: .+\]/);
    const path = text.match(/Full output: (.+)\]/)?.[1];
    expect(path).toBeTruthy();
    // 返回文本只含截断后的尾部
    expect(text.startsWith("1001\n")).toBe(true);
    expect(text.includes("1\n2\n")).toBe(false);
    // 文件是完整输出，且 details 携带路径
    const fileContent = await readFile(path, "utf8");
    const fileLines = fileContent.split("\n");
    expect(fileLines[0]).toBe("1");
    expect(fileLines[2999]).toBe("3000");
    expect(result.details?.fullOutputPath).toBe(path);
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
