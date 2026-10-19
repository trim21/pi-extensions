/**
 * request-headers —— 给每个 provider 请求附加当前会话 id。
 *
 * 监听 before_provider_headers，把 Thread-Id 覆盖为当前会话 id，供网关侧按
 * 会话追踪与归属请求。会话 id 在每次请求时读取，resume / fork / 新建会话后
 * 自动跟随。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function requestHeaders(pi: ExtensionAPI) {
  pi.on("before_provider_headers", (event, ctx) => {
    event.headers["Thread-Id"] = ctx.sessionManager.getSessionId();
  });
}
