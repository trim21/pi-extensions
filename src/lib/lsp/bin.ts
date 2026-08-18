/**
 * 工作区优先的二进制 / 模块查找。
 *
 * 查找顺序（对每个候选目录逐级向上到 stopDir 为止）：
 *   node_modules/.bin/<cmd> → .venv/bin/<cmd> → venv/bin/<cmd>
 * 全部落空后由调用方回退到 PATH（which）。
 * 这样项目用 uv / pnpm 装的服务器（.venv、node_modules）优先于系统级安装。
 */

import { existsSync } from "node:fs";
import { delimiter, dirname, join, normalize } from "node:path";

export function exists(p: string): boolean {
  return existsSync(p);
}

/** 从 fromDir 逐级向上（含 stopDir 本身）收集目录，到文件系统根为止。 */
export function walkUp(fromDir: string, stopDir: string): string[] {
  const dirs: string[] = [];
  let current = normalize(fromDir);
  const stop = normalize(stopDir);
  for (;;) {
    dirs.push(current);
    if (current === stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function binaryNames(cmd: string): string[] {
  if (process.platform === "win32") {
    const ext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").toLowerCase().split(";");
    return [cmd, ...ext.map((e) => cmd + e)];
  }
  return [cmd];
}

/**
 * 从 fromDir 向上（到 stopDir）在项目工作区里找二进制。
 * 候选位置：node_modules/.bin、.venv/bin、venv/bin。
 */
export function findBinaryInWorkspace(
  cmd: string,
  fromDir: string,
  stopDir: string,
): Promise<string | undefined> {
  for (const dir of walkUp(fromDir, stopDir)) {
    const roots = [
      join(dir, "node_modules", ".bin"),
      join(dir, ".venv", "bin"),
      join(dir, "venv", "bin"),
    ];
    for (const root of roots) {
      for (const name of binaryNames(cmd)) {
        const candidate = join(root, name);
        if (exists(candidate)) return Promise.resolve(candidate);
      }
    }
  }
  return Promise.resolve(undefined);
}

/** PATH 查找（同步，逻辑简单；调用频率低，无需缓存）。 */
export function which(cmd: string): string | undefined {
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of binaryNames(cmd)) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
