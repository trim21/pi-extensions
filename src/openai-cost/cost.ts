/**
 * 从 Chat Completions SSE 里截取 usage.cost，写回 AssistantMessage.usage.cost.total。
 * 内置 openai-completions 会用模型单价覆盖费用，必须在 fetch 层把上报值留下来。
 */
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface ReportedCostCapture {
  fetch: typeof globalThis.fetch;
  wait: () => Promise<number | undefined>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const usageCostSchema = Type.Object(
  {
    cost: Type.Optional(
      Type.Union([
        Type.Number(),
        Type.Object({ total: Type.Optional(Type.Number()) }, { additionalProperties: true }),
      ]),
    ),
  },
  { additionalProperties: true },
);

const chunkSchema = Type.Object(
  {
    usage: Type.Optional(usageCostSchema),
    choices: Type.Optional(
      Type.Array(
        Type.Object({ usage: Type.Optional(usageCostSchema) }, { additionalProperties: true }),
      ),
    ),
  },
  { additionalProperties: true },
);

function costFromUsage(
  usage: { cost?: number | { total?: number } } | undefined,
): number | undefined {
  if (!usage) return undefined;
  const asNumber = finiteNumber(usage.cost);
  if (asNumber !== undefined) return asNumber;
  if (usage.cost && typeof usage.cost === "object") return finiteNumber(usage.cost.total);
  return undefined;
}

/** 从 chat completions JSON 块读取上报费用：usage.cost 或 choice.usage.cost。 */
export function extractReportedCost(value: unknown): number | undefined {
  let chunk;
  try {
    chunk = Value.Parse(chunkSchema, value);
  } catch {
    return undefined;
  }
  const fromUsage = costFromUsage(chunk.usage);
  if (fromUsage !== undefined) return fromUsage;
  for (const choice of chunk.choices ?? []) {
    const fromChoice = costFromUsage(choice.usage);
    if (fromChoice !== undefined) return fromChoice;
  }
  return undefined;
}

export function costFromSseLine(line: string): number | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const data = trimmed.slice("data:".length).trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    return extractReportedCost(JSON.parse(data) as unknown);
  } catch {
    return undefined;
  }
}

export async function scanSseCost(body: ReadableStream<Uint8Array>): Promise<number | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last: number | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const cost = costFromSseLine(line);
        if (cost !== undefined) last = cost;
      }
    }
    buffer += decoder.decode();
    const cost = costFromSseLine(buffer);
    if (cost !== undefined) last = cost;
    return last;
  } catch {
    return last;
  } finally {
    reader.releaseLock();
  }
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function shouldScan(input: FetchInput, response: Response): boolean {
  if (!response.ok || !response.body) return false;
  if (requestUrl(input).includes("/chat/completions")) return true;
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("text/event-stream");
}

export function createReportedCostCapture(
  innerFetch: typeof globalThis.fetch,
): ReportedCostCapture {
  let scan: Promise<number | undefined> | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await innerFetch(input, init);
    if (!shouldScan(input, response) || !response.body) return response;
    const [forSdk, forScan] = response.body.tee();
    scan = scanSseCost(forScan);
    return new Response(forSdk, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return {
    fetch,
    wait: async () => (scan ? await scan : undefined),
  };
}

export function applyReportedCost(usage: Usage, reported: number): void {
  usage.cost.input = 0;
  usage.cost.output = 0;
  usage.cost.cacheRead = 0;
  usage.cost.cacheWrite = 0;
  usage.cost.total = reported;
}

function messageOf(event: AssistantMessageEvent): AssistantMessage {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return event.partial;
}

export function applyCostToEvent(
  event: AssistantMessageEvent,
  reported: number | undefined,
): AssistantMessageEvent {
  if (reported === undefined) return event;
  applyReportedCost(messageOf(event).usage, reported);
  return event;
}

export function wrapStreamWithReportedCost(
  inner: AssistantMessageEventStream,
  waitCost: () => Promise<number | undefined>,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of inner) {
        let reported: number | undefined;
        if (event.type === "done" || event.type === "error") {
          try {
            reported = await waitCost();
          } catch {
            reported = undefined;
          }
        }
        out.push(applyCostToEvent(event, reported));
      }
    } catch {
      // inner already terminated or failed; result() follows the inner events
    } finally {
      out.end();
    }
  })();
  return out;
}
