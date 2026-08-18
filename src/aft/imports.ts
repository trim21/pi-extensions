/**
 * aft_import —— language-aware import add / remove。
 *
 * 参数经 bridge.toolCall 以 agent 工具名 "import" 分派，Rust 侧 subc 翻译层
 * 按 op 转成内部命令（add_import / remove_import）。
 * 与 aft_refactor 相同：不支持 preview，写保护为路径级审批。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type ToolPendant } from "../lib/pendant.js";
import { guardWriteAccess } from "../lib/write-guard.js";
import { callAftTool } from "./bridge.js";
import { type AftToolContext, bridgeFor, buildPendantMarkdown, resolvePathArg } from "./tools.js";

const IMPORT_OPS = ["add", "remove"] as const;
const VALIDATE_LEVELS = ["syntax", "full"] as const;

const ImportParams = Type.Object(
  {
    op: Type.Union(
      IMPORT_OPS.map((op) => Type.Literal(op)),
      { description: "import 操作" },
    ),
    path: Type.String({ description: "目标文件路径（绝对或相对项目根）" }),
    module: Type.Optional(
      Type.String({ description: "模块路径（add/remove 必填），如 'react'、'./utils'" }),
    ),
    names: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "要添加的具名导入，用语言原生的具名导入写法，支持按名 `as` 别名，如 ['useState']、Solidity ['ERC20', 'IERC20 as IToken']",
      }),
    ),
    default_import: Type.Optional(Type.String({ description: "默认导入名（仅 ES），如 'React'" })),
    namespace: Type.Optional(
      Type.String({
        description:
          "命名空间绑定：`import * as ns from 'mod'`（ES）、`* as N from \"./X.sol\"`（Solidity）",
      }),
    ),
    alias: Type.Optional(
      Type.String({ description: '整模块别名。Solidity：`import "./X.sol" as X`' }),
    ),
    modifiers: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "语句级修饰符，按语言校验：Java/C# 'static'、C# 'global'/'unsafe'、Java/Kotlin/Scala 'wildcard'、Swift '@testable'",
      }),
    ),
    import_kind: Type.Optional(
      Type.String({
        description:
          "符号类导入：PHP 'function'/'const'、Swift 'struct'/'class'/'enum'、Scala 'given'",
      }),
    ),
    remove_name: Type.Optional(
      Type.String({ description: "要移除的具名导入；缺省移除整个 import" }),
    ),
    type_only: Type.Optional(Type.Boolean({ description: "仅类型导入（仅 TS）" })),
    validate: Type.Optional(
      Type.Union(
        VALIDATE_LEVELS.map((level) => Type.Literal(level)),
        {
          description: "编辑后校验级别（默认 syntax）",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export function registerImportTool(pi: ExtensionAPI, ctx: AftToolContext): void {
  pi.registerTool({
    name: "aft_import",
    label: "aft_import",
    description: [
      "语言感知的 import 管理：add / remove。",
      "支持 TS, JS, TSX, Python, Rust, Go, Solidity, Java, C#, PHP, Kotlin, Scala, Swift, Ruby, Lua, C, C++, Perl, Vue。",
      "add：添加默认/具名/命名空间导入；remove：移除具名导入或整个 import。",
      "import 排序整理交给 lint（如 import/order + --fix），本工具不负责。",
    ].join("\n"),
    promptSnippet: "Language-aware import add / remove",
    parameters: ImportParams,
    async execute(_id, params, _signal, _onUpdate, extCtx) {
      if (params.module === undefined || params.module.trim() === "") {
        throw new Error(`'module' is required for '${params.op}' op`);
      }

      const filePath = resolvePathArg(extCtx.cwd, params.path);
      await guardWriteAccess(extCtx, { toolName: "aft_import", absolutePath: filePath });

      const rawArgs: Record<string, unknown> = { op: params.op, path: filePath };
      if (params.module !== undefined && params.module.trim() !== "") {
        rawArgs.module = params.module;
      }
      if (params.names !== undefined) rawArgs.names = params.names;
      if (params.default_import !== undefined) rawArgs.defaultImport = params.default_import;
      if (params.namespace !== undefined) rawArgs.namespace = params.namespace;
      if (params.alias !== undefined) rawArgs.alias = params.alias;
      if (params.modifiers !== undefined) rawArgs.modifiers = params.modifiers;
      if (params.import_kind !== undefined) rawArgs.importKind = params.import_kind;
      if (params.remove_name !== undefined) rawArgs.removeName = params.remove_name;
      if (params.type_only !== undefined) rawArgs.typeOnly = params.type_only;
      if (params.validate !== undefined) rawArgs.validate = params.validate;

      const { text } = await callAftTool(bridgeFor(ctx), "import", rawArgs, extCtx);
      return {
        content: [{ type: "text", text }],
        details: {
          files: [filePath],
          pendant: {
            markdown: buildPendantMarkdown({
              title: "aft_import",
              input: params,
              output: text,
            }),
            expanded: true,
          } satisfies ToolPendant,
        },
      };
    },
  });
}
