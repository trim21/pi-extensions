/**
 * 把工具声明渲染成 codemode 脚本侧的 TypeScript：写进 codemode 的工具描述里，模型据此
 * 知道脚本里能写 `await call("Read", { file_path: "..." })`，以及每个工具返回什么。
 *
 * 只处理本仓库工具实际用到的形状（object / array / string / number / boolean /
 * const / union / enum），其余退化成 `unknown`——宁可少给类型，也不要编出错类型。
 */

import { isRecord } from "../lib/narrow.js";
import type { ScriptTool } from "./protocol.js";

interface ToolLike {
  name: string;
  description?: string;
  parameters?: unknown;
  /** 只有声明了它的工具才可调用（见 `tool.ts` 的准入条件），因此这里是必需的。 */
  structuredSchema: unknown;
}

function literal(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** 对象成员名：非法标识符用引号形式。 */
function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** schema 自带的字段说明：没有或为空时不渲染注释。 */
function descriptionOf(schema: unknown): string {
  if (!isRecord(schema) || typeof schema.description !== "string") {
    return "";
  }
  return schema.description.trim();
}

/** 字段注释：单行用 `//`，多行才用 JSDoc；缩进与它下面的属性对齐。 */
function fieldComment(description: string, indent: string): string {
  const lines = description.split("\n").map((line) => line.trim());
  if (lines.length === 1) {
    return `${indent}// ${lines[0]}`;
  }
  return [
    `${indent}/**`,
    ...lines.map((line) => (line === "" ? `${indent} *` : `${indent} * ${line}`)),
    `${indent} */`,
  ].join("\n");
}

export function renderType(schema: unknown, indent: string): string {
  if (!isRecord(schema)) {
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
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const entries = Object.entries(properties);
      if (entries.length === 0) {
        return "Record<string, unknown>";
      }
      const lines = entries.map(([key, value]) => {
        const optional = required.has(key) ? "" : "?";
        const property = `${indent}  ${propertyName(key)}${optional}: ${renderType(value, `${indent}  `)};`;
        const description = descriptionOf(value);
        return description === ""
          ? property
          : `${fieldComment(description, `${indent}  `)}\n${property}`;
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
  const description = tool.description?.trim();
  const doc = description ? `${docComment(description)}\n` : "";
  const output = renderType(tool.structuredSchema, "");
  return `${doc}declare function call(name: ${JSON.stringify(tool.name)}, args: ${renderType(tool.parameters, "")}): Promise<${output}>;`;
}

/**
 * 工具的 JSDoc 注释：description 的每一行都要进描述——只取首行会让工具作者写的说明
 * 在 codemode 里凭空消失。多行按 JSDoc 缩进渲染，单行仍是一行注释。
 */
function docComment(description: string): string {
  const lines = description.split("\n").map((line) => line.trim());
  if (lines.length === 1) {
    return `/** ${lines[0]} */`;
  }
  return ["/**", ...lines.map((line) => (line === "" ? " *" : ` * ${line}`)), " */"].join("\n");
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
    "declare function sleep(seconds: number): Promise<void>;",
    "declare const store: { set(key: string, value: unknown): void; get(key: string): unknown; list(): string[] };",
  ].join("\n");
}
