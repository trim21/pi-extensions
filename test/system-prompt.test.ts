/**
 * Tests for the system-prompt extension:
 * - formatTools / formatGuidelines / formatContextFiles / formatSkills: block rendering
 * - buildPrompt: placeholder substitution and tail fallback
 * - buildSystemPromptText: full assembly against the real prompt.md
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPrompt,
  buildSystemPromptText,
  formatContextFiles,
  formatGuidelines,
  formatSkills,
  formatTools,
} from "../src/system-prompt/index.js";

const PROMPT_MD = readFileSync(
  fileURLToPath(new URL("../src/system-prompt/prompt.md", import.meta.url)),
  "utf8",
);

afterEach(() => {
  vi.useRealTimers();
});

describe("formatTools", () => {
  it("lists only tools that have snippets", () => {
    const tools = ["read", "bash", "custom"];
    const snippets = { read: "Read files", custom: "Custom thing" };
    expect(formatTools(tools, snippets)).toBe("- read: Read files\n- custom: Custom thing");
  });

  it("returns (none) when no tool has a snippet", () => {
    expect(formatTools(["read", "bash"], {})).toBe("(none)");
    expect(formatTools(undefined, undefined)).toBe("(none)");
  });
});

describe("formatGuidelines", () => {
  it("renders bullets under a Guidelines heading, trimmed", () => {
    expect(formatGuidelines(["Use custom_tool when scanning", "  padded  "])).toBe(
      "## Guidelines\n\n- Use custom_tool when scanning\n- padded",
    );
  });

  it("omits the block when empty", () => {
    expect(formatGuidelines(undefined)).toBe("");
    expect(formatGuidelines([])).toBe("");
    expect(formatGuidelines([" ".repeat(3)])).toBe("");
  });
});

describe("formatContextFiles", () => {
  it("renders project instructions inside a project_context block", () => {
    const out = formatContextFiles([{ path: "/a/AGENTS.md", content: "# Rules\n\nBe nice." }]);
    expect(out).toContain("<project_context>");
    expect(out).toContain(
      '<project_instructions path="/a/AGENTS.md">\n# Rules\n\nBe nice.\n</project_instructions>',
    );
    expect(out).toContain("</project_context>");
  });

  it("omits the block when empty", () => {
    expect(formatContextFiles(undefined)).toBe("");
    expect(formatContextFiles([])).toBe("");
  });
});

describe("formatSkills", () => {
  it("renders an available_skills block with name/description/location", () => {
    const out = formatSkills([
      { name: "review", description: "Review a PR", filePath: "/s/review/SKILL.md" },
    ]);
    expect(out).toContain("<available_skills>");
    expect(out).toContain("<name>review</name>");
    expect(out).toContain("<description>Review a PR</description>");
    expect(out).toContain("<location>/s/review/SKILL.md</location>");
    expect(out).toContain("</available_skills>");
  });

  it("escapes XML metacharacters", () => {
    const out = formatSkills([{ name: "a<b&c", description: 'quote " & <tag>', filePath: "/x" }]);
    expect(out).toContain("<name>a&lt;b&amp;c</name>");
    expect(out).toContain("<description>quote &quot; &amp; &lt;tag&gt;</description>");
  });

  it("excludes skills with disableModelInvocation", () => {
    expect(
      formatSkills([
        { name: "hidden", description: "d", filePath: "/h", disableModelInvocation: true },
      ]),
    ).toBe("");
  });

  it("omits the block when empty", () => {
    expect(formatSkills(undefined)).toBe("");
  });
});

describe("buildPrompt", () => {
  it("replaces placeholders with their blocks", () => {
    expect(buildPrompt("A {{tools}} B {{cwd}}", { tools: "- read: x", cwd: "/home" })).toBe(
      "A - read: x B /home",
    );
  });

  it("appends non-empty blocks whose placeholder is missing", () => {
    expect(buildPrompt("static text", { tools: "- read: x", date: "2026-04-16" })).toBe(
      "static text\n- read: x\n2026-04-16",
    );
  });

  it("replaces empty blocks with empty string", () => {
    expect(buildPrompt("A {{skills}} B", { skills: "" })).toBe("A  B");
  });
});

describe("buildSystemPromptText", () => {
  it("assembles the real prompt.md with all dynamic blocks", () => {
    vi.setSystemTime(new Date("2026-04-16T12:34:56Z"));
    const out = buildSystemPromptText(PROMPT_MD, {
      cwd: "/home/user/proj",
      selectedTools: ["read", "bash"],
      toolSnippets: { read: "Read files", bash: "Run commands" },
      promptGuidelines: ["Use read for files"],
      contextFiles: [{ path: "/home/user/proj/AGENTS.md", content: "rules" }],
      skills: [{ name: "review", description: "Review a PR", filePath: "/s/SKILL.md" }],
      appendSystemPrompt: "extra",
    });

    expect(out).toContain("You are an expert coding assistant operating inside pi");
    expect(out).toContain("- read: Read files\n- bash: Run commands");
    expect(out).toContain("## Guidelines\n\n- Use read for files");
    expect(out).toContain('<project_instructions path="/home/user/proj/AGENTS.md">');
    expect(out).toContain("<available_skills>");
    expect(out).toContain("extra");
    expect(out).toContain("Current date: 2026-04-16");
    expect(out).toContain("Current working directory: /home/user/proj");
    expect(out).not.toContain("{{");
  });

  it("handles missing dynamic data gracefully", () => {
    vi.setSystemTime(new Date("2026-04-16T00:00:00Z"));
    const out = buildSystemPromptText(PROMPT_MD, { cwd: "/tmp" });

    expect(out).toContain("(none)");
    expect(out).not.toContain("<available_skills>");
    expect(out).not.toContain("<project_context>");
    expect(out).not.toContain("## Guidelines");
    expect(out).toContain("Current date: 2026-04-16");
    expect(out).toContain("Current working directory: /tmp");
    expect(out).not.toContain("{{");
  });
});
