/**
 * 诊断报告格式化（移植自 opencode lsp/diagnostic.ts）：只报告 ERROR
 * 级诊断，每个文件最多 20 条。
 */

import type { Diagnostic } from "./client.js";

const MAX_PER_FILE = 20;

const SEVERITY_LABELS: Record<number, string> = {
  1: "ERROR",
  2: "WARN",
  3: "INFO",
  4: "HINT",
};

export function prettyDiagnostic(diagnostic: Diagnostic): string {
  const severity = SEVERITY_LABELS[diagnostic.severity || 1] ?? "ERROR";
  const line = diagnostic.range.start.line + 1;
  const col = diagnostic.range.start.character + 1;
  // 3.18 起 message 可能是 MarkupContent（客户端未声明 markupMessageSupport 时不会出现）
  const message =
    typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value;
  return `${severity} [${line}:${col}] ${message}`;
}

/** 返回空字符串表示没有 ERROR 级诊断。 */
export function report(file: string, issues: Diagnostic[]): string {
  const errors = issues.filter((item) => item.severity === 1);
  if (errors.length === 0) return "";
  const limited = errors.slice(0, MAX_PER_FILE);
  const more = errors.length - MAX_PER_FILE;
  const suffix = more > 0 ? `\n... and ${more} more` : "";
  return `<diagnostics file="${file}">\n${limited.map((d) => prettyDiagnostic(d)).join("\n")}${suffix}\n</diagnostics>`;
}
