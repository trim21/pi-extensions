import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { AftProjectTransport } from "@cortexkit/aft-bridge";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callAftTool } from "../src/aft/bridge.js";
import {
  buildOutlineSubtitle,
  buildZoomSubtitle,
  callCallgraphWithBuildRetry,
  compactArgs,
  formatSemanticIndexProgress,
} from "../src/aft/tools.js";
import { resolvePathArg } from "../src/lib/path.js";

vi.mock("../src/aft/bridge.js", () => ({
  callAftTool: vi.fn(),
  SEMANTIC_INDEX_WAIT_TIMEOUT_MS: 600_000,
}));

describe("compactArgs", () => {
  it("drops undefined and blank strings but keeps false and empty arrays", () => {
    expect(
      compactArgs({
        a: undefined,
        b: "",
        c: " ".repeat(3),
        d: false,
        e: [],
        f: 0,
        g: "x",
      }),
    ).toEqual({ d: false, e: [], f: 0, g: "x" });
  });

  it("keeps strings with non-whitespace content intact", () => {
    expect(compactArgs({ s: " spaced " })).toEqual({ s: " spaced " });
  });
});

describe("resolvePathArg", () => {
  const cwd = resolve("/work", "project");

  it("resolves relative paths against cwd", () => {
    expect(resolvePathArg(cwd, "src/app.ts")).toBe(resolve(cwd, "src/app.ts"));
    expect(resolvePathArg(cwd, "./src/app.ts")).toBe(resolve(cwd, "./src/app.ts"));
    expect(resolvePathArg(cwd, "../other/a.ts")).toBe(resolve(cwd, "../other/a.ts"));
  });

  it("keeps absolute paths unchanged", () => {
    expect(resolvePathArg(cwd, "/abs/path.ts")).toBe("/abs/path.ts");
  });

  it("expands ~ and ~/ prefixes to home", () => {
    expect(resolvePathArg(cwd, "~/config.json")).toBe(join(homedir(), "config.json"));
    expect(resolvePathArg(cwd, "~")).toBe(homedir());
  });

  it("resolves URLs as relative paths（URL 不再透传，文件工具只接受路径）", () => {
    expect(resolvePathArg(cwd, "https://example.com/a.md")).toBe(
      resolve(cwd, "https://example.com/a.md"),
    );
  });
});

describe("buildZoomSubtitle", () => {
  const cwd = resolve("/work", "project");

  it.skipIf(process.platform === "win32")("formats path + single symbol", () => {
    expect(buildZoomSubtitle(cwd, { path: "./src/app.ts", symbols: "main" })).toBe(
      'path="./src/app.ts" symbol="main"',
    );
  });

  it.skipIf(process.platform === "win32")("joins multiple symbols with comma", () => {
    expect(buildZoomSubtitle(cwd, { path: "src/app.ts", symbols: ["a", "b"] })).toBe(
      'path="./src/app.ts" symbol="a, b"',
    );
  });

  it("formats home paths as ~/…", () => {
    expect(buildZoomSubtitle(cwd, { path: "~/config.ts", symbols: "cfg" })).toBe(
      'path="~/config.ts" symbol="cfg"',
    );
  });

  it("keeps absolute paths outside cwd and home", () => {
    expect(buildZoomSubtitle(cwd, { path: "/etc/x.ts", symbols: "s" })).toBe(
      'path="/etc/x.ts" symbol="s"',
    );
  });

  it.skipIf(process.platform === "win32")("omits symbol when absent", () => {
    expect(buildZoomSubtitle(cwd, { path: "./src/app.ts" })).toBe('path="./src/app.ts"');
  });
});

describe("buildOutlineSubtitle", () => {
  const cwd = resolve("/work", "project");

  it.skipIf(process.platform === "win32")("formats target path", () => {
    expect(buildOutlineSubtitle(cwd, "./src/app.ts")).toBe('target="./src/app.ts"');
  });

  it.skipIf(process.platform === "win32")("falls back to parent/basename for long targets", () => {
    const longPath = resolve(
      cwd,
      "src/components/very-long-directory-name-here/deeper/another-long-name/App.module.spec.test.ts",
    );
    expect(buildOutlineSubtitle(cwd, longPath)).toBe(
      'target="another-long-name/App.module.spec.test.ts"',
    );
  });
});

const building = (semantic: Record<string, unknown>): Record<string, unknown> => ({
  semantic_index: { status: "building", ...semantic },
});

describe("formatSemanticIndexProgress", () => {
  it("formats stage, chunk percent and batch", () => {
    expect(
      formatSemanticIndexProgress(
        building({
          stage: "embedding_symbols",
          embedded_chunks: 6,
          total_chunks: 12,
          current_batch: 2,
          total_batches: 4,
        }),
      ),
    ).toBe("语义索引构建中 (embedding_symbols) · 6/12 chunks (50%) · batch 2/4");
  });

  it("caps percent at 100 for reporting overflow", () => {
    expect(
      formatSemanticIndexProgress(
        building({ stage: "embedding_symbols", embedded_chunks: 15, total_chunks: 12 }),
      ),
    ).toBe("语义索引构建中 (embedding_symbols) · 15/12 chunks (100%)");
  });

  it("omits numbers that are absent", () => {
    expect(formatSemanticIndexProgress(building({ stage: "refreshing_corpus" }))).toBe(
      "语义索引构建中 (refreshing_corpus)",
    );
  });

  it("ignores zero totals", () => {
    expect(
      formatSemanticIndexProgress(
        building({
          stage: "embedding_symbols",
          embedded_chunks: 3,
          total_chunks: 0,
          current_batch: 1,
          total_batches: 0,
        }),
      ),
    ).toBe("语义索引构建中 (embedding_symbols)");
  });

  it("returns undefined for non-building semantic status", () => {
    expect(formatSemanticIndexProgress({ semantic_index: { status: "ready" } })).toBeUndefined();
    expect(formatSemanticIndexProgress({ semantic_index: { status: "disabled" } })).toBeUndefined();
    expect(formatSemanticIndexProgress({})).toBeUndefined();
  });

  it("returns undefined when the snapshot shape mismatches", () => {
    expect(
      formatSemanticIndexProgress(
        building({ stage: "embedding_symbols", embedded_chunks: "6", total_chunks: 12 }),
      ),
    ).toBeUndefined();
  });
});

describe("callCallgraphWithBuildRetry", () => {
  const bridge = {} as AftProjectTransport;
  const extCtx = {} as ExtensionContext;
  const mockCallAftTool = vi.mocked(callAftTool);

  beforeEach(() => {
    mockCallAftTool.mockReset();
  });

  it("retries callgraph_building until a ready response arrives", async () => {
    mockCallAftTool
      .mockResolvedValueOnce({
        text: "callgraph_building — callgraph store is building in the background",
        response: { code: "callgraph_building" },
      })
      .mockResolvedValueOnce({ text: "3 callers", response: {} });

    const { text } = await callCallgraphWithBuildRetry(bridge, { op: "callers" }, extCtx, {
      budgetMs: 5_000,
      intervalMs: 1,
    });

    expect(text).toBe("3 callers");
    expect(mockCallAftTool).toHaveBeenCalledTimes(2);
    expect(mockCallAftTool.mock.calls[0]?.[1]).toBe("callgraph");
  });

  it("returns the building response once the budget is exhausted", async () => {
    mockCallAftTool.mockResolvedValue({
      text: "callgraph_building — callgraph store is building in the background",
      response: { code: "callgraph_building" },
    });

    const { response } = await callCallgraphWithBuildRetry(bridge, { op: "callers" }, extCtx, {
      budgetMs: 30,
      intervalMs: 5,
    });

    expect(response.code).toBe("callgraph_building");
    expect(mockCallAftTool.mock.calls.length).toBeGreaterThan(1);
  });

  it("returns symbol_not_found immediately without retrying", async () => {
    mockCallAftTool.mockResolvedValue({
      text: "symbol_not_found — no such symbol",
      response: { code: "symbol_not_found" },
    });

    const { text } = await callCallgraphWithBuildRetry(bridge, { op: "callers" }, extCtx, {
      budgetMs: 5_000,
      intervalMs: 1,
    });

    expect(text).toBe("symbol_not_found — no such symbol");
    expect(mockCallAftTool).toHaveBeenCalledTimes(1);
  });
});
