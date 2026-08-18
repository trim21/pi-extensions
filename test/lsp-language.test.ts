import { describe, expect, it } from "vitest";

import { LANGUAGE_EXTENSIONS } from "../src/lib/lsp/language.js";

describe("lsp language mapping", () => {
  it("常见扩展名映射正确", () => {
    expect(LANGUAGE_EXTENSIONS[".ts"]).toBe("typescript");
    expect(LANGUAGE_EXTENSIONS[".tsx"]).toBe("typescriptreact");
    expect(LANGUAGE_EXTENSIONS[".js"]).toBe("javascript");
    expect(LANGUAGE_EXTENSIONS[".py"]).toBe("python");
    expect(LANGUAGE_EXTENSIONS[".c"]).toBe("c");
    expect(LANGUAGE_EXTENSIONS[".cpp"]).toBe("cpp");
    expect(LANGUAGE_EXTENSIONS[".go"]).toBe("go");
    expect(LANGUAGE_EXTENSIONS[".rs"]).toBe("rust");
  });
});
