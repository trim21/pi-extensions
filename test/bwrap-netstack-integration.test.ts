/**
 * 原生执行器 host 集成测试：通过 TS 公开接口（runSandboxCommand / runInSandbox）
 * 驱动 `bin/native/<arch>/sandbox`，验证网络 allowlist 放行 / 拒绝、超时终止与清理。
 *
 * 需要真实的 bwrap / mihomo / slirp4netns 与可出网的 DNS，常规 CI 不满足；
 * 用 RUN_NETSTACK_INTEGRATION=1 手动运行。执行器通过 PI_SANDBOX_BINARY 指向构建产物
 * （未设置时用随包分发的 bin/native，缺失则整组跳过）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { resolveSandboxBinary, TimeoutError } from "../src/bwrap/executor.js";
import { loadSandboxConfig, runInSandbox, runSandboxCommand } from "../src/bwrap/sandbox.js";

const enabled = process.env.RUN_NETSTACK_INTEGRATION === "1";

function executorUsable(): boolean {
  try {
    resolveSandboxBinary();
    return true;
  } catch {
    return false;
  }
}

/** 一个只读工作区 + 指定 allowlist 的 limited 配置。 */
function limitedWorkspace(allowlist: string[]): { workspace: string; configPath: string } {
  const workspace = mkdtempSync(join(tmpdir(), "bwrap-netstack-"));
  const configPath = join(workspace, "sandbox.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({ fs: { mode: "workspace-write" }, network: { mode: "limited", allowlist } })}\n`,
  );
  return { workspace, configPath };
}

interface RunOutcome {
  exitCode: number | null;
  output: string;
  error: Error | undefined;
}

async function runLimited(
  allowlist: string[],
  command: string,
  timeout?: number,
): Promise<RunOutcome> {
  const { workspace, configPath } = limitedWorkspace(allowlist);
  let output = "";
  try {
    const result = await runSandboxCommand({
      workspace,
      configPath,
      command,
      onData: (data) => {
        output += data.toString();
      },
      ...(timeout !== undefined && { timeout }),
    });
    return {
      exitCode: result.exitCode,
      output,
      error: undefined,
    };
  } catch (error) {
    return {
      exitCode: null,
      output,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** 宿主上名字匹配 `name` 的进程数（执行器必须在退出前清掉自己的网络栈进程）。 */
function processCount(name: string): number {
  const result = spawnSync("pgrep", ["-x", name], { encoding: "utf8" });
  return result.stdout.trim() === "" ? 0 : result.stdout.trim().split("\n").length;
}

async function bwrapSandboxLogs(): Promise<string[]> {
  try {
    return readdirSync(join(getAgentDir(), "tmp")).filter((name) =>
      name.startsWith("bwrap-sandbox-"),
    );
  } catch {
    return [];
  }
}

describe.skipIf(!enabled || !executorUsable())("native sandbox integration", () => {
  it("allowlist 域名可直连，非 allowlist 在 DNS 层被拒", async () => {
    const allowed = await runLimited(["pypi.org"], "getent ahostsv4 pypi.org | head -1");
    expect(allowed.exitCode).toBe(0);
    expect(allowed.output).toMatch(/^198\.18\./);

    const http = await runLimited(
      ["pypi.org", "files.pythonhosted.org"],
      "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://pypi.org/simple/",
    );
    expect(http.output).toContain("200");

    // 未允许域名在 DNS 层被拒（不在 fake-ip 白名单里 → 落到 rcode://name_error）
    const denied = await runLimited(
      ["pypi.org"],
      "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com",
    );
    expect(denied.output).toMatch(/Could not resolve host|Temporary failure in name resolution/);

    // 宿主 resolv.conf 指向 loopback stub 时靠栈内监听处理，沙箱内文件保持原样
    const hostResolv = readFileSync("/etc/resolv.conf", "utf8");
    const sandboxResolv = await runLimited(["pypi.org"], "cat /etc/resolv.conf");
    expect(sandboxResolv.exitCode).toBe(0);
    expect(sandboxResolv.output).toBe(hostResolv);
  }, 120000);

  it("超时由执行器终止并以 TimeoutError 结束，且不残留网络栈进程", async () => {
    const mihomoBefore = processCount("mihomo");
    const slirpBefore = processCount("slirp4netns");
    const startedAt = Date.now();

    const outcome = await runLimited([], "sleep 30", 3);
    expect(outcome.error).toBeInstanceOf(TimeoutError);
    // 执行器内部超时兜底：命令 30s 未结束，3s 到点即终止
    expect(Date.now() - startedAt).toBeLessThan(20000);

    expect(processCount("mihomo")).toBe(mihomoBefore);
    expect(processCount("slirp4netns")).toBe(slirpBefore);
  }, 120000);

  it("正常结束不落盘诊断日志", async () => {
    const before = await bwrapSandboxLogs();
    const outcome = await runLimited([], "printf done");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("done");
    expect(await bwrapSandboxLogs()).toEqual(before);
  }, 120000);

  it("block 模式不建栈，命令在断网沙箱里执行", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bwrap-netstack-block-"));
    const configPath = join(workspace, "sandbox.json");
    writeFileSync(
      configPath,
      `${JSON.stringify({ fs: { mode: "workspace-write" }, network: { mode: "block" } })}\n`,
    );
    let output = "";
    const result = await runInSandbox(loadSandboxConfig({ workspace, configPath }), {
      workspace,
      command: "printf blocked",
      onData: (data) => {
        output += data.toString();
      },
    });
    expect(result.exitCode).toBe(0);
    expect(output).toContain("blocked");
  }, 60000);
});
