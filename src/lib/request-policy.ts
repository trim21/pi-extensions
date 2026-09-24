/**
 * 非沙盒请求策略：用户执行 `/bwrap-deny-request` 后，模型的提权请求
 * （bash 的 `dangerouslyDisableSandbox`、编辑类工具的工作区外写入）不再弹审批框，
 * 一律按用户「无理由拒绝」处理；`/bwrap-allow-request` 恢复审批。
 *
 * pi 给每个扩展入口单独建 jiti 实例（loader 里 `moduleCache: false`），模块级状态
 * 不跨入口共享，所以策略实例由各入口的工厂创建，生命周期随扩展实例，聚合入口
 * （claude-code / opencode 的 index.ts）创建一份注入给文件工具与 bash runtime。
 *
 * 需要跨入口一致时（独立入口的 web_fetch 也要跟随同一个开关）把 `pi.events` 传进来：
 * 变更广播给同进程内所有订阅者，订阅由 loader 随扩展卸载自动撤销。
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** 策略广播频道；同进程内各入口的策略副本据此保持同步。 */
export const REQUEST_POLICY_CHANNEL = "bwrap:request-policy";

const requestPolicyMessageSchema = Type.Object({ denyRequests: Type.Boolean() });

export type RequestPolicyMessage = Static<typeof requestPolicyMessageSchema>;

export interface RequestPolicy {
  /** 是否拒绝一切非沙盒请求（不弹审批框，直接拒绝）。 */
  deniesRequests(): boolean;
  setDenyRequests(deny: boolean): void;
}

/** 不传 events 时策略只在本入口内生效（测试与不需要跨入口同步的场景）。 */
export function createRequestPolicy(events?: EventBus): RequestPolicy {
  let denyRequests = false;

  events?.on(REQUEST_POLICY_CHANNEL, (data) => {
    if (Value.Check(requestPolicyMessageSchema, data)) {
      denyRequests = data.denyRequests;
    }
  });

  return {
    deniesRequests: () => denyRequests,
    setDenyRequests(deny: boolean) {
      denyRequests = deny;
      events?.emit(REQUEST_POLICY_CHANNEL, { denyRequests: deny } satisfies RequestPolicyMessage);
    },
  };
}
