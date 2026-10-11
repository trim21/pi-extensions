import { type ChildProcess, spawn } from "node:child_process";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { childHasExited, forEachLine, killChild, waitForChildExit } from "../src/lib/proc.js";

describe("forEachLine", () => {
  it("行跨多个 chunk 时正确拼接", async () => {
    const lines: string[] = [];
    const stream = Readable.from(["Tun adapter ", "listening at: X\n", "next line\n"]);
    await forEachLine(stream, (line) => {
      lines.push(line);
    });
    expect(lines).toEqual(["Tun adapter listening at: X", "next line"]);
  });

  it("单个 chunk 含多行", async () => {
    const lines: string[] = [];
    const stream = Readable.from(["a\nb\nc\n"]);
    await forEachLine(stream, (line) => {
      lines.push(line);
    });
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("末尾无换行的行不回调", async () => {
    const lines: string[] = [];
    const stream = Readable.from(["partial line"]);
    await forEachLine(stream, (line) => {
      lines.push(line);
    });
    expect(lines).toEqual([]);
  });

  it("回调返回 false 时提前停止消费", async () => {
    const lines: string[] = [];
    const stream = Readable.from(["a\n", "b\n", "c\n"]);
    await forEachLine(stream, (line) => {
      lines.push(line);
      return line !== "a";
    });
    expect(lines).toEqual(["a"]);
  });
});

/** 起一个长命子进程（用 node 自身，不依赖 sleep 之类的外部命令）。 */
function spawnIdle(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) {
    return;
  }
  await new Promise((resolve) => child.once("exit", resolve));
}

describe("killChild", () => {
  it("向存活的子进程发信号并使其退出", async () => {
    const child = spawnIdle();
    try {
      expect(childHasExited(child)).toBe(false);
      expect(killChild(child)).toBe(true);
      await waitForExit(child);
      expect(childHasExited(child)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("子进程已退出后不再发信号", async () => {
    const child = spawnIdle();
    child.kill("SIGKILL");
    await waitForExit(child);
    const kill = vi.spyOn(child, "kill");
    try {
      expect(killChild(child, "SIGKILL")).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});

describe("waitForChildExit", () => {
  it("已结束的子进程立即返回 true", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await waitForExit(child);
    expect(await waitForChildExit(child, 1000)).toBe(true);
  });

  it("仍在运行的子进程超时后返回 false", async () => {
    const child = spawnIdle();
    try {
      expect(await waitForChildExit(child, 100)).toBe(false);
    } finally {
      killChild(child, "SIGKILL");
      await waitForExit(child);
    }
  });

  it("等待期间退出的子进程返回 true", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { stdio: "ignore" });
    expect(await waitForChildExit(child, 5000)).toBe(true);
  });
});
