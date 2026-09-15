// 驻留 LRU 淘汰的挂死回归驱动：由 test/lsp-client.test.ts 以子进程方式运行，
// 并在超时后强杀——旧实现（"跳过等待项，下一轮再淘汰"的 while 循环）会在这里
// 同步自旋，同一个进程内的测试无法自行超时退出。
//
// 复现的状态：驻留文档全部在等诊断，而刚打开的文档本身也在等待集合里
// （它的等待还没结束，文档却被容量淘汰过、又被重新打开）。
// 详见 src/lib/lsp/client.ts 的 evictionPlan 注释。
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

// jiti 负责 .js → .ts 的解析（与 bin/ 下的脚本同一套），fixture 自身不能直接
// import src 里的 TS：Node 的 type stripping 不重写 "./x.js" 到 "./x.ts"。
const jiti = createJiti(import.meta.url);
const { create } = await jiti.import("../../src/lib/lsp/client.ts");

const mockServer = fileURLToPath(new URL("mock-lsp-server.mjs", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "lsp-evict-driver-"));
const files = ["a.py", "b.py", "c.py"].map((name) => join(dir, name));
for (const file of files) await writeFile(file, "x = 1\n");

const proc = spawn(process.execPath, [mockServer], {
  env: { ...process.env, MOCK_DIAGNOSTICS_NEVER: "1" },
});
const client = await create({
  serverID: "mock",
  server: { process: proc },
  root: dir,
  directory: dir,
  maxOpenDocuments: 2,
  // 等待窗口压到 500ms 之内，让驱动能干净退出（不影响"打开即淘汰"的时序）
  diagnosticsDocumentWaitTimeoutMs: 500,
});

const wait = (path, version) => client.waitForDiagnostics({ path, version, mode: "document" });
const pending = [];
try {
  // a、b 驻留并各自开始等待：服务器不推诊断，两者一直留在 waitingForDiagnostics
  await client.notify.open({ path: files[0] });
  pending.push(wait(files[0], 0));
  await client.notify.open({ path: files[1] });
  pending.push(wait(files[1], 0));

  // 容量（2）已满：c 是唯一不在等待集合里的项，打开时会被立刻淘汰，随后才开始等它
  await client.notify.open({ path: files[2] });
  pending.push(wait(files[2], 0));

  // 重新打开 c：新文档就是 c 自己，而它已在等待集合里 → 没有任何可淘汰项
  await client.notify.open({ path: files[2] });

  console.log("OK");
} finally {
  await Promise.allSettled(pending);
  await client.shutdown();
  await rm(dir, { recursive: true, force: true });
}
