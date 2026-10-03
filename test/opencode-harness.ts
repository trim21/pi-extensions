/**
 * opencode 族测试共用的假 pi 装配：`registerTool` 把工具定义收进 Map，`on` 把事件
 * 处理器收进 Map，其余宿主方法给成 `vi.fn()`。只做装配，不约束工具的入参/出参形状
 * ——各测试仍用自己的 `interface Tool` 标注，通过 `createToolRecorder<Tool>()` 传进来。
 */
import { vi } from "vitest";

import { createToolBus, type ToolBus } from "../src/lib/tool-bus.js";

export interface ToolRecorder<T> {
  /** 注册过程中被 `registerTool` 捕获的工具，按名字索引。 */
  readonly tools: Map<string, T>;
  /** 被 `on` 捕获的事件处理器，按事件名索引（注册顺序）。 */
  readonly handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
  readonly bus: ToolBus;
  /** 假 pi，直接传给入口函数或需要 pi 的 `registerXxx`。 */
  readonly pi: never;
}

/** 造一个假的 pi 与基于它的 ToolBus，调用方随后自己触发注册。 */
export function createToolRecorder<T extends { name: string }>(): ToolRecorder<T> {
  const tools = new Map<string, T>();
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const pi = {
    registerTool: (def: T) => {
      tools.set(def.name, def);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    exec: vi.fn(),
  };
  return { tools, handlers, bus: createToolBus(pi as never), pi: pi as never };
}

/** 单个工具的收窄：注册后按名字取，取不到直接抛错，省掉 `!`。 */
export function requireTool<T extends { name: string }>(
  recorder: ToolRecorder<T>,
  name: string,
): T {
  const tool = recorder.tools.get(name);
  if (tool === undefined) {
    throw new Error(`tool "${name}" was not registered`);
  }
  return tool;
}
