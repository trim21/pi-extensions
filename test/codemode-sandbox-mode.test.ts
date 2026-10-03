/**
 * 拿不到 bwrap 时的行为（sandbox.ts 的 `resolveMode` / `approveUnsandboxed` 路径）：
 * 必须拿到用户授权才以普通子进程执行，否则拒绝执行——不能静默降级成无沙箱。
 *
 * 用例直接把 sandbox 视图标成 `bwrapUnavailable: true` 并配 fs/network 需要沙箱的配置，
 * 因此不依赖真实 bwrap，任何平台都能跑。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveBwrap } from "../src/bwrap/core.js";
import { createCodemodeSandbox, type SandboxView } from "../src/codemode/sandbox.js";

/** 需要沙箱的配置（fs 不是 allow-all），配 `bwrapUnavailable: true` 即「拿不到 bwrap」。 */
function unavailableView(): SandboxView {
  return {
    resolved: resolveBwrap({
      fs: {
        mode: "workspace-write",
        writablePaths: ["."],
        extraWritablePaths: [],
        denyPaths: [],
      },
      network: { mode: "block", allowlist: [] },
      extraArgs: [],
    }),
    bwrapUnavailable: true,
  };
}

async function run(
  view: SandboxView,
  overrides: Partial<Parameters<ReturnType<typeof createCodemodeSandbox>["run"]>[0]> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "codemode-nobwrap-"));
  return await createCodemodeSandbox().run({
    code: "return 40 + 2;",
    tools: [],
    store: {},
    workspace: dir,
    sandbox: view,
    onCall: async () => ({ ok: true, value: null }),
    ...overrides,
  });
}

describe("拿不到 bwrap 时", () => {
  it("没有授权路径：脚本不执行，结果说明原因", async () => {
    const result = await run(unavailableView());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("sandbox");
      expect(result.error.message).toContain("bwrap (bubblewrap) is not available");
    }
    expect(result.calls).toEqual([]);
  });

  it("用户拒绝授权：脚本不执行", async () => {
    const approve = vi.fn(async () => false);
    const result = await run(unavailableView(), { approveUnsandboxed: approve });

    expect(approve).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("sandbox");
    }
  });

  it("用户授权后以普通子进程执行（脚本真的跑起来）", async () => {
    const approve = vi.fn(async () => true);
    const result = await run(unavailableView(), {
      approveUnsandboxed: approve,
      code: `return { argv: process.execPath.length > 0, cwd: process.cwd() };`,
    });

    expect(approve).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ argv: true });
    }
  });

  it("配置本身就允许全权限（fs 与 network 都 allow-all）：不需要授权，也不进沙箱", async () => {
    const approve = vi.fn(async () => true);
    const view: SandboxView = {
      resolved: resolveBwrap({
        fs: {
          mode: "allow-all",
          writablePaths: ["."],
          extraWritablePaths: [],
          denyPaths: [],
        },
        network: { mode: "allow-all", allowlist: [] },
        extraArgs: [],
      }),
      // 即便标成不可用也一样：这种配置本来就不需要沙箱
      bwrapUnavailable: true,
    };

    const result = await run(view, { approveUnsandboxed: approve });

    expect(approve).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it("用户思考很久也不计入执行上限（上限从子进程起好之后开始算）", async () => {
    const approve = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    });
    const result = await run(unavailableView(), {
      approveUnsandboxed: approve,
      // 上限远小于用户批准所花的时间：若把批准算进去，脚本必然超时
      timeoutMs: 200,
      code: `return "approved then ran";`,
    });

    expect(approve).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("approved then ran");
    }
  });

  it("已中止的调用直接以 aborted 结束，不起进程", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(unavailableView(), {
      approveUnsandboxed: async () => true,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });
});
