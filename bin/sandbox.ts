#!/usr/bin/env node
/* eslint-disable no-console -- 独立调试 CLI：直接写 stdout/stderr，退出码取自被沙箱命令 */

/**
 * bwrap 沙箱调试入口：加载一份 bwrap 配置，在同一条代码路径
 * （src/bwrap/sandbox.ts，与 pi 扩展层共用）里执行一条命令。
 *
 *   pnpm sandbox --config=/tmp/net.json --verbose -- 'curl -sS https://pypi.org/simple/'
 *   tsx bin/sandbox.ts --mode=readonly --print-args -- 'ls -al'
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

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { BWRAP_MODES, type BwrapMode } from "../src/bwrap/core.js";
import {
  HOLDER_PID_PLACEHOLDER,
  loadSandboxConfig,
  previewSandboxCommand,
  runInSandbox,
} from "../src/bwrap/sandbox.js";
import { expandHome } from "../src/lib/path.js";

const flagsSchema = Type.Object({
  config: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  workdir: Type.Optional(Type.String()),
  mode: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number()),
  printArgs: Type.Optional(Type.Boolean()),
  verbose: Type.Optional(Type.Boolean()),
  headless: Type.Optional(Type.Boolean()),
  help: Type.Optional(Type.Boolean()),
});

type Flags = Static<typeof flagsSchema>;

interface Invocation {
  flags: Flags;
  /** ` -- ` 之后的整条命令字符串，原样交给 `bash -lc`。 */
  command: string;
}

/** 用法/参数错误：打印 usage，退出码 2。 */
class UsageError extends Error {}

const FLAG_KEYS: Record<string, keyof Flags> = {
  config: "config",
  cwd: "cwd",
  workdir: "workdir",
  mode: "mode",
  timeout: "timeout",
  "print-args": "printArgs",
  verbose: "verbose",
  headless: "headless",
  help: "help",
};

const BOOLEAN_FLAGS = new Set<keyof Flags>(["printArgs", "verbose", "headless", "help"]);

function parseInvocation(argv: string[]): Invocation {
  const separator = argv.indexOf("--");
  const flagTokens = separator === -1 ? argv : argv.slice(0, separator);
  const rest = separator === -1 ? [] : argv.slice(separator + 1);

  const raw: Record<string, unknown> = {};
  for (let index = 0; index < flagTokens.length; index++) {
    const token = flagTokens[index];
    if (token === "-h") {
      raw.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new UsageError(
        `意外的参数 '${token}'：待执行命令要放在 ' -- ' 之后，选项需用 '--名称' 写法`,
      );
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const name = equals === -1 ? body : body.slice(0, equals);
    const inline = equals === -1 ? undefined : body.slice(equals + 1);
    const key = FLAG_KEYS[name];
    if (!key) {
      throw new UsageError(`未知选项 '--${name}'`);
    }
    if (BOOLEAN_FLAGS.has(key)) {
      raw[key] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline ?? flagTokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`选项 '--${name}' 需要取值`);
    }
    if (inline === undefined) {
      index++;
    }
    raw[key] = value;
  }

  const converted: unknown = Value.Convert(flagsSchema, raw);
  if (!Value.Check(flagsSchema, converted)) {
    const [first] = [...Value.Errors(flagsSchema, converted)];
    throw new UsageError(`选项取值不合法：${first?.message ?? "与 schema 不匹配"}`);
  }
  // 只接受一条命令字符串：多个 argv 说明整体没被引号包住，拼接会静默改变语义
  if (converted.help !== true) {
    if (rest.length === 0) {
      throw new UsageError("缺少命令：用 ' -- ' 分隔选项与待执行命令");
    }
    if (rest.length > 1) {
      throw new UsageError(
        `待执行命令必须是单个字符串（收到 ${String(rest.length)} 个参数），` +
          `用引号包住整体：-- '${rest.join(" ")}'`,
      );
    }
  }
  return { flags: converted, command: rest[0] ?? "" };
}

function diagnose(text: string): void {
  console.error(`# ${text}`);
}

/** CLI 传入的 mode 是 string，BWRAP_MODES 是唯一真值来源，校验后收窄。 */
function parseMode(value: string | undefined, modes: readonly string[]): BwrapMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!modes.includes(value)) {
    throw new UsageError(`未知 mode '${value}'，可选：${modes.join(", ")}`);
  }
  return value as BwrapMode;
}

function usage(modes: readonly string[]): string {
  return [
    "Usage: tsx bin/sandbox.ts [options] -- '<command string>'",
    "",
    "加载 bwrap 配置并在对应沙箱里执行一条命令（与 pi 扩展同一条代码路径）。",
    "",
    "Options:",
    "  --config <path>   只用该配置文件；默认读 ~/.pi/agent/bwrap.json 与 <cwd>/.pi/bwrap.json",
    "  --cwd <path>      沙箱工作区（'.' 与 .git 只读保护的基准），默认当前目录",
    "  --workdir <path>  命令执行目录，默认同 --cwd",
    `  --mode <mode>     覆盖配置中的 mode：${modes.join(" | ")}`,
    "  --timeout <sec>   命令超时秒数",
    "  --headless        按无 UI 会话策略执行（强制 readonly）",
    "  --print-args      以 JSON 打印将要执行的 argv 与环境变量（stdout）后退出，不执行",
    "  --verbose         透传 netns holder（unshare/mihomo）与 slirp4netns 日志",
    "  -h, --help        显示本说明",
    "",
    "` -- ` 之后必须是单个参数：整条命令字符串，原样交给 bash -lc 解析（&&、管道、$() 均可用）。",
    "",
    "Examples:",
    "  tsx bin/sandbox.ts --mode=workspace-write -- 'pwd'",
    "  tsx bin/sandbox.ts --print-args -- 'ls -al'",
    "  tsx bin/sandbox.ts --mode=workspace-write --workdir ~/proj -- 'uv sync --upgrade'",
    "  tsx bin/sandbox.ts --config=/tmp/allowlist.json --verbose -- 'curl -sS https://pypi.org/simple/'",
  ].join("\n");
}

async function run(invocation: Invocation): Promise<number> {
  const { flags, command } = invocation;
  const verbose = flags.verbose === true;

  const workspace = resolve(expandHome(flags.cwd ?? process.cwd()));
  const commandCwd = resolve(expandHome(flags.workdir ?? workspace));
  const configPath = flags.config === undefined ? undefined : resolve(expandHome(flags.config));
  const mode = parseMode(flags.mode, BWRAP_MODES);
  const strategy = loadSandboxConfig({
    workspace,
    ...(configPath && { configPath }),
    ...(mode && { mode }),
    headless: flags.headless === true,
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
    ["approval rules", `${String(strategy.approvalRules.length)} 条（CLI 不做审批，仅提示）`],
  ];
  // 要执行的命令行：argv 逐项 + 沙箱环境，结构化给出（不拼 shell 文本，无 quoting 歧义）
  const payload = preview === undefined ? undefined : { mode: strategy.mode, ...preview };
  const width = Math.max(...plan.map(([label]) => label.length));
  for (const [label, value] of plan) {
    diagnose(`${label.padEnd(width)}: ${value}`);
  }

  if (flags.printArgs === true) {
    if (!payload) {
      throw new UsageError(`${strategy.mode} 模式不经 bwrap，没有可打印的命令行`);
    }
    console.log(JSON.stringify(payload, null, 2));
    if (payload.needsNetworkStack) {
      diagnose(
        `argv 里的 ${HOLDER_PID_PLACEHOLDER} 是 netns holder pid 占位符：加 --verbose 实跑可看到真实 pid`,
      );
    }
    return 0;
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
      ...(flags.timeout !== undefined && { timeout: flags.timeout }),
      ...(verbose && {
        log: {
          holder: (chunk: string) => diagnose(`[holder] ${chunk.trimEnd()}`),
        },
        onNetworkStack: (stack) => {
          diagnose(`netns holder pid: ${String(stack.holderPid)}`);
          diagnose(`mihomo config: ${stack.configPath}`);
        },
      }),
    });
    diagnose(`exit=${String(exitCode ?? "killed-by-signal")} in ${String(Date.now() - started)}ms`);
    return exitCode ?? 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

async function main(): Promise<void> {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(usage(BWRAP_MODES));
      process.exit(2);
    }
    throw error;
  }
  if (invocation.flags.help === true) {
    console.log(usage(BWRAP_MODES));
    return;
  }
  try {
    // 命令的存在性与「必须是单个参数」已由 parseInvocation 校验
    process.exitCode = await run(invocation);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || message.startsWith("timeout:"))
    ) {
      console.error(`# 命令超时（${message.slice("timeout:".length)} 秒）`);
    } else {
      console.error(`# 失败：${message}`);
    }
    if (invocation.flags.verbose === true && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

await main();
