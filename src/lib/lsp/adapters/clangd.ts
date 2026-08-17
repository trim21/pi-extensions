/**
 * C/C++ LSP 服务器（clangd，随 LLVM/clang 工具链安装，走 PATH）。
 */

import { type LspServerAdapter, type LspServerHandle, nearestRoot } from "../adapter.js";
import { which } from "../bin.js";
import { spawnProcess } from "../launch.js";

const PROJECT_MARKERS = ["compile_commands.json", "compile_flags.txt", ".clangd"];

export class ClangdAdapter implements LspServerAdapter {
  readonly id = "clangd";
  readonly extensions = [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"];

  findRoot(file: string, cwd: string): Promise<string> {
    return nearestRoot(PROJECT_MARKERS, file, cwd);
  }

  spawn(root: string): Promise<LspServerHandle | undefined> {
    const bin = which("clangd");
    if (!bin) return Promise.resolve(undefined);
    return Promise.resolve({
      process: spawnProcess(bin, ["--background-index", "--clang-tidy"], { cwd: root }),
    });
  }
}
