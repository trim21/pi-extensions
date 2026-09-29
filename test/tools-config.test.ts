import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  parseToolsConfig,
  readToolsConfig,
  resolveFileIoToolset,
  resolveToolAvailability,
  type ToolsConfig,
} from "../src/lib/tools-config.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function config(section: unknown): ToolsConfig {
  return parseToolsConfig(section);
}

describe("personalExtensions 解析", () => {
  it("未配置时使用默认值且无警告", () => {
    const parsed = config(undefined);

    expect(parsed.fileIo).toBe("claude-code");
    expect(parsed.fileIoByModel).toEqual([]);
    expect(parsed.disabledTools).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("section 不是对象时给出警告", () => {
    const parsed = config("nope");

    expect(parsed.fileIo).toBe("claude-code");
    expect(parsed.warnings).toEqual(["personalExtensions: expected an object, ignored"]);
  });

  it("fileIo 非法取值时回退默认值并警告", () => {
    const parsed = config({ fileIo: "opencode2" });

    expect(parsed.fileIo).toBe("claude-code");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("personalExtensions.fileIo");
    expect(parsed.warnings[0]).toContain("opencode2");
  });

  it("fileIoByModel 逐条解析，非法条目被忽略", () => {
    const parsed = config({
      fileIoByModel: [
        { models: ["glm-*"], fileIo: "opencode" },
        { models: ["x"], fileIo: "vim" },
        "nope",
      ],
    });

    expect(parsed.fileIoByModel).toEqual([{ models: ["glm-*"], fileIo: "opencode" }]);
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings[0]).toContain("personalExtensions.fileIoByModel[1]");
    expect(parsed.warnings[1]).toContain("personalExtensions.fileIoByModel[2]");
  });

  it("工具规则支持字符串与对象两种写法", () => {
    const parsed = config({
      disabledTools: ["talk-*", { tools: ["web_*"], models: ["gpt-*"] }],
      enabledTools: [{ tools: ["web_search"], models: ["glm-*"] }],
    });

    expect(parsed.disabledTools).toEqual([
      { tools: ["talk-*"], models: [] },
      { tools: ["web_*"], models: ["gpt-*"] },
    ]);
    expect(parsed.enabledTools).toEqual([{ tools: ["web_search"], models: ["glm-*"] }]);
    expect(parsed.warnings).toEqual([]);
  });

  it("非法规则条目被忽略并警告，其余仍生效", () => {
    const parsed = config({ disabledTools: [42, { tools: "web_search" }, "Read"] });

    expect(parsed.disabledTools).toEqual([{ tools: ["Read"], models: [] }]);
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings[0]).toContain("personalExtensions.disabledTools[0]");
    expect(parsed.warnings[1]).toContain("personalExtensions.disabledTools[1]");
  });

  it("字段不是数组时给出警告并按空处理", () => {
    const parsed = config({ disabledTools: "Read" });

    expect(parsed.disabledTools).toEqual([]);
    expect(parsed.warnings).toEqual([
      "personalExtensions.disabledTools: expected an array, ignored",
    ]);
  });
});

describe("工具集与工具可用性判定", () => {
  it("fileIoByModel 按顺序取首条命中，未命中回退 fileIo", () => {
    const parsed = config({
      fileIo: "claude-code",
      fileIoByModel: [
        { models: ["glm-*"], fileIo: "opencode" },
        { models: ["*"], fileIo: "claude-code" },
      ],
    });

    expect(resolveFileIoToolset(parsed, { id: "glm-4.6" })).toBe("opencode");
    expect(resolveFileIoToolset(parsed, { id: "gpt-5" })).toBe("claude-code");
    expect(resolveFileIoToolset(parsed, undefined)).toBe("claude-code");
  });

  it("模型名同时匹配 provider/model", () => {
    const parsed = config({ fileIoByModel: [{ models: ["zhipu/*"], fileIo: "opencode" }] });

    expect(resolveFileIoToolset(parsed, { id: "glm-4.6", provider: "zhipu" })).toBe("opencode");
    expect(resolveFileIoToolset(parsed, { id: "glm-4.6", provider: "other" })).toBe("claude-code");
  });

  it("通配禁用与 enabledTools 豁免", () => {
    const parsed = config({
      disabledTools: ["talk-*", "web_*"],
      enabledTools: [{ tools: ["web_search"], models: ["glm-*"] }],
    });

    const onGlm = resolveToolAvailability(parsed, { id: "glm-4.6" });
    const onGpt = resolveToolAvailability(parsed, { id: "gpt-5" });

    expect(onGlm.isDisabled("talk-send")).toBe(true);
    expect(onGlm.isDisabled("web_search")).toBe(false);
    expect(onGpt.isDisabled("web_search")).toBe(true);
    expect(onGpt.isDisabled("Read")).toBe(false);
  });

  it("带 models 的规则只在模型命中时生效", () => {
    const parsed = config({ disabledTools: [{ tools: ["web_*"], models: ["gpt-*"] }] });

    expect(resolveToolAvailability(parsed, { id: "gpt-5" }).isDisabled("web_fetch")).toBe(true);
    expect(resolveToolAvailability(parsed, { id: "glm-4.6" }).isDisabled("web_fetch")).toBe(false);
    expect(resolveToolAvailability(parsed, undefined).isDisabled("web_fetch")).toBe(false);
  });

  it("报告匹配不到任何工具的模式（含被禁用的工具名）", () => {
    const parsed = config({
      disabledTools: ["talk-*", "web_*"],
      enabledTools: ["nope_*"],
    });

    const availability = resolveToolAvailability(parsed, { id: "gpt-5" });

    expect(availability.unmatchedPatterns(["Read", "talk-send"])).toEqual([
      { field: "disabledTools", pattern: "web_*" },
      { field: "enabledTools", pattern: "nope_*" },
    ]);
    expect(availability.unmatchedPatterns(["Read", "talk-send", "web_search"])).toEqual([
      { field: "enabledTools", pattern: "nope_*" },
    ]);
  });
});

describe("readToolsConfig", () => {
  it("读取 settings.json 的 personalExtensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tools-config-"));
    tempDirs.push(dir);
    const file = join(dir, "settings.json");
    await writeFile(
      file,
      JSON.stringify({
        theme: "dark",
        personalExtensions: { fileIo: "opencode", disabledTools: ["Read"] },
      }),
    );

    const parsed = readToolsConfig(file);

    expect(parsed.fileIo).toBe("opencode");
    expect(parsed.disabledTools).toEqual([{ tools: ["Read"], models: [] }]);
  });

  it("文件缺失或损坏时使用默认值", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tools-config-"));
    tempDirs.push(dir);
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{ not json");

    expect(readToolsConfig(join(dir, "missing.json")).fileIo).toBe("claude-code");
    expect(readToolsConfig(broken).fileIo).toBe("claude-code");
    expect(readToolsConfig(broken).warnings).toEqual([]);
  });
});
