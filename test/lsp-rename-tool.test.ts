/**
 * lsp-rename 工具壳的编排测试（src/lib/lsp/rename-tool.ts）：用 fake LspService
 * 驱动行内同名符号的逐个探测，验证消歧分组只列出真正探测成功的候选。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEdit } from "vscode-languageserver-types";

import { RenameNotPossibleError } from "../src/lib/lsp/client.js";
import { EMPTY_DIAGNOSTIC_REPORT } from "../src/lib/lsp/diagnostic.js";
import type { LspService } from "../src/lib/lsp/lsp.js";
import { registerLspRenameTool } from "../src/lib/lsp/rename-tool.js";
import { createRequestPolicy } from "../src/lib/request-policy.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

/** 注册 lsp-rename 并取回工具对象；service 是双桩，不需要真实语言服务器。 */
function loadRenameTool(service: LspService): RegisteredTool {
  const tools = new Map<string, RegisteredTool>();
  registerLspRenameTool(
    {
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never,
    service,
    { policy: createRequestPolicy() },
  );
  const tool = tools.get("lsp-rename");
  if (!tool) throw new Error("lsp-rename was not registered");
  return tool;
}

interface RenameProbe {
  character: number;
}

/** service 双桩：rename 按候选列决定成败，其余能力本用例用不到。 */
function fakeService(
  rename: (request: RenameProbe) => Promise<{ edit: WorkspaceEdit; placeholder?: string }>,
): LspService {
  return {
    rename: vi.fn(rename),
    lspDiagnosticsForFile: vi.fn(() => Promise.resolve(EMPTY_DIAGNOSTIC_REPORT)),
  } as unknown as LspService;
}

function singleEdit(uri: string, character: number, newText: string): WorkspaceEdit {
  return {
    changes: {
      [uri]: [
        {
          range: { start: { line: 0, character }, end: { line: 0, character: character + 1 } },
          newText,
        },
      ],
    },
  };
}

describe("lsp-rename 工具壳", () => {
  it("消歧提示只列出探测成功的候选，不因前置候选失败而错位", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-rename-tool-"));
    dirs.push(dir);
    const file = join(dir, "a.ts");
    // 行内三处同名符号：第 1 处不是可重命名的符号（如注释/字符串里的名字），
    // 第 2、3 处是两个不同的符号 → 1-based 列 4 / 6 / 8
    await writeFile(file, "// s s s\n", "utf8");

    const uri = pathToFileURL(file).href;
    const service = fakeService((request) => {
      if (request.character === 3) {
        throw new RenameNotPossibleError("cannot rename this position");
      }
      if (request.character === 5) {
        return Promise.resolve({ edit: singleEdit(uri, 5, "x"), placeholder: "X" });
      }
      return Promise.resolve({ edit: singleEdit(uri, 7, "y"), placeholder: "Y" });
    });
    const tool = loadRenameTool(service);
    const ctx = { cwd: dir, hasUI: false, ui: { notify: vi.fn() } };

    const failure: Error = await tool
      .execute(
        "call-1",
        { file_path: file, line: 1, symbol: "s", new_name: "renamed" },
        undefined,
        undefined,
        ctx,
      )
      .catch((error: unknown) => error as Error);

    // 列 4 的探测失败，不该出现在候选列表里（旧实现按 successes 下标配对，
    // 会把它和列 6 的成功结果配成一组，提示因此指向错误的列）
    expect(failure.message).toContain("- line 1, column 6 (rename target: X)");
    expect(failure.message).toContain("- line 1, column 8 (rename target: Y)");
    expect(failure.message).not.toContain("column 4");
  });
});
