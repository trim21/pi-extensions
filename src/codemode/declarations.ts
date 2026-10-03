/**
 * 把工具声明渲染成 codemode 脚本侧的 TypeScript：写进 codemode 的工具描述里，模型据此
 * 知道脚本里能写 `await call("Read", { file_path: "..." })`，以及每个工具返回什么。
 *
 * 只处理本仓库工具实际用到的形状（object / array / string / number / boolean /
 * const / union / enum），其余退化成 `unknown`——宁可少给类型，也不要编出错类型。
 */

import type { ScriptTool } from "./protocol.js";

interface ToolLike {
  name: string;
  description?: string;
  parameters?: unknown;
  structuredSchema?: unknown;
}

type JsonSchema = Record<string, unknown>;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** 对象成员名：非法标识符用引号形式。 */
function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function renderType(schema: unknown, indent: string): string {
  if (!isSchema(schema)) {
    return "unknown";
  }
  // TypeBox 的 Type.Literal / StringEnum 产出 const，而不是 enum
  if ("const" in schema) {
    return literal(schema.const);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value) => literal(value)).join(" | ");
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.map((option) => renderType(option, indent)).join(" | ");
  }

  switch (schema.type) {
    case "string": {
      return "string";
    }
    case "number":
    case "integer": {
      return "number";
    }
    case "boolean": {
      return "boolean";
    }
    case "null": {
      return "null";
    }
    case "array": {
      return `Array<${renderType(schema.items, indent)}>`;
    }
    case "object": {
      const properties = isSchema(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const entries = Object.entries(properties);
      if (entries.length === 0) {
        return "Record<string, unknown>";
      }
      const lines = entries.map(([key, value]) => {
        const optional = required.has(key) ? "" : "?";
        return `${indent}  ${propertyName(key)}${optional}: ${renderType(value, `${indent}  `)};`;
      });
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
    default: {
      return "unknown";
    }
  }
}

/**
 * 单个工具在脚本里的调用重载：`declare function call(name: "X", args: T): Promise<R>;`。
 * 返回类型取自工具声明的输出结构，未声明就是文本（`string`）。
 */
function renderOverload(tool: ToolLike): string {
  const summary = tool.description?.split("\n", 1)[0]?.trim();
  const doc = summary ? `/** ${summary} */\n` : "";
  const output =
    tool.structuredSchema === undefined ? "string" : renderType(tool.structuredSchema, "");
  return `${doc}declare function call(name: ${JSON.stringify(tool.name)}, args: ${renderType(tool.parameters, "")}): Promise<${output}>;`;
}

/** 给脚本用的工具清单（名字 + 说明）。 */
export function toScriptTools(tools: readonly ToolLike[]): ScriptTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    structuredSchema: tool.structuredSchema,
  }));
}

/** 渲染脚本侧的声明：每个工具一条 `call` 重载，外加 `fs` 原语、`CallFailedError` 与全局辅助函数。 */
export function renderDeclarations(tools: readonly ToolLike[]): string {
  return [
    ...tools.map((tool) => renderOverload(tool)),
    // 动态名字的兜底重载，必须放最后
    "declare function call(name: string, args?: unknown): Promise<unknown>;",
    "declare const ALL_TOOLS: Array<{ name: string; description?: string }>;",
    // 文件原语：直接读写文件。它们不是工具，所以不在上面的 call 重载里。
    [
      "declare const fs: {",
      "  read(path: string): Promise<string>;",
      "  write(path: string, content: string): Promise<void>;",
      "};",
    ].join("\n"),
    'declare class CallFailedError extends Error { readonly name: "CallFailedError"; }',
    "declare function text(value: unknown): void;",
    "declare function image(value: unknown): void;",
    "declare function exit(): void;",
    "declare const store: { set(key: string, value: unknown): void; get(key: string): unknown; list(): string[] };",
  ].join("\n");
}
