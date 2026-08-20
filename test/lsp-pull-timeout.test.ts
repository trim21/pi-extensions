// 回归测试：pull 请求挂起（服务器无响应）时，waitForDiagnostics 应因
// 请求超时而中断返回，而不是无限重试阻塞编辑。
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
  });

  await client.notify.open({ path: join(directory, "a.py") });

  const startedAt = Date.now();
  await client.waitForDiagnostics({
    path: join(directory, "a.py"),
    version: 0,
    mode: "document",
  });
  const elapsed = Date.now() - startedAt;

  // 应在单次请求超时附近返回（中断），而不是无限重试
  expect(elapsed).toBeGreaterThanOrEqual(400);
  expect(elapsed).toBeLessThan(5_000);

  await client.shutdown();
}, 30_000);
