/**
 * 把工具的参数 schema 渲染成脚本侧的 TypeScript 声明：写进 codemode 的工具描述里，
 * 模型据此知道脚本里能写 `await tools.Read({ file_path: "..." })`。
 *
 * 只处理本仓库工具实际用到的形状（object / array / string / number / boolean /
 * union / enum），其余退化成 `unknown`——宁可少给类型，也不要编出错类型。
 */

import type { ScriptTool } from "./protocol.js";

interface ToolLike {
  name: string;
  description?: string;
  parameters?: unknown;
}

type JsonSchema = Record<string, unknown>;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** 工具名作为属性访问：非法标识符用引号形式。 */
function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function renderType(schema: unknown, indent: string): string {
  if (!isSchema(schema)) {
    return "unknown";
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

/** 单个工具在脚本里的签名（`tools` 的一个成员）。 */
function renderToolMember(tool: ToolLike): string {
  const summary = tool.description?.split("\n", 1)[0]?.trim();
  const doc = summary ? `/** ${summary} */\n  ` : "";
  return `${doc}${propertyName(tool.name)}(args: ${renderType(tool.parameters, "  ")}): Promise<unknown>;`;
}

/** 给脚本用的工具清单（名字 + 说明）。 */
export function toScriptTools(tools: readonly ToolLike[]): ScriptTool[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description }));
}

/** 渲染脚本侧的声明：`declare const tools: {...}` 与全局辅助函数。 */
export function renderDeclarations(tools: readonly ToolLike[]): string {
  const members = tools.map((tool) => `  ${renderToolMember(tool)}`).join("\n");
  return [
    `declare const tools: {\n${members}\n};`,
    "declare const ALL_TOOLS: Array<{ name: string; description?: string }>;",
    "declare function text(value: unknown): void;",
    "declare function image(value: unknown): void;",
    "declare function exit(): void;",
    "declare const store: { set(key: string, value: unknown): void; get(key: string): unknown; list(): string[] };",
  ].join("\n");
}
