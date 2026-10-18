/**
 * 订阅失败降级为快照轮询测试（watcher.ts）：
 * - subscribe 抛 ENOSPC 时改用 getEventsSince + writeSnapshot 继续投递事件
 * - onDegraded 只提示一次，不触发 onError
 * - stop 后不再回调并删除快照文件
 * - 未配置 pollingIntervalMs 时保持原有 onError 行为
 */
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type FileChange, watchWorkspace } from "../src/lib/lsp/watcher.js";

vi.mock("@parcel/watcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@parcel/watcher")>();
  return {
    ...actual,
    subscribe: vi.fn(async () => {
      throw new Error("inotify_add_watch failed: No space left on device");
    }),
  };
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(50);
  }
  throw new Error("waitFor timed out");
}

function snapshotPathFor(dir: string): string {
  const hash = createHash("sha1").update(dir).digest("hex");
  return join(tmpdir(), "pi-lsp-watch", `${hash}-${process.pid}.snapshot`);
}

describe("workspace watcher polling fallback", () => {
  it("ENOSPC 后改用轮询继续投递 created / changed / deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-poll-"));
    const file = join(dir, "a.txt");
    const batches: FileChange[][] = [];
    const degraded: string[] = [];
    const errors: string[] = [];
    const watcher = await watchWorkspace(
      dir,
      (batch) => {
        batches.push(batch);
      },
      {
        debounceMs: 50,
        flushMs: 200,
        pollingIntervalMs: 100,
        onDegraded: (message) => {
          degraded.push(message);
        },
        onError: (message) => {
          errors.push(message);
        },
      },
    );
    try {
      await waitFor(() => degraded.length === 1);
      const snapshot = snapshotPathFor(dir);
      await access(snapshot);

      await writeFile(file, "x");
      await waitFor(() => batches.flat().some((c) => c.path === file && c.type === "created"));

      await writeFile(file, "y");
      await waitFor(() => batches.flat().some((c) => c.path === file && c.type === "changed"));

      await unlink(file);
      await waitFor(() => batches.flat().some((c) => c.path === file && c.type === "deleted"));

      expect(errors).toEqual([]);
      expect(degraded).toHaveLength(1);
      expect(degraded[0]).toContain("polling");

      await watcher.stop();
      await expect(access(snapshot)).rejects.toThrow();
    } finally {
      await watcher.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("未配置 pollingIntervalMs 时不降级，走 onError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lsp-watcher-poll-"));
    const errors: string[] = [];
    const degraded: string[] = [];
    const watcher = await watchWorkspace(dir, () => {}, {
      onDegraded: (message) => {
        degraded.push(message);
      },
      onError: (message) => {
        errors.push(message);
      },
    });
    try {
      await waitFor(() => errors.length === 1);
      expect(errors[0]).toContain("No space left on device");
      expect(degraded).toEqual([]);
    } finally {
      await watcher.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
