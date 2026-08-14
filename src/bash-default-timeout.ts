import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

export default function bashDefaultTimeout(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    // opencode 风格 bash 的 timeout 单位是毫秒
    if (isToolCallEventType("bash", event) && event.input.timeout === undefined) {
      event.input.timeout = 180_000;
    }
  });
}
