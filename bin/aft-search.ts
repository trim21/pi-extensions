#!/usr/bin/env node
/* eslint-disable no-console -- 独立 CLI：直接写 stdout/stderr */

/**
 * 命令行版 aft_search：与 pi 扩展走同一 bridge 代码路径（createAftState +
 * callAftTool），只是把「工具调用」换成 argv。参数解析用 citty。
 *
 *   pnpm aft-search 'ORM 如何构建并执行查询'
 *   pnpm aft-search '^export function' --path ~/other/proj --top-k 20 --include-tests
 *
 * 约定：
 *   - 结果文本走 stdout，诊断信息一律以 `# ` 前缀走 stderr，便于分开重定向。
 *   - 语义索引首次构建会阻塞到完成（最长约 10 分钟），与 aft_search 工具行为一致。
 *   - 语义搜索未配置（未开 semantic_search 或未配外部 embedding 后端）时警告后
 *     继续跑词法搜索，不像扩展那样直接不注册工具。
 *   - 退出码：成功 0，用法错误 2，执行失败 1（SIGINT/SIGTERM 为 130/143）。
 */

import { resolve } from "node:path";

import { resolveCortexKitConfigPaths } from "@cortexkit/aft-bridge";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineCommand, runMain } from "citty";

import {
  callAftTool,
  createAftState,
  SEMANTIC_INDEX_WAIT_TIMEOUT_MS,
  shutdownAftPool,
} from "../src/aft/bridge.js";
import { loadAftConfig } from "../src/aft/config.js";
import { compactArgs } from "../src/aft/tools.js";
import { expandHome } from "../src/lib/path.js";

type AftState = Awaited<ReturnType<typeof createAftState>>;

/** 当前 bridge 状态：信号退出时释放子进程，避免遗留常驻 aft 进程。 */
const activeState: { current: AftState | null } = { current: null };

function diagnose(text: string): void {
  console.error(`# ${text}`);
}

function releaseActiveState(): void {
  const current = activeState.current;
  activeState.current = null;
  if (current) {
    void shutdownAftPool(current.pool).catch((error: unknown) => {
      diagnose(`释放 bridge 失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function search(flags: {
  query: string;
  path?: string;
  topK?: number;
  includeTests?: boolean;
}): Promise<number> {
  const root = resolve(expandHome(flags.path ?? process.cwd()));

  const cfg = loadAftConfig(resolveCortexKitConfigPaths(root).userConfigPath);
  if (!cfg.enabled) {
    diagnose(`AFT 已在用户级 aft.jsonc 中禁用（enabled: false），项目根：${root}`);
    return 1;
  }
  if (!cfg.semanticRemote || !cfg.semanticSearch) {
    diagnose(
      "语义搜索未启用（aft.jsonc 未开 semantic_search 或未配外部 embedding 后端），本次走词法搜索",
    );
  }

  const state = await createAftState(root, undefined, cfg.semanticRemote);
  activeState.current = state;
  try {
    const bridge = state.pool.pool.getBridge(root);
    const rawArgs = compactArgs({
      query: flags.query,
      topK: flags.topK,
      includeTests: flags.includeTests,
    });
    // CLI 没有 session，传空 context（callAftTool 只读 sessionManager）；
    // 超时策略与 aft_search 工具一致：覆盖默认 60s，容纳首次索引构建等待。
    const { text } = await callAftTool(
      bridge,
      "search",
      rawArgs,
      {} as unknown as ExtensionContext,
      {
        transportTimeoutMs: SEMANTIC_INDEX_WAIT_TIMEOUT_MS + 60_000,
        keepBridgeOnTimeout: true,
      },
    );
    console.log(text);
    return 0;
  } finally {
    releaseActiveState();
    await state.logger.drain();
  }
}

const command = defineCommand({
  meta: {
    name: "aft-search",
    description:
      "命令行版 aft_search：概念、标识符、错误串、正则、字面量、文件名自动路由到合适的引擎" +
      "并按相关度排序。语义索引首次构建会阻塞到完成（最长约 10 分钟）。",
  },
  args: {
    query: {
      type: "positional",
      required: true,
      description: "搜索意图：概念、标识符、错误串、正则、字面量或文件名",
    },
    path: {
      type: "string",
      description: "目标项目根（支持 ~），默认当前目录",
      valueHint: "<dir>",
    },
    "top-k": {
      // citty 0.2 没有 number 类型，收到后自行转换校验
      type: "string",
      description: "最大结果数（1-100，默认 10）",
      valueHint: "<n>",
    },
    "include-tests": {
      type: "boolean",
      description: "包含测试文件（默认排除）",
    },
  },
  async run({ args }) {
    let topK: number | undefined;
    if (args["top-k"] !== undefined) {
      topK = Number(args["top-k"]);
      if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100) {
        diagnose(`--top-k 需要一个 1-100 的整数，收到 '${args["top-k"]}'`);
        process.exit(2);
      }
    }
    try {
      process.exitCode = await search({
        query: args.query,
        path: args.path,
        topK,
        includeTests: args["include-tests"] === true,
      });
    } catch (error) {
      diagnose(`失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
});

process.on("SIGINT", () => {
  releaseActiveState();
  process.exit(130);
});
process.on("SIGTERM", () => {
  releaseActiveState();
  process.exit(143);
});

await runMain(command);
