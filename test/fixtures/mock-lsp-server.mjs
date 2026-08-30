// 简易 stdio LSP 服务器 fixture：用于 client 测试。
// 行为：initialize 握手 → didOpen 后 50ms 推送一个 ERROR 诊断 → shutdown/exit。
// 收到的 notifications 以 JSONL 写到 stderr 供测试断言载荷；
// env MOCK_REGISTER_WATCHERS（逗号分隔，每项 "pattern" 或 "pattern:kind"，
// kind 缺省 7）时，initialized 后主动发送 client/registerCapability 注册
// workspace/didChangeWatchedFiles watchers；
// env MOCK_UNREGISTER_IDS（逗号分隔 registration id）时，收到 textDocument/didClose
// 后发送 client/unregisterCapability 移除对应注册。
// env MOCK_RENAME_MODE 控制 rename 能力：
//   ok          声明 renameProvider: { prepareProvider: true }，prepare/rename 正常响应
//   no_prepare  声明 renameProvider: true（无 prepare），仅响应 rename
//   null_prepare prepare 返回 null（位置不可 rename）
//   null_rename prepare 成功但 rename 返回 null
//   unsupported 不声明 renameProvider，请求返回 MethodNotFound
const renameMode = process.env.MOCK_RENAME_MODE ?? "";
const prepareResult = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  placeholder: "mockSymbol",
};
let buffer = Buffer.alloc(0);

const registerWatchers = (process.env.MOCK_REGISTER_WATCHERS ?? "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [pattern, kind] = entry.split(":");
    return { globPattern: pattern, ...(kind !== undefined ? { kind: Number(kind) } : {}) };
  });
const unregisterIds = (process.env.MOCK_UNREGISTER_IDS ?? "").split(",").filter(Boolean);
let watchersRegistered = false;
let unregisterSent = false;

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
  // 通知回传（请求/响应带 id，通知不带）
  if (msg.id === undefined && msg.method !== undefined) {
    process.stderr.write(JSON.stringify({ method: msg.method, params: msg.params }) + "\n");
  }
  if (msg.method === "initialize") {
    const capabilities = { textDocumentSync: 1 };
    if (["ok", "null_prepare", "null_rename"].includes(renameMode)) {
      capabilities.renameProvider = { prepareProvider: true };
    } else if (renameMode === "no_prepare") {
      capabilities.renameProvider = true;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { capabilities },
    });
    return;
  }
  if (msg.method === "initialized") {
    if (!watchersRegistered && registerWatchers.length > 0) {
      watchersRegistered = true;
      send({
        jsonrpc: "2.0",
        id: "reg-cap-1",
        method: "client/registerCapability",
        params: {
          registrations: registerWatchers.map((watcher, i) => ({
            id: `watcher-${i}`,
            method: "workspace/didChangeWatchedFiles",
            registerOptions: { watchers: [watcher] },
          })),
        },
      });
    }
    return;
  }
  if (msg.method === "textDocument/didClose") {
    if (!unregisterSent && unregisterIds.length > 0) {
      unregisterSent = true;
      send({
        jsonrpc: "2.0",
        id: "unreg-cap-1",
        method: "client/unregisterCapability",
        params: {
          unregisterations: unregisterIds.map((id) => ({
            id,
            method: "workspace/didChangeWatchedFiles",
          })),
        },
      });
    }
    return;
  }
  if (msg.method === "textDocument/didOpen") {
    const uri = msg.params.textDocument.uri;
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              severity: 1,
              message: "mock error message",
            },
          ],
        },
      });
    }, 50);
    return;
  }
  if (msg.method === "textDocument/didChange") {
    // 模拟慢服务器：重算耗时 300ms 后才推送基于新内容的结果
    const uri = msg.params.textDocument.uri;
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              severity: 1,
              message: "new error message",
            },
          ],
        },
      });
    }, 300);
    return;
  }
  if (msg.method === "textDocument/prepareRename" && renameMode !== "unsupported") {
    if (renameMode === "no_prepare") return;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: renameMode === "null_prepare" ? null : prepareResult,
    });
    return;
  }
  if (msg.method === "textDocument/rename" && renameMode !== "unsupported") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result:
        renameMode === "null_rename"
          ? null
          : {
              changes: {
                [msg.params.textDocument.uri]: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                    newText: msg.params.newName,
                  },
                ],
              },
            },
    });
    return;
  }
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "exit") {
    process.exit(0);
  }
  // 未实现的请求统一回 MethodNotFound，避免客户端挂起
  if (msg.id !== undefined && msg.method !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "MethodNotFound" } });
  }
}
