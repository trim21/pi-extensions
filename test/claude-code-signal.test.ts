/**
 * 文件工具的取消信号：Read / Edit / Write 都要把 signal 交给 LSP 诊断等待
 * （lspDiagnosticsForFile 的 document 模式最长等 5s），否则一次被取消的
 * 读/写会白等满窗口才返回。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { registerFileTools } from "../src/claude-code/files.js";
import { createReadsState } from "../src/lib/file-reads.js";
import { EMPTY_DIAGNOSTIC_REPORT } from "../src/lib/lsp/diagnostic.js";
import type { LspService } from "../src/lib/lsp/lsp.js";
import { createRequestPolicy } from "../src/lib/request-policy.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

/** 注册文件工具（共享一份 reads state），service 是只记录诊断调用的双桩。 */
function loadFileTools(service: LspService): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  registerFileTools(
    {
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never,
    createReadsState(),
    () => service,
    createRequestPolicy(),
  );
  return tools;
}

describe("文件工具的取消信号", () => {
  it("Read / Edit / Write 都把 signal 传给 LSP 诊断等待", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-signal-"));
    dirs.push(dir);
    const file = join(dir, "note.txt");
    await writeFile(file, "hello\n", "utf8");

    const diagnostics = vi.fn(() => Promise.resolve(EMPTY_DIAGNOSTIC_REPORT));
    const tools = loadFileTools({ lspDiagnosticsForFile: diagnostics } as unknown as LspService);
    const controller = new AbortController();
    const ctx = { cwd: dir, hasUI: false, ui: { notify: vi.fn() } };
    const run = (name: string, params: Record<string, unknown>) =>
      tools.get(name)!.execute("call-1", params, controller.signal, undefined, ctx);

    // Read 先写 reads state，后续 Edit/Write 才有 read-before-write 快照
    await run("Read", { file_path: file });
    await run("Edit", { file_path: file, old_string: "hello", new_string: "hi" });
    await run("Write", { file_path: file, content: "bye\n" });

    type DiagnosticsCall = [string, string, { signal?: AbortSignal }?];
    const calls = diagnostics.mock.calls as unknown as DiagnosticsCall[];
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call[2]).toMatchObject({ signal: controller.signal });
    }
  });
});
