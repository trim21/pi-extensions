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

/** 单个文件的诊断报告；计数覆盖该文件全部 ERROR / WARN，不受每文件上限影响。 */
export interface DiagnosticReport {
  /** 空字符串表示没有 ERROR / WARN。 */
  text: string;
  errorCount: number;
  warningCount: number;
}

export const EMPTY_DIAGNOSTIC_REPORT: DiagnosticReport = {
  text: "",
  errorCount: 0,
  warningCount: 0,
};

export function prettyDiagnostic(diagnostic: Diagnostic): string {
  const severity = SEVERITY_LABELS[severityOf(diagnostic)] ?? "ERROR";
  const line = diagnostic.range.start.line + 1;
  const col = diagnostic.range.start.character + 1;
  // 3.18 起 message 可能是 MarkupContent（客户端未声明 markupMessageSupport 时不会出现）
  const message =
    typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value;
  return `${severity} [${line}:${col}] ${message}`;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** 未列出部分的构成：`3 errors, 4 warnings`（为 0 的一类省略；单复数按数量）。 */
function hiddenSummary(hidden: Diagnostic[]): string {
  const errors = hidden.filter((item) => severityOf(item) === 1).length;
  const warnings = hidden.length - errors;
  return [
    ...(errors > 0 ? [pluralize(errors, "error")] : []),
    ...(warnings > 0 ? [pluralize(warnings, "warning")] : []),
  ].join(", ");
}

/** 返回空 text 表示没有 ERROR / WARN。ERROR 在前，WARN 在后，超出上限的部分只报数量。 */
export function report(file: string, issues: Diagnostic[]): DiagnosticReport {
  const errors = issues.filter((item) => severityOf(item) === 1);
  const warnings = issues.filter((item) => item.severity === 2);
  const relevant = [...errors, ...warnings];
  if (relevant.length === 0) {
    return EMPTY_DIAGNOSTIC_REPORT;
  }
  const limited = relevant.slice(0, MAX_PER_FILE);
  const hidden = relevant.slice(MAX_PER_FILE);
  const suffix = hidden.length > 0 ? `\n... and ${hiddenSummary(hidden)}` : "";
  return {
    text: `<diagnostics file="${file}">\n${limited.map((d) => prettyDiagnostic(d)).join("\n")}${suffix}\n</diagnostics>`,
    errorCount: errors.length,
    warningCount: warnings.length,
  };
}

/** 把 LSP 诊断块接到工具成功文案后面；无诊断时原样返回。 */
export function appendLspDiagnosticText(message: string, diagnosticText: string): string {
  if (diagnosticText === "") {
    return message;
  }
  return `${message}\n\nLSP diagnostics detected in this file\n${diagnosticText}`;
}
