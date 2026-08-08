import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

export default function bashDefaultTimeout(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("bash", event) && event.input.timeout === undefined) {
      event.input.timeout = 180;
    }
  });
}
