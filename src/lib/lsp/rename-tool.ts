/**
 * lsp-rename 工具壳，由 claude-code / opencode 两个工具集共享注册。
 *
 * rename 的纯逻辑（候选枚举、同名消歧、WorkspaceEdit 展开）在 ./rename.ts，
 * 这里只负责工具注册与执行编排：按行内候选逐个探测 → canonicalizeEdit 分组
 * 消歧 → expandWorkspaceEdit 内存展开 → 审批 → 写盘 → 诊断。
 *
 * 两个工具集行为一致，唯一差异是 reads 记账：跟踪 read-before-write 状态的
 * 工具集通过 hooks.recordReads 把重命名文件标记为已读并随 details 持久化；
 * 不跟踪该状态的工具集不传 hook。
 */

import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  type ExtensionAPI,
  generateDiffString,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolvePathArg } from "../path.js";
import type { ToolPendant } from "../pendant.ts";
import { guardWriteAccess } from "../write-guard.js";
import { RenameNotPossibleError } from "./client.js";
import type { LspService } from "./lsp.js";
import {
  type AppliedFileEdit,
  canonicalizeEdit,
  expandWorkspaceEdit,
  symbolCandidates,
} from "./rename.js";

export interface LspRenameHooks {
  /**
   * rename 落盘后对每个被修改文件做已读记账；返回的 map 随 details.reads
   * 持久化，供 session 恢复时重放。不跟踪已读状态的工具集不提供该 hook。
   */
  recordReads?: (applied: readonly AppliedFileEdit[]) => Promise<Record<string, unknown>>;
}

const LSP_RENAME_PROMPT = readFileSync(
  fileURLToPath(new URL("lsp-rename.md", import.meta.url)),
  "utf8",
).trim();

export function registerLspRenameTool(
  pi: ExtensionAPI,
  service: LspService,
  hooks: LspRenameHooks = {},
): void {
  pi.registerTool({
    name: "lsp-rename",
    label: "Lsp Rename",
    description: "Rename a code symbol and update all references across the workspace via LSP",
    promptSnippet: "Workspace-wide symbol rename via LSP",
    promptGuidelines: [LSP_RENAME_PROMPT],
    parameters: Type.Object(
      {
        file_path: Type.String({
          description:
            "A file containing the symbol (absolute path, or relative / ~/ path resolved against the session cwd)",
        }),
        line: Type.Integer({
          minimum: 1,
          description:
            "1-based line number where the symbol appears (any occurrence works, not only the definition)",
        }),
        symbol: Type.String({
          minLength: 1,
          description: "The symbol's name exactly as it appears on that line",
        }),
        new_name: Type.String({ minLength: 1, description: "The new name for the symbol" }),
        character: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "1-based character offset of the symbol on that line. Only needed when the tool reports an ambiguity error on this line",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();

      const filePath = resolvePathArg(ctx.cwd, params.file_path);
      let content: string;
      try {
        await stat(filePath);
        content = await readFile(filePath, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new Error(`File does not exist: ${filePath}`, { cause: error });
        }
        throw error;
      }

      const notify = (message: string, level: "info" | "warning" | "error") =>
        ctx.ui.notify(message, level);
      const options = { notify, signal };

      // ── 按 symbol 名枚举行内候选，逐候选探测与消歧 ────────────────────────
      const candidates = symbolCandidates(
        content,
        params.line - 1,
        params.symbol,
        params.character === undefined ? undefined : params.character - 1,
      );
      if (candidates.length === 0) {
        throw new Error(
          `Symbol "${params.symbol}" not found on line ${params.line} of ${filePath}. Read the file again and locate the symbol.`,
        );
      }
      const successes: { result: Awaited<ReturnType<typeof service.rename>> }[] = [];
      const notPossibleErrors: string[] = [];
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        try {
          const result = await service.rename({
            file: filePath,
            cwd: ctx.cwd,
            line: candidate.line,
            character: candidate.character,
            newName: params.new_name,
            options,
          });
          successes.push({ result });
        } catch (error) {
          if (error instanceof RenameNotPossibleError) {
            notPossibleErrors.push(error.message);
            continue;
          }
          throw error;
        }
      }
      if (successes.length === 0) {
        throw new RenameNotPossibleError(
          notPossibleErrors.length > 0
            ? notPossibleErrors.join("; ")
            : `no renameable symbol "${params.symbol}" on line ${params.line} of ${filePath}`,
        );
      }

      // 同一符号的多次出现编辑集合一致；不一致即为不同符号 → 要求补 character
      const groups = new Map<
        string,
        { result: (typeof successes)[number]["result"]; candidates: typeof candidates }
      >();
      for (const [index, candidate] of candidates.entries()) {
        const entry = successes.at(index);
        if (!entry) continue;
        const key = canonicalizeEdit(entry.result.edit);
        const group = groups.get(key);
        if (group) group.candidates.push(candidate);
        else groups.set(key, { result: entry.result, candidates: [candidate] });
      }
      if (groups.size > 1) {
        const listing = [...groups.values()]
          .map((group) =>
            group.candidates
              .map(
                (candidate) =>
                  `- line ${candidate.line + 1}, column ${candidate.character + 1} (rename target: ${group.result.placeholder ?? "unknown"})`,
              )
              .join("\n"),
          )
          .join("\n");
        throw new Error(
          `Ambiguous rename target on line ${params.line} of ${filePath}: several distinct symbols share the name "${params.symbol}". Retry with 'character' (1-based) to pick one:\n${listing}`,
        );
      }
      const firstGroup = [...groups.values()].at(0);
      if (!firstGroup) throw new Error("LSP rename returned no target");
      const { result } = firstGroup;

      // ── 内存展开 → 审批 → 写盘 → 诊断 ────────────────────────────────────
      signal?.throwIfAborted();
      const applied = await expandWorkspaceEdit(result.edit, (path) => readFile(path, "utf8"));
      if (applied.length === 0) {
        throw new Error("LSP rename returned no edits");
      }
      for (const fileEdit of applied) {
        await guardWriteAccess(ctx, {
          toolName: "lsp-rename",
          absolutePath: fileEdit.path,
          change: { oldText: fileEdit.oldText, newText: fileEdit.newText },
        });
      }

      const diffs: string[] = [];
      for (const fileEdit of applied) {
        await withFileMutationQueue(fileEdit.path, async () => {
          await writeFile(fileEdit.path, fileEdit.newText, "utf8");
        });
        diffs.push(
          `### ${fileEdit.path} (${fileEdit.changeCount} edit(s))\n\n\`\`\`diff\n${generateDiffString(fileEdit.oldText, fileEdit.newText).diff}\n\`\`\``,
        );
      }
      const reads = hooks.recordReads === undefined ? undefined : await hooks.recordReads(applied);

      let diagnosticText = "";
      for (const fileEdit of applied) {
        signal?.throwIfAborted();
        const diagnostics = await service.lspDiagnosticsForFile(fileEdit.path, ctx.cwd, {
          notify,
          signal,
        });
        if (diagnostics.text !== "") diagnosticText += `${diagnostics.text}\n`;
      }

      const renamed =
        result.placeholder !== undefined && result.placeholder !== params.new_name
          ? `'${result.placeholder}' -> '${params.new_name}'`
          : `to '${params.new_name}'`;
      const summary = `Renamed ${renamed} across ${applied.length} file(s).`;
      const text =
        diagnosticText === ""
          ? summary
          : `${summary}\n\nLSP diagnostics detected in renamed files:\n${diagnosticText.trimEnd()}`;

      return {
        content: [{ type: "text" as const, text }],
        details: {
          ...(reads !== undefined && { reads }),
          pendant: {
            title: "lsp-rename",
            subtitle: `${renamed} · ${applied.length} file(s)`,
            markdown: diffs.join("\n\n"),
          } satisfies ToolPendant,
        },
      };
    },
  });
}
