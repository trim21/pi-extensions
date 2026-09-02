// 端到端回归测试：真实 vtsls（tsserver）下的只读 LSP 符号查询工具
// （lsp-find-definition / lsp-find-reference / lsp-inspect）。
// 工具壳由 claude-code / opencode 两个入口共享注册，对两个入口跑同一组场景。
// 项目结构来自 test/fixtures/lsp-project（拷贝到临时目录后运行），
// 需要 vtsls 在 PATH；二进制缺失时整组跳过。
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import claudeCodeFileTools from "../src/claude-code/files.js";
import { which } from "../src/lib/lsp/bin.js";
import opencodeFileTools from "../src/opencode/files.js";

const hasVtsls = which("vtsls") !== undefined;
const FIXTURE_PROJECT = new URL("fixtures/lsp-project", import.meta.url);

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

type ToolsetLoader = (pi: ExtensionAPI) => void;

function loadFileTools(loader: ToolsetLoader): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  loader({
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

const ENTRIES: Record<string, ToolsetLoader> = {
  "claude-code": claudeCodeFileTools,
  opencode: opencodeFileTools,
};

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

async function setupProject(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "lsp-inspect-e2e-"));
  await cp(FIXTURE_PROJECT, directory, { recursive: true });
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/**
 * 只读查询没有 rename 那样的收敛校验：vtsls 索引未加载完时会给出过时结果
 * （definition 停在 import 处、references 漏掉未入索引的文件）。轮询重试到
 * 出现跨文件结果，模拟用户看到旧结果后重试的行为。
 */
async function retryUntil(
  run: () => Promise<{ content: { text: string }[] }>,
  until: (text: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await run();
    const text: string = result.content[0].text;
    if (until(text) || Date.now() >= deadline) return text;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe.each(Object.entries(ENTRIES))("lsp-inspect tools + real vtsls (%s)", (_name, loader) => {
  it.runIf(hasVtsls)(
    "lsp-find-definition：从 import 处定位到定义行并附行片段",
    async () => {
      const { directory, cleanup } = await setupProject();
      try {
        const libPath = join(directory, "lib.ts");
        const mainPath = join(directory, "main.ts");
        const tools = loadFileTools(loader);
        const ctx = context(directory);

        const text = await retryUntil(
          () =>
            call(
              tools.get("lsp-find-definition")!,
              { file_path: mainPath, line: 1, symbol: "greet" },
              ctx,
            ),
          (text) => text.includes(`${libPath}:1:`),
        );
        expect(text).toContain("export function greet");
      } finally {
        await cleanup();
      }
    },
    120_000,
  );

  it.runIf(hasVtsls)(
    "lsp-find-reference：跨文件引用按文件分组并含声明处",
    async () => {
      const { directory, cleanup } = await setupProject();
      try {
        const libPath = join(directory, "lib.ts");
        const mainPath = join(directory, "main.ts");
        const tools = loadFileTools(loader);
        const ctx = context(directory);

        // 声明处 + main.ts 的 import 与调用 = 3 处；轮询到 main.ts 入索引
        const text = await retryUntil(
          () =>
            call(
              tools.get("lsp-find-reference")!,
              { file_path: libPath, line: 1, symbol: "greet" },
              ctx,
            ),
          (text) => text.includes("2 file(s)"),
        );
        expect(text).toContain("3 reference(s) in 2 file(s)");
        expect(text).toContain(libPath);
        expect(text).toContain(mainPath);
        // 只读：文件未被修改
        expect(await readFile(mainPath, "utf8")).toContain("greet");
      } finally {
        await cleanup();
      }
    },
    120_000,
  );

  it.runIf(hasVtsls)(
    "lsp-inspect：hover 返回类型签名",
    async () => {
      const { directory, cleanup } = await setupProject();
      try {
        const libPath = join(directory, "lib.ts");
        const tools = loadFileTools(loader);
        const ctx = context(directory);

        const result = await call(
          tools.get("lsp-inspect")!,
          { file_path: libPath, line: 1, symbol: "greet" },
          ctx,
        );

        const text: string = result.content[0].text;
        expect(text).toContain("greet");
        expect(text).toContain("name: string");
      } finally {
        await cleanup();
      }
    },
    120_000,
  );

  it.runIf(hasVtsls)(
    "该行没有目标符号时报可定位错误；同名歧义报错后补 character 消歧",
    async () => {
      const { directory, cleanup } = await setupProject();
      try {
        const mainPath = join(directory, "amb.ts");
        const tools = loadFileTools(loader);
        const ctx = context(directory);

        await expect(
          call(
            tools.get("lsp-find-definition")!,
            { file_path: mainPath, line: 1, symbol: "nonexistent" },
            ctx,
          ),
        ).rejects.toThrow(/Symbol "nonexistent" not found on line 1/);

        // 行内 "item" 既是变量声明又是对象属性，两个不同的符号 → 歧义报错
        await expect(
          call(
            tools.get("lsp-find-definition")!,
            { file_path: mainPath, line: 1, symbol: "item" },
            ctx,
          ),
        ).rejects.toThrow(/Ambiguous symbol[\s\S]*column 7[\s\S]*column 16/);

        // 补 character（1-based 第 16 列是对象属性 item）后正常返回且文件未被修改
        const result = await call(
          tools.get("lsp-find-definition")!,
          { file_path: mainPath, line: 1, symbol: "item", character: 16 },
          ctx,
        );
        expect(result.content[0].text).toContain(`${mainPath}:1:`);
        expect(await readFile(mainPath, "utf8")).toBe("const item = { item: 1 };\n");
      } finally {
        await cleanup();
      }
    },
    120_000,
  );
});
