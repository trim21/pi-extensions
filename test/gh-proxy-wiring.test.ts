/**
 * Regression test for the wiring between the gh CLI child processes and the
 * proxy config: runGh must hand the resolved proxy variables to `gh`. The proxy
 * layer is mocked so the assertions do not depend on the developer's
 * ~/.pi/agent/gh.json.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("../src/lib/gh-proxy.js", () => ({
  createGhProxy: () => ({
    load: () => Promise.resolve({ settings: { proxy: "http://config:7890" } }),
    env: () => Promise.resolve({ HTTPS_PROXY: "http://config:7890" }),
    fetch: globalThis.fetch,
  }),
}));

import { runGh } from "../src/gh-readonly.js";

/** Fake gh child process that exits on demand (see run-gh-timeout.test.ts). */
class FakeChildProcess extends EventEmitter {
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    this.killed = true;
    this.emit("close", null);
    return true;
  }

  exit(code: number): void {
    this.emit("close", code);
  }
}

let fakeProc: FakeChildProcess;

afterEach(() => {
  spawnMock.mockClear();
});

function childEnv(call = 0): NodeJS.ProcessEnv {
  return (spawnMock.mock.calls[call]?.[2] as { env: NodeJS.ProcessEnv }).env;
}

describe("runGh proxy env", () => {
  it("passes the configured proxy variables to the gh child process", async () => {
    fakeProc = new FakeChildProcess();
    spawnMock.mockReturnValue(fakeProc);

    // runGh 先解析代理配置再 spawn，所以要等进程真的起来才能发假事件
    const promise = runGh(["api", "user"], {});
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalled();
    });
    fakeProc.exit(0);
    await promise;

    expect(childEnv().HTTPS_PROXY).toBe("http://config:7890");
    expect(childEnv().GH_PAGER).toBe("cat");
  });

  it("lets the caller override the proxy variables", async () => {
    fakeProc = new FakeChildProcess();
    spawnMock.mockReturnValue(fakeProc);

    const promise = runGh(["api", "user"], { env: { HTTPS_PROXY: "http://caller:1" } });
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalled();
    });
    fakeProc.exit(0);
    await promise;

    expect(childEnv().HTTPS_PROXY).toBe("http://caller:1");
  });
});
