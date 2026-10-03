/**
 * codemode 的帧协议（src/codemode/protocol.ts）：分帧、重新同步与校验。
 * 子进程侧的同一套逻辑在 src/codemode/bootstrap.ts 里，两边必须能互通（真实互通由
 * test/codemode.test.ts 的沙箱用例覆盖，这里覆盖解析器自身的边界）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  CHILD_FRAME_FD,
  CHILD_FRAME_MAGIC,
  createFrameDecoder,
  decodeChildMessage,
  encodeFrame,
  type HostMessage,
} from "../src/codemode/protocol.js";

function decoder() {
  const frames: unknown[] = [];
  const stray: string[] = [];
  const invalid: string[] = [];
  const parse = createFrameDecoder({
    onFrame: (frame) => {
      frames.push(frame);
    },
    onStray: (text) => {
      stray.push(text);
    },
    onInvalid: (reason) => {
      invalid.push(reason);
    },
  });
  return { parse, frames, stray, invalid };
}

describe("帧编码", () => {
  it("magic + 字节长度 + 冒号 + JSON 文本", () => {
    const encoded = encodeFrame({ t: "ready" });

    expect(encoded.startsWith(CHILD_FRAME_MAGIC)).toBe(true);
    const body = JSON.stringify({ t: "ready" });
    expect(encoded).toBe(`${CHILD_FRAME_MAGIC}${Buffer.byteLength(body, "utf8")}:${body}`);
  });

  it("长度按 UTF-8 字节数算（不能按字符数）", () => {
    const frame: HostMessage = { t: "result", id: 1, ok: true, value: "中文" };
    const encoded = encodeFrame(frame);
    const header = encoded.slice(CHILD_FRAME_MAGIC.length).split(":", 1)[0];

    expect(Number(header)).toBe(Buffer.byteLength(JSON.stringify(frame), "utf8"));
  });

  it("协议 fd 是 3（stdin/stdout/stderr 之外的通道）", () => {
    expect(CHILD_FRAME_FD).toBe(3);
  });
});

describe("帧解析", () => {
  it("一次喂入多帧与任意切分都能解析", () => {
    const first = encodeFrame({ t: "call", id: 1, name: "Read", args: { a: 1 } });
    const second = encodeFrame({ t: "done", ok: true, writes: { set: {}, delete: [] } });
    const stream = Buffer.from(first + second, "utf8");

    for (const size of [1, 3, 7, 64, stream.length]) {
      const { parse, frames, stray } = decoder();
      for (let at = 0; at < stream.length; at += size) {
        parse.push(stream.subarray(at, at + size));
      }
      expect(frames).toEqual([
        { t: "call", id: 1, name: "Read", args: { a: 1 } },
        { t: "done", ok: true, writes: { set: {}, delete: [] } },
      ]);
      expect(stray).toEqual([]);
    }
  });

  it("magic 之前的杂散字节当脚本输出报出去，随后重新同步", () => {
    const { parse, frames, stray } = decoder();
    parse.push(Buffer.from("library noise\n", "utf8"));
    parse.push(Buffer.from(encodeFrame({ t: "ready" }), "utf8"));
    parse.push(Buffer.from("more noise", "utf8"));
    parse.finish();

    expect(stray.join("")).toBe("library noise\nmore noise");
    expect(frames).toEqual([{ t: "ready" }]);
  });

  it("帧体不是 JSON 时报告 invalid，并继续解析后续帧", () => {
    const { parse, frames, invalid } = decoder();
    const bad = Buffer.from(`${CHILD_FRAME_MAGIC}3:not`, "utf8");
    parse.push(Buffer.concat([bad, Buffer.from(encodeFrame({ t: "ready" }), "utf8")]));

    expect(invalid[0]).toContain("not JSON");
    expect(frames).toEqual([{ t: "ready" }]);
  });

  it("长度前缀不是数字时报告 invalid", () => {
    const { parse, invalid } = decoder();
    parse.push(Buffer.from(`${CHILD_FRAME_MAGIC}abc:{}`, "utf8"));

    expect(invalid[0]).toContain("not a number");
  });

  it("流结束时残留半帧会被报告", () => {
    const { parse, invalid } = decoder();
    parse.push(Buffer.from(`${CHILD_FRAME_MAGIC}100:{"t":`, "utf8"));
    parse.finish();

    expect(invalid[0]).toContain("ended mid-frame");
  });

  it("magic 跨 chunk 切开也能识别", () => {
    const { parse, frames, stray } = decoder();
    const encoded = Buffer.from(encodeFrame({ t: "ready" }), "utf8");
    const cut = Math.floor(CHILD_FRAME_MAGIC.length / 2);
    parse.push(encoded.subarray(0, cut));
    parse.push(encoded.subarray(cut));

    expect(frames).toEqual([{ t: "ready" }]);
    expect(stray).toEqual([]);
  });
});

describe("帧校验", () => {
  it("接受合法的子进程帧", () => {
    expect(
      decodeChildMessage({
        t: "done",
        ok: false,
        error: { kind: "script", message: "x" },
        writes: { set: {}, delete: [] },
      }),
    ).toEqual({
      ok: true,
      frame: {
        t: "done",
        ok: false,
        error: { kind: "script", message: "x" },
        writes: { set: {}, delete: [] },
      },
    });
  });

  it("call 帧可以没有 args（call 不带参数）", () => {
    expect(decodeChildMessage({ t: "call", id: 1, name: "Read" }).ok).toBe(true);
  });

  it("拒绝形状不对的帧", () => {
    const onStray = vi.fn();
    expect(decodeChildMessage({ t: "call", name: "Read" }).ok).toBe(false);
    expect(decodeChildMessage({ t: "done", ok: true }).ok).toBe(false);
    expect(decodeChildMessage("nope").ok).toBe(false);
    expect(onStray).not.toHaveBeenCalled();
  });
});
