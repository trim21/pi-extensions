// 端到端回归测试：真实 pyright / ruff server 下，cc 的 Edit/Write 引入或
// 消除的错误能否通过 LSP 诊断正确反映在工具返回文本中。
// 需要本机安装 pyright-langserver 与 ruff（均在 PATH）。
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import claudeCodeFileTools from "../src/claude-code/files.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  execute: (...args: any[]) => Promise<any>;
}

function loadFileTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  claudeCodeFileTools({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    exec: vi.fn(),
  } as never);
  return tools;
}

function context(cwd: string) {
  return {
    cwd,
    hasUI: true,
    ui: {
      setWidget: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
    },
  };
}

async function call(
  tool: RegisteredTool,
  params: Record<string, unknown>,
  ctx: ReturnType<typeof context>,
) {
  return tool.execute("call-id", params, undefined, undefined, ctx);
}

async function setupProject(disabled: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "cc-lsp-e2e-"));
  // pyright 与 ruff 的 root marker；放宽诊断等待时间避免首次启动超时
  await writeFile(join(directory, "pyproject.toml"), "[tool.ruff]\n");
  await mkdir(join(directory, ".pi"), { recursive: true });
  await writeFile(
    join(directory, ".pi", "lsp.json"),
    JSON.stringify({
      diagnosticsDocumentWaitTimeoutMs: "20s",
      ...(disabled.length > 0 && { disabled }),
    }),
  );
  const filePath = join(directory, "bad.py");
  await writeFile(
    filePath,
    [
      "def greet(name: str) -> str:",
      '    return f"hello {name}"',
      "",
      "",
      "def main():",
      '    print(greet("world"))',
      "",
    ].join("\n"),
    "utf8",
  );
  return { directory, filePath };
}

describe("cc Edit + real pyright/ruff LSP", () => {
  it("reports pyright and ruff errors introduced by Edit", async () => {
    const { directory, filePath } = await setupProject();

    const tools = loadFileTools();
    const ctx = context(directory);
    await call(tools.get("Read")!, { file_path: filePath }, ctx);
    const result = await call(
      tools.get("Edit")!,
      {
        file_path: filePath,
        old_string: 'print(greet("world"))',
        new_string: "print(greet(undefined_name))",
      },
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("LSP errors detected in this file");
    // pyright: undefined_name 未定义
    expect(text).toContain("undefined_name");
    // ruff: F821 undefined-name（消息用反引号包裹名字）
    expect(text).toMatch(/F821|Undefined name `undefined_name`/);
  }, 90_000);

  it("does not report diagnostics when Edit leaves the file clean (ruff only)", async () => {
    const { directory, filePath } = await setupProject(["pyright"]);

    const tools = loadFileTools();
    const ctx = context(directory);
    await call(tools.get("Read")!, { file_path: filePath }, ctx);

    // 引入错误 → 有诊断
    const broken = await call(
      tools.get("Edit")!,
      {
        file_path: filePath,
        old_string: 'print(greet("world"))',
        new_string: "print(greet(undefined_name))",
      },
      ctx,
    );
    expect(broken.content[0].text).toContain("LSP errors detected in this file");

    // 给服务器时间消化第一次 didChange 的重算，排除处理时序竞态
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // 改回干净版本 → 无诊断
    const fixed = await call(
      tools.get("Edit")!,
      {
        file_path: filePath,
        old_string: "print(greet(undefined_name))",
        new_string: 'print(greet("world"))',
      },
      ctx,
    );
    expect(fixed.content[0].text).not.toContain("LSP errors detected");
  }, 90_000);

  it("does not report stale diagnostics on a later Write after the error is fixed", async () => {
    const { directory, filePath } = await setupProject(["pyright"]);

    const tools = loadFileTools();
    const ctx = context(directory);
    await call(tools.get("Read")!, { file_path: filePath }, ctx);

    // 引入错误 → 有诊断
    await call(
      tools.get("Edit")!,
      {
        file_path: filePath,
        old_string: 'print(greet("world"))',
        new_string: "print(greet(undefined_name))",
      },
      ctx,
    );

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // 改回干净版本
    await call(
      tools.get("Edit")!,
      {
        file_path: filePath,
        old_string: "print(greet(undefined_name))",
        new_string: 'print(greet("world"))',
      },
      ctx,
    );

    // 磁盘内容已干净，sleep 后再触发一次 Write（内容不变），不应再报旧错误
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const clean = await readFile(filePath, "utf8");
    const recheck = await call(tools.get("Write")!, { file_path: filePath, content: clean }, ctx);
    expect(recheck.content[0].text).not.toContain("LSP errors detected");
  }, 90_000);
});
