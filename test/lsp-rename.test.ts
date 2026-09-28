/**
 * WorkspaceEdit 应用与 rename 定位辅助测试（src/lib/lsp/rename.ts）：
 * - expandWorkspaceEdit：changes / documentChanges / 多文件 / 乱序 edit /
 *   CRLF / 位置越界报错 / 文件级 document change 报不支持 / readText 失败
 * - canonicalizeEdit：URI 归一化后比较两次 rename 结果
 * - symbolCandidates：符号名 + 可选 character 的候选定位
 * - trackStability / stabilityAcceptable：references 稳定窗口（防残缺答案假稳定）
 * - verifyRenameCoverage：注入收敛序列 / 预算 / 就绪状态后的判定与归宿
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canonicalizeEdit,
  DEFAULT_RENAME_VERIFICATION_TIMING,
  expandWorkspaceEdit,
  RenameIncompleteError,
  type RenameVerificationTiming,
  stabilityAcceptable,
  symbolCandidates,
  trackStability,
  verifyRenameCoverage,
} from "../src/lib/lsp/rename.js";

const readFrom = (texts: Record<string, string>) => (path: string) => {
  const text = texts[path];
  if (text === undefined) {
    return Promise.reject(new Error(`ENOENT: ${path}`));
  }
  return Promise.resolve(text);
};

function pathSet(...paths: string[]): ReadonlySet<string> {
  return new Set(paths);
}

describe("trackStability / stabilityAcceptable", () => {
  it("连续一致累加样本且窗口起点不变，集合变化即重启窗口", () => {
    let run = trackStability({ previous: undefined, paths: pathSet("a"), now: 100 });
    expect(run).toMatchObject({ since: 100, samples: 1 });
    run = trackStability({ previous: run, paths: pathSet("a"), now: 200 });
    expect(run).toMatchObject({ since: 100, samples: 2 });
    run = trackStability({ previous: run, paths: pathSet("a", "b"), now: 300 });
    expect(run).toMatchObject({ since: 300, samples: 1 });
    // 集合内容一致即可，与插入顺序无关
    run = trackStability({ previous: run, paths: pathSet("b", "a"), now: 400 });
    expect(run).toMatchObject({ since: 300, samples: 2 });
  });

  it("样本数与持续时长都达标才可接受", () => {
    const first = trackStability({ previous: undefined, paths: pathSet("a"), now: 100 });
    // 样本数不足：哪怕时长再长也不放行（残缺答案的假稳定）
    expect(stabilityAcceptable(first, { now: 5_000, minSamples: 3, minStableMs: 0 })).toBe(false);
    const second = trackStability({ previous: first, paths: pathSet("a"), now: 200 });
    const third = trackStability({ previous: second, paths: pathSet("a"), now: 300 });
    // 样本数达标但持续时长不足
    expect(stabilityAcceptable(third, { now: 350, minSamples: 3, minStableMs: 400 })).toBe(false);
    // 两者都达标
    expect(stabilityAcceptable(third, { now: 500, minSamples: 3, minStableMs: 400 })).toBe(true);
  });
});

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

/** 只带 changes 的最小 WorkspaceEdit：每个路径一个 edit。 */
function editCovering(...paths: string[]) {
  return {
    changes: Object.fromEntries(
      paths.map((path) => [pathToFileURL(path).href, [edit(0, 0, 0, 1, "y")]]),
    ),
  };
}

/** 覆盖默认节奏；用例只声明自己关心的字段。 */
function timing(overrides: Partial<RenameVerificationTiming>): RenameVerificationTiming {
  return { ...DEFAULT_RENAME_VERIFICATION_TIMING, ...overrides };
}

/** 假时间轴：now 从 0 开始，sleep 直接推进时钟（不真的等待）。 */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

describe("verifyRenameCoverage", () => {
  it("references 收敛且 rename 覆盖一致：返回 edit", async () => {
    const clock = fakeClock();
    const refetchedAt: number[] = [];
    let renames = 0;
    const expected = editCovering("/proj/a.ts");
    const result = await verifyRenameCoverage({
      indexReady: true,
      timing: timing({ settleSamples: 2, pollMs: 10, budgetMs: 1_000, stableFloorReadyMs: 0 }),
      initialPaths: pathSet("/proj/a.ts"),
      refetchPaths: async () => {
        refetchedAt.push(clock.now());
        return pathSet("/proj/a.ts");
      },
      sendRename: async () => {
        renames += 1;
        return expected;
      },
      sleep: clock.sleep,
      now: clock.now,
      notRenameable: () => new Error("not renameable"),
    });
    expect(result).toEqual(expected);
    // 首次采样由调用方完成：这里只多采一次，就在第二次采样后收敛
    expect(refetchedAt).toEqual([10]);
    expect(renames).toBe(1);
  });

  it("只有 extra 时继续轮询，references 追上后成功", async () => {
    const clock = fakeClock();
    // rename 一次触及 a + b，而 references 起初只报 a（extra 分支）：恢复到
    // 一致需要 references 也采样到 a + b（集合变化重启稳定窗口）。
    const refetchedAt: number[] = [];
    let renames = 0;
    const expected = editCovering("/proj/a.ts", "/proj/b.ts");
    const result = await verifyRenameCoverage({
      indexReady: true,
      timing: timing({ settleSamples: 2, pollMs: 10, budgetMs: 1_000, stableFloorReadyMs: 0 }),
      initialPaths: pathSet("/proj/a.ts"),
      refetchPaths: async () => {
        refetchedAt.push(clock.now());
        return refetchedAt.length >= 2
          ? pathSet("/proj/a.ts", "/proj/b.ts")
          : pathSet("/proj/a.ts");
      },
      sendRename: async () => {
        renames += 1;
        return expected;
      },
      sleep: clock.sleep,
      now: clock.now,
      notRenameable: () => new Error("not renameable"),
    });
    expect(result).toEqual(expected);
    expect(refetchedAt).toEqual([10, 20, 30]);
    // 第一次 rename 只有 extra（继续轮询），第二次复检才一致
    expect(renames).toBe(2);
  });

  it("预算耗尽且 rename 漏文件：抛 RenameIncompleteError(missing, extra)", async () => {
    const clock = fakeClock();
    // 稳定窗口下限大于预算：永远走不到"稳定"，只能靠预算耗尽触发校验
    const error = await verifyRenameCoverage({
      indexReady: true,
      timing: timing({ settleSamples: 5, pollMs: 10, budgetMs: 15, stableFloorReadyMs: 1_000 }),
      initialPaths: pathSet("/proj/a.ts", "/proj/b.ts"),
      refetchPaths: async () => pathSet("/proj/a.ts", "/proj/b.ts"),
      sendRename: async () => editCovering("/proj/a.ts", "/proj/c.ts"),
      sleep: clock.sleep,
      now: clock.now,
      notRenameable: () => new Error("not renameable"),
    }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(RenameIncompleteError);
    expect((error as RenameIncompleteError).missing).toEqual(["/proj/b.ts"]);
    expect((error as RenameIncompleteError).extra).toEqual(["/proj/c.ts"]);
    expect((error as RenameIncompleteError).message).toContain("/proj/b.ts");
    expect((error as RenameIncompleteError).message).toContain("/proj/c.ts");
  });

  it("双向一致但未达稳定窗口：抛 RenameIncompleteError([], [])", async () => {
    const clock = fakeClock();
    // 就绪未证实 + 稳定窗口下限大于预算：rename 与 references 双向一致，但这份
    // 一致性从未被稳定窗口证明（残缺答案假稳定），归宿是空 missing / extra 的不完整错误。
    const error = await verifyRenameCoverage({
      indexReady: false,
      timing: timing({ pollMs: 10, budgetMs: 15, stableFloorUnreadyMs: 1_000 }),
      initialPaths: pathSet("/proj/a.ts"),
      refetchPaths: async () => pathSet("/proj/a.ts"),
      sendRename: async () => editCovering("/proj/a.ts"),
      sleep: clock.sleep,
      now: clock.now,
      notRenameable: () => new Error("not renameable"),
    }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(RenameIncompleteError);
    expect((error as RenameIncompleteError).missing).toEqual([]);
    expect((error as RenameIncompleteError).extra).toEqual([]);
    expect((error as RenameIncompleteError).message).toContain("not been stable long enough");
  });

  it("sendRename 返回 null：抛 notRenameable() 的错误", async () => {
    const clock = fakeClock();
    const refusal = new Error('LSP server "mock" cannot rename at /proj/a.ts:1:1');
    let refetches = 0;
    const error = await verifyRenameCoverage({
      indexReady: true,
      timing: timing({ settleSamples: 1, stableFloorReadyMs: 0 }),
      initialPaths: pathSet("/proj/a.ts"),
      refetchPaths: async () => {
        refetches += 1;
        return pathSet("/proj/a.ts");
      },
      sendRename: async () => null,
      sleep: clock.sleep,
      now: clock.now,
      notRenameable: () => refusal,
    }).catch((error_: unknown) => error_);
    expect(error).toBe(refusal);
    expect(refetches).toBe(0);
  });
});
