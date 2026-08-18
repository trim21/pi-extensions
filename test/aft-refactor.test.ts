import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AftTransportPool } from "@cortexkit/aft-bridge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/aft/bridge.js", () => ({
  callAftTool: vi.fn(),
}));

import { callAftTool } from "../src/aft/bridge.js";
import { registerRefactorTool } from "../src/aft/refactor.js";
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
  registerRefactorTool(mockPi, ctx);
  if (!captured) throw new Error("tool not registered");
  return captured;
}

describe("aft_refactor", () => {
  const dir = mkdtempSync(join(tmpdir(), "aft-refactor-test-"));
  const pool = { getBridge: () => ({}) } as unknown as AftTransportPool;

  beforeEach(() => {
    mockCallAftTool.mockReset();
  });

  it("maps move args to wire format and resolves relative paths", async () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "export function foo() {}\n");
    mockCallAftTool.mockResolvedValue({
      text: "moved foo → b.ts",
      response: {
        success: true,
        files_modified: 2,
        consumers_updated: 1,
        results: [{ file: join(dir, "b.ts") }],
      },
    });

    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    const result = await tool.execute(
      "id",
      {
        op: "move",
        path: "a.ts",
        symbol: "foo",
        destination: "b.ts",
      },
      undefined,
      undefined,
      { cwd: dir, hasUI: false },
    );

    expect(mockCallAftTool).toHaveBeenCalledTimes(1);
    expect(mockCallAftTool).toHaveBeenCalledWith(
      pool.getBridge(dir),
      "refactor",
      { op: "move", path: file, symbol: "foo", destination: join(dir, "b.ts") },
      expect.anything(),
    );
    expect((result as { content: { text: string }[] }).content[0].text).toBe("moved foo → b.ts");
    expect((result as { details: { files: string[] } }).details.files).toEqual([
      file,
      join(dir, "b.ts"),
    ]);
  });

  it("requires symbol and destination for move", async () => {
    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    await expect(
      tool.execute("id", { op: "move", path: "a.ts" }, undefined, undefined, {
        cwd: dir,
        hasUI: false,
      }),
    ).rejects.toThrow("'symbol' is required for 'move' op");
  });

  it("coerces string line numbers for extract", async () => {
    mockCallAftTool.mockResolvedValue({
      text: "extracted helper",
      response: { success: true, name: "helper", file: join(dir, "a.ts") },
    });
    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    await tool.execute(
      "id",
      { op: "extract", path: "a.ts", name: "helper", start_line: "3", end_line: "5" },
      undefined,
      undefined,
      { cwd: dir, hasUI: false },
    );
    expect(mockCallAftTool).toHaveBeenCalledWith(
      pool.getBridge(dir),
      "refactor",
      { op: "extract", path: join(dir, "a.ts"), name: "helper", startLine: 3, endLine: 5 },
      expect.anything(),
    );
  });

  it("requires start_line and end_line for extract", async () => {
    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    await expect(
      tool.execute("id", { op: "extract", path: "a.ts", name: "helper" }, undefined, undefined, {
        cwd: dir,
        hasUI: false,
      }),
    ).rejects.toThrow("'start_line' is required for 'extract' op");
  });

  it("passes call_site_line for inline", async () => {
    mockCallAftTool.mockResolvedValue({
      text: "inlined foo",
      response: { success: true, symbol: "foo", file: join(dir, "a.ts") },
    });
    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    await tool.execute(
      "id",
      { op: "inline", path: "a.ts", symbol: "foo", call_site_line: 10 },
      undefined,
      undefined,
      { cwd: dir, hasUI: false },
    );
    expect(mockCallAftTool).toHaveBeenCalledWith(
      pool.getBridge(dir),
      "refactor",
      { op: "inline", path: join(dir, "a.ts"), symbol: "foo", callSiteLine: 10 },
      expect.anything(),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
