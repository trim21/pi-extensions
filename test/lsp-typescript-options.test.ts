import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(nodeExecFile);
const script = fileURLToPath(new URL("../bin/typescript-options.mjs", import.meta.url));

/** 建一个 `<dir>/lib/tsserver.js` 与 package.json 的假 typescript 包。 */
async function packageAt(dir: string, version: string, tsserver: boolean): Promise<void> {
  await mkdir(join(dir, "lib"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "typescript", version }));
  await writeFile(join(dir, tsserver ? "lib/tsserver.js" : "lib/typescript.js"), "");
}

/** 在 fixture 目录下跑脚本，返回 stdout 解析出的 JSON。 */
async function runProbe(caseDir: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFile(process.execPath, [script], { cwd: caseDir });
  return JSON.parse(stdout);
}

async function tsserverPath(caseDir: string): Promise<string | undefined> {
  const output = (await runProbe(caseDir)) as { tsserver?: { path?: string } };
  return output.tsserver?.path;
}

describe("typescript-options 脚本", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-ts-options-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("标准 typescript 依赖不覆盖", async () => {
    const dir = join(root, "standard");
    await packageAt(join(dir, "node_modules/typescript"), "5.9.2", true);

    expect(await runProbe(dir)).toEqual({});
  });

  it("只有 TS6 shim（没有真实 tsserver）输出空对象", async () => {
    const dir = join(root, "shim-only");
    await packageAt(join(dir, "node_modules/typescript"), "6.0.2", false);

    expect(await runProbe(dir)).toEqual({});
  });

  it("只有 TS7 native 与 TS6 shim 时输出空对象", async () => {
    const dir = join(root, "native-only");
    await packageAt(join(dir, "node_modules/typescript"), "6.0.2", false);
    await packageAt(join(dir, "node_modules/@typescript/native"), "7.0.2", false);

    expect(await runProbe(dir)).toEqual({});
  });

  it("npm 提升的 shim 用同级的 @typescript/<包>", async () => {
    const dir = join(root, "npm-flat");
    await packageAt(join(dir, "node_modules/typescript"), "6.0.2", false);
    await packageAt(join(dir, "node_modules/@typescript/old"), "6.0.3", true);

    expect(await tsserverPath(dir)).toBe(join(dir, "node_modules/@typescript/old/lib/tsserver.js"));
  });

  it("npm 嵌套在 shim 下的 @typescript/<包> 也能找到", async () => {
    const dir = join(root, "npm-nested");
    await packageAt(join(dir, "node_modules/typescript"), "6.0.2", false);
    const nested = join(dir, "node_modules/typescript/node_modules/@typescript/old");
    await packageAt(nested, "6.0.3", true);

    expect(await tsserverPath(dir)).toBe(join(nested, "lib/tsserver.js"));
  });

  it("pnpm store 里的真实 typescript", async () => {
    const dir = join(root, "pnpm-store");
    await packageAt(join(dir, "node_modules/typescript"), "6.0.2", false);
    const store = join(dir, "node_modules/.pnpm/typescript@5.9.2/node_modules/typescript");
    await packageAt(store, "5.9.2", true);

    expect(await tsserverPath(dir)).toBe(join(store, "lib/tsserver.js"));
  });

  it("pnpm store 里 alias 出来的 @typescript/<包>", async () => {
    const dir = join(root, "pnpm-store-alias");
    await packageAt(join(dir, "node_modules/typescript"), "6.0.2", false);
    const store = join(
      dir,
      "node_modules/.pnpm/@typescript+old@6.0.3/node_modules/@typescript/old",
    );
    await packageAt(store, "6.0.3", true);

    expect(await tsserverPath(dir)).toBe(join(store, "lib/tsserver.js"));
  });

  it("同层多个候选取版本最高的（store 目录名带 peer 后缀也算）", async () => {
    const dir = join(root, "highest-version");
    await packageAt(join(dir, "node_modules/typescript"), "6.0.2", false);
    const lower = join(dir, "node_modules/.pnpm/typescript@5.9.2/node_modules/typescript");
    const higher = join(
      dir,
      "node_modules/.pnpm/typescript@6.0.3_@types+node@24.0.0/node_modules/typescript",
    );
    await packageAt(lower, "5.9.2", true);
    await packageAt(higher, "6.0.3", true);

    expect(await tsserverPath(dir)).toBe(join(higher, "lib/tsserver.js"));
  });

  it("标准 typescript 存在时即使 store 里有别的版本也不覆盖", async () => {
    const dir = join(root, "standard-wins");
    await packageAt(join(dir, "node_modules/typescript"), "5.9.2", true);
    const store = join(dir, "node_modules/.pnpm/typescript@6.0.3/node_modules/typescript");
    await packageAt(store, "6.0.3", true);

    expect(await runProbe(dir)).toEqual({});
  });

  it("本级找不到时继续往上级 node_modules 找", async () => {
    const dir = join(root, "parent-chain/app");
    await mkdir(dir, { recursive: true });
    await packageAt(join(root, "parent-chain/node_modules/typescript"), "6.0.2", false);
    await packageAt(join(root, "parent-chain/node_modules/@typescript/old"), "6.0.3", true);

    expect(await tsserverPath(dir)).toBe(
      join(root, "parent-chain/node_modules/@typescript/old/lib/tsserver.js"),
    );
  });

  it("package.json 读不到版本的候选仍可用（排序退化为最低）", async () => {
    const dir = join(root, "no-version");
    await mkdir(join(dir, "node_modules/typescript/lib"), { recursive: true });
    await writeFile(join(dir, "node_modules/typescript/lib/typescript.js"), "");
    await mkdir(join(dir, "node_modules/@typescript/old/lib"), { recursive: true });
    await writeFile(join(dir, "node_modules/@typescript/old/lib/tsserver.js"), "");

    expect(await tsserverPath(dir)).toBe(join(dir, "node_modules/@typescript/old/lib/tsserver.js"));
  });
});
