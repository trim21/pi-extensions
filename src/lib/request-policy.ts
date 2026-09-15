/**
 * 非沙盒请求策略：用户执行 `/bwrap-deny-request` 后，模型的提权请求
 * （bash 的 `dangerouslyDisableSandbox`、编辑类工具的工作区外写入）不再弹审批框，
 * 一律按用户「无理由拒绝」处理；`/bwrap-allow-request` 恢复审批。
 *
 * 状态由闭包持有（AGENTS.md：不用模块级可变变量维护跨调用状态）。
 * 模块级单例让互相独立的扩展入口（bwrap runtime、claude-code / opencode 的文件工具、
 * lsp-rename、web_fetch）共享同一份会话状态——各入口分别 createRequestPolicy()
 * 会得到互不相通的策略，等于开关只对其中一半生效。
 */

export interface RequestPolicy {
  /** 是否拒绝一切非沙盒请求（不弹审批框，直接拒绝）。 */
  deniesRequests(): boolean;
  setDenyRequests(deny: boolean): void;
}

export function createRequestPolicy(): RequestPolicy {
  let denyRequests = false;
  return {
    deniesRequests: () => denyRequests,
    setDenyRequests(deny: boolean) {
      denyRequests = deny;
    },
  };
}

/** 进程级共享的策略实例；由 `/bwrap-deny-request` / `/bwrap-allow-request` 切换，session_start 复位。 */
export const requestPolicy = createRequestPolicy();
