/**
 * gitignore 目录计算测试（gitignore.ts）：
 * - 只返回被整体忽略的目录，单文件忽略不返回
 * - 嵌套 .gitignore 生效，父目录取反不能重新包含文件
 * - 含 glob 元字符的目录被跳过（避免 @parcel/watcher 误判成 glob）
 * - 非 git 仓库 / 不存在的目录返回空集合
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { gitignoredDirectories } from "../src/lib/lsp/gitignore.js";

const exec = promisify(execFile);

const hasGit = await exec("git", ["--version"]).then(
  () => true,
  () => false,
);

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lsp-gitignore-"));
  dirs.push(dir);
  return dir;
}

async function initRepo(): Promise<string> {
  const dir = await tempDir();
  await exec("git", ["init", "-q", "."], { cwd: dir });
  return dir;
}

async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
}

describe.skipIf(!hasGit)("gitignoredDirectories", () => {
  it("returns directories ignored as a whole", async () => {
    const root = await initRepo();
    await write(root, ".gitignore", "gi-cache-dir/\n");
    await write(root, "gi-cache-dir/a.txt", "a");
    await write(root, "gi-cache-dir/nested/b.txt", "b");

    expect(await gitignoredDirectories(root)).toEqual(["gi-cache-dir"]);
  });

  it("honors nested .gitignore files", async () => {
    const root = await initRepo();
    await write(root, "packages/app/.gitignore", "gi-gen-dir/\n");
    await write(root, "packages/app/gi-gen-dir/out.js", "x");

    expect(await gitignoredDirectories(root)).toEqual(["packages/app/gi-gen-dir"]);
  });

  it("keeps excluding a directory when a child is re-included", async () => {
    const root = await initRepo();
    await write(root, ".gitignore", "gi-dist/\n!gi-dist/keep.js\n");
    await write(root, "gi-dist/keep.js", "x");
    await write(root, "gi-dist/other.js", "y");

    expect(await gitignoredDirectories(root)).toEqual(["gi-dist"]);
  });

  it("does not return single ignored files", async () => {
    const root = await initRepo();
    await write(root, ".gitignore", "*.gi-log\n");
    await write(root, "debug.gi-log", "x");

    expect(await gitignoredDirectories(root)).toEqual([]);
  });

  it("skips directory names containing glob metacharacters", async () => {
    const root = await initRepo();
    await write(root, ".gitignore", "gi\\[1\\]/\n");
    await write(root, "gi[1]/a.txt", "x");

    expect(await gitignoredDirectories(root)).toEqual([]);
  });

  it("returns empty for a non-git directory", async () => {
    const dir = await tempDir();
    await write(dir, ".gitignore", "gi-cache-dir/\n");
    await write(dir, "gi-cache-dir/a.txt", "x");

    expect(await gitignoredDirectories(dir)).toEqual([]);
  });

  it("returns empty for a missing directory", async () => {
    const dir = await tempDir();

    expect(await gitignoredDirectories(join(dir, "missing"))).toEqual([]);
  });
});
