import { describe, expect, it } from "vitest";

import { jsoncToJson } from "../src/lib/jsonc.js";

describe("jsoncToJson", () => {
  it("strips line and block comments", () => {
    const out = jsoncToJson(`{
  // line comment
  "a": 1, /* block
    comment */ "b": 2,
}`);
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
  });

  it("keeps comment markers inside string literals", () => {
    const out = jsoncToJson(`{ "url": "https://example.com/a//b", "x": 1 }`);
    expect(JSON.parse(out)).toEqual({ url: "https://example.com/a//b", x: 1 });
  });

  it("keeps escaped quotes inside strings", () => {
    const out = jsoncToJson(String.raw`{ "note": "say \"hi\"", "a": 1 }`);
    expect(JSON.parse(out)).toEqual({ note: 'say "hi"', a: 1 });
  });

  it("drops trailing commas", () => {
    const out = jsoncToJson(`{ "a": 1, "b": [1, 2,], }`);
    expect(JSON.parse(out)).toEqual({ a: 1, b: [1, 2] });
  });
});
