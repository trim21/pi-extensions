import { describe, expect, it } from "vitest";

import { fenceCodeBlock } from "../src/lib/markdown.js";

describe("fenceCodeBlock", () => {
  it("uses three backticks when the content has none", () => {
    expect(fenceCodeBlock("hello", "diff")).toMatchInlineSnapshot(`
      "\`\`\`diff
      hello
      \`\`\`"
    `);
  });

  it("defaults to no language tag", () => {
    expect(fenceCodeBlock("hello")).toMatchInlineSnapshot(`
      "\`\`\`
      hello
      \`\`\`"
    `);
  });

  it("uses a longer fence when the content contains a ``` fence", () => {
    expect(fenceCodeBlock("```js\nx\n```", "diff")).toMatchInlineSnapshot(`
      "\`\`\`\`diff
      \`\`\`js
      x
      \`\`\`
      \`\`\`\`"
    `);
  });

  it("outruns the longest backtick run inside the content", () => {
    expect(fenceCodeBlock("a`` ``` ````b")).toMatchInlineSnapshot(`
      "\`\`\`\`\`
      a\`\` \`\`\` \`\`\`\`b
      \`\`\`\`\`"
    `);
  });
});
