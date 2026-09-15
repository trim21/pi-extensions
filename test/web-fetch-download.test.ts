/**
 * Tests for web_fetch 的落盘模式（src/web/fetch.ts 的 saveUrlToFile）：
 * GitHub 用户附件、release 资产这类二进制只能原样写文件，所以这里验证
 * 字节不被改写、缺目录会建、重定向逐跳复检 SSRF、失败不留半截文件，
 * 以及请求是从代理层发出去的（不是全局 fetch —— 那正是沙箱里下不动的原因）。
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));

// 代理层替身：所有出口请求都记在这里，测试不依赖开发机的 ~/.pi/agent/proxy.json。
const { proxyFetch } = vi.hoisted(() => ({ proxyFetch: vi.fn() }));
vi.mock("../src/lib/proxy.js", () => ({
  createHttpProxy: () => ({ settings: {}, env: {}, fetch: proxyFetch }),
}));

import { saveUrlToFile } from "../src/web/fetch.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 依次给出预置响应，并记录每次被请求的地址。 */
function respond(...responses: Response[]): void {
  let call = 0;
  proxyFetch.mockImplementation(async () => responses[Math.min(call++, responses.length - 1)]);
}

describe("saveUrlToFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "web-fetch-download-"));
    lookup.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
  });

  afterEach(async () => {
    proxyFetch.mockReset();
    lookup.mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the body verbatim and reports its type and size", async () => {
    const bytes = new Uint8Array([0x00, 0x89, 0x50, 0xff, 0x0a, 0xc3, 0xa9]);
    respond(
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const target = join(dir, "shot.png");

    const file = await saveUrlToFile("https://github.com/user-attachments/assets/abc", target);

    expect(await readFile(target)).toEqual(Buffer.from(bytes));
    expect(file).toEqual({
      url: "https://github.com/user-attachments/assets/abc",
      filePath: target,
      contentType: "image/png",
      bytes: bytes.byteLength,
    });
  });

  it("creates the missing parent directories", async () => {
    respond(new Response("stack", { status: 200, headers: { "content-type": "text/plain" } }));
    const target = join(dir, "a", "b", "stacktrace.txt");

    await saveUrlToFile("https://example.com/x.txt", target);

    expect(await readFile(target, "utf8")).toBe("stack");
  });

  it("follows redirects through the proxy, re-validating every hop", async () => {
    lookup
      .mockResolvedValueOnce([{ address: "1.2.3.4", family: 4 }])
      .mockResolvedValueOnce([{ address: "5.6.7.8", family: 4 }]);
    respond(
      new Response(null, {
        status: 302,
        headers: { location: "https://objects.githubusercontent.com/blob/1" },
      }),
      new Response("signed-body", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const target = join(dir, "stack.txt");

    const file = await saveUrlToFile(
      "https://github.com/user-attachments/files/21942216/stacktrace-psycopg.txt",
      target,
    );

    expect(await readFile(target, "utf8")).toBe("signed-body");
    expect(file.url).toBe("https://objects.githubusercontent.com/blob/1");
    expect(proxyFetch).toHaveBeenCalledTimes(2);
    expect(String(proxyFetch.mock.calls[1]?.[0])).toBe(
      "https://objects.githubusercontent.com/blob/1",
    );
    // 每一跳都重新解析、重新判定，不做「首跳安全则全程安全」的假设。
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("blocks a redirect target that resolves to a private address", async () => {
    lookup
      .mockResolvedValueOnce([{ address: "1.2.3.4", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    respond(
      new Response(null, {
        status: 302,
        headers: { location: "https://metadata.internal/latest" },
      }),
    );

    await expect(saveUrlToFile("https://example.com/redirect", join(dir, "evil"))).rejects.toThrow(
      "内网地址",
    );
    expect(await exists(join(dir, "evil"))).toBe(false);
  });

  it("rejects a non-2xx response without creating the file", async () => {
    respond(new Response("nope", { status: 404 }));
    const target = join(dir, "missing.txt");

    await expect(saveUrlToFile("https://example.com/gone", target)).rejects.toThrow("HTTP 404");
    expect(await exists(target)).toBe(false);
  });

  it("deletes the partial file when the stream fails midway", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("connection reset"));
      },
    });
    respond(new Response(stream, { status: 200, headers: { "content-type": "image/png" } }));
    const target = join(dir, "partial.png");

    await expect(saveUrlToFile("https://example.com/streaming.png", target)).rejects.toThrow(
      "connection reset",
    );
    // 半截文件比下载失败更危险：它看起来是个完整的 png。
    expect(await exists(target)).toBe(false);
  });
});
