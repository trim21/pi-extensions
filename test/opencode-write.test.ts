/**
 * Tests for the opencode-aligned write extension:
 * - resolveBom: desiredBom = source.bom || next.bom
 */
import { describe, expect, it } from "vitest";

import { resolveBom } from "../src/opencode-write.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe("resolveBom", () => {
  it("new file without BOM keeps content as-is", () => {
    expect(resolveBom(undefined, "hello")).toEqual({ bom: "", text: "hello" });
  });

  it("new file with BOM keeps the content BOM", () => {
    expect(resolveBom(undefined, "\uFEFFhello")).toEqual({ bom: "\uFEFF", text: "hello" });
  });

  it("existing BOM is preserved even when new content has none", () => {
    expect(resolveBom(UTF8_BOM, "hello")).toEqual({ bom: "\uFEFF", text: "hello" });
  });

  it("existing BOM wins over the new content BOM", () => {
    expect(resolveBom(UTF8_BOM, "\uFEFFhello")).toEqual({ bom: "\uFEFF", text: "hello" });
  });

  it("existing file without BOM falls back to the new content BOM", () => {
    expect(resolveBom(Buffer.from("abc"), "\uFEFFhello")).toEqual({
      bom: "\uFEFF",
      text: "hello",
    });
  });

  it("short existing buffer (no full BOM) falls back to the new content BOM", () => {
    expect(resolveBom(Buffer.from([0xef, 0xbb]), "\uFEFFhello")).toEqual({
      bom: "\uFEFF",
      text: "hello",
    });
  });
});
