/**
 * TypeScript / JavaScript LSP 服务器（typescript-language-server）。
 * tsserver 路径解析自项目工作区的 node_modules，语言服务器二进制同样
 * 工作区优先、PATH 兜底。
 */

import { type LspServerAdapter, nearestRoot } from "../adapter.js";
import { findBinaryInWorkspace, findModuleInWorkspace, which } from "../bin.js";
import { spawnProcess } from "../launch.js";

const LOCK_FILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

export class TypescriptAdapter implements LspServerAdapter {
  readonly id = "typescript";
  readonly extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

  findRoot(file: string, cwd: string): Promise<string> {
    return nearestRoot(LOCK_FILES, file, cwd);
  }

  async spawn(root: string, cwd: string) {
    // typescript-language-server 依赖项目里的 tsserver（本身不带）
    const tsserver = await findModuleInWorkspace("typescript/lib/tsserver.js", root, cwd);
    if (!tsserver) return;
    const bin =
      (await findBinaryInWorkspace("typescript-language-server", root, cwd)) ??
      which("typescript-language-server");
    if (!bin) return;
    return {
      process: spawnProcess(bin, ["--stdio"], { cwd: root }),
      initialization: { tsserver: { path: tsserver } },
    };
  }
}
