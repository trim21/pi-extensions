/**
 * 集成测试：原生执行器沙箱下，可写边界恒为 session 工作区（ctx.cwd），
 * Bash 的 workdir 参数只改变进程执行目录，不能把可写范围带出工作区。
 * 需要随包分发的原生执行器且环境允许嵌套 user/pid namespace，否则整组跳过。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createBwrapRuntime } from "../src/bwrap/runtime.js";
import { nativeSandboxUsable } from "./bwrap-native-probe.js";

const sandbox = nativeSandboxUsable();

beforeAll(() => {
  // Bash 输出运行时落盘到 agent-dir/tmp：测试环境指向可写的临时目录
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cc-bwrap-guard-"));
});

// 沙箱内 --ro-bind / / 使所有工作区外路径只读；/etc 恒存在，用作工作区外的执行目录。
const OUTSIDE = "/etc";

function workspaceRuntime(workspace: string) {
  const runtime = createBwrapRuntime();
  runtime.setMode(workspace, { fs: "workspace-write" });
  return runtime;
}

describe.skipIf(!sandbox)("bwrap write guard (workspace is ctx.cwd, not workdir)", () => {
  it("writes freely inside the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cc-guard-in-"));
    const runtime = workspaceRuntime(workspace);
    const result = await runtime.execute({
      toolCallId: "t1",
      command: "touch inside.txt && ls inside.txt",
      ctx: {
        cwd: workspace,
        hasUI: true,
        sessionManager: { getSessionId: () => "test-session" },
      } as never,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("inside.txt");
  });

  it("rejects writes to a workdir outside the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cc-guard-ws-"));
    const runtime = workspaceRuntime(workspace);
    const result = await runtime.execute({
      toolCallId: "t2",
      command: "touch block.txt",
      cwd: OUTSIDE,
      ctx: {
        cwd: workspace,
        hasUI: true,
        sessionManager: { getSessionId: () => "test-session" },
      } as never,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/Read-only file system|Permission denied/);
    // 工作区不受影响：沙箱外宿主文件系统里该目录确实没有写入
  });

  it("still executes in the requested workdir outside the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cc-guard-ws2-"));
    const runtime = workspaceRuntime(workspace);
    const result = await runtime.execute({
      toolCallId: "t3",
      command: "pwd",
      cwd: OUTSIDE,
      ctx: {
        cwd: workspace,
        hasUI: true,
        sessionManager: { getSessionId: () => "test-session" },
      } as never,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe(OUTSIDE);
  });
});
