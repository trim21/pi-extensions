/**
 * 工具总线：本仓库全部工具的唯一注册通道，也让同入口的模块可以直接调用别的工具
 * （按名执行，不必绕回模型）。
 *
 * - `register`：按配置过滤（被禁用时跳过并返回 false）后交给 `pi.registerTool`，
 *   并保留通过的定义供 `list` / `get` 查询。
 * - `executeTool`：先用工具自身的参数 schema 校验参数，再调用定义的 `execute`；
 *   参数校验失败与工具抛出的异常都归一化成错误结果返回，不向调用方抛异常。
 *
 * 状态由闭包持有（工厂 + 闭包），不使用模块级可变状态。
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

import { parseWithSchema } from "./parse-with-schema.js";

/** 一次工具执行的结果：`isError` 标出失败（工具不存在、参数不合法、工具抛错）。 */
export type ToolExecutionResult = AgentToolResult<unknown> & { isError: boolean };

export interface ExecuteToolOptions {
  /** 工具 `execute` 需要的宿主上下文：调用方把自己拿到的那个 ctx 传进来。 */
  ctx: ExtensionContext;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  /** 日志与临时文件命名用的调用 id；缺省由总线生成。 */
  toolCallId?: string;
}

export interface ToolBus {
  /** 注册一个工具；被配置禁用时跳过并返回 false。 */
  register<TParams extends TSchema, TDetails>(
    definition: ToolDefinition<TParams, TDetails, unknown>,
  ): boolean;
  /** 本次实际注册的工具定义。 */
  list(): readonly ToolDefinition[];
  /** 所有尝试注册过的工具名（含被禁用而跳过的），用于校验配置里的模式是否有效。 */
  declaredNames(): readonly string[];
  get(name: string): ToolDefinition | undefined;
  /** 按名执行一个已注册工具；任何失败都以 `isError` 结果返回，不抛异常。 */
  executeTool(
    name: string,
    args: unknown,
    options: ExecuteToolOptions,
  ): Promise<ToolExecutionResult>;
}

export interface ToolBusOptions {
  /** 返回 true 表示该工具被禁用、不注册。 */
  isDisabled?: (name: string) => boolean;
}

type AnyToolDefinition = ToolDefinition<TSchema, unknown, unknown>;

function errorResult(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text }], details: { error: text }, isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createToolBus(pi: ExtensionAPI, options: ToolBusOptions = {}): ToolBus {
  const registered = new Map<string, AnyToolDefinition>();
  const declared = new Set<string>();
  let callCounter = 0;

  return {
    register(definition) {
      declared.add(definition.name);
      if (options.isDisabled?.(definition.name) === true) {
        return false;
      }
      const stored = definition as unknown as AnyToolDefinition;
      pi.registerTool(stored);
      registered.set(stored.name, stored);
      return true;
    },

    list() {
      return [...registered.values()];
    },

    declaredNames() {
      return [...declared];
    },

    get(name) {
      return registered.get(name);
    },

    async executeTool(name, args, options) {
      const definition = registered.get(name);
      if (!definition) {
        return errorResult(`Tool "${name}" is not available.`);
      }

      const toolCallId = options.toolCallId ?? `tool-bus-${++callCounter}`;
      let params: Static<TSchema>;
      try {
        const prepared = definition.prepareArguments ? definition.prepareArguments(args) : args;
        params = parseWithSchema(definition.parameters, prepared);
      } catch (error) {
        return errorResult(`Invalid arguments for tool "${name}": ${errorMessage(error)}`);
      }

      try {
        const result = await definition.execute(
          toolCallId,
          params,
          options.signal,
          options.onUpdate,
          options.ctx,
        );
        return { ...result, isError: false };
      } catch (error) {
        return errorResult(`Tool "${name}" failed: ${errorMessage(error)}`);
      }
    },
  };
}
