/**
 * codemode 宿主 ↔ 脚本子进程的协议：消息形状与分帧。
 *
 * 两个方向共用**一条专用 fd**（见 `CHILD_FRAME_FD`）：它由 spawn 建成 socketpair，
 * 本来就是全双工，读写都走它。stdin/stdout/stderr 于是全归脚本——脚本是模型写的普通
 * Node 程序，它（或它用的库、原生模块）会往 stdio 写任意内容，包括刚好长得像协议帧的
 * 文本；stdout/stderr 整体当脚本输出收集，协议因此不会被插进中间。
 *
 * 两个方向的分帧一致：magic + 十进制长度 + `:` + JSON 文本。
 *
 * 帧的校验：子进程回传的帧一律当外部输入用 typebox 校验（脚本能在子进程里往 fd 写东西，
 * 这里防的是意外而不是攻击——解析不出就按协议损坏处理，由调用方杀掉子进程）。子进程侧
 * 对宿主帧只做形状检查：宿主是可信方，且那边只能用 node: 内置模块。
 */

import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

/** 协议 fd：stdin(0)/stdout(1)/stderr(2) 之外的第一条通道，全双工 socketpair。 */
export const CHILD_FRAME_FD = 3;

/**
 * 帧起始标记。用 ASCII 控制字符 0x1e 包住：脚本往协议 fd 写普通文本时几乎不可能凑出它，
 * 因而不会把脚本文本当帧解析。写成 `fromCharCode` 是为了让转译产物里也不出现裸控制字符
 * （子进程侧的 `bootstrap.ts` 用同一段构造，两边必须一致）。
 */
const FRAME_MAGIC_BYTE = 0x1e;
export const CHILD_FRAME_MAGIC = `${String.fromCodePoint(FRAME_MAGIC_BYTE)}PI_CODEMODE${String.fromCodePoint(FRAME_MAGIC_BYTE)}`;

/** 帧头的最大长度（magic 之后的十进制长度 + 冒号），超过即判定协议损坏。 */
const MAX_HEADER_CHARS = 12;

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type CodemodeOutputItem =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type ScriptErrorKind = "script" | "aborted" | "sandbox";

export interface ScriptError {
  kind: ScriptErrorKind;
  name?: string;
  message: string;
  stack?: string;
}

/** 脚本侧的 store 写入：`set` 是覆写的键值，`delete` 是被删除的键（`set(k, undefined)`）。 */
export interface StoreWrites {
  set: Record<string, unknown>;
  delete: string[];
}

export interface ScriptTool {
  name: string;
  description?: string;
  /** 工具的 structuredSchema（TypeBox schema）：脚本侧据此渲染 call() 的返回类型。 */
  structuredSchema?: unknown;
}

/** 宿主发给子进程的帧。 */
export type HostMessage =
  | { t: "start"; code: string; tools: ScriptTool[]; store: Record<string, unknown> }
  | { t: "result"; id: number; ok: true; value?: unknown }
  | { t: "result"; id: number; ok: false; error: string };

/** 子进程回给宿主的帧。 */
export type ChildMessage =
  | { t: "ready" }
  | { t: "call"; id: number; name: string; args: unknown }
  | { t: "output"; items: CodemodeOutputItem[] }
  | { t: "done"; ok: true; value?: unknown; writes: StoreWrites }
  | { t: "done"; ok: false; error: ScriptError; writes: StoreWrites };

// ── schema ───────────────────────────────────────────────────────────────────

const outputItemSchema = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
]);

const storeWritesSchema = Type.Object({
  set: Type.Record(Type.String(), Type.Unknown()),
  delete: Type.Array(Type.String()),
});

const scriptErrorSchema = Type.Object({
  kind: Type.Union([Type.Literal("script"), Type.Literal("aborted"), Type.Literal("sandbox")]),
  name: Type.Optional(Type.String()),
  message: Type.String(),
  stack: Type.Optional(Type.String()),
});

const childMessageSchema = Type.Union([
  Type.Object({ t: Type.Literal("ready") }),
  Type.Object({
    t: Type.Literal("call"),
    id: Type.Number(),
    name: Type.String(),
    // 可以缺席：`call("Read")` 没有参数，JSON 序列化后 `args` 键不存在
    args: Type.Optional(Type.Unknown()),
  }),
  Type.Object({ t: Type.Literal("output"), items: Type.Array(outputItemSchema) }),
  Type.Object({
    t: Type.Literal("done"),
    ok: Type.Literal(true),
    value: Type.Optional(Type.Unknown()),
    writes: storeWritesSchema,
  }),
  Type.Object({
    t: Type.Literal("done"),
    ok: Type.Literal(false),
    error: scriptErrorSchema,
    writes: storeWritesSchema,
  }),
]);

/** 校验子进程回传的帧。 */
export function decodeChildMessage(value: unknown): DecodeResult<ChildMessage> {
  return decode<ChildMessage>(childMessageSchema, value);
}

export type DecodeResult<T> = { ok: true; frame: T } | { ok: false; error: string };

function decode<T>(schema: TSchema, value: unknown): DecodeResult<T> {
  if (!Value.Check(schema, value)) {
    const json = JSON.stringify(value) as string | undefined;
    const preview = (json ?? String(value)).slice(0, 200);
    return { ok: false, error: `unexpected message shape: ${preview}` };
  }
  return { ok: true, frame: value as T };
}

// ── 分帧（两个方向一致） ─────────────────────────────────────────────────────

export function encodeFrame(frame: HostMessage | ChildMessage): string {
  const json = JSON.stringify(frame);
  return `${CHILD_FRAME_MAGIC}${Buffer.byteLength(json, "utf8")}:${json}`;
}

export interface ChildFrameHandlers {
  /** 解析出的一帧（未经 schema 校验，由调用方决定怎么校验）。 */
  onFrame(frame: unknown): void;
  /** magic 之前的杂散字节：子进程（或脚本）往协议 fd 写了别的东西。 */
  onStray?(text: string): void;
  /** 帧体不是合法 JSON、或头本身损坏。 */
  onInvalid?(reason: string): void;
}

/**
 * 增量帧解析器：喂进来的字节流可能任意切分，magic 之前允许有杂散字节（按 `onStray` 报出去，
 * 解析器自行重新同步）。返回的 `finish()` 报告流结束时是否还有半帧残留。
 */
export function createFrameDecoder(handlers: ChildFrameHandlers): {
  push(chunk: Buffer): void;
  finish(): void;
} {
  let pending = Buffer.alloc(0);

  function stray(bytes: Buffer): void {
    if (bytes.length > 0) {
      handlers.onStray?.(bytes.toString("utf8"));
    }
  }

  function parse(): void {
    for (;;) {
      const magicAt = pending.indexOf(CHILD_FRAME_MAGIC);
      if (magicAt === -1) {
        // 保留末尾可能是半个 magic 的部分，其余当杂散字节报出去
        const keep = CHILD_FRAME_MAGIC.length - 1;
        if (pending.length > keep) {
          stray(pending.subarray(0, pending.length - keep));
          pending = pending.subarray(pending.length - keep);
        }
        return;
      }
      if (magicAt > 0) {
        stray(pending.subarray(0, magicAt));
        pending = pending.subarray(magicAt);
      }

      const afterMagic = pending.subarray(CHILD_FRAME_MAGIC.length);
      const colonAt = afterMagic.indexOf(0x3a);
      if (colonAt === -1) {
        if (afterMagic.length > MAX_HEADER_CHARS) {
          handlers.onInvalid?.("frame header is not a length prefix");
          // 丢掉这一个 magic，继续往后找（重新同步）
          pending = pending.subarray(CHILD_FRAME_MAGIC.length);
          continue;
        }
        return;
      }
      const lengthText = afterMagic.subarray(0, colonAt).toString("ascii");
      const length = /^\d+$/.test(lengthText) ? Number(lengthText) : NaN;
      if (!Number.isSafeInteger(length)) {
        handlers.onInvalid?.(`frame length is not a number: ${JSON.stringify(lengthText)}`);
        pending = pending.subarray(CHILD_FRAME_MAGIC.length);
        continue;
      }

      const bodyAt = CHILD_FRAME_MAGIC.length + colonAt + 1;
      if (pending.length < bodyAt + length) {
        return; // 帧还没收全
      }
      const body = pending.subarray(bodyAt, bodyAt + length).toString("utf8");
      pending = pending.subarray(bodyAt + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        handlers.onInvalid?.(
          `frame body is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      handlers.onFrame(parsed);
    }
  }

  return {
    push(chunk) {
      pending = Buffer.concat([pending, chunk]);
      parse();
    },
    finish() {
      if (pending.length === 0) {
        return;
      }
      // 带 magic 的残留 = 半帧（协议损坏）；不带的只能是杂散字节（当脚本输出报出去）
      if (!pending.includes(CHILD_FRAME_MAGIC)) {
        stray(pending);
        pending = Buffer.alloc(0);
        return;
      }
      handlers.onInvalid?.(`stream ended mid-frame (${pending.length} byte(s) left)`);
    },
  };
}
