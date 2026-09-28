// full 模式的等待在既有用例里没有直接覆盖（test/lsp-client.test.ts 与
// test/lsp-pull-timeout.test.ts 都只用 mode: "document"）。这里补一条最小用例：
// 服务器声明支持 pull 但对 textDocument/diagnostic 不回应时，full 模式在 pull
// 超时后不重试 pull，而是继续等 push 兜底到预算结束（本例把 10s 预算改短）。
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { create } from "../src/lib/lsp/client.js";

it("full 模式在 pull 挂起后仍等 push 兜底到预算结束", async () => {
  const directory = await mkdtemp(join(tmpdir(), "full-pull-hang-"));
  const file = join(directory, "a.py");
  await writeFile(file, "x = 1\n");

  const serverPath = fileURLToPath(new URL("fixtures/pull-hang-server.mjs", import.meta.url));
  const client = await create({
    serverID: "hang",
    server: {
      process: spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] }),
    },
    root: directory,
    directory,
    diagnosticsRequestTimeoutMs: 500,
    diagnosticsFullWaitTimeoutMs: 2_000,
  });

  await client.notify.open({ path: file });

  const startedAt = Date.now();
  await client.waitForDiagnostics({ path: file, version: 0, mode: "full" });
  const elapsed = Date.now() - startedAt;

  // pull 超时（500ms）后直接返回会明显早于预算；下限取 1.5s 确保等待确实走完了
  // push 兜底（预算 2s），与 document 模式在同一路径上的语义一致。
  expect(elapsed).toBeGreaterThanOrEqual(1_500);
  expect(elapsed).toBeLessThan(4_000);

  await client.shutdown();
}, 30_000);
