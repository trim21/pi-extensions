// 回归测试：pull 请求挂起（服务器无响应）时，waitForDiagnostics 不应无限
// 重试阻塞编辑——pull 超时后放弃重试，等 push 兜底到窗口结束即返回。
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { create } from "../src/lib/lsp/client.js";

it("stops retrying pull after request timeout when server never responds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pull-hang-"));
  await writeFile(join(directory, "a.py"), "x = 1\n");

  const serverPath = fileURLToPath(new URL("fixtures/pull-hang-server.mjs", import.meta.url));
  const client = await create({
    serverID: "hang",
    server: {
      process: spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] }),
    },
    root: directory,
    directory,
    diagnosticsRequestTimeoutMs: 500,
    diagnosticsDocumentWaitTimeoutMs: 2_000,
  });

  await client.notify.open({ path: join(directory, "a.py") });

  const startedAt = Date.now();
  await client.waitForDiagnostics({
    path: join(directory, "a.py"),
    version: 0,
    mode: "document",
  });
  const elapsed = Date.now() - startedAt;

  // 不再重试 pull：返回时间在等待窗口内（约 2s），而不是无限阻塞。
  // 下限取 1.5s 确保确实经过了 pull 超时 + push 等待，而非提前退出。
  expect(elapsed).toBeGreaterThanOrEqual(1_500);
  expect(elapsed).toBeLessThan(4_000);

  await client.shutdown();
}, 30_000);
