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
import { registerImportTool } from "../src/aft/imports.js";
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
  registerImportTool(mockPi, ctx);
  if (!captured) throw new Error("tool not registered");
  return captured;
}

describe("aft_import", () => {
  const dir = mkdtempSync(join(tmpdir(), "aft-import-test-"));
  const pool = { getBridge: () => ({}) } as unknown as AftTransportPool;

  beforeEach(() => {
    mockCallAftTool.mockReset();
  });

  it("maps add args to wire format with camelCase keys", async () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "export const x = 1;\n");
    mockCallAftTool.mockResolvedValue({
      text: "added import react",
      response: { success: true, file, module: "react", group: "external" },
    });

    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    const result = await tool.execute(
      "id",
      {
        op: "add",
        path: "a.ts",
        module: "react",
        names: ["useState"],
        default_import: "React",
        type_only: true,
      },
      undefined,
      undefined,
      { cwd: dir, hasUI: false },
    );

    expect(mockCallAftTool).toHaveBeenCalledTimes(1);
    expect(mockCallAftTool).toHaveBeenCalledWith(
      pool.getBridge(dir),
      "import",
      {
        op: "add",
        path: file,
        module: "react",
        names: ["useState"],
        defaultImport: "React",
        typeOnly: true,
      },
      expect.anything(),
    );
    expect((result as { content: { text: string }[] }).content[0].text).toBe("added import react");
  });

  it("requires module for add", async () => {
    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    await expect(
      tool.execute("id", { op: "add", path: "a.ts" }, undefined, undefined, {
        cwd: dir,
        hasUI: false,
      }),
    ).rejects.toThrow("'module' is required for 'add' op");
  });

  it("maps remove args without module-required behavior", async () => {
    mockCallAftTool.mockResolvedValue({
      text: "removed import ./utils",
      response: { success: true, file: join(dir, "a.ts"), module: "./utils" },
    });
    const tool = captureTool({} as ExtensionAPI, { cwd: dir, pool });
    await tool.execute(
      "id",
      { op: "remove", path: "a.ts", module: "./utils", remove_name: "helper" },
      undefined,
      undefined,
      { cwd: dir, hasUI: false },
    );
    expect(mockCallAftTool).toHaveBeenCalledWith(
      pool.getBridge(dir),
      "import",
      { op: "remove", path: join(dir, "a.ts"), module: "./utils", removeName: "helper" },
      expect.anything(),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
