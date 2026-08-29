/**
 * 诊断报告格式化：报告 ERROR 与 WARN，每个文件最多 5 条。
 */

import type { Diagnostic } from "./client.js";

const MAX_PER_FILE = 5;

const SEVERITY_LABELS: Record<number, string> = {
  1: "ERROR",
  2: "WARN",
  3: "INFO",
  4: "HINT",
};

function severityOf(diagnostic: Diagnostic): number {
  return diagnostic.severity ?? 1;
}

export function prettyDiagnostic(diagnostic: Diagnostic): string {
  const severity = SEVERITY_LABELS[severityOf(diagnostic)] ?? "ERROR";
  const line = diagnostic.range.start.line + 1;
  const col = diagnostic.range.start.character + 1;
  // 3.18 起 message 可能是 MarkupContent（客户端未声明 markupMessageSupport 时不会出现）
  const message =
    typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value;
  return `${severity} [${line}:${col}] ${message}`;
}

/** 返回空字符串表示没有 ERROR / WARN。ERROR 在前，WARN 在后。 */
export function report(file: string, issues: Diagnostic[]): string {
  const errors = issues.filter((item) => severityOf(item) === 1);
  const warnings = issues.filter((item) => item.severity === 2);
  const relevant = [...errors, ...warnings];
  if (relevant.length === 0) return "";
  const limited = relevant.slice(0, MAX_PER_FILE);
  const more = relevant.length - MAX_PER_FILE;
  const suffix = more > 0 ? `\n... and ${more} more` : "";
  return `<diagnostics file="${file}">\n${limited.map((d) => prettyDiagnostic(d)).join("\n")}${suffix}\n</diagnostics>`;
}

/** 把 LSP 诊断块接到工具成功文案后面；无诊断时原样返回。 */
export function appendLspDiagnosticText(
  message: string,
  diagnosticText: string,
  errorCount: number,
): string {
  if (!diagnosticText) return message;
  const kind = errorCount > 0 ? "errors" : "warnings";
  return `${message}\n\nLSP ${kind} detected in this file:\n${diagnosticText}`;
}
