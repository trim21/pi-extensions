import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadAftConfig } from "../src/aft/config.js";

describe("loadAftConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "aft-config-test-"));
  const written = (name: string, content: string) => {
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  };

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults when file is missing", () => {
    expect(loadAftConfig(join(dir, "missing.jsonc"))).toEqual({
      enabled: true,
      semanticSearch: false,
      semanticRemote: undefined,
    });
  });

  it("reads enabled and semantic_search", () => {
    const file = written("ok.jsonc", '{ "enabled": false, "semantic_search": true }');
    expect(loadAftConfig(file)).toEqual({
      enabled: false,
      semanticSearch: true,
      semanticRemote: undefined,
    });
  });

  it("accepts an openai-compatible backend with base_url", () => {
    const file = written(
      "openai.jsonc",
      '{ "semantic_search": true, "semantic": { "backend": "openai_compatible", "base_url": "https://gateway.internal/v1/" } }',
    );
    expect(loadAftConfig(file).semanticRemote).toEqual({
      backend: "openai_compatible",
      baseUrl: "https://gateway.internal/v1",
    });
  });

  it("accepts ollama as an external backend", () => {
    const file = written(
      "ollama.jsonc",
      '{ "semantic": { "backend": "ollama", "base_url": "http://127.0.0.1:11434" } }',
    );
    expect(loadAftConfig(file).semanticRemote).toEqual({
      backend: "ollama",
      baseUrl: "http://127.0.0.1:11434",
    });
  });

  it("reads an inline api key value for the extension to inject", () => {
    const file = written(
      "api-key.jsonc",
      '{ "semantic": { "backend": "openai_compatible", "base_url": "https://gw.internal/v1", "api_key": "  sk-test  " } }',
    );
    expect(loadAftConfig(file).semanticRemote).toMatchObject({ apiKey: "sk-test" });
  });

  it("keeps a user-specified key variable name", () => {
    const file = written(
      "api-key-env.jsonc",
      '{ "semantic": { "backend": "ollama", "base_url": "http://127.0.0.1:11434", "api_key_env": "MY_EMBED_KEY" } }',
    );
    expect(loadAftConfig(file).semanticRemote).toMatchObject({
      apiKeyEnv: "MY_EMBED_KEY",
      apiKey: undefined,
    });
  });

  it("rejects the local onnx fastembed backend", () => {
    const file = written(
      "fastembed.jsonc",
      '{ "semantic_search": true, "semantic": { "backend": "fastembed" } }',
    );
    expect(loadAftConfig(file).semanticRemote).toBeUndefined();
  });

  it("requires base_url before treating a backend as ready", () => {
    const file = written(
      "no-url.jsonc",
      '{ "semantic_search": true, "semantic": { "backend": "openai_compatible" } }',
    );
    expect(loadAftConfig(file).semanticRemote).toBeUndefined();
  });

  it("rejects an unknown backend name", () => {
    const file = written(
      "unknown.jsonc",
      '{ "semantic": { "backend": "milvus", "base_url": "https://x.internal/v1" } }',
    );
    expect(loadAftConfig(file).semanticRemote).toBeUndefined();
  });

  it("parses JSONC comments and trailing commas", () => {
    const file = written(
      "comments.jsonc",
      `{
        // line comment
        "enabled": false, /* block comment */
        "semantic_search": true,
      }`,
    );
    expect(loadAftConfig(file)).toEqual({
      enabled: false,
      semanticSearch: true,
      semanticRemote: undefined,
    });
  });

  it("does not misparse // inside string values (URLs)", () => {
    const file = written(
      "url.jsonc",
      '{ "semantic": { "base_url": "https://example.com/api" }, "semantic_search": true }',
    );
    expect(loadAftConfig(file)).toEqual({
      enabled: true,
      semanticSearch: true,
      semanticRemote: undefined,
    });
  });

  it("fills defaults for missing fields", () => {
    const file = written("missing-fields.jsonc", '{ "semantic_search": true }');
    expect(loadAftConfig(file)).toEqual({
      enabled: true,
      semanticSearch: true,
      semanticRemote: undefined,
    });
  });

  it("falls back to defaults when a scalar has the wrong type", () => {
    const file = written("partial.jsonc", '{ "enabled": "yes", "semantic_search": "true" }');
    expect(loadAftConfig(file)).toEqual({
      enabled: true,
      semanticSearch: false,
      semanticRemote: undefined,
    });
  });

  it("falls back to defaults on invalid content", () => {
    const file = written("broken.jsonc", "{ not json");
    expect(loadAftConfig(file).enabled).toBe(true);
    expect(loadAftConfig(file).semanticSearch).toBe(false);
  });

  it("falls back to defaults when content is not an object", () => {
    const file = written("array.jsonc", "[1, 2, 3]");
    expect(loadAftConfig(file)).toEqual({
      enabled: true,
      semanticSearch: false,
      semanticRemote: undefined,
    });
  });

  it("falls back to defaults when semantic is not an object", () => {
    const file = written("semantic-string.jsonc", '{ "semantic": "openai_compatible" }');
    expect(loadAftConfig(file).semanticRemote).toBeUndefined();
  });
});
