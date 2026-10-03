import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // bootstrap.ts 由 node 在沙箱子进程里加载，覆盖数据不在测试进程内（它的行为由
      // test/codemode.test.ts 端到端覆盖：每个沙箱用例都在跑它）。
      exclude: ["src/lib/pendant.ts", "src/codemode/bootstrap.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
