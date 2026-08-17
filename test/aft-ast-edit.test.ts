import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AftTransportPool } from "@cortexkit/aft-bridge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/aft/bridge.js", () => ({
  callAftTool: vi.fn(),
}));

import { extractPreviewFiles, mapEditItems, registerAstEditTool } from "../src/aft/ast-edit.js";
import { callAftTool } from "../src/aft/bridge.js";
import type { AftToolContext } from "../src/aft/tools.js";

const mockCallAftTool = vi.mocked(callAftTool);

function captureTool(pi: ExtensionAPI, ctx: AftToolContext) {
  let captured:
    | {
        execute: (
          id: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
          onUpdate?: unknown,
          extCtx?: { cwd: string; hasUI: boolean },
        ) => Promise<unknown>;
      }
    | undefined;
  const mockPi = {
    registerTool: (tool: typeof captured) => {
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  registerAstEditTool(mockPi, ctx);
  if (!captured) throw new Error("tool not registered");
  return captured;
}

describe("extractPreviewFiles", () => {
  it("extracts single-file diffs from top-level diff (symbol mode)", () => {
    expect(
      extractPreviewFiles({
        success: true,
        diff: { before: "old", after: "new", additions: 1, deletions: 1 },
      }),
    ).toEqual({ files: [{ file: "", before: "old", after: "new" }], truncated: false });
  });

  it("extracts all files from files[] (glob batch)", () => {
    expect(
      extractPreviewFiles({
        success: true,
        files: [
          { file: "/a.ts", replacements: 1, diff: { before: "a1", after: "a2" } },
          { file: "/b.ts", replacements: 2, diff: { before: "b1", after: "b2" } },
        ],
      }),
    ).toEqual({
      files: [
        { file: "/a.ts", before: "a1", after: "a2" },
        { file: "/b.ts", before: "b1", after: "b2" },
      ],
      truncated: false,
    });
  });

  it("flags truncated files (over 512KB) and drops their content", () => {
    expect(
      extractPreviewFiles({
        success: true,
        files: [
          {
            file: "/big.ts",
            replacements: 1,
            diff: { additions: 1, deletions: 1, truncated: true },
          },
          { file: "/ok.ts", replacements: 1, diff: { before: "x", after: "y" } },
        ],
      }),
    ).toEqual({ files: [{ file: "/ok.ts", before: "x", after: "y" }], truncated: true });
  });

  it("returns empty when nothing found", () => {
    expect(extractPreviewFiles({ success: true, ok: true })).toEqual({
      files: [],
      truncated: false,
    });
  });
});

describe("mapEditItems", () => {
  it("maps snake_case params to AFT wire names", () => {
    expect(
      mapEditItems([
        { old_string: "a", new_string: "b", occurrence: 2 },
        { start_line: 3, end_line: 5, content: "c" },
      ]),
    ).toEqual([
      { oldString: "a", newString: "b", occurrence: 2 },
      { startLine: 3, endLine: 5, content: "c" },
    ]);
  });
});

describe("ast_edit execute", () => {
  const dir = mkdtempSync(join(tmpdir(), "aft-ast-edit-test-"));
  const pool = { getBridge: () => ({}) } as unknown as AftTransportPool;

  beforeEach(() => {
    mockCallAftTool.mockReset();
  });

  it("previews for write-guard then lets AFT write a single-file symbol edit", async () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "export function foo() { return 1; }\n");
    mockCallAftTool
      .mockResolvedValueOnce({
        text: "",
        response: {
          success: true,
          preview: true,
          diff: {
            before: "export function foo() { return 1; }",
            after: "export function foo() { return 2; }",
          },
        },
      })
      .mockResolvedValueOnce({
        text: "Edited symbol foo in a.ts",
        response: { success: true, file, symbol: "foo", operation: "replace", backup_id: "b1" },
      });

    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    const result = await tool.execute(
      "id",
      { file_path: file, symbol: "foo", content: "new" },
      undefined,
      undefined,
      {
        cwd: dir,
        hasUI: false,
      },
    );

    expect(mockCallAftTool).toHaveBeenCalledTimes(2);
    expect(mockCallAftTool).toHaveBeenNthCalledWith(
      1,
      pool.getBridge(dir),
      "edit",
      { path: file, symbol: "foo", content: "new" },
      expect.anything(),
      { preview: true },
    );
    // 回归：preview 走 options 通道，rawArgs 不携带 preview/include_diff_content
    const previewCall = mockCallAftTool.mock.calls[0];
    expect(previewCall[2]).not.toHaveProperty("preview");
    expect(previewCall[2]).not.toHaveProperty("include_diff_content");
    expect(mockCallAftTool).toHaveBeenNthCalledWith(
      2,
      pool.getBridge(dir),
      "edit",
      { path: file, symbol: "foo", content: "new" },
      expect.anything(),
    );
    expect((result as { content: { text: string }[] }).content[0].text).toBe(
      "Edited symbol foo in a.ts",
    );
    expect((result as { details: { files: string[] } }).details.files).toEqual([file]);
  });

  it("runs write-guard for every file in a glob batch and lets AFT write once", async () => {
    const a = join(dir, "g-a.ts");
    const b = join(dir, "g-b.ts");
    writeFileSync(a, "const V = 1;\n");
    writeFileSync(b, "const V = 2;\n");
    mockCallAftTool
      .mockResolvedValueOnce({
        text: "",
        response: {
          success: true,
          preview: true,
          files: [
            { file: a, replacements: 1, diff: { before: "const V = 1;", after: "const V = 9;" } },
            { file: b, replacements: 1, diff: { before: "const V = 2;", after: "const V = 9;" } },
          ],
          total_files: 2,
        },
      })
      .mockResolvedValueOnce({
        text: "2 files updated",
        response: { success: true, total_files: 2 },
      });

    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    const result = await tool.execute(
      "id",
      {
        file_path: join(dir, "**/*.ts"),
        old_string: "V = ",
        new_string: "V = 9",
        replace_all: true,
      },
      undefined,
      undefined,
      { cwd: dir, hasUI: false },
    );

    expect(mockCallAftTool).toHaveBeenCalledTimes(2);
    // 第一次（preview）走 options 通道，rawArgs 不携带 preview 标志
    const firstCall = mockCallAftTool.mock.calls[0];
    expect(firstCall[2]).not.toHaveProperty("preview");
    expect(firstCall[4]).toEqual({ preview: true });
    // 第二次（真正写盘）不带 preview 标志
    const secondArgs = mockCallAftTool.mock.calls[1][2];
    expect(secondArgs.preview).toBeUndefined();
    expect(secondArgs.include_diff_content).toBeUndefined();
    expect((result as { details: { files: string[] } }).details.files).toEqual([a, b]);
  });

  it("rejects truncated preview", async () => {
    const file = join(dir, "t.ts");
    writeFileSync(file, "x\n");
    mockCallAftTool.mockResolvedValue({
      text: "",
      response: {
        success: true,
        preview: true,
        files: [{ file, replacements: 1, diff: { additions: 1, deletions: 1, truncated: true } }],
      },
    });

    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    await expect(
      tool.execute(
        "id",
        { file_path: file, old_string: "x", new_string: "y" },
        undefined,
        undefined,
        {
          cwd: dir,
          hasUI: false,
        },
      ),
    ).rejects.toThrow("too large");
  });

  it("rejects when preview returns no content", async () => {
    const file = join(dir, "n.ts");
    writeFileSync(file, "x\n");
    mockCallAftTool.mockResolvedValue({ text: "", response: { success: true, ok: true } });

    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    await expect(
      tool.execute(
        "id",
        { file_path: file, old_string: "x", new_string: "y" },
        undefined,
        undefined,
        {
          cwd: dir,
          hasUI: false,
        },
      ),
    ).rejects.toThrow("did not return");
  });

  it("rejects when multiple modes are given", async () => {
    const file = join(dir, "m.ts");
    writeFileSync(file, "x\n");
    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    await expect(
      tool.execute(
        "id",
        { file_path: file, old_string: "x", new_string: "y", symbol: "foo", content: "z" },
        undefined,
        undefined,
        { cwd: dir, hasUI: false },
      ),
    ).rejects.toThrow("exactly one mode");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
