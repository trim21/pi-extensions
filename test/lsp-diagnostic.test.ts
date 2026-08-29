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
    expect(prettyDiagnostic(diag())).toBe("ERROR [1:1] boom");
    expect(prettyDiagnostic(diag({ severity: 2 }))).toBe("WARN [1:1] boom");
    expect(
      prettyDiagnostic(
        diag({ range: { start: { line: 3, character: 5 }, end: { line: 3, character: 9 } } }),
      ),
    ).toBe("ERROR [4:6] boom");
  });

  it("无 ERROR 且无 WARN 时返回空串", () => {
    expect(report("/x.py", [diag({ severity: 3 }), diag({ severity: 4 })])).toBe("");
    expect(report("/x.py", [])).toBe("");
  });

  it("保留 ERROR 与 WARN，ERROR 在前，丢弃 INFO/HINT", () => {
    const text = report("/x.py", [
      diag({ severity: 2, message: "warn1" }),
      diag({ severity: 3, message: "info" }),
      diag({ message: "err1" }),
      diag({ message: "err2" }),
      diag({ severity: 2, message: "warn2" }),
    ]);
    expect(text).toBe(
      '<diagnostics file="/x.py">\nERROR [1:1] err1\nERROR [1:1] err2\nWARN [1:1] warn1\nWARN [1:1] warn2\n</diagnostics>',
    );
  });

  it("severity 缺省视为 ERROR", () => {
    expect(report("/x.py", [diag({ message: "missing", severity: undefined })])).toBe(
      '<diagnostics file="/x.py">\nERROR [1:1] missing\n</diagnostics>',
    );
  });

  it("超过 5 条时截断并提示 more", () => {
    const many = [
      ...Array.from({ length: 8 }, (_, i) => diag({ message: `err${i}` })),
      ...Array.from({ length: 4 }, (_, i) => diag({ severity: 2, message: `warn${i}` })),
    ];
    const text = report("/x.py", many);
    expect(text).toContain("... and 7 more");
    expect(text.match(/^ERROR/gm)?.length).toBe(5);
    expect(text.match(/^WARN/gm)).toBeNull();
  });

  it("appendLspDiagnosticText 按错误数量选择标题", () => {
    expect(appendLspDiagnosticText("ok", "", 0)).toBe("ok");
    expect(appendLspDiagnosticText("ok", "<d/>", 2)).toBe(
      "ok\n\nLSP errors detected in this file:\n<d/>",
    );
    expect(appendLspDiagnosticText("ok", "<d/>", 0)).toBe(
      "ok\n\nLSP warnings detected in this file:\n<d/>",
    );
  });
});
