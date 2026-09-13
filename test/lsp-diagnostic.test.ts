import { describe, expect, it } from "vitest";

import type { Diagnostic } from "../src/lib/lsp/client.js";
import { appendLspDiagnosticText, prettyDiagnostic, report } from "../src/lib/lsp/diagnostic.js";

function diag(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    message: "boom",
    ...overrides,
  };
}

describe("lsp diagnostic report", () => {
  it("prettyDiagnostic 输出 ERROR [行:列] 消息", () => {
    expect(prettyDiagnostic(diag())).toMatchInlineSnapshot(`"ERROR [1:1] boom"`);
    expect(prettyDiagnostic(diag({ severity: 2 }))).toMatchInlineSnapshot(`"WARN [1:1] boom"`);
    expect(
      prettyDiagnostic(
        diag({ range: { start: { line: 3, character: 5 }, end: { line: 3, character: 9 } } }),
      ),
    ).toMatchInlineSnapshot(`"ERROR [4:6] boom"`);
  });

  it("无 ERROR 且无 WARN 时返回空 text", () => {
    expect(report("/x.py", [diag({ severity: 3 }), diag({ severity: 4 })])).toMatchInlineSnapshot(`
      {
        "errorCount": 0,
        "text": "",
        "warningCount": 0,
      }
    `);
    expect(report("/x.py", [])).toMatchInlineSnapshot(`
      {
        "errorCount": 0,
        "text": "",
        "warningCount": 0,
      }
    `);
  });

  it("保留 ERROR 与 WARN，ERROR 在前，丢弃 INFO/HINT", () => {
    expect(
      report("/x.py", [
        diag({ severity: 2, message: "warn1" }),
        diag({ severity: 3, message: "info" }),
        diag({ message: "err1" }),
        diag({ message: "err2" }),
        diag({ severity: 2, message: "warn2" }),
      ]),
    ).toMatchInlineSnapshot(`
      {
        "errorCount": 2,
        "text": "<diagnostics file="/x.py">
      ERROR [1:1] err1
      ERROR [1:1] err2
      WARN [1:1] warn1
      WARN [1:1] warn2
      </diagnostics>",
        "warningCount": 2,
      }
    `);
  });

  it("severity 缺省视为 ERROR", () => {
    expect(report("/x.py", [diag({ message: "missing", severity: undefined })]))
      .toMatchInlineSnapshot(`
      {
        "errorCount": 1,
        "text": "<diagnostics file="/x.py">
      ERROR [1:1] missing
      </diagnostics>",
        "warningCount": 0,
      }
    `);
  });

  it("超过 5 条时截断，块尾按严重级别报出未列出的数量", () => {
    const result = report("/x.py", [
      ...Array.from({ length: 8 }, (_, i) => diag({ message: `err${i}` })),
      ...Array.from({ length: 4 }, (_, i) => diag({ severity: 2, message: `warn${i}` })),
    ]);
    expect(result).toMatchInlineSnapshot(`
      {
        "errorCount": 8,
        "text": "<diagnostics file="/x.py">
      ERROR [1:1] err0
      ERROR [1:1] err1
      ERROR [1:1] err2
      ERROR [1:1] err3
      ERROR [1:1] err4
      ... and 3 errors, 4 warnings
      </diagnostics>",
        "warningCount": 4,
      }
    `);
    // 快照里能看到列出的条数，这里再显式钉住「只列 ERROR、且只列 5 条」
    expect(result.text.match(/^ERROR/gm)?.length).toBe(5);
    expect(result.text.match(/^WARN/gm)).toBeNull();
  });

  it("未列出部分只有一类时省略另一类，并处理单复数", () => {
    // 6 个 ERROR：列 5 条，剩 1 条
    expect(
      report(
        "/x.py",
        Array.from({ length: 6 }, (_, i) => diag({ message: `err${i}` })),
      ).text,
    ).toMatchInlineSnapshot(`
      "<diagnostics file="/x.py">
      ERROR [1:1] err0
      ERROR [1:1] err1
      ERROR [1:1] err2
      ERROR [1:1] err3
      ERROR [1:1] err4
      ... and 1 error
      </diagnostics>"
    `);
    // 5 个 ERROR + 6 个 WARN：列满 5 条 ERROR，剩的全是 WARN
    expect(
      report("/x.py", [
        ...Array.from({ length: 5 }, (_, i) => diag({ message: `err${i}` })),
        ...Array.from({ length: 6 }, (_, i) => diag({ severity: 2, message: `warn${i}` })),
      ]).text,
    ).toMatchInlineSnapshot(`
      "<diagnostics file="/x.py">
      ERROR [1:1] err0
      ERROR [1:1] err1
      ERROR [1:1] err2
      ERROR [1:1] err3
      ERROR [1:1] err4
      ... and 6 warnings
      </diagnostics>"
    `);
  });

  it("appendLspDiagnosticText 拼接标题；无诊断时原样返回", () => {
    expect(appendLspDiagnosticText("ok", "")).toMatchInlineSnapshot(`"ok"`);
    expect(appendLspDiagnosticText("ok", "<d/>")).toMatchInlineSnapshot(`
      "ok

      LSP diagnostics detected in this file
      <d/>"
    `);
  });
});
