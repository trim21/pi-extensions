/**
 * 本仓库的统一扩展入口：所有工具都在这里注册。
 *
 * 为什么是单一入口：pi 给每个扩展入口单独的模块图，模块级状态不跨入口共享
 * （两套文件 IO 工具集、LSP 服务、bwrap runtime 都各自持有状态），而且只有集中
 * 在一处，`personalExtensions` 配置（`fileIo` / `fileIoByModel` / `disabledTools`
 * / `enabledTools`）才有一个唯一的求值点。
 *
 * 注册时机：pi 在每次会话启动（启动、/new、resume、fork、/reload）时重建扩展，
 * 所以在 `session_start` 里注册即「每个会话按自己的模型判定一次」。模型在扩展
 * 加载期读不到（`ctx.model` 只在事件里），这是注册放在 session_start 的原因。
 *
 * 模块划分：两套文件 IO 工具集（claude-code / opencode）由 `ToolUnit` 表描述，
 * 其余工具模块暴露 `createXxx(pi)`；各模块的默认导出保留给「按路径单独加载」
 * （手工 `-e`），本入口直接调用 createXxx，因此一个实例里只有一份模块状态。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createAftTools } from "./aft/index.js";
import { createClaudeCodeFileTools } from "./claude-code/files.js";
import { createCodemodeTools } from "./codemode/tool.js";
import { createGithubTools } from "./gh/index.js";
import type { ToolBus } from "./lib/tool-bus.js";
import { createToolRegistration } from "./lib/tool-registration.js";
import { createToolServices } from "./lib/tool-services.js";
import { TOOL_UNITS, type ToolUnitDeps } from "./lib/tool-units.js";
import { resolveFileIoToolset } from "./lib/tools-config.js";
import { createOpencodeFileTools } from "./opencode/files.js";
import { createSpawnAgentTool } from "./spawn-agent.js";
import { createTalkTools } from "./talk/index.js";
import { createVisionTools } from "./vision-agent.js";
import { createWebFetch } from "./web/fetch.js";
import { createWebSearchTool } from "./web/search.js";

/** 只做工具注册、以及自己那些与会话无关的钩子的模块。 */
interface ToolModule {
  register(bus: ToolBus): void;
}

export default function personalExtensions(pi: ExtensionAPI): void {
  const registration = createToolRegistration(pi);
  // 共享服务要在 registration 之后创建：LSP manager 的 session_start handler 得
  // 排在「记录本会话模型」的 handler 之后。
  const services = createToolServices(pi);

  // 与文件工具集无关的模块（各自在 create 里注册自己的会话钩子与提示）。
  const modules: { name: string; module: ToolModule }[] = [];
  const addModule = (name: string, module: ToolModule | undefined): void => {
    if (module) {
      modules.push({ name, module });
    }
  };
  addModule("github", createGithubTools());
  addModule("vision", createVisionTools());
  addModule("talk", createTalkTools(pi));
  addModule("spawn-agent", createSpawnAgentTool());
  addModule("web_search", createWebSearchTool());
  addModule("web_fetch", createWebFetch(pi));
  const aft = createAftTools(pi);
  const codemode = createCodemodeTools(pi);

  // 注册期的失败攒起来，在会话启动时一次性上报（那里才有 UI）。
  const warnings: string[] = [];

  /** 单个模块/单元注册失败不影响其余：记下失败，继续注册。 */
  function runModule<T>(name: string, run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async function runModuleAsync<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  registration.onSessionStart(async (bus, ctx) => {
    // 配置解析期的警告是稳定的，注册期的失败每个会话重新收集（避免跨会话重复上报）。
    warnings.length = 0;
    warnings.push(...registration.config.warnings);

    // 文件工具集跟着本会话的模型走（会话内切换模型不重建扩展，因此不重判）。
    const kind = resolveFileIoToolset(registration.config, ctx.model);
    const fileToolset =
      kind === "opencode"
        ? createOpencodeFileTools(pi, {
            policy: services.policy,
            bus,
            manager: services.manager,
          })
        : createClaudeCodeFileTools(pi, {
            policy: services.policy,
            bus,
            manager: services.manager,
          });
    services.setLspEnabledHandler((service) => fileToolset.onLspEnabled(bus, service));
    runModule(kind, () => fileToolset.restoreReads(ctx));

    const deps: ToolUnitDeps = {
      pi,
      bus,
      policy: services.policy,
      runtime: services.runtime,
      fileToolset,
    };
    for (const unit of TOOL_UNITS[kind]) {
      runModule(unit.tools.join("/"), () => unit.register(deps));
    }

    // aft 的二进制探测、bridge 状态与工具注册绑在一起（找不到二进制就不注册）。
    await runModule("aft", () => aft.registerForSession(bus, ctx));
    for (const { name, module } of modules) {
      runModule(name, () => module.register(bus));
    }
    // codemode 最后注册：它把总线上已有的工具写进自己的描述，并在注册时编译 wasm。
    // 脚本的 fs 原语与文件工具共用请求策略与已读记账，所以这里把工具集那两份注入过去。
    await runModuleAsync("codemode", () =>
      codemode.register(bus, { policy: services.policy, reads: fileToolset.reads }),
    );

    // 注册期的可诊断问题（例如 codemode-only 命中但没有结构化输出的工具）与其它警告一起上报。
    warnings.push(...registration.diagnostics());

    for (const warning of warnings) {
      ctx.ui.notify(warning, "warning");
    }
    for (const { field, pattern } of registration.unmatchedPatterns()) {
      ctx.ui.notify(`personalExtensions.${field}: pattern "${pattern}" matches no tool`, "warning");
    }
  });
}
