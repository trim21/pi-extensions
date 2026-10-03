/**
 * codemode 主线程 ↔ worker 线程的消息类型（结构化克隆，不是字符串协议）。
 *
 * 每次执行起一个新的 worker：主线程把注册时编好的 wasm 模块连同脚本、可调用工具、
 * 初始 store 一起发过去，worker 里建 QuickJS VM 跑脚本，脚本的嵌套调用与输出回传，
 * 主线程执行工具后把结果发回去。脚本没有超时，只有调用方的中止：中止时主线程直接
 * `worker.terminate()`，因此不需要取消消息。
 *
 * worker 边界两侧都做 typebox 校验：worker 里跑的是模型写的代码，回传的消息同样
 * 当外部输入对待。
 */

import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

// ── 消息 schema ──────────────────────────────────────────────────────────────

const outputItemSchema = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
]);

const toolDeclSchema = Type.Object({
  name: Type.String(),
  description: Type.Optional(Type.String()),
  /** 工具的 structuredSchema（TypeBox schema）：脚本侧据此渲染 call() 的返回类型。 */
  structuredSchema: Type.Optional(Type.Unknown()),
});

const startSchema = Type.Object({
  t: Type.Literal("start"),
  code: Type.String(),
  tools: Type.Array(toolDeclSchema),
  store: Type.Record(Type.String(), Type.Unknown()),
});

const resultSchema = Type.Union([
  Type.Object({
    t: Type.Literal("result"),
    id: Type.Number(),
    ok: Type.Literal(true),
    value: Type.Unknown(),
  }),
  Type.Object({
    t: Type.Literal("result"),
    id: Type.Number(),
    ok: Type.Literal(false),
    error: Type.String(),
  }),
]);

const callSchema = Type.Object({
  t: Type.Literal("call"),
  id: Type.Number(),
  name: Type.String(),
  args: Type.Unknown(),
});

const outputFrameSchema = Type.Object({
  t: Type.Literal("output"),
  items: Type.Array(outputItemSchema),
});

const scriptErrorSchema = Type.Object({
  kind: Type.Union([Type.Literal("script"), Type.Literal("aborted"), Type.Literal("sandbox")]),
  name: Type.Optional(Type.String()),
  message: Type.String(),
  stack: Type.Optional(Type.String()),
});

const storeWritesSchema = Type.Object({
  set: Type.Record(Type.String(), Type.Unknown()),
  delete: Type.Array(Type.String()),
});

const doneSchema = Type.Union([
  Type.Object({
    t: Type.Literal("done"),
    ok: Type.Literal(true),
    value: Type.Unknown(),
    writes: storeWritesSchema,
  }),
  Type.Object({
    t: Type.Literal("done"),
    ok: Type.Literal(false),
    error: scriptErrorSchema,
    writes: storeWritesSchema,
  }),
]);

const hostMessageSchema = Type.Union([startSchema, resultSchema]);
const workerMessageSchema = Type.Union([callSchema, outputFrameSchema, doneSchema]);

/** worker 启动数据：注册时编译好的 wasm 模块（结构化克隆可以带它跨线程）。 */
export interface WorkerBootstrap {
  wasm: object;
}

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

/** 脚本侧的 store 写入：`set` 是覆写的键值，`delete` 是被删除的键。 */
export interface StoreWrites {
  set: Record<string, unknown>;
  delete: string[];
}

export interface ScriptTool {
  name: string;
  description?: string;
  structuredSchema?: unknown;
}

export type HostMessage =
  | { t: "start"; code: string; tools: ScriptTool[]; store: Record<string, unknown> }
  | { t: "result"; id: number; ok: true; value: unknown }
  | { t: "result"; id: number; ok: false; error: string };

export type WorkerMessage =
  | { t: "call"; id: number; name: string; args: unknown }
  | { t: "output"; items: CodemodeOutputItem[] }
  | { t: "done"; ok: true; value: unknown; writes: StoreWrites }
  | { t: "done"; ok: false; error: ScriptError; writes: StoreWrites };

export type DecodeResult<T> = { ok: true; frame: T } | { ok: false; error: string };

function decode<T>(schema: TSchema, value: unknown): DecodeResult<T> {
  if (!Value.Check(schema, value)) {
    const preview = JSON.stringify(value).slice(0, 200);
    return { ok: false, error: `unexpected message shape: ${preview}` };
  }
  return { ok: true, frame: value as T };
}

/** 校验主线程发给 worker 的消息。 */
export function decodeHostMessage(value: unknown): DecodeResult<HostMessage> {
  return decode<HostMessage>(hostMessageSchema, value);
}

/** 校验 worker 发回主线程的消息。 */
export function decodeWorkerMessage(value: unknown): DecodeResult<WorkerMessage> {
  return decode<WorkerMessage>(workerMessageSchema, value);
}
