// 端到端回归测试：真实 pyright / ruff server 下，cc 的 Edit/Write 引入或
// 消除的错误能否通过 LSP 诊断正确反映在工具返回文本中。
// 需要 pyright-langserver 与 ruff 在 PATH（CI 的 check job 安装了它们）；
// 二进制缺失时整组跳过（本地无工具时测试仍可运行）。
// 服务器定义写进临时项目的 .pi/lsp.json，不依赖全局 ~/.pi/agent/lsp.json：
// 生效的 servers 只来自用户配置，缺 servers 时 adapter 为空、拿不到任何诊断。
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import claudeCodeFileTools from "../src/claude-code/files.js";
import { which } from "../src/lib/lsp/bin.js";

const hasPyright = which("pyright-langserver") !== undefined;
const hasRuff = which("ruff") !== undefined;

interface RegisteredTool {
  name: string;
  description: string;
  parameters: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  execute: (...args: any[]) => Promise<any>;
}

function loadFileTools(): {
  tools: Map<string, RegisteredTool>;
  emitSessionStart: (cwd: string) => Promise<void>;
} {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, ((...args: any[]) => unknown)[]>();
  claudeCodeFileTools({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    exec: vi.fn(),
  } as never);
  return { tools, emitSessionStart: (cwd: string) => emitSessionStart(handlers, cwd) };
}

/** 触发 session_start（pi 会 await 该事件）：加载并校验 lsp.json，注册 LSP 工具。 */
async function emitSessionStart(
  handlers: Map<string, ((...args: any[]) => unknown)[]>,
  cwd: string,
): Promise<void> {
  for (const handler of handlers.get("session_start") ?? []) {
    await handler(
      { type: "session_start", reason: "startup" },
      {
        cwd,
        ui: {
          notify: vi.fn(),
          setStatus: vi.fn(),
          theme: { fg: (_k: string, text: string) => text },
        },
        sessionManager: { getBranch: () => [] },
      },
    );
  }
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

const SERVERS = {
  pyright: {
    include: ["**/*.py", "**/*.pyi"],
    bin: "pyright-langserver",
    args: ["--stdio"],
    languageIdByExtension: { ".py": "python", ".pyi": "python" },
  },
  ruff: {
    include: ["**/*.py", "**/*.pyi"],
    bin: "ruff",
    args: ["server"],
    languageIdByExtension: { ".py": "python", ".pyi": "python" },
  },
};

async function setupProject(disabled: string[] = [], maxOpenDocuments?: number) {
  const directory = await mkdtemp(join(tmpdir(), "cc-lsp-e2e-"));
  // pyright 与 ruff 的 root marker；放宽诊断等待时间避免首次启动超时
  await writeFile(join(directory, "pyproject.toml"), "[tool.ruff]\n");
  await mkdir(join(directory, ".pi"), { recursive: true });
  const lspConfig: Record<string, unknown> = {
    diagnosticsDocumentWaitTimeoutMs: "20s",
    servers: SERVERS,
    ...(disabled.length > 0 && { disabled }),
  };
  if (maxOpenDocuments !== undefined) lspConfig.maxOpenDocuments = maxOpenDocuments;
  await writeFile(join(directory, ".pi", "lsp.json"), JSON.stringify(lspConfig));
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
  it.runIf(hasPyright && hasRuff)(
    "reports pyright and ruff errors introduced by Edit",
    async () => {
      const { directory, filePath } = await setupProject();

      const { tools, emitSessionStart } = loadFileTools();
      await emitSessionStart(directory);
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
    },
    90_000,
  );

  it.runIf(hasRuff)(
    "does not report diagnostics when Edit leaves the file clean (ruff only)",
    async () => {
      const { directory, filePath } = await setupProject(["pyright"]);

      const { tools, emitSessionStart } = loadFileTools();
      await emitSessionStart(directory);
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
    },
    90_000,
  );

  it.runIf(hasRuff)(
    "does not report stale diagnostics on a later Write after the error is fixed",
    async () => {
      const { directory, filePath } = await setupProject(["pyright"]);

      const { tools, emitSessionStart } = loadFileTools();
      await emitSessionStart(directory);
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
    },
    90_000,
  );

  it.runIf(hasRuff)(
    "连续 edit 超过 maxOpenDocuments 个文件后，每个 Edit 仍包含其自身诊断",
    async () => {
      const { directory } = await setupProject(["pyright"], 2);
      const { tools, emitSessionStart } = loadFileTools();
      await emitSessionStart(directory);
      const ctx = context(directory);

      for (const name of ["a.py", "b.py", "c.py"]) {
        const filePath = join(directory, name);
        await writeFile(filePath, "x = 1\n");
        // read 不占驻留名额；Edit 让文件进入有界 LRU，容量 2 时第三个 Edit 会淘汰最早者
        await call(tools.get("Read")!, { file_path: filePath }, ctx);
        const result = await call(
          tools.get("Edit")!,
          {
            file_path: filePath,
            old_string: "x = 1",
            new_string: "x = undefined_name",
          },
          ctx,
        );
        expect(result.content[0].text).toContain("LSP errors detected in this file");
        expect(result.content[0].text).toContain("undefined_name");
      }
    },
    90_000,
  );

  it.runIf(hasPyright)(
    "外部改写被依赖文件后，Edit 上层文件的诊断反映新磁盘状态",
    async () => {
      const { directory } = await setupProject(["ruff"]);
      const libPath = join(directory, "lib.py");
      const mainPath = join(directory, "main.py");
      await writeFile(libPath, 'def greet(name: str) -> str:\n    return f"hi {name}"\n');
      await writeFile(mainPath, 'import lib\nprint(lib.greet("world"))\n');
      const { tools, emitSessionStart } = loadFileTools();
      await emitSessionStart(directory);
      const ctx = context(directory);

      // 建立 client 并驻留 main.py（引入自身错误拿到基线诊断）
      await call(tools.get("Read")!, { file_path: mainPath }, ctx);
      const baseline = await call(
        tools.get("Edit")!,
        {
          file_path: mainPath,
          old_string: 'print(lib.greet("world"))',
          new_string: "print(lib.greet(undefined_name))",
        },
        ctx,
      );
      expect(baseline.content[0].text).toContain("undefined_name");

      // 外部工具改写被依赖的 lib.py（greet 参数改为 int）
      await writeFile(libPath, 'def greet(name: int) -> str:\n    return "hi"\n');
      // 等 watcher 去抖（300ms）+ fan-out + pyright 刷新磁盘快照
      await new Promise((resolve) => setTimeout(resolve, 2_500));

      // 修复 main.py 自身错误：诊断应反映 lib.py 的新签名（str 不能赋给 int）
      const fixed = await call(
        tools.get("Edit")!,
        {
          file_path: mainPath,
          old_string: "print(lib.greet(undefined_name))",
          new_string: 'print(lib.greet("world"))',
        },
        ctx,
      );
      expect(fixed.content[0].text).toContain("LSP errors detected in this file");
      expect(fixed.content[0].text).toMatch(/cannot be assigned|reportArgumentType/);
    },
    90_000,
  );
});
