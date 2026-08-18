import { describe, expect, it } from "vitest";

import type { Diagnostic } from "../src/lib/lsp/client.js";
import { prettyDiagnostic, report } from "../src/lib/lsp/diagnostic.js";

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

  it("无 ERROR 时返回空串", () => {
    expect(report("/x.py", [diag({ severity: 2 }), diag({ severity: 3 })])).toBe("");
    expect(report("/x.py", [])).toBe("");
  });

  it("只保留 ERROR 并按格式输出", () => {
    const text = report("/x.py", [
      diag({ severity: 2 }),
      diag({ message: "err1" }),
      diag({ message: "err2" }),
    ]);
    expect(text).toBe(
      '<diagnostics file="/x.py">\nERROR [1:1] err1\nERROR [1:1] err2\n</diagnostics>',
    );
  });

  it("超过 20 条时截断并提示 more", () => {
    const many = Array.from({ length: 25 }, (_, i) => diag({ message: `err${i}` }));
    const text = report("/x.py", many);
    expect(text).toContain("... and 5 more");
    expect(text.match(/^ERROR/gm)?.length).toBe(20);
  });
});
