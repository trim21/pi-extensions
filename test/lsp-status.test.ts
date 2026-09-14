import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { LspServerAdapter } from "../src/lib/lsp/adapter.js";
import { spawnProcess } from "../src/lib/lsp/launch.js";
import { createLspService } from "../src/lib/lsp/lsp.js";

const fixture = fileURLToPath(new URL("fixtures/mock-lsp-server.mjs", import.meta.url));

/** spawn 真实 mock stdio LSP server（initialize 握手后 didOpen 会 push 诊断）。 */
function runningAdapter(id: string): LspServerAdapter {
  return {
    id,
    extensions: [".py"],
    spawn: async () => ({ process: spawnProcess(process.execPath, [fixture]) }),
  };
}

function unavailableAdapter(id: string): LspServerAdapter {
  return {
    id,
    extensions: [".py"],
    spawn: () => Promise.resolve(undefined),
  };
}

describe("LSP status", () => {
  it("shows running servers and clears on shutdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-status-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    const service = createLspService([runningAdapter("pyright")], join(dir, "no-global.json"));
    const statuses: (string | undefined)[] = [];
    service.attachStatus((text) => {
      statuses.push(text);
    });

    await service.touchFile(join(dir, "a.py"), dir);
    expect(statuses.at(-1)).toContain("pyright");
    expect(statuses.at(-1)).not.toContain("unavailable");

    await service.shutdownAll();
    expect(statuses.at(-1)).toBeUndefined();
  });

  it("marks servers that failed to spawn as unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-status-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    const service = createLspService([unavailableAdapter("ruff")], join(dir, "no-global.json"));
    const statuses: (string | undefined)[] = [];
    service.attachStatus((text) => {
      statuses.push(text);
    });

    await service.touchFile(join(dir, "a.py"), dir);
    expect(statuses.at(-1)).toContain("ruff (unavailable)");

    await service.shutdownAll();
  });

  it("refreshStatus re-renders the current server state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-status-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    const service = createLspService([runningAdapter("pyright")], join(dir, "no-global.json"));
    const statuses: (string | undefined)[] = [];
    service.attachStatus((text) => {
      statuses.push(text);
    });

    // attachStatus 时还没有任何 server：应清除 status
    expect(statuses.at(-1)).toBeUndefined();

    await service.touchFile(join(dir, "a.py"), dir);
    service.refreshStatus();
    expect(statuses.at(-1)).toContain("pyright");

    await service.shutdownAll();
  });
});
