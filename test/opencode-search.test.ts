/**
 * Tests for the opencode-aligned grep / glob tools:
 * - rg JSON record parsing and line normalization
 * - output rendering (grouping, truncation notice, empty result)
 * - execute against a real ripgrep: matching, include filter, file target,
 *   .gitignore/.git handling, truncation at the 100-result limit, errors
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import opencodeGlob, { buildGlobArgs, renderGlobOutput } from "../src/opencode/glob.js";
import opencodeGrep, {
  buildGrepArgs,
  parseGrepRecord,
  renderGrepOutput,
} from "../src/opencode/grep.js";

interface Tool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{ content: { type: string; text: string }[]; details: { pendant?: unknown } }>;
}

function loadTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const pi = {
    registerTool: (def: Tool) => {
      tools.set(def.name, def);
    },
    on: vi.fn(),
    registerCommand: vi.fn(),
  } as never;
  opencodeGrep(pi);
  opencodeGlob(pi);
  return tools;
}

const jsonMatch = (path: string, line: number, text: string) =>
  JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text },
      line_number: line,
      absolute_offset: 0,
      submatches: [{ match: { text: "foo" }, start: 0, end: 3 }],
    },
  });

describe("parseGrepRecord", () => {
  it("maps a match record to a normalized path and line", () => {
    expect(parseGrepRecord(jsonMatch("./src/a.ts", 12, "const foo = 1;\n"))).toEqual({
      path: "src/a.ts",
      line: 12,
      text: "const foo = 1;",
    });
  });

  it("ignores non-match records", () => {
    expect(parseGrepRecord(JSON.stringify({ type: "begin", data: { path: { text: "a" } } }))).toBe(
      undefined,
    );
    expect(parseGrepRecord(JSON.stringify({ type: "summary", data: {} }))).toBe(undefined);
  });

  it("throws on a malformed match record and on an oversized record", () => {
    expect(() => parseGrepRecord('{"type":"match","data":{"path":{}}}')).toThrow(/^\/data:/);
    expect(() => parseGrepRecord('{"type":"match"')).toThrow(/Invalid ripgrep JSON output/);
    const huge = jsonMatch("a", 1, "x".repeat(64 * 1024 + 1));
    expect(() => parseGrepRecord(huge)).toThrow(/exceeded/);
  });

  it("truncates long lines without leaving a lone surrogate", () => {
    const parsed = parseGrepRecord(jsonMatch("a.ts", 1, "a".repeat(1999) + "😀extra\n"));
    expect(parsed?.text.endsWith("...")).toBe(true);
    // 截到 2000 字符后只留下半个 emoji，去掉高代理再补省略号
    expect(parsed?.text.length).toBe(2002);
    expect(parsed?.text).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
});

describe("grep / glob argument and output helpers", () => {
  it("builds grep args with the include filter and a -- separator", () => {
    expect(buildGrepArgs("foo", undefined, ".")).toEqual([
      "--no-config",
      "--json",
      "--hidden",
      "--no-messages",
      "--glob=!**/.git/**",
      "--",
      "foo",
      ".",
    ]);
    expect(buildGrepArgs("-weird", "*.ts", "/tmp/x.ts")).toContain("--glob=*.ts");
    expect(buildGrepArgs("-weird", undefined, ".").at(-2)).toBe("-weird");
  });

  it("builds glob args and renders results", () => {
    expect(buildGlobArgs("**/*.ts")).toEqual([
      "--no-config",
      "--files",
      "--glob=**/*.ts",
      "--glob=!**/.git/**",
      ".",
    ]);
    expect(renderGlobOutput([], false)).toBe("No files found");
    expect(renderGlobOutput(["/a/b.ts"], false)).toBe("/a/b.ts");
    expect(renderGlobOutput(["/a/b.ts"], true)).toContain(
      "Results are truncated: showing first 100",
    );
  });

  it("renders grep matches grouped by file", () => {
    expect(renderGrepOutput([], false)).toBe("No files found");
    const text = renderGrepOutput(
      [
        { path: "/p/a.ts", line: 1, text: "foo" },
        { path: "/p/a.ts", line: 3, text: "foo" },
        { path: "/p/b.ts", line: 2, text: "foo" },
      ],
      false,
    );
    expect(text).toBe(
      [
        "Found 3 matches",
        "/p/a.ts:",
        "  Line 1: foo",
        "  Line 3: foo",
        "",
        "/p/b.ts:",
        "  Line 2: foo",
      ].join("\n"),
    );
    expect(renderGrepOutput([{ path: "/p/a.ts", line: 1, text: "foo" }], true)).toContain(
      "Found 1 matches (more matches available)",
    );
    expect(renderGrepOutput([{ path: "/p/a.ts", line: 1, text: "foo" }], true)).toContain(
      "(Results truncated. Consider using a more specific path or pattern.)",
    );
  });
});

describe("opencode grep / glob execute", () => {
  let dir: string;
  let ctx: { cwd: string };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-search-test-"));
    ctx = { cwd: dir };
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "const foo = 1;\nconst bar = 2;\n", "utf8");
    await writeFile(join(dir, "src", "b.py"), "foo = 1\n", "utf8");
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(dir, "ignored.txt"), "foo\n", "utf8");
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "config"), "foo\n", "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds matches with line numbers, grouped by absolute path", async () => {
    const result = await loadTools()
      .get("grep")!
      .execute("id", { pattern: "foo" }, undefined, undefined, ctx);
    const text = result.content[0].text;
    expect(text).toMatch(/^Found 2 matches\n/);
    expect(text).toContain(`${join(dir, "src", "a.ts")}:`);
    expect(text).toContain("  Line 1: const foo = 1;");
    expect(text).toContain(`${join(dir, "src", "b.py")}:`);
    // .gitignore 与 .git 都不参与搜索（rg 默认行为）
    expect(text).not.toContain("ignored.txt");
    expect(text).not.toContain(join(".git", "config"));
    expect(result.details.pendant).toEqual({ subtitle: "2 matches in 2 files" });
  });

  it("filters files with include and reports no matches", async () => {
    const tool = loadTools().get("grep")!;
    const filtered = await tool.execute(
      "id",
      { pattern: "foo", include: "*.py" },
      undefined,
      undefined,
      ctx,
    );
    expect(filtered.content[0].text).toContain("b.py");
    expect(filtered.content[0].text).not.toContain("a.ts");

    const none = await tool.execute("id", { pattern: "nothing-here" }, undefined, undefined, ctx);
    expect(none.content[0].text).toBe("No files found");
    expect(none.details.pendant).toEqual({ subtitle: "no matches" });
  });

  it("searches a single file when path points at a file", async () => {
    const result = await loadTools()
      .get("grep")!
      .execute("id", { pattern: "foo", path: join("src", "a.ts") }, undefined, undefined, ctx);
    const text = result.content[0].text;
    expect(text).toContain("Found 1 matches");
    expect(text).toContain(`${join(dir, "src", "a.ts")}:`);
    expect(text).not.toContain("b.py");
  });

  it("reports a missing path and an invalid pattern", async () => {
    const tool = loadTools().get("grep")!;
    await expect(
      tool.execute("id", { pattern: "foo", path: "nope/missing" }, undefined, undefined, ctx),
    ).rejects.toThrow(/Path does not exist: nope\/missing/);
    await expect(
      tool.execute("id", { pattern: "a(", path: "." }, undefined, undefined, ctx),
    ).rejects.toThrow(/Invalid pattern/);
  });

  it("caps results at 100 matches and says more are available", async () => {
    const lines = Array.from({ length: 120 }, (_value, index) => `foo line ${index}`).join("\n");
    await writeFile(join(dir, "many.txt"), `${lines}\n`, "utf8");
    const result = await loadTools()
      .get("grep")!
      .execute("id", { pattern: "foo", path: "many.txt" }, undefined, undefined, ctx);
    const text = result.content[0].text;
    expect(text).toContain("Found 100 matches (more matches available)");
    expect(text).toContain("(Results truncated. Consider using a more specific path or pattern.)");
    expect(text).not.toContain("  Line 101: ");
  });

  it("globs files, skipping .git and gitignored entries", async () => {
    const result = await loadTools()
      .get("glob")!
      .execute("id", { pattern: "**/*.ts" }, undefined, undefined, ctx);
    expect(result.content[0].text).toBe(join(dir, "src", "a.ts"));
    expect(result.details.pendant).toEqual({ subtitle: "1 file" });

    const none = await loadTools()
      .get("glob")!
      .execute("id", { pattern: "**/*.rs" }, undefined, undefined, ctx);
    expect(none.content[0].text).toBe("No files found");
  });

  it("globs inside a given directory and rejects files or missing paths", async () => {
    const tool = loadTools().get("glob")!;
    const scoped = await tool.execute(
      "id",
      { pattern: "*.py", path: "src" },
      undefined,
      undefined,
      ctx,
    );
    expect(scoped.content[0].text).toBe(join(dir, "src", "b.py"));

    await expect(
      tool.execute("id", { pattern: "*.ts", path: join("src", "a.ts") }, undefined, undefined, ctx),
    ).rejects.toThrow(/glob path must be a directory/);
    await expect(
      tool.execute("id", { pattern: "*.ts", path: "nope" }, undefined, undefined, ctx),
    ).rejects.toThrow(/Directory does not exist: nope/);
  });

  it("caps glob results at 100 files", async () => {
    await mkdir(join(dir, "many"));
    await Promise.all(
      Array.from({ length: 120 }, (_value, index) =>
        writeFile(join(dir, "many", `f${index}.txt`), "x\n", "utf8"),
      ),
    );
    const result = await loadTools()
      .get("glob")!
      .execute("id", { pattern: "*.txt", path: "many" }, undefined, undefined, ctx);
    const lines = result.content[0].text.split("\n");
    // 100 条路径 + 一个空行 + 截断提示
    expect(lines).toHaveLength(102);
    expect(lines.at(-1)).toContain("Results are truncated: showing first 100 results");
  });

  it("honours an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = loadTools().get("grep")!;
    await expect(
      tool.execute("id", { pattern: "foo" }, controller.signal, undefined, ctx),
    ).rejects.toThrow(/aborted/i);
  });
});
