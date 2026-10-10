/**
 * 三个 LSP 查询工具的结构化结果（src/lib/lsp/inspect-tool.ts）：fake LspService 返回原始
 * 位置 / hover，工具把它们归一化成 1-based 位置载荷。走真实 ToolBus（`executeTool`）跑，
 * 因此载荷也会过一遍总线的 schema 复核。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodemodeTools } from "../src/codemode/tool.js";
import { createReadsState } from "../src/lib/file-reads.js";
import { registerLspInspectTools } from "../src/lib/lsp/inspect-tool.js";
import type { LspService } from "../src/lib/lsp/lsp.js";
import { createRequestPolicy } from "../src/lib/request-policy.js";
import { createToolBus, type ToolBus } from "../src/lib/tool-bus.js";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface StructuredExecuteResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredResult?: { ok: boolean; value?: unknown; error?: string };
}

/** 工具输出文本（工具结果的 content 部分）。 */
function textOf(result: StructuredExecuteResult): string {
  return (result.content ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lsp-inspect-"));
  dirs.push(dir);
  // 符号在第 2 行，工具按行找候选
  await writeFile(
    join(dir, "a.ts"),
    "const other = 1;\nexport function greet(name: string) {}\n",
    "utf8",
  );
  return dir;
}

function context(cwd: string): ExtensionToolContext {
  return { cwd } as unknown as ExtensionToolContext;
}

/** 注册三个查询工具并返回总线（service 是双桩，不需要真实语言服务器）。 */
function setup(service: LspService): ToolBus {
  const pi = { registerTool: () => {} } as never;
  const bus = createToolBus(pi);
  registerLspInspectTools(bus, service);
  return bus;
}

function serviceReturning(inspect: (query: string) => unknown): LspService {
  return {
    inspect: vi.fn(async (request: { query: string }) => inspect(request.query)),
  } as unknown as LspService;
}

function payloadOf(result: StructuredExecuteResult): Record<string, unknown> {
  if (result.structuredResult?.ok !== true) {
    throw new Error(`expected a successful structured result, got: ${JSON.stringify(result)}`);
  }
  return result.structuredResult.value as Record<string, unknown>;
}

async function execute(bus: ToolBus, name: string, cwd: string): Promise<StructuredExecuteResult> {
  const result = await bus.executeTool(
    name,
    { file_path: join(cwd, "a.ts"), line: 2, symbol: "greet" },
    { ctx: context(cwd) },
  );
  return result;
}

describe("LSP 查询工具的结构化结果", () => {
  it("definition 载荷给出 1-based 位置，顺序与文本一致", async () => {
    const cwd = await workspace();
    const bus = setup(
      serviceReturning(() => ({
        serverID: "tsserver",
        query: "definition",
        locations: [
          { path: join(cwd, "a.ts"), line: 1, character: 18 },
          { path: join(cwd, "b.ts"), line: 4, character: 0 },
        ],
      })),
    );

    const result = await execute(bus, "lsp-find-definition", cwd);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Found 2 definition(s):");
    expect(payloadOf(result)).toEqual({
      text: textOf(result),
      serverID: "tsserver",
      locations: [
        { path: join(cwd, "a.ts"), line: 2, character: 19 },
        { path: join(cwd, "b.ts"), line: 5, character: 1 },
      ],
    });
  });

  it("references 载荷给全部位置，即使文本按上限截断", async () => {
    const cwd = await workspace();
    // 同一文件里 12 条引用：文本每文件只列 10 条，载荷给全部 12 条
    const locations = Array.from({ length: 12 }, (_unused, index) => ({
      path: join(cwd, "a.ts"),
      line: index,
      character: 0,
    }));
    const bus = setup(
      serviceReturning(() => ({ serverID: "tsserver", query: "references", locations })),
    );

    const result = await execute(bus, "lsp-find-reference", cwd);

    expect(textOf(result)).toContain("(+2 more in this file)");
    const payload = payloadOf(result);
    expect(payload.serverID).toBe("tsserver");
    expect(payload.locations).toHaveLength(12);
    expect((payload.locations as { line: number }[])[11]?.line).toBe(12);
  });

  it("hover 载荷带回答的服务器 id，内容仍在 text 里", async () => {
    const cwd = await workspace();
    const bus = setup(
      serviceReturning(() => ({
        serverID: "tsserver",
        query: "hover",
        hover: {
          contents: { kind: "markdown", value: "```ts\nfunction greet(name: string): void\n```" },
        },
      })),
    );

    const result = await execute(bus, "lsp-inspect", cwd);

    expect(payloadOf(result)).toEqual({
      text: "```ts\nfunction greet(name: string): void\n```",
      serverID: "tsserver",
    });
  });

  it("没有 hover 信息也是成功结果", async () => {
    const cwd = await workspace();
    const bus = setup(
      serviceReturning(() => ({ serverID: "tsserver", query: "hover", hover: null })),
    );

    const result = await execute(bus, "lsp-inspect", cwd);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No hover information");
    expect(payloadOf(result)).toEqual({ text: textOf(result), serverID: "tsserver" });
  });

  it("三个查询工具因声明了结构化输出而进入 codemode 的可调用集合", async () => {
    const registered = new Map<string, { description: string }>();
    const pi = {
      registerTool: (tool: { name: string; description: string }) =>
        registered.set(tool.name, tool),
      getActiveTools: () => ["lsp-find-definition", "lsp-find-reference", "lsp-inspect"],
    } as never;
    const bus = createToolBus(pi);
    registerLspInspectTools(
      bus,
      serviceReturning(() => ({ serverID: "ts", locations: [] })),
    );
    await createCodemodeTools(pi).register(bus, {
      policy: createRequestPolicy(),
      reads: createReadsState(),
    });

    const description = registered.get("codemode")?.description ?? "";
    for (const name of ["lsp-find-definition", "lsp-find-reference", "lsp-inspect"]) {
      expect(description).toContain(`declare function call(name: "${name}"`);
    }
    // lsp-rename 是写工具、没有结构化输出，因此不在集合里
    expect(description).not.toContain('declare function call(name: "lsp-rename"');
  });
});
