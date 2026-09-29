/**
 * 共享工具服务：同一个扩展实例里的所有工具共用一份请求策略、bwrap runtime 与
 * LSP manager。
 *
 * 为什么必须共享：两套文件 IO 工具集各自创建 LSP manager 会重复注册 `/lsp-*`
 * 命令（命令名冲突）；各自创建 bwrap runtime 会重复注册 `/bwrap*` 命令。因此
 * 由入口创建一份、注入给选中的工具集。
 *
 * LSP 专属工具（lsp-rename / inspect 族）由「当前会话选中的工具集」注册，
 * 通过 `setLspEnabledHandler` 交给本模块——manager 在 session_start 之后才
 * 触发该回调，那时入口已完成工具集选择。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { BwrapConfig } from "../bwrap/core.js";
import { type BwrapRuntime, createBwrapRuntime } from "../bwrap/runtime.js";
import {
  createLspManager,
  type LspManager,
  type LspService,
  type LspServiceOptions,
} from "./lsp/lsp.js";
import { createRequestPolicy, type RequestPolicy } from "./request-policy.js";

export interface ToolServices {
  policy: RequestPolicy;
  runtime: BwrapRuntime;
  manager: LspManager;
  /** 由入口在选出本会话的工具集后设置。 */
  setLspEnabledHandler(handler: ((service: LspService) => void) | undefined): void;
}

export interface ToolServicesOptions extends LspServiceOptions {
  /** 固定沙箱配置（子代理用）；不传则跟随用户配置与 /bwrap-* 命令。 */
  sandbox?: BwrapConfig;
}

export function createToolServices(pi: ExtensionAPI, options?: ToolServicesOptions): ToolServices {
  const policy = createRequestPolicy(pi.events);
  const runtime = createBwrapRuntime(policy, options?.sandbox);
  // 注册 /bwrap* 命令、沙箱系统提示与 session 生命周期钩子；固定沙箱
  // （子代理）不注册命令，见 BwrapRuntime.setup。
  runtime.setup(pi);

  let delegate: ((service: LspService) => void) | undefined;
  // manager 的 session_start handler 注册在入口的注册回调之前（入口须先知道本会话
  // 的模型才能选出工具集），所以它触发 onEnabled 时 delegate 往往还没就位。先缓存
  // 服务，等 setLspEnabledHandler 调用时立即补发，注册不再依赖两者的先后顺序。
  let pendingService: LspService | undefined;
  const manager = createLspManager(
    pi,
    {
      onEnabled: (_pi, service) => {
        if (delegate) {
          delegate(service);
        } else {
          pendingService = service;
        }
      },
    },
    options,
  );

  return {
    policy,
    runtime,
    manager,
    setLspEnabledHandler(handler) {
      delegate = handler;
      if (!handler) {
        return;
      }
      const pending = pendingService;
      pendingService = undefined;
      if (pending) {
        handler(pending);
      }
    },
  };
}
