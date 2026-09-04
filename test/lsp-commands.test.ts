import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { LspServerAdapter } from "../src/lib/lsp/adapter.js";
import { spawnProcess } from "../src/lib/lsp/launch.js";
import { createLspService } from "../src/lib/lsp/lsp.js";

const fixture = fileURLToPath(new URL("fixtures/mock-lsp-server.mjs", import.meta.url));

function countingAdapter(id: string): { adapter: LspServerAdapter; spawns: () => number } {
  let count = 0;
  return {
    adapter: {
      id,
      extensions: [".py"],
      spawn: async () => {
        count++;
        return { process: spawnProcess(process.execPath, [fixture]) };
      },
    },
    spawns: () => count,
  };
}

describe("LSP stop/start/reload", () => {
  it("stop disables spawning, start re-enables it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-commands-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    const { adapter, spawns } = countingAdapter("pyright");
    const service = createLspService([adapter], join(dir, "no-global.json"));
    const statuses: (string | undefined)[] = [];
    service.attachStatus((text) => {
      statuses.push(text);
    });

    await service.touchFile(join(dir, "a.py"), dir);
    expect(spawns()).toBe(1);

    await service.stop();
    expect(statuses.at(-1)).toBe("lsp: disabled");

    await service.touchFile(join(dir, "a.py"), dir);
    expect(spawns()).toBe(1);

    service.start();
    expect(statuses.at(-1)).toBeUndefined();

    await service.touchFile(join(dir, "a.py"), dir);
    expect(spawns()).toBe(2);
    expect(statuses.at(-1)).toContain("pyright");

    await service.shutdownAll();
  });

  it("reload restarts only the named server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-commands-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    const pyright = countingAdapter("pyright");
    const ruff = countingAdapter("ruff");
    const service = createLspService([pyright.adapter, ruff.adapter], join(dir, "no-global.json"));
    const statuses: (string | undefined)[] = [];
    service.attachStatus((text) => {
      statuses.push(text);
    });

    await service.touchFile(join(dir, "a.py"), dir);
    expect(pyright.spawns()).toBe(1);
    expect(ruff.spawns()).toBe(1);
    expect(service.serverIDs().toSorted()).toEqual(["pyright", "ruff"]);

    await service.reload("pyright");
    expect(statuses.at(-1)).toContain("ruff");
    expect(statuses.at(-1)).not.toContain("pyright");

    await service.touchFile(join(dir, "a.py"), dir);
    expect(pyright.spawns()).toBe(2);
    expect(ruff.spawns()).toBe(1);

    await service.shutdownAll();
  });

  it("reload clears the broken set so failed servers can retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-commands-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    let fail = true;
    const adapter: LspServerAdapter = {
      id: "pyright",
      extensions: [".py"],
      spawn: async () =>
        fail ? undefined : { process: spawnProcess(process.execPath, [fixture]) },
    };
    const service = createLspService([adapter], join(dir, "no-global.json"));
    const statuses: (string | undefined)[] = [];
    service.attachStatus((text) => {
      statuses.push(text);
    });

    await service.touchFile(join(dir, "a.py"), dir);
    expect(statuses.at(-1)).toContain("pyright (unavailable)");

    fail = false;
    await service.reload("pyright");
    await service.touchFile(join(dir, "a.py"), dir);
    expect(statuses.at(-1)).toContain("pyright");
    expect(statuses.at(-1)).not.toContain("unavailable");

    await service.shutdownAll();
  });
});
