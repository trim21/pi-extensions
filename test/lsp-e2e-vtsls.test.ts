// 端到端回归测试：真实 vtsls（tsserver）下，外部写入者（git pull / 并发 agent）
// 修正错误后，本 agent 后续 pull 诊断是否仍拿到旧结果。
// 需要 vtsls 在 PATH；二进制缺失时整组跳过。
// 服务器定义写进临时项目的 .pi/lsp.json，不依赖全局 ~/.pi/agent/lsp.json。
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import claudeCodeFileTools from "../src/claude-code/files.js";
import { which } from "../src/lib/lsp/bin.js";

const hasVtsls = which("vtsls") !== undefined;

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
  typescript: {
    include: ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
    rootMarkers: ["pnpm-lock.yaml", "package-lock.json"],
    bin: "vtsls",
    args: ["--stdio"],
    cwd: "{root}",
    languageIdByExtension: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
    },
  },
};

async function setupProject() {
  const directory = await mkdtemp(join(tmpdir(), "cc-lsp-e2e-vtsls-"));
  // root marker + tsconfig，避免 tsserver 把临时目录之外的文件当项目根
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "e2e" }));
  await writeFile(join(directory, "pnpm-lock.yaml"), "");
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
  );
  await mkdir(join(directory, ".pi"), { recursive: true });
  await writeFile(
    join(directory, ".pi", "lsp.json"),
    JSON.stringify({
      diagnosticsDocumentWaitTimeoutMs: "30s",
      servers: SERVERS,
    }),
  );
  return { directory };
}

describe("cc Edit/Write + real vtsls LSP", () => {
  it.runIf(hasVtsls)(
    "外部修正被依赖文件后，Edit 上层文件的诊断反映新磁盘状态",
    async () => {
      const { directory } = await setupProject();
      const libPath = join(directory, "lib.ts");
      const mainPath = join(directory, "main.ts");
      await writeFile(
        libPath,
        'export function greet(name: string): string {\n  return "hi " + name;\n}\n',
      );
      await writeFile(mainPath, 'import { greet } from "./lib";\ngreet("world");\n');
      const { tools, emitSessionStart } = loadFileTools();
      await emitSessionStart(directory);
      const ctx = context(directory);

      // 建立 client 并驻留 main.ts（引入自身错误拿到基线诊断）
      await call(tools.get("Read")!, { file_path: mainPath }, ctx);
      const baseline = await call(
        tools.get("Edit")!,
        {
          file_path: mainPath,
          old_string: 'greet("world")',
          new_string: "greet(undefined_name)",
        },
        ctx,
      );
      expect(baseline.content[0].text).toContain("undefined_name");

      // 外部写入者（git pull / 对方 agent push）改写被依赖的 lib.ts：参数改为 number
      await writeFile(
        libPath,
        "export function greet(name: number): string {\n  return String(name);\n}\n",
      );
      // 等 watcher 去抖（300ms）+ fan-out + tsserver 刷新磁盘快照
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      // 修复 main.ts 自身错误：诊断应反映 lib.ts 的新签名（string 不能赋给 number）
      // 若拿到旧结果（旧签名 string），此处将不会有任何诊断
      const fixed = await call(
        tools.get("Edit")!,
        {
          file_path: mainPath,
          old_string: "greet(undefined_name)",
          new_string: 'greet("world")',
        },
        ctx,
      );
      const text: string = fixed.content[0].text;
      expect(text).toContain("LSP errors detected in this file");
      expect(text).toMatch(/not assignable|2345/);
      expect(text).not.toContain("undefined_name");
    },
    120_000,
  );

  it.runIf(hasVtsls)(
    "文件自身被外部改写修正（git pull 覆盖）后，后续 Write 不报旧错误",
    async () => {
      const { directory } = await setupProject();
      const mainPath = join(directory, "main.ts");
      await writeFile(mainPath, 'const x: number = "not a number";\n');
      const { tools, emitSessionStart } = loadFileTools();
      await emitSessionStart(directory);
      const ctx = context(directory);

      // Edit 触碰文件使其驻留（磁盘本身就有类型错误，Edit 不改内容也行，用无操作替换）
      await call(tools.get("Read")!, { file_path: mainPath }, ctx);
      const broken = await call(
        tools.get("Edit")!,
        {
          file_path: mainPath,
          old_string: 'const x: number = "not a number";',
          new_string: 'const x: number = "still not a number";',
        },
        ctx,
      );
      expect(broken.content[0].text).toContain("LSP errors detected in this file");

      await new Promise((resolve) => setTimeout(resolve, 2_000));

      // 外部写入者把错误修掉（git pull 覆盖磁盘）
      await writeFile(mainPath, "const x: number = 42;\n");
      // 等 watcher 去抖 + 驻留文档退场（didClose）+ didChangeWatchedFiles
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      // pull 之后重新 Read（read-before-write 守卫 + 触发文件事件）
      await call(tools.get("Read")!, { file_path: mainPath }, ctx);

      // 磁盘已干净，再触发一次 Write（内容不变），不应再报旧错误
      const clean = await readFile(mainPath, "utf8");
      const recheck = await call(tools.get("Write")!, { file_path: mainPath, content: clean }, ctx);
      expect(recheck.content[0].text).not.toContain("LSP errors detected");
    },
    120_000,
  );
});
