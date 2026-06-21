import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("bash", event) && event.input.timeout === undefined) {
      event.input.timeout = 180;
    }
  });
}
