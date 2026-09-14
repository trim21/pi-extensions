/**
 * WorkspaceEdit 应用与 rename 定位辅助测试（src/lib/lsp/rename.ts）：
 * - expandWorkspaceEdit：changes / documentChanges / 多文件 / 乱序 edit /
 *   CRLF / 位置越界报错 / 文件级 document change 报不支持 / readText 失败
 * - canonicalizeEdit：URI 归一化后比较两次 rename 结果
 * - symbolCandidates：符号名 + 可选 character 的候选定位
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalizeEdit, expandWorkspaceEdit, symbolCandidates } from "../src/lib/lsp/rename.js";

const readFrom = (texts: Record<string, string>) => (path: string) => {
  const text = texts[path];
  if (text === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
  return Promise.resolve(text);
};

const edit = (
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  newText: string,
) => ({
  range: {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
  },
  newText,
});

describe("expandWorkspaceEdit", () => {
  it("changes 形式：乱序 edit 按位置降序应用", async () => {
    const file = "/proj/a.ts";
    const applied = await expandWorkspaceEdit(
      {
        changes: {
          [pathToFileURL(file).href]: [edit(0, 6, 0, 10, "second"), edit(0, 0, 0, 5, "first")],
        },
      },
      readFrom({ [file]: "alpha beta gamma\n" }),
    );
    expect(applied).toEqual([
      {
        path: file,
        oldText: "alpha beta gamma\n",
        newText: "first second gamma\n",
        changeCount: 2,
      },
    ]);
  });

  it("documentChanges 形式（TextDocumentEdit）", async () => {
    const file = "/proj/b.ts";
    const applied = await expandWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: pathToFileURL(file).href, version: 1 },
            edits: [edit(0, 0, 0, 3, "xyz")],
          },
        ],
      },
      readFrom({ [file]: "abc\n" }),
    );
    expect(applied[0]?.newText).toBe("xyz\n");
  });

  it("多文件：每个文件独立计算新旧文本", async () => {
    const a = "/proj/a.ts";
    const b = "/proj/b.ts";
    const applied = await expandWorkspaceEdit(
      {
        changes: {
          [pathToFileURL(a).href]: [edit(0, 0, 0, 1, "x")],
          [pathToFileURL(b).href]: [edit(0, 0, 0, 1, "y")],
        },
      },
      readFrom({ [a]: "aa\n", [b]: "bb\n" }),
    );
    expect(applied).toHaveLength(2);
    const byPath = new Map(applied.map((item) => [item.path, item]));
    expect(byPath.get(a)?.newText).toBe("xa\n");
    expect(byPath.get(b)?.newText).toBe("yb\n");
  });

  it("changes 与 documentChanges 指向同一文件时合并编辑", async () => {
    const file = "/proj/c.ts";
    const applied = await expandWorkspaceEdit(
      {
        changes: { [pathToFileURL(file).href]: [edit(1, 0, 1, 1, "B")] },
        documentChanges: [
          {
            textDocument: { uri: pathToFileURL(file).href, version: 1 },
            edits: [edit(0, 0, 0, 1, "A")],
          },
        ],
      },
      readFrom({ [file]: "aa\nbb\n" }),
    );
    expect(applied).toEqual([
      { path: file, oldText: "aa\nbb\n", newText: "Aa\nBb\n", changeCount: 2 },
    ]);
  });

  it(String.raw`CRLF：列号不含 \r`, async () => {
    const file = "/proj/crlf.ts";
    const applied = await expandWorkspaceEdit(
      { changes: { [pathToFileURL(file).href]: [edit(0, 6, 0, 9, "X")] } },
      readFrom({ [file]: "const old = 1;\r\n" }),
    );
    expect(applied[0]?.newText).toBe("const X = 1;\r\n");
  });

  it("行号越界报错，不产出部分结果", async () => {
    const file = "/proj/short.ts";
    await expect(
      expandWorkspaceEdit(
        { changes: { [pathToFileURL(file).href]: [edit(5, 0, 5, 1, "x")] } },
        readFrom({ [file]: "one\n" }),
      ),
    ).rejects.toThrow(/out of range/);
  });

  it("列号越界报错", async () => {
    const file = "/proj/short.ts";
    await expect(
      expandWorkspaceEdit(
        { changes: { [pathToFileURL(file).href]: [edit(0, 20, 0, 21, "x")] } },
        readFrom({ [file]: "one\n" }),
      ),
    ).rejects.toThrow(/out of range/);
  });

  it("文件级 document change（create/rename/delete）报不支持", async () => {
    await expect(
      expandWorkspaceEdit(
        {
          documentChanges: [{ kind: "create" as const, uri: "file:///proj/new.ts" }],
        },
        readFrom({}),
      ),
    ).rejects.toThrow(/not supported/);
  });

  it("readText 失败时整体失败", async () => {
    await expect(
      expandWorkspaceEdit(
        { changes: { [pathToFileURL("/proj/gone.ts").href]: [edit(0, 0, 0, 1, "x")] } },
        readFrom({}),
      ),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("canonicalizeEdit", () => {
  it("URI 写法不同（大小写盘符等经 file: 解析）指向同一文件时归一", () => {
    const file = "/proj/a.ts";
    const first = canonicalizeEdit({
      changes: { [pathToFileURL(file).href]: [edit(0, 0, 0, 1, "x")] },
    });
    const second = canonicalizeEdit({
      changes: { [pathToFileURL(join("/proj", "a.ts")).href]: [edit(0, 0, 0, 1, "x")] },
    });
    expect(first).toBe(second);
  });

  it("不同的编辑集合归一结果不同", () => {
    const file = "/proj/a.ts";
    const first = canonicalizeEdit({
      changes: { [pathToFileURL(file).href]: [edit(0, 0, 0, 1, "x")] },
    });
    const second = canonicalizeEdit({
      changes: { [pathToFileURL(file).href]: [edit(0, 0, 0, 1, "y")] },
    });
    expect(first).not.toBe(second);
  });
});

describe("symbolCandidates", () => {
  const text = "const getValue = () => getValue();\nconst other = 1;\n";

  it("枚举行内与 symbol 相同的词出现位置", () => {
    expect(symbolCandidates(text, 0, "getValue")).toEqual([
      { line: 0, character: 6 },
      { line: 0, character: 23 },
    ]);
  });

  it("character 指定时返回该词的起始位置", () => {
    expect(symbolCandidates(text, 0, "getValue", 25)).toEqual([{ line: 0, character: 23 }]);
  });

  it("character 指向其他词时报错", () => {
    expect(() => symbolCandidates(text, 0, "getValue", 0)).toThrow(
      /does not point at symbol 'getValue' \(points at 'const'\)/,
    );
  });

  it("character 指向行外或词间空白时报错", () => {
    expect(() => symbolCandidates(text, 0, "getValue", 5)).toThrow(/does not point at/);
    expect(() => symbolCandidates(text, 0, "getValue", 99)).toThrow(/does not point at/);
  });

  it("该行没有目标符号时返回空数组", () => {
    expect(symbolCandidates(text, 1, "getValue")).toEqual([]);
    expect(symbolCandidates(text, 99, "getValue")).toEqual([]);
  });

  it("识别 $ 与下划线", () => {
    const source = "let $a_1 = 0;\nlet b = $a_1;\n";
    expect(symbolCandidates(source, 0, "$a_1")).toEqual([{ line: 0, character: 4 }]);
    expect(symbolCandidates(source, 1, "b")).toEqual([{ line: 1, character: 4 }]);
  });

  it(String.raw`CRLF 行的列号不含 \r`, () => {
    expect(symbolCandidates("const a = 1;\r\n", 0, "a")).toEqual([{ line: 0, character: 6 }]);
  });
});
