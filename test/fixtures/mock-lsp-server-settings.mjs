// 记录 didChangeConfiguration 通知与 workspace/configuration 响应值的 mock LSP 服务器。
// 用法：node mock-lsp-server-settings.mjs <logFile>
import { appendFileSync } from "node:fs";

const logFile = process.argv[2];
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) return;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});

function send(msg) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  process.stdout.write(header + body);
}

function handle(msg) {
  // JSON-RPC 响应（无 method 但有 id）
  if (msg.id !== undefined && !msg.method) {
    if (msg.result !== undefined) {
      appendFileSync(logFile, `config-response: ${JSON.stringify(msg.result)}\n`);
    }
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (msg.method === "initialized") {
    send({
      jsonrpc: "2.0",
      id: 100,
      method: "workspace/configuration",
      params: { items: [{ section: "python" }] },
    });
    return;
  }
  if (msg.method === "workspace/didChangeConfiguration") {
    appendFileSync(logFile, `didChangeConfiguration: ${JSON.stringify(msg.params)}\n`);
    return;
  }
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "exit") {
    process.exit(0);
  }
}
