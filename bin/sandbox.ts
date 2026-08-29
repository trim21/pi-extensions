#!/usr/bin/env node
/* eslint-disable no-console -- 独立调试 CLI：直接写 stdout/stderr，退出码取自被沙箱命令 */

/**
 * bwrap 沙箱调试入口：加载一份 bwrap 配置，在同一条代码路径
 * （src/bwrap/sandbox.ts，与 pi 扩展层共用）里执行一条命令。参数解析用 citty。
 *
 *   pnpm sandbox --config=/tmp/net.json --verbose -- 'curl -sS https://pypi.org/simple/'
 *   pnpm sandbox --mode=readonly --print-args -- 'ls -al'
 *
 * 约定：
 *   - ` -- ` 之后只接受**一个**参数：整条命令的字符串，原样交给 `bash -lc` 解析，
 *     本 CLI 不做任何再转义，所以 `&&`、管道、`$()`、`*` 都与 pi 的 Bash 工具同语义。
 *     用你自己的 shell 引号包住整体：-- 'cd ~/tmp && ls'
 *   - `--print-args` 输出 JSON（argv 与环境变量按结构化数据给出，无 quoting 歧义）；
 *     命令输出走 stdout，诊断信息一律以 `# ` 前缀走 stderr，便于分开重定向。
 *   - 退出码即被执行命令的退出码（被信号杀死为 1；用法错误为 2）。
 */

import { resolve } from "node:path";

import { defineCommand, runMain } from "citty";

import { BWRAP_MODES, type BwrapMode } from "../src/bwrap/core.js";
import {
  HOLDER_PID_PLACEHOLDER,
  loadSandboxConfig,
  previewSandboxCommand,
  runInSandbox,
} from "../src/bwrap/sandbox.js";
import { expandHome } from "../src/lib/path.js";

function diagnose(text: string): void {
  console.error(`# ${text}`);
}

/** 用法/参数错误：打印到 stderr，退出码 2。 */
function usageError(message: string): never {
  diagnose(message);
  process.exit(2);
}

const command = defineCommand({
  meta: {
    name: "sandbox",
    description:
      "加载 bwrap 配置并在对应沙箱里执行一条命令（与 pi 扩展同一条代码路径）。\n" +
      "` -- ` 之后必须是单个参数：整条命令字符串，原样交给 bash -lc 解析" +
      "（&&、管道、$() 均可用），用你自己的 shell 引号包住整体。",
  },
  args: {
    config: {
      type: "string",
      description: "只用该配置文件；默认读 ~/.pi/agent/bwrap.json 与 <cwd>/.pi/bwrap.json",
      valueHint: "<path>",
    },
    cwd: {
      type: "string",
      description: "沙箱工作区（'.' 与 .git 只读保护的基准），默认当前目录",
      valueHint: "<path>",
    },
    workdir: {
      type: "string",
      description: "命令执行目录，默认同 --cwd",
      valueHint: "<path>",
    },
    mode: {
      type: "string",
      description: `覆盖配置中的 mode：${BWRAP_MODES.join(" | ")}`,
      valueHint: "<mode>",
    },
    timeout: {
      // citty 0.2 没有 number 类型，收到后自行转换校验
      type: "string",
      description: "命令超时秒数",
      valueHint: "<sec>",
    },
    "print-args": {
      type: "boolean",
      description: "以 JSON 打印将要执行的 argv 与环境变量（stdout）后退出，不执行",
    },
    verbose: {
      type: "boolean",
      description: "透传 netns holder（unshare/mihomo）与 slirp4netns 日志",
    },
    headless: {
      type: "boolean",
      description: "按无 UI 会话策略执行（强制 readonly）",
    },
  },
  async run({ args }) {
    const rest: string[] = args._;
    // 只接受一条命令字符串：多个 argv 说明整体没被引号包住，拼接会静默改变语义
    if (rest.length === 0) {
      usageError("缺少命令：用 ' -- ' 分隔选项与待执行命令");
    }
    if (rest.length > 1) {
      usageError(
        `待执行命令必须是单个字符串（收到 ${String(rest.length)} 个参数），` +
          `用引号包住整体：-- '${rest.join(" ")}'`,
      );
    }
    const command = rest[0] ?? "";

    let timeout: number | undefined;
    if (args.timeout !== undefined) {
      timeout = Number(args.timeout);
      if (!Number.isFinite(timeout) || timeout <= 0) {
        usageError(`--timeout 需要正数秒，收到 '${args.timeout}'`);
      }
    }

    let mode: BwrapMode | undefined;
    if (args.mode !== undefined) {
      if (!(BWRAP_MODES as readonly string[]).includes(args.mode)) {
        usageError(`未知 mode '${args.mode}'，可选：${BWRAP_MODES.join(", ")}`);
      }
      mode = args.mode as BwrapMode;
    }

    const verbose = args.verbose === true;
    const workspace = resolve(expandHome(args.cwd ?? process.cwd()));
    const commandCwd = resolve(expandHome(args.workdir ?? workspace));
    const configPath = args.config === undefined ? undefined : resolve(expandHome(args.config));
    const strategy = loadSandboxConfig({
      workspace,
      ...(configPath && { configPath }),
      ...(mode && { mode }),
      headless: args.headless === true,
    });
    const preview = strategy.bwrapEnabled
      ? await previewSandboxCommand(strategy, {
          workspace,
          commandCwd,
          command,
        })
      : undefined;

    const plan = [
      ["config", configPath ?? "全局 + 项目 bwrap.json"],
      ["workspace", workspace],
      ["exec cwd", commandCwd],
      [
        "mode",
        `${strategy.mode} (bwrap=${strategy.bwrapEnabled ? "on" : "off"}, network=${strategy.network ? "on" : "off"})`,
      ],
      ["writable", [...strategy.writablePaths, ...strategy.extraWritablePaths].join(", ") || "-"],
      ["deny", strategy.denyPaths.join(", ") || "-"],
      ["allowlist", strategy.networkAllowlist.join(", ") || "-"],
      ["approval rules", `${strategy.approvalRules.length} 条（CLI 不做审批，仅提示）`],
    ];
    // 要执行的命令行：argv 逐项 + 沙箱环境，结构化给出（不拼 shell 文本，无 quoting 歧义）
    const payload = preview === undefined ? undefined : { mode: strategy.mode, ...preview };
    const width = Math.max(...plan.map(([label]) => label.length));
    for (const [label, value] of plan) {
      diagnose(`${label.padEnd(width)}: ${value}`);
    }

    if (args["print-args"] === true) {
      if (!payload) {
        usageError(`${strategy.mode} 模式不经 bwrap，没有可打印的命令行`);
      }
      console.log(JSON.stringify(payload, null, 2));
      if (payload.needsNetworkStack) {
        diagnose(
          `argv 里的 ${HOLDER_PID_PLACEHOLDER} 是 netns holder pid 占位符：加 --verbose 实跑可看到真实 pid`,
        );
      }
      return;
    }
    // 实跑路径也打出真正执行的命令行（一行 JSON），否则只剩结果、看不到沙箱参数
    if (payload) {
      diagnose(`argv: ${JSON.stringify(payload)}`);
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    const started = Date.now();
    try {
      const { exitCode } = await runInSandbox(strategy, {
        workspace,
        commandCwd,
        command,
        onData: (data) => process.stdout.write(data),
        signal: controller.signal,
        ...(timeout !== undefined && { timeout }),
        ...(verbose && {
          log: {
            holder: (chunk: string) => diagnose(`[holder] ${chunk.trimEnd()}`),
          },
          onNetworkStack: (stack) => {
            diagnose(`netns holder pid: ${String(stack.holderPid)}`);
          },
        }),
      });
      diagnose(
        `exit=${String(exitCode ?? "killed-by-signal")} in ${String(Date.now() - started)}ms`,
      );
      process.exitCode = exitCode ?? 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || message.startsWith("timeout:"))
      ) {
        console.error(`# 命令超时（${message.slice("timeout:".length)} 秒）`);
      } else {
        console.error(`# 失败：${message}`);
      }
      if (verbose && error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  },
});

await runMain(command);
