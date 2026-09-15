/**
 * 取消信号在 LSP 层的连通性：inspect（hover/definition/references）与 rename 的
 * 中止必须让调用方立刻返回，并把 $/cancelRequest 发给服务器——而不是等一个
 * 永不回应的请求，或被折叠成 "all servers failed"。
 *
 * 用 mock 语言服务器（fixtures/mock-lsp-server.mjs）的 MOCK_HANG_METHODS 挂起
 * 指定方法，模拟"服务器卡住"。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LspServerAdapter } from "../src/lib/lsp/adapter.js";
import { spawnProcess } from "../src/lib/lsp/launch.js";
import { createLspService, type LspService } from "../src/lib/lsp/lsp.js";

const fixture = fileURLToPath(new URL("fixtures/mock-lsp-server.mjs", import.meta.url));

const dirs: string[] = [];
const services: LspService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdownAll()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 启动 mock 服务器的 adapter，并把子进程回显的方法名（JSONL）收集起来。 */
function mockAdapter(env: Record<string, string>): {
  adapter: LspServerAdapter;
  methods: () => string[];
} {
  const methods: string[] = [];
  let buffer = "";
  return {
    adapter: {
      id: "mock",
      extensions: [".py"],
      async spawn() {
        const child = spawnProcess(process.execPath, [fixture], { env });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (!line.trim()) continue;
            try {
              methods.push((JSON.parse(line) as { method?: string }).method ?? "");
            } catch {
              // fixture 只写 JSONL；非 JSON 行忽略
            }
          }
        });
        return { process: child };
      },
    },
    methods: () => methods,
  };
}

async function setup(env: Record<string, string>): Promise<{
  dir: string;
  file: string;
  methods: () => string[];
  service: LspService;
}> {
  const dir = await mkdtemp(join(tmpdir(), "lsp-signal-"));
  dirs.push(dir);
  const file = join(dir, "a.py");
  await writeFile(file, "x = 1\n");
  const { adapter, methods } = mockAdapter(env);
  const service = createLspService([adapter], join(dir, "no-global.json"));
  services.push(service);
  return { dir, file, methods, service };
}

describe("inspect 的取消信号", () => {
  it("hover 挂起时中止立刻拒绝（AbortError），并发送 $/cancelRequest", async () => {
    const { dir, file, methods, service } = await setup({
      MOCK_HANG_METHODS: "textDocument/hover",
      MOCK_ECHO_REQUESTS: "1",
    });
    const controller = new AbortController();

    const pending = service.inspect({
      file,
      cwd: dir,
      line: 0,
      character: 0,
      query: "hover",
      options: { signal: controller.signal },
    });
    // 等请求真的发到服务器再中止
    await vi.waitFor(() => expect(methods()).toContain("textDocument/hover"));
    controller.abort();

    const failure = (await pending.catch((error: unknown) => error)) as Error;
    expect(failure.name).toBe("AbortError");
    // 中止不能被折叠成"所有服务器都失败"
    expect(failure.message).not.toMatch(/all servers/i);
    await vi.waitFor(() => expect(methods()).toContain("$/cancelRequest"));
  });
});

describe("rename 的取消信号", () => {
  it("references 挂起时中止立刻拒绝，并发送 $/cancelRequest", async () => {
    const { dir, file, methods, service } = await setup({
      MOCK_HANG_METHODS: "textDocument/references",
      MOCK_ECHO_REQUESTS: "1",
      MOCK_RENAME_MODE: "ok",
    });
    const controller = new AbortController();

    const pending = service.rename({
      file,
      cwd: dir,
      line: 0,
      character: 0,
      newName: "y",
      options: { signal: controller.signal },
    });
    await vi.waitFor(() => expect(methods()).toContain("textDocument/references"));
    controller.abort();

    const failure = (await pending.catch((error: unknown) => error)) as Error;
    expect(failure.name).toBe("AbortError");
    expect(failure.message).not.toMatch(/all servers/i);
    await vi.waitFor(() => expect(methods()).toContain("$/cancelRequest"));
  });
});
