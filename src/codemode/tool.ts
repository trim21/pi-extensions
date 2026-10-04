/**
 * codemode 工具：模型写一段 JavaScript，脚本在 QuickJS VM（worker 线程）里执行，脚本的
 * 能力有两条：`call(name, args)` 调用工具（每个嵌套调用都由主线程经本仓库的工具总线执行，
 * 因此工具实现内部的审批——工作区外写入、Bash 沙箱提权等——照常生效；codemode 不再加
 * 自己的确认层），以及 `fs.read` / `fs.write` 两个文件原语（同样由主线程执行，与文件工具
 * 共用写审批与已读记账，见 fs.ts）。
 *
 * 可调用集合：总线上实际注册的、**声明了 `structuredSchema`** 的工具，执行时再与 active
 * 列表求交——pi 自己的 `defaultTools` / `--tools` / 子代理白名单的排除因此同样生效。
 * codemode-only 工具（`codemodeOnlyTools` 命中且声明了 schema，因而没有交给 pi 注册）不在
 * active 列表里是常态，直接进集合、不求交。
 *
 * wasm 在注册这个工具时编译一次（`createCodemodeSandbox`），worker 复用编译结果。
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { FileSnapshot, ReadsState } from "../lib/file-reads.js";
import type { ToolPendant } from "../lib/pendant.js";
import type { RequestPolicy } from "../lib/request-policy.js";
import { type ToolBus, toolResultText } from "../lib/tool-bus.js";
import { renderDeclarations, toScriptTools } from "./declarations.js";
import { createCodemodeFs } from "./fs.js";
import type { CodemodeOutputItem, ScriptError, StoreWrites } from "./protocol.js";
import { type CodemodeSandbox, createCodemodeSandbox, type ScriptCall } from "./sandbox.js";
import { CODEMODE_SOURCE_GRAMMAR, DEFAULT_OUTPUT_TOKENS, parseCodemodeSource } from "./source.js";

export const CODEMODE_TOOL_NAME = "codemode";

/**
 * 准入条件：工具**声明了 `structuredSchema`** 才进 codemode。
 *
 * 脚本拿到的返回值必须有确定的形状——只给文本的工具在脚本里既没法当数据用（得解析文本），
 * 也没有返回类型能写进声明。用「有没有结构化输出」当门槛，这条规则自己会维持一致：不给工具
 * 加 schema 就不进集合，不需要维护一份会随工具增减而漂移的黑名单。
 *
 * active 求交只作用于直接工具；命中了 `codemodeOnlyTools` 的工具（声明了 schema、因而没有
 * 交给 pi 注册）不在 active 列表里是常态，直接进集合。
 *
 * 下列工具天然不在集合里，理由各自成立：`codemode` 自身与 `spawn-agent`（没有 schema）、
 * 文件读写工具（脚本用 `fs.read` / `fs.write`，不重复一套为 LLM 上下文设计的行号/锚点
 * 语义）、搜索工具（脚本用 `call("Bash", { command })` 跑 `rg`，退出码可用、能拼管道）、
 * `lsp-rename`（写工具）以及 talk / 会话工具（会把执行时间交给外部输入）。
 */
/** 估计 token 用的字符数（与 pi 一致）。 */
const CHARS_PER_TOKEN = 4;

export interface CodemodeToolDeps {
  /** 与写类工具共享的非沙盒请求策略（写审批要用）。 */
  policy: RequestPolicy;
  /** 与文件工具共享的已读记账：脚本的 fs 原语据此做 stale 保护（两边互通）。 */
  reads: ReadsState;
}

export interface CodemodeTools {
  /**
   * 注册 codemode 工具。注册时编译 quickjs.wasm（编译失败则注册失败，由入口记成
   * 警告），之后每次执行复用同一份编译结果。
   */
  register(bus: ToolBus, deps: CodemodeToolDeps): Promise<void>;
}

interface CallableTool {
  name: string;
  description?: string;
  parameters?: unknown;
  /** 准入条件：进集合的工具一定带着它（见上面的注释）。 */
  structuredSchema: unknown;
}

/** 只在 pi 有 active 工具概念时才求交（子代理、`--tools` 等场景）。 */
function allowedToolNames(pi: ExtensionAPI): Set<string> | undefined {
  try {
    const active = pi.getActiveTools();
    return active.length > 0 ? new Set(active) : undefined;
  } catch {
    return undefined;
  }
}

function collectTools(bus: ToolBus, allowed: Set<string> | undefined): CallableTool[] {
  return bus
    .list()
    .filter((definition) => definition.structuredSchema !== undefined)
    .filter(
      (definition) =>
        definition.codemodeOnly === true || allowed === undefined || allowed.has(definition.name),
    )
    .map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      structuredSchema: definition.structuredSchema,
    }));
}

function buildDescription(tools: readonly CallableTool[]): string {
  return [
    "Run JavaScript code that orchestrates tool calls in a QuickJS sandbox.",
    "- The code is the body of an async function: top-level `await` and `return` both work.",
    "- Call tools with `await call(name, args)`. Arguments and results make a JSON round trip,",
    "  and a failing tool rejects with a `CallFailedError` you can catch.",
    "- Only what the script passes to `text(value)` / `console.log(...)` and its `return` value enter",
    "  this conversation; nested calls and their results stay out of it.",
    "- Pass only necessary content to `text(value)`: print the content the next step needs, not whole",
    "  tool results or data you will not use.",
    "- `store.set(key, value)`, `store.get(key)` and `store.list()` are a small key/value store that",
    "  persists across codemode calls in this session; `store.set(key, undefined)` removes a key.",
    "- The sandbox has no file system, network, timers or Node APIs: calling tools is its only",
    "  capability. Tool calls still go through each tool's own approvals, so a call that needs the",
    "  user's consent will ask for it.",
    "- Prefer one script over many round trips: batch independent calls with `Promise.all`, filter in",
    "  JavaScript, and print only what matters.",
    "",
    "```ts",
    renderDeclarations(tools),
    "```",
  ].join("\n");
}

/**
 * store 的恢复：把当前分支上每次 codemode 调用记在工具结果 `details.store` 里的写入
 * 按顺序重放（与 `src/lib/file-reads.ts` 从 toolResult 的 details 重放已读同一套做法）。
 * 只认分支上的结果，所以 rewind / fork / resume 后 store 跟着分支走。
 */
function readStore(ctx: ExtensionContext): Record<string, unknown> {
  const store = new Map<string, unknown>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") {
      continue;
    }
    if (entry.message.toolName !== CODEMODE_TOOL_NAME) {
      continue;
    }
    const details = entry.message.details;
    if (typeof details !== "object" || details === null) {
      continue;
    }
    const record = (details as { store?: unknown }).store;
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      continue;
    }
    const writes = record as Partial<StoreWrites>;
    for (const key of writes.delete ?? []) {
      store.delete(key);
    }
    for (const [key, value] of Object.entries(writes.set ?? {})) {
      store.set(key, value);
    }
  }
  return Object.fromEntries(store);
}

/** 本次脚本有没有通过 fs 读写过文件（决定 details 里要不要带 reads 记账）。 */
function hasReads(reads: Record<string, FileSnapshot>): boolean {
  return Object.keys(reads).length > 0;
}

function errorText(error: ScriptError): string {
  const head = error.name ? `${error.name}: ${error.message}` : error.message;
  return `${head}${error.stack && error.stack !== head ? `\n${error.stack}` : ""}`;
}

/** 文本项拼接：脚本的 `text()` 输出与返回值。 */
function textOf(items: readonly CodemodeOutputItem[]): string {
  return items
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function imagesOf(
  items: readonly CodemodeOutputItem[],
): { type: "image"; data: string; mimeType: string }[] {
  return items.filter(
    (item): item is { type: "image"; data: string; mimeType: string } => item.type === "image",
  );
}

/** 输出太长时把全文写到临时文件，返回路径（写失败返回错误文本）。 */
async function spillOutput(text: string): Promise<{ path: string } | { error: string }> {
  const path = join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.txt`);
  try {
    await writeFile(path, text);
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 套用输出预算：文本超过 `maxTokens * 4` 个字符时保留头尾、写全文到临时文件。
 * 图片不受影响，始终保留。
 */
async function truncateOutput(
  text: string,
  images: readonly { type: "image"; data: string; mimeType: string }[],
  maxTokens: number,
): Promise<{ text: string; fullOutputPath?: string }> {
  const budget = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= budget) {
    return { text };
  }
  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removed = text.length - headChars - tailChars;
  const spilled = await spillOutput(text);
  const notice =
    "path" in spilled
      ? `[Full output: ${spilled.path} (read with offset/limit)]`
      : `[Could not save the full output: ${spilled.error}]`;
  return {
    text: [
      `Warning: truncated output (original token count: ${Math.ceil(text.length / CHARS_PER_TOKEN)})`,
      `Total output lines: ${text.split("\n").length}`,
      "",
      `${text.slice(0, headChars)}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${
        tailChars > 0 ? text.slice(-tailChars) : ""
      }`,
      "",
      notice,
      images.length > 0
        ? `(${images.length} image output${images.length === 1 ? "" : "s"} not shown here)`
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
    ...("path" in spilled && { fullOutputPath: spilled.path }),
  };
}

/**
 * TUI 面板：脚本原文放在 js 代码块里，用比脚本里最长反引号串更长的围栏包住，
 * 免得脚本里的 ``` 把面板截断。
 */
function scriptPendant(code: string, subtitle: string): ToolPendant {
  const longest = (code.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return {
    title: CODEMODE_TOOL_NAME,
    subtitle,
    markdown: `${fence}js\n${code.trimEnd()}\n${fence}`,
  };
}

function formatCallSummary(calls: readonly ScriptCall[]): string {
  if (calls.length === 0) {
    return "No tool calls were made.";
  }
  return `Tool calls made before the failure (they are not undone): ${calls
    .map((call) => `${call.name} (${call.status})`)
    .join(", ")}`;
}

export function createCodemodeTools(pi: ExtensionAPI): CodemodeTools {
  return {
    async register(bus, deps) {
      const sandbox: CodemodeSandbox = await createCodemodeSandbox();
      const fs = createCodemodeFs(deps);
      const tools = collectTools(bus, allowedToolNames(pi));
      const callable = new Set(tools.map((tool) => tool.name));
      const scriptTools = toScriptTools(tools);

      bus.register({
        name: CODEMODE_TOOL_NAME,
        label: "codemode",
        description: buildDescription(tools),
        promptSnippet: "codemode: run JavaScript that calls tools in parallel",
        promptGuidelines: [
          "Use codemode to batch or chain several tool calls, or to filter large tool output down to what matters, instead of issuing many individual tool calls.",
          "Keep codemode output minimal: pass only the content the next step needs to `text(value)`, not whole tool results or data you will not use.",
        ],
        parameters: Type.Object({
          code: Type.String({
            description:
              'Raw JavaScript source. Top-level await and return work. May start with a `// @options: {"max_output_tokens": 10000}` line.',
          }),
        }),
        constrainedSampling: {
          type: "grammar",
          variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR },
        },
        executionMode: "sequential",

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          let code: string;
          let maxOutputTokens = DEFAULT_OUTPUT_TOKENS;
          try {
            const parsed = parseCodemodeSource(params.code);
            code = parsed.code;
            maxOutputTokens = parsed.options.maxOutputTokens ?? maxOutputTokens;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              isError: true,
              content: [{ type: "text", text: message }],
              details: {
                error: message,
                pendant: scriptPendant(params.code, "invalid @options"),
              },
            };
          }

          // 脚本的 fs 原语读到的文件也进同一份记账，随结果持久化（与 details.store 同一处）
          const recordedReads: Record<string, FileSnapshot> = {};

          const outcome = await sandbox.run({
            code,
            tools: scriptTools,
            store: readStore(ctx),
            signal,
            onOutput: (items) => {
              const text = textOf(items);
              if (text) {
                onUpdate?.({
                  content: [{ type: "text", text }],
                  details: { pendant: scriptPendant(code, text.slice(0, 80)) },
                });
              }
            },
            onCallProgress: ({ phase, name, args }) => {
              const detail =
                phase === "start" && args !== undefined
                  ? ` ${JSON.stringify(args).slice(0, 200)}`
                  : "";
              const line = `${phase === "start" ? "→" : "←"} ${name}${detail}`;
              onUpdate?.({
                content: [{ type: "text", text: line }],
                details: { pendant: scriptPendant(code, line.slice(0, 120)) },
              });
            },
            onCall: async ({ name, args }) => {
              if (fs.handles(name)) {
                try {
                  const result = await fs.execute(name, args, { ctx, signal });
                  if (result.reads !== undefined) {
                    Object.assign(recordedReads, result.reads);
                  }
                  return { ok: true, value: result.value };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              }
              if (!callable.has(name)) {
                return { ok: false, error: `Tool "${name}" is not available in codemode.` };
              }
              const result = await bus.executeTool(name, args, { ctx, signal });
              if (result.structuredResult) {
                return result.structuredResult.ok
                  ? { ok: true, value: result.structuredResult.value }
                  : { ok: false, error: result.structuredResult.error };
              }
              const text = toolResultText(result);
              if (result.isError) {
                return { ok: false, error: text };
              }
              return { ok: true, value: text };
            },
          });

          const images = imagesOf(outcome.output);
          if (outcome.ok) {
            const writes = outcome.writes;
            const hasWrites = Object.keys(writes.set).length > 0 || writes.delete.length > 0;
            const value =
              outcome.value === undefined ? "" : `\n\n${JSON.stringify(outcome.value, null, 2)}`;
            const truncated = await truncateOutput(
              textOf(outcome.output) + value,
              images,
              maxOutputTokens,
            );
            return {
              content: [
                { type: "text" as const, text: truncated.text },
                ...images.map((image) => ({
                  type: "image" as const,
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              ],
              details: {
                calls: outcome.calls,
                // store 的写入随工具结果持久化，下一次调用从这里重放恢复
                ...(hasWrites && { store: writes }),
                ...(hasReads(recordedReads) && { reads: recordedReads }),
                pendant: scriptPendant(code, `${outcome.calls.length} tool call(s)`),
                ...(truncated.fullOutputPath && { fullOutputPath: truncated.fullOutputPath }),
              },
            };
          }

          const body = textOf(outcome.output);
          const text = [
            `Script failed (${outcome.error.kind}):\n${errorText(outcome.error)}`,
            body,
            formatCallSummary(outcome.calls),
          ]
            .filter((part) => part !== "")
            .join("\n\n");
          return {
            isError: true,
            content: [{ type: "text", text }],
            details: {
              calls: outcome.calls,
              error: outcome.error.kind,
              ...(hasReads(recordedReads) && { reads: recordedReads }),
              pendant: scriptPendant(code, `failed (${outcome.error.kind})`),
            },
          };
        },
      });
    },
  };
}
