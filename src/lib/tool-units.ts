/**
 * 工具单元表：本仓库工具按「一套文件 IO 工具集 + 若干单元」组织，主入口与
 * spawn-agent 的子代理共用同一张表，因此两处的工具实现、参数与审批完全一致。
 *
 * - 主入口按配置选中的工具集注册全部单元（`fileIo` / `fileIoByModel`）。
 * - 子代理按 frontmatter 声明的工具名注册覆盖到的单元；可见性再由
 *   `createAgentSession({ tools })` 的白名单收敛。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { BwrapRuntime } from "../bwrap/runtime.js";
import type { FileToolset } from "../claude-code/files.js";
import { registerSearchTools } from "../claude-code/search.js";
import { registerSessionTools } from "../claude-code/session-tools.js";
import { registerShellTools } from "../claude-code/shell.js";
import { registerBashTool } from "../opencode/bash.js";
import type { OpencodeFileToolset } from "../opencode/files.js";
import { registerGlobTool } from "../opencode/glob.js";
import { registerGrepTool } from "../opencode/grep.js";
import { registerQuestionTool } from "../opencode/question.js";
import { registerTodoTool } from "../opencode/todo.js";
import type { RequestPolicy } from "./request-policy.js";
import type { ToolBus } from "./tool-bus.js";
import type { FileIoToolset } from "./tools-config.js";

export interface ToolUnitDeps {
  pi: ExtensionAPI;
  bus: ToolBus;
  policy: RequestPolicy;
  runtime: BwrapRuntime;
  /** 选中工具集的文件工具（Read/Edit/Write 或 read/edit/write）。 */
  fileToolset: FileToolset | OpencodeFileToolset;
}

export interface ToolUnit {
  /** 该单元提供的工具名，用于子代理按声明挑选单元。 */
  tools: readonly string[];
  register(deps: ToolUnitDeps): void;
}

export const TOOL_UNITS: Record<FileIoToolset, readonly ToolUnit[]> = {
  "claude-code": [
    {
      tools: ["Read", "Edit", "Write"],
      register: ({ bus, fileToolset }) => fileToolset.register(bus),
    },
    {
      tools: ["Glob", "Grep"],
      register: ({ bus, pi }) => registerSearchTools(bus, pi),
    },
    {
      tools: ["Bash"],
      register: ({ bus, pi, runtime }) => registerShellTools(bus, pi, runtime),
    },
    {
      tools: ["TodoWrite", "AskUserQuestion"],
      register: ({ bus, pi }) => registerSessionTools(bus, pi),
    },
  ],
  opencode: [
    {
      tools: ["read", "edit", "write"],
      register: ({ bus, fileToolset }) => fileToolset.register(bus),
    },
    {
      tools: ["glob", "grep"],
      register: ({ bus }) => {
        registerGlobTool(bus);
        registerGrepTool(bus);
      },
    },
    {
      tools: ["bash"],
      register: ({ bus, pi, runtime }) => registerBashTool(bus, pi, runtime),
    },
    {
      tools: ["todowrite", "question"],
      register: ({ bus }) => {
        registerTodoTool(bus);
        registerQuestionTool(bus);
      },
    },
  ],
};

/** 子代理声明的工具名对应哪一套文件 IO 工具集：出现哪一套的名字就用哪一套。 */
export function toolsetsForToolNames(toolNames: readonly string[]): FileIoToolset | undefined {
  const declared = new Set(toolNames);
  for (const kind of ["claude-code", "opencode"] as const) {
    if (TOOL_UNITS[kind].some((unit) => unit.tools.some((name) => declared.has(name)))) {
      return kind;
    }
  }
  return undefined;
}

/** 挑出覆盖到声明工具名的单元。 */
export function unitsForToolNames(kind: FileIoToolset, toolNames: readonly string[]): ToolUnit[] {
  const declared = new Set(toolNames);
  return TOOL_UNITS[kind].filter((unit) => unit.tools.some((name) => declared.has(name)));
}
