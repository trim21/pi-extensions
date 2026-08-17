import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { findBinaryInWorkspace, findModuleInWorkspace, walkUp } from "../src/lib/lsp/bin.js";

describe("lsp bin lookup", () => {
  it("walkUp 从 fromDir 逐级向上到 stopDir（含两端）", () => {
    // 用 join(sep, ...) 构造路径，保证 POSIX 与 Windows 都从根开始
    const from = join(sep, "a", "b", "c");
    const stop = join(sep, "a");
    expect(walkUp(from, stop)).toEqual([from, join(sep, "a", "b"), stop]);
    expect(walkUp(stop, stop)).toEqual([stop]);
  });

  it("findBinaryInWorkspace 工作区优先于 PATH 且逐级向上", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-bin-test-"));
    const nested = join(dir, "packages", "foo");
    await mkdir(join(nested, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(dir, ".venv", "bin"), { recursive: true });
    await writeFile(join(nested, "node_modules", ".bin", "foo-server"), "#!/bin/sh\n");
    await writeFile(join(dir, ".venv", "bin", "ruff"), "#!/bin/sh\n");

    // 从深层目录向上：命中最近的 node_modules/.bin
    expect(await findBinaryInWorkspace("foo-server", nested, dir)).toBe(
      join(nested, "node_modules", ".bin", "foo-server"),
    );
    // 上级目录的 .venv/bin
    expect(await findBinaryInWorkspace("ruff", nested, dir)).toBe(
      join(dir, ".venv", "bin", "ruff"),
    );
    // 找不到返回 undefined
    expect(await findBinaryInWorkspace("nope", nested, dir)).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  it("findModuleInWorkspace 找到 node_modules 里的模块文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-bin-test-"));
    const nested = join(dir, "packages", "foo");
    await mkdir(join(nested, "node_modules", "typescript", "lib"), { recursive: true });
    await writeFile(
      join(nested, "node_modules", "typescript", "lib", "tsserver.js"),
      "// tsserver",
    );

    expect(await findModuleInWorkspace("typescript/lib/tsserver.js", nested, dir)).toBe(
      join(nested, "node_modules", "typescript", "lib", "tsserver.js"),
    );
    expect(
      await findModuleInWorkspace("typescript/lib/tsserver.js", join(dir, "other"), dir),
    ).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});
