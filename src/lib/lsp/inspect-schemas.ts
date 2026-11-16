/**
 * 三个只读 LSP 查询工具（`lsp-find-definition` / `lsp-find-reference` / `lsp-inspect`）的
 * 结构化结果 schema。
 *
 * 载荷只有我们自己归一化过的数据（`service.inspect` 的产出），没有外部引擎字段，因此这里
 * 不学 AFT 那样全线可选：字段都在，类型确定。位置的行列号是 **1-based**（与工具文本、
 * 与这三个工具自己的 `line` / `character` 参数一致），脚本拿到就能直接回喂给另一次查询。
 *
 * `locations` 给的是查询到的**全部**位置：文本会为了模型上下文对引用列表做截断
 * （每文件 10 条、最多 30 个文件），载荷不跟着截——它是给程序用的数据，截断是渲染的事。
 *
 * 载荷只包含这里列出的字段，因此用 `z.strictObject`（多一个字段就是工具实现的问题）。
 */

import { z } from "zod";

/** 一个位置：绝对路径 + 1-based 行列号（与工具文本里的 `path:line:col` 同源）。 */
export const lspLocationSchema = z.strictObject({
  path: z.string().describe("文件的绝对路径"),
  line: z.number().int().min(1).describe("1-based 行号"),
  character: z.number().int().min(1).describe("1-based 列号"),
});

/** 回答这次查询的语言服务器 id，以及查询到的全部位置。 */
export const lspLocationsStructuredSchema = z.strictObject({
  text: z.string().describe("与工具输出一致的渲染文本（引用列表可能被截断）"),
  serverID: z.string().describe("回答这次查询的语言服务器 id"),
  locations: z
    .array(lspLocationSchema)
    .describe("查询到的全部位置，1-based 行列号，顺序与文本一致"),
});

/** hover 的内容是服务器给的异构结构，渲染成文本后原样给出。 */
export const lspHoverStructuredSchema = z.strictObject({
  text: z.string().describe("与工具输出一致的 hover 文本（服务器返回的内容）"),
  serverID: z.string().describe("回答这次查询的语言服务器 id"),
});
