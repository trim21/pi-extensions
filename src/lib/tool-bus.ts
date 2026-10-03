/**
 * 工具总线：本仓库全部工具的唯一注册通道，也让同入口的模块可以直接调用别的工具
 * （按名执行，不必绕回模型）。
 *
 * - `register`：按配置过滤（被禁用时跳过并返回 false）后交给 `pi.registerTool`，
 *   并保留通过的定义供 `list` / `get` 查询。
 * - `executeTool`：先用工具自身的参数 schema 校验参数，再调用定义的 `execute`；
 *   参数校验失败与工具抛出的异常都归一化成错误结果返回，不向调用方抛异常。
 *
 * 结构化结果：工具可以在定义上声明 `structuredSchema`（TypeBox），并在结果里带
 * `structuredResult: StructuredResult<Static<typeof structuredSchema>>`。成功支的载荷类型
 * 由 schema 在编译期约束，执行时再由总线 `Value.Parse` 复核；`ok: false` 让工具不必抛异常
 * 也能结构化地报告失败（它不改变结果的 `isError`）。
 *
 * 这两个名字是本仓库自己的约定，刻意不占用宿主字段：pi-agent-core >= 0.99 自带
 * `outputSchema` / `structuredContent`，语义是「裸载荷 + 用 `isError` 表失败」，与本仓库的
 * Result 信封不同，将来接宿主原生管线时需要显式换算。
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

/**
 * 结构化结果：成功带 `value`，失败带可直接展示的错误说明。它只嵌在工具结果的
 * `structuredResult` 一个属性里，结果对象本身保持单一类型（两个互斥字段会让整个
 * 结果类型分配成对象联合）。
 */
export type StructuredResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 声明了输出结构的工具定义：`structuredResult` 成功支的载荷类型由 `structuredSchema` 在编译
 * 期绑定，因此工具无法返回与声明不符的结果。
 */
export interface StructuredToolDefinition<
  TParams extends TSchema = TSchema,
  TOutput extends TSchema = TSchema,
  TDetails = unknown,
> extends Omit<ToolDefinition<TParams, TDetails, unknown>, "execute"> {
  structuredSchema: TOutput;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails> & { structuredResult: StructuredResult<Static<TOutput>> }>;
}

/**
 * 结构化工具必须经它定义：`structuredSchema` 与 `execute` 返回类型之间的绑定只有在
 * generic 函数的参数位置才建立得起来（与 pi 的 `defineTool` 同理）。
 */
export function defineStructuredTool<
  TParams extends TSchema,
  TOutput extends TSchema,
  TDetails = unknown,
>(
  definition: StructuredToolDefinition<TParams, TOutput, TDetails>,
): StructuredToolDefinition<TParams, TOutput, TDetails> {
  return definition;
}

/** 一次工具执行的结果：`isError` 标出失败（工具不存在、参数不合法、工具抛错）。 */
export type ToolExecutionResult = AgentToolResult<unknown> & {
  isError: boolean;
  /** 工具声明的结构化结果，原样交给 codemode 脚本。 */
  structuredResult?: StructuredResult<unknown>;
};

export interface ExecuteToolOptions {
  /** 工具 `execute` 需要的宿主上下文：调用方把自己拿到的那个 ctx 传进来。 */
  ctx: ExtensionContext;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  /** 日志与临时文件命名用的调用 id；缺省由总线生成。 */
  toolCallId?: string;
}

/** 注册后的定义：多出的 `structuredSchema` 供 codemode 渲染脚本侧返回类型。 */
export type RegisteredToolDefinition = ToolDefinition<TSchema, unknown, unknown> & {
  structuredSchema?: TSchema;
};

export interface ToolBus {
  /** 注册一个工具；被配置禁用时跳过并返回 false。 */
  register<TParams extends TSchema, TDetails>(
    definition: ToolDefinition<TParams, TDetails, unknown>,
  ): boolean;
  /** 本次实际注册的工具定义。 */
  list(): readonly RegisteredToolDefinition[];
  /** 所有尝试注册过的工具名（含被禁用而跳过的），用于校验配置里的模式是否有效。 */
  declaredNames(): readonly string[];
  get(name: string): RegisteredToolDefinition | undefined;
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

function errorResult(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text }], details: { error: text }, isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type StructuredCheck =
  { ok: true; result?: StructuredResult<unknown> } | { ok: false; error: string };

/**
 * 复核工具返回的 `structuredResult`：声明了 `structuredSchema` 的工具必须返回它，成功支的
 * 载荷必须过 schema（外部数据用 typebox 校验是本仓库约定），失败支的错误必须是字符串。
 */
function checkStructuredResult(
  name: string,
  structuredSchema: TSchema | undefined,
  result: AgentToolResult<unknown>,
): StructuredCheck {
  const structured = (result as { structuredResult?: unknown }).structuredResult;
  if (structured === undefined) {
    return structuredSchema === undefined
      ? { ok: true }
      : {
          ok: false,
          error: `Tool "${name}" declared a structuredSchema but returned no structuredResult.`,
        };
  }
  if (structuredSchema === undefined) {
    return {
      ok: false,
      error: `Tool "${name}" returned a structuredResult without declaring a structuredSchema.`,
    };
  }
  if (typeof structured !== "object" || structured === null) {
    return { ok: false, error: `Tool "${name}" returned a malformed structuredResult.` };
  }
  const candidate = structured as { ok?: unknown; value?: unknown; error?: unknown };
  if (candidate.ok === false) {
    if (typeof candidate.error !== "string") {
      return {
        ok: false,
        error: `Tool "${name}" returned a structuredResult whose error is not a string.`,
      };
    }
    return { ok: true, result: { ok: false, error: candidate.error } };
  }
  if (candidate.ok !== true) {
    return { ok: false, error: `Tool "${name}" returned a malformed structuredResult.` };
  }
  try {
    return {
      ok: true,
      result: { ok: true, value: parseWithSchema(structuredSchema, candidate.value) },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Tool "${name}" returned a structuredResult value that does not match its structuredSchema: ${errorMessage(error)}`,
    };
  }
}

export function createToolBus(pi: ExtensionAPI, options: ToolBusOptions = {}): ToolBus {
  const registered = new Map<string, RegisteredToolDefinition>();
  const declared = new Set<string>();
  let callCounter = 0;

  return {
    register(definition) {
      declared.add(definition.name);
      if (options.isDisabled?.(definition.name) === true) {
        return false;
      }
      const stored = definition as unknown as RegisteredToolDefinition;
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
        const checked = checkStructuredResult(name, definition.structuredSchema, result);
        if (!checked.ok) {
          return errorResult(checked.error);
        }
        return {
          ...result,
          isError: false,
          ...(checked.result !== undefined && { structuredResult: checked.result }),
        };
      } catch (error) {
        return errorResult(`Tool "${name}" failed: ${errorMessage(error)}`);
      }
    },
  };
}

/** 工具结果里的文本内容拼接，便于调用方展示或回传给脚本。 */
export function toolResultText(result: ToolExecutionResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
    .join("\n");
}
