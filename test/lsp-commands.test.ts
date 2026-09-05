import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { LspServerAdapter } from "../src/lib/lsp/adapter.js";
import { spawnProcess } from "../src/lib/lsp/launch.js";
import { createLspService } from "../src/lib/lsp/lsp.js";

const fixture = fileURLToPath(new URL("fixtures/mock-lsp-server.mjs", import.meta.url));

function countingAdapter(
  id: string,
  extensions: string[] = [".py"],
): { adapter: LspServerAdapter; spawns: () => number } {
  let count = 0;
  return {
    adapter: {
      id,
      extensions,
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

    // 此前运行中的 pyright 立即重启，不等下一次工具调用；ruff 不受影响
    await service.reload("pyright");
    expect(pyright.spawns()).toBe(2);
    expect(ruff.spawns()).toBe(1);
    expect(statuses.at(-1)).toContain("pyright");
    expect(statuses.at(-1)).toContain("ruff");

    await service.touchFile(join(dir, "a.py"), dir);
    expect(pyright.spawns()).toBe(2);
    expect(ruff.spawns()).toBe(1);

    await service.shutdownAll();
  });

  it("reload leaves servers that were not running lazy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-commands-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    const pyright = countingAdapter("pyright");
    // ruff 只匹配 .ts：触碰 .py 文件时它不会启动
    const ruff = countingAdapter("ruff", [".ts"]);
    const service = createLspService([pyright.adapter, ruff.adapter], join(dir, "no-global.json"));

    // 只有 pyright 匹配 .py；ruff 从未运行，reload 后保持惰性
    await service.touchFile(join(dir, "a.py"), dir);
    expect(pyright.spawns()).toBe(1);
    expect(ruff.spawns()).toBe(0);

    const restarted = await service.reload("ruff");
    expect(restarted).toEqual([]);
    expect(ruff.spawns()).toBe(0);

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

  it("reloadAll restarts every server and re-reads config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-commands-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    const globalFile = join(dir, "global.json");
    await writeFile(globalFile, JSON.stringify({ disabled: ["a", "b"] }));
    const a = countingAdapter("a");
    const b = countingAdapter("b");
    const service = createLspService([a.adapter, b.adapter], globalFile);

    // 配置禁用：不 spawn
    await service.touchFile(join(dir, "a.py"), dir);
    expect(a.spawns()).toBe(0);
    expect(b.spawns()).toBe(0);

    // 改盘上配置解除禁用：同 cwd 缓存生效，仍不 spawn
    await writeFile(globalFile, JSON.stringify({}));
    await service.touchFile(join(dir, "a.py"), dir);
    expect(a.spawns()).toBe(0);

    // reloadAll 清缓存并解除禁用：没有运行中的服务器，保持惰性，下次触碰启动
    await service.reloadAll();
    await service.touchFile(join(dir, "a.py"), dir);
    expect(a.spawns()).toBe(1);
    expect(b.spawns()).toBe(1);

    await service.shutdownAll();
  });

  it("reloadAll immediately restarts running servers without a tool call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-commands-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    const a = countingAdapter("a");
    const b = countingAdapter("b");
    const service = createLspService([a.adapter, b.adapter], join(dir, "no-global.json"));

    await service.touchFile(join(dir, "a.py"), dir);
    expect(a.spawns()).toBe(1);
    expect(b.spawns()).toBe(1);

    // 无需再触碰文件：运行中的服务器立即重启
    const restarted = await service.reloadAll();
    expect(restarted.toSorted()).toEqual(["a", "b"]);
    expect(a.spawns()).toBe(2);
    expect(b.spawns()).toBe(2);

    await service.shutdownAll();
  });

  it("reloadAll respawns from the new config: removed servers stay down", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-commands-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    const globalFile = join(dir, "global.json");
    await writeFile(globalFile, JSON.stringify({}));
    const a = countingAdapter("a");
    const service = createLspService([a.adapter], globalFile);

    await service.touchFile(join(dir, "a.py"), dir);
    expect(a.spawns()).toBe(1);

    // 盘上配置禁用 a：reloadAll 重读配置后不再重启它
    await writeFile(globalFile, JSON.stringify({ disabled: ["a"] }));
    const restarted = await service.reloadAll();
    expect(restarted).toEqual([]);
    expect(a.spawns()).toBe(1);

    await service.touchFile(join(dir, "a.py"), dir);
    expect(a.spawns()).toBe(1);

    await service.shutdownAll();
  });

  it("reloadAll re-enables LSP after stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-commands-"));
    await writeFile(join(dir, "a.py"), "x = 1\n");
    const a = countingAdapter("a");
    const service = createLspService([a.adapter], join(dir, "no-global.json"));
    await service.touchFile(join(dir, "a.py"), dir);
    expect(a.spawns()).toBe(1);

    await service.stop();
    await service.touchFile(join(dir, "a.py"), dir);
    expect(a.spawns()).toBe(1);

    await service.reloadAll();
    await service.touchFile(join(dir, "a.py"), dir);
    expect(a.spawns()).toBe(2);

    await service.shutdownAll();
  });
});
