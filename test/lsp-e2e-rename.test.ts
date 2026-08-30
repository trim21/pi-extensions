// 端到端回归测试：真实 vtsls（tsserver）下的 lsp-rename 工具。
// 覆盖：跨文件重命名同步更新引用、symbol 缺省时的同名歧义报错、
// 补 character 后按指定位置执行。
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
    },
  },
};

async function setupProject() {
  const directory = await mkdtemp(join(tmpdir(), "lsp-rename-e2e-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "e2e" }));
  await writeFile(join(directory, "pnpm-lock.yaml"), "");
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
  );
  await mkdir(join(directory, ".pi"), { recursive: true });
  await writeFile(join(directory, ".pi", "lsp.json"), JSON.stringify({ servers: SERVERS }));
  return { directory };
}

describe("lsp-rename + real vtsls", () => {
  it.runIf(hasVtsls)(
    "跨文件重命名：定义与引用同步更新，结果附诊断与 reads 快照",
    async () => {
      const { directory } = await setupProject();
      const libPath = join(directory, "lib.ts");
      const mainPath = join(directory, "main.ts");
      await writeFile(
        libPath,
        'export function greet(name: string): string {\n  return "hi " + name;\n}\n',
      );
      await writeFile(mainPath, 'import { greet } from "./lib";\nconsole.log(greet("world"));\n');
      const tools = loadFileTools();
      const ctx = context(directory);

      // 不做预热：renameSymbol 前置的 textDocument/references 请求会阻塞到
      // vtsls 完成项目加载（响应即同步点），覆盖校验 + 重试保证跨文件引用完整。
      const result = await call(
        tools.get("lsp-rename")!,
        { file_path: libPath, line: 1, symbol: "greet", new_name: "farewell" },
        ctx,
      );

      const text: string = result.content[0].text;
      expect(text).toContain("farewell");
      expect(text).toContain("2 file(s)");

      const lib = await readFile(libPath, "utf8");
      const main = await readFile(mainPath, "utf8");
      expect(lib).toContain("export function farewell(");
      expect(lib).not.toContain("greet");
      expect(main).toContain('import { farewell } from "./lib";');
      expect(main).toContain('farewell("world")');
      expect(Object.keys(result.details?.reads ?? {})).toHaveLength(2);
    },
    120_000,
  );

  it.runIf(hasVtsls)(
    "同名不同符号报歧义并列出候选，补 character 后按指定位置执行",
    async () => {
      const { directory } = await setupProject();
      const ambPath = join(directory, "amb.ts");
      await writeFile(ambPath, "const item = { item: 1 };\n");
      const tools = loadFileTools();
      const ctx = context(directory);

      // 行内 "item" 既是变量声明又是对象属性，是两个不同的符号；
      // 歧义报错列出各候选的 1-based 列号（声明 7、属性 15）
      await expect(
        call(
          tools.get("lsp-rename")!,
          { file_path: ambPath, line: 1, symbol: "item", new_name: "renamed" },
          ctx,
        ),
      ).rejects.toThrow(/Ambiguous rename target[\s\S]*column 7[\s\S]*column 16/);

      // 文件未被修改
      expect(await readFile(ambPath, "utf8")).toBe("const item = { item: 1 };\n");

      // 补 character（1-based 第 16 列是对象属性 item）后只改属性
      await call(
        tools.get("lsp-rename")!,
        { file_path: ambPath, line: 1, symbol: "item", new_name: "count", character: 16 },
        ctx,
      );
      expect(await readFile(ambPath, "utf8")).toBe("const item = { count: 1 };\n");
    },
    120_000,
  );

  it.runIf(hasVtsls)(
    "该行没有目标符号时报可定位错误",
    async () => {
      const { directory } = await setupProject();
      const mainPath = join(directory, "main.ts");
      await writeFile(mainPath, "const value = 1;\n");
      const tools = loadFileTools();
      const ctx = context(directory);

      await expect(
        call(
          tools.get("lsp-rename")!,
          { file_path: mainPath, line: 1, symbol: "nonexistent", new_name: "x" },
          ctx,
        ),
      ).rejects.toThrow(/Symbol "nonexistent" not found on line 1/);
    },
    120_000,
  );
});
