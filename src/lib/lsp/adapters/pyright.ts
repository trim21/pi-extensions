/**
 * Python 类型检查 LSP 服务器（pyright-langserver）。
 * pythonPath 优先取 VIRTUAL_ENV，其次项目 .venv / venv 里的解释器。
 */

import { join } from "node:path";

import { type LspServerAdapter, nearestRoot } from "../adapter.js";
import { exists, findBinaryInWorkspace, which } from "../bin.js";
import { spawnProcess } from "../launch.js";

const PROJECT_MARKERS = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "pyrightconfig.json",
];

export class PyrightAdapter implements LspServerAdapter {
  readonly id = "pyright";
  readonly extensions = [".py", ".pyi"];

  findRoot(file: string, cwd: string): Promise<string> {
    return nearestRoot(PROJECT_MARKERS, file, cwd);
  }

  async spawn(root: string, cwd: string) {
    const bin =
      (await findBinaryInWorkspace("pyright-langserver", root, cwd)) ?? which("pyright-langserver");
    if (!bin) return;

    const initialization: Record<string, string> = {};
    const venvs = [process.env.VIRTUAL_ENV, join(root, ".venv"), join(root, "venv")];
    for (const venv of venvs) {
      if (!venv) continue;
      const python = join(venv, process.platform === "win32" ? "Scripts" : "bin", "python");
      if (exists(python)) {
        initialization.pythonPath = python;
        break;
      }
    }

    return {
      process: spawnProcess(bin, ["--stdio"], { cwd: root }),
      initialization,
    };
  }
}
