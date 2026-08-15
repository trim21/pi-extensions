/**
 * dcg-scan —— 可选的 dcg（Destructive Command Guard）扫描建议层。
 *
 * 系统安装了 dcg 时，在 full-access 人工审批弹窗里附加一段破坏性命令
 * 扫描建议，作为人工 review 的参考；dcg 未安装、调用失败或超时时静默
 * 跳过，不影响审批流程。dcg 输出只作建议文本，不参与任何执行决策。
 */
import { spawn } from "node:child_process";

/** `dcg test --format json` 输出中我们关心的字段。 */
interface DcgTestOutput {
  decision?: "allow" | "deny" | "indeterminate";
  severity?: "critical" | "high" | "medium" | "low";
  rule_id?: string;
  reason?: string;
}

/** dcg 扫描建议（纯文本，外部字段已转义，可直接拼进弹窗 description）。 */
export interface DcgSuggestion {
  kind: "danger" | "clean";
  text: string;
}

/** dcg 扫描的超时预算：超时视为无建议，不让审批弹窗被拖住。 */
const DCG_SCAN_TIMEOUT_MS = 2000;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 对命令做 dcg 扫描，返回建议文本；任何失败（未安装/退出码非 0/超时/
 * 输出不可解析）都返回 undefined，调用方按"无建议"处理。
 */
export async function dcgSuggestion(command: string): Promise<DcgSuggestion | undefined> {
  let stdout: string;
  try {
    stdout = await runDcgScan(command);
  } catch {
    return undefined;
  }

  let output: DcgTestOutput;
  try {
    output = JSON.parse(stdout) as DcgTestOutput;
  } catch {
    return undefined;
  }

  if (output.decision === "deny") {
    const details = [
      output.rule_id ? `rule: ${escapeHtml(output.rule_id)}` : undefined,
      output.severity ? `severity: ${escapeHtml(output.severity)}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const reason = output.reason ? escapeHtml(output.reason) : "检测到破坏性命令模式";
    return {
      kind: "danger",
      text: `⚡ dcg 建议拦截: ${reason}${details ? ` (${details})` : ""}`,
    };
  }
  if (output.decision === "allow") {
    return { kind: "clean", text: "✅ dcg 未检测到破坏性命令模式" };
  }
  // indeterminate / 缺字段：没有可用的建议
  return undefined;
}

function runDcgScan(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("dcg", ["test", "--stdin", "--format", "json", "--dialect", "posix"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const timeoutId = setTimeout(() => {
      proc.kill("SIGKILL");
      settle(new Error("dcg scan timed out"));
    }, DCG_SCAN_TIMEOUT_MS);
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (error) reject(error);
      else resolve(stdout);
    };
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.on("error", (error: NodeJS.ErrnoException) => {
      // ENOENT = dcg 未安装：静默跳过
      settle(error);
    });
    proc.on("close", (code) => {
      if (code === 0) settle();
      else settle(new Error(`dcg exited with code ${String(code)}`));
    });
    proc.stdin.end(command);
  });
}
