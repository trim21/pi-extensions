import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadAftConfig } from "../src/aft/config.js";

describe("loadAftConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "aft-config-test-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults when file is missing", () => {
    expect(loadAftConfig(join(dir, "missing.jsonc"))).toEqual({
      enabled: true,
      semanticSearch: false,
    });
  });

  it("reads enabled and semantic_search", () => {
    const file = join(dir, "ok.jsonc");
    writeFileSync(file, '{ "enabled": false, "semantic_search": true }');
    expect(loadAftConfig(file)).toEqual({ enabled: false, semanticSearch: true });
  });

  it("parses JSONC comments and trailing commas", () => {
    const file = join(dir, "comments.jsonc");
    writeFileSync(
      file,
      `{
        // line comment
        "enabled": false, /* block comment */
        "semantic_search": true,
      }`,
    );
    expect(loadAftConfig(file)).toEqual({ enabled: false, semanticSearch: true });
  });

  it("does not misparse // inside string values (URLs)", () => {
    const file = join(dir, "url.jsonc");
    writeFileSync(
      file,
      '{ "semantic": { "base_url": "https://example.com/api" }, "semantic_search": true }',
    );
    expect(loadAftConfig(file)).toEqual({ enabled: true, semanticSearch: true });
  });

  it("defaults per-field when values are missing or non-boolean", () => {
    const file = join(dir, "partial.jsonc");
    writeFileSync(file, '{ "enabled": "yes", "semantic_search": "true" }');
    expect(loadAftConfig(file)).toEqual({ enabled: true, semanticSearch: false });
  });

  it("falls back to defaults on invalid content", () => {
    const file = join(dir, "broken.jsonc");
    writeFileSync(file, "{ not json");
    expect(loadAftConfig(file)).toEqual({ enabled: true, semanticSearch: false });
  });

  it("falls back to defaults when content is not an object", () => {
    const file = join(dir, "array.jsonc");
    writeFileSync(file, "[1, 2, 3]");
    expect(loadAftConfig(file)).toEqual({ enabled: true, semanticSearch: false });
  });
});
