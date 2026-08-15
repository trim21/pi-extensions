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

/** dcg 扫描结果：正常判定 / 未安装（静默跳过）/ 扫描失败（应提示用户）。 */
export type DcgScanOutcome =
  | { kind: "suggestion"; suggestion: DcgSuggestion }
  | { kind: "not-installed" }
  | { kind: "failed"; detail: string };

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
 * 对命令做 dcg 扫描。返回三种结果：
 * - `suggestion`：正常判定，携带建议文本
 * - `not-installed`：dcg 未安装（调用方静默跳过）
 * - `failed`：dcg 已安装但扫描失败（退出码异常/超时/输出不可解析），
 *   调用方应通过 `ui.notify` 提示用户
 */
export async function dcgSuggestion(command: string): Promise<DcgScanOutcome> {
  let stdout: string;
  try {
    stdout = await runDcgScan(command);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not-installed" };
    return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  }

  let output: DcgTestOutput;
  try {
    output = JSON.parse(stdout) as DcgTestOutput;
  } catch {
    return { kind: "failed", detail: "无法解析 dcg 输出" };
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
      kind: "suggestion",
      suggestion: {
        kind: "danger",
        text: `dcg 建议拦截: ${reason}${details ? ` (${details})` : ""}`,
      },
    };
  }
  if (output.decision === "allow") {
    return {
      kind: "suggestion",
      suggestion: { kind: "clean", text: "dcg 未检测到破坏性命令模式" },
    };
  }
  // indeterminate / 缺字段：dcg 未能给出可用判定
  return {
    kind: "failed",
    detail: `dcg 未返回可用判定 (decision=${output.decision ?? "missing"})`,
  };
}

function runDcgScan(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("dcg", ["test", "--stdin", "--format", "json"], {
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
      // dcg 的退出码是决策结果（deny 时非 0），不是失败标志：只要 stdout
      // 有内容就交给上层解析；真正出错时（参数错误等）stdout 为空。
      if (code === 0 || stdout.length > 0) settle();
      else settle(new Error(`dcg exited with code ${String(code)}`));
    });
    proc.stdin.end(command);
  });
}
