/**
 * system-prompt —— 完全替换 pi 默认 system prompt 的扩展。
 *
 * pi 的 SYSTEM.md 机制走 buildSystemPrompt 的 customPrompt 分支，该分支不生成
 * "Available tools" 列表（每个工具的 promptSnippet 说明），也不追加 skills，
 * 替换后模型对可用工具和技能的感知会明显变弱。本扩展用 before_agent_start
 * 钩子完全接管 system prompt：
 * - 静态主体来自同目录 prompt.md（手写行为准则，衍生自 Claude Code 的
 *   system prompt，剥离了 tool 相关说明）；
 * - 动态部分（工具列表、工具 guideline、AGENTS.md 上下文、skills、日期、
 *   cwd、--append-system-prompt 内容）用 event.systemPromptOptions 程序化
 *   拼装，渲染格式与 pi 默认 buildSystemPrompt 保持一致；
 * - prompt.md 中的 {{tools}} {{guidelines}} {{project_context}} {{skills}}
 *   {{append}} {{date}} {{cwd}} 占位符决定每个动态块的位置；占位符被删掉时
 *   对应块追加到末尾。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── types ────────────────────────────────────────────────────────────────────

/** skills 所需的字段（duck typing，不绑定 pi 内部 Skill 类型，便于测试） */
export interface SkillLike {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

/** 拼装 system prompt 所需的动态数据（取自 before_agent_start 的 systemPromptOptions） */
export interface PromptInputs {
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd: string;
  contextFiles?: { path: string; content: string }[];
  skills?: SkillLike[];
}

// ── 格式化（纯函数，可测试）─────────────────────────────────────────────────

/** XML 转义，格式与 pi 的 formatSkillsForPrompt 保持一致 */
function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * 渲染 Available tools 列表，与 pi 默认 buildSystemPrompt 一致：只列出有
 * snippet 的工具；一个都没有时显示 (none)。
 */
export function formatTools(
  selectedTools: string[] | undefined,
  toolSnippets: Record<string, string> | undefined,
): string {
  const lines: string[] = [];
  for (const name of selectedTools ?? []) {
    const snippet = toolSnippets?.[name];
    if (snippet) {
      lines.push(`- ${name}: ${snippet}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

/** 渲染工具特定 guideline 块；为空时整个块（含标题）省略。guide 本身是 md 文档，直接拼接。 */
export function formatGuidelines(promptGuidelines: string[] | undefined): string {
  const items = (promptGuidelines ?? []).map((g) => g.trim()).filter((g) => g.length > 0);
  if (items.length === 0) return "";
  return `## Guidelines\n\n${items.join("\n\n")}`;
}

/** 渲染 AGENTS.md 等上下文文件；为空时省略 */
export function formatContextFiles(
  contextFiles: { path: string; content: string }[] | undefined,
): string {
  if (!contextFiles || contextFiles.length === 0) return "";
  const inner = contextFiles
    .map(
      ({ path, content }) =>
        `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
    )
    .join("\n\n");
  return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${inner}\n\n</project_context>\n`;
}

/**
 * 渲染 skills 的 <available_skills> 块，格式与 pi 的 formatSkillsForPrompt
 * 一致；disableModelInvocation 的 skill 不展示；为空时省略。
 */
export function formatSkills(skills: SkillLike[] | undefined): string {
  const visible = (skills ?? []).filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push(
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    );
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

// ── 拼装 ─────────────────────────────────────────────────────────────────────

export interface DynamicBlocks {
  tools?: string;
  guidelines?: string;
  projectContext?: string;
  skills?: string;
  append?: string;
  date?: string;
  cwd?: string;
}

/**
 * 用动态块替换 prompt.md 中的 {{token}} 占位符。占位符缺失的块在非空时
 * 追加到末尾，这样删掉 prompt.md 里某个占位符只是把该块移到尾部。
 */
export function buildPrompt(staticText: string, blocks: DynamicBlocks): string {
  let prompt = staticText;
  const entries: [string, string][] = [
    ["tools", blocks.tools ?? ""],
    ["guidelines", blocks.guidelines ?? ""],
    ["project_context", blocks.projectContext ?? ""],
    ["skills", blocks.skills ?? ""],
    ["append", blocks.append ?? ""],
    ["date", blocks.date ?? ""],
    ["cwd", blocks.cwd ?? ""],
  ];
  for (const [key, value] of entries) {
    const token = `{{${key}}}`;
    if (prompt.includes(token)) {
      prompt = prompt.split(token).join(value);
    } else if (value) {
      prompt += `\n${value}`;
    }
  }
  return prompt;
}

/** 生成完整 system prompt：静态主体 + 程序化拼装的动态块（含当前日期与 cwd） */
export function buildSystemPromptText(promptMd: string, options: PromptInputs): string {
  const now = new Date();
  const date = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return buildPrompt(promptMd, {
    tools: formatTools(options.selectedTools, options.toolSnippets),
    guidelines: formatGuidelines(options.promptGuidelines),
    projectContext: formatContextFiles(options.contextFiles),
    skills: formatSkills(options.skills),
    append: options.appendSystemPrompt,
    date,
    cwd: options.cwd,
  });
}

// ── extension ────────────────────────────────────────────────────────────────

/** prompt.md 相对本模块的路径（import.meta.url 保证打包/链接后仍可解析） */
const PROMPT_PATH = fileURLToPath(new URL("prompt.md", import.meta.url));

export default function systemPromptExtension(pi: ExtensionAPI) {
  // 模块加载时读一次并缓存；prompt.md 随扩展分发，缺失时直接抛错（扩展
  // 加载失败会显示可定位的错误），不静默降级。
  const staticPrompt = readFileSync(PROMPT_PATH, "utf8");

  // 每轮替换 system prompt。返回的 systemPrompt 是最终值，完全覆盖 pi
  // 默认 prompt（含 SYSTEM.md / --system-prompt 内容）。
  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: buildSystemPromptText(staticPrompt, event.systemPromptOptions),
    };
  });
}
