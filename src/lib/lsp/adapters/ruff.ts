/**
 * Python lint LSP 服务器（ruff 内置的 `ruff server`）。
 * 二进制优先项目 .venv / venv，其次 PATH。
 */

import { type LspServerAdapter, nearestRoot } from "../adapter.js";
import { findBinaryInWorkspace, which } from "../bin.js";
import { spawnProcess } from "../launch.js";

const PROJECT_MARKERS = ["pyproject.toml", "ruff.toml", ".ruff.toml"];

export class RuffAdapter implements LspServerAdapter {
  readonly id = "ruff";
  readonly extensions = [".py", ".pyi"];

  findRoot(file: string, cwd: string): Promise<string> {
    return nearestRoot(PROJECT_MARKERS, file, cwd);
  }

  async spawn(root: string, cwd: string) {
    const bin = (await findBinaryInWorkspace("ruff", root, cwd)) ?? which("ruff");
    if (!bin) return;
    return {
      process: spawnProcess(bin, ["server"], { cwd: root }),
    };
  }
}
