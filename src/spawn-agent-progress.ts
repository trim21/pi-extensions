/**
 * Progress state machine for the `spawn_agent` tool.
 *
 * The parent sees a rolling log: `tool: <name>` lines for tool calls and
 * `text: <content>` lines for completed text blocks, keeping the last
 * `MAX_PROGRESS_LINES` lines. Consecutive tool calls are merged into a single
 * `tool:` line (`read x 2, glob`) and the merged content is folded to the
 * first/last 9 chars joined by `…`, so a burst of tool calls or a long text
 * block does not flood the window. Only a text block starts a new line —
 * thinking is a transient status line, so it does not break the merge across
 * turn boundaries. Line content is sanitized first: markdown marker characters
 * are stripped and whitespace (including newlines) is collapsed to single
 * spaces, so one log entry is always exactly one rendered line.
 *
 * The rendered panel is the window, then an optional transient
 * `thinking ( N chars )` line while the model is thinking, then a fixed footer
 * line: the subagent name as a code span (`` `scout` ``) followed by the live
 * usage stats when there are any. The thinking line and the footer ride
 * outside the rolling window, so the footer is never trimmed. The model name
 * on the footer is the model the session actually uses, which differs from the
 * frontmatter string when the declared model resolved to nothing and the SDK
 * fell back to a default.
 *
 * State is held in the closure of a `createSubagentProgress` instance, one per
 * run. The `noteX` methods only mutate state and return nothing; pushing the
 * rendered text to the host (`onUpdate`) is the caller's job, so the caller
 * decides when a state change is worth a refresh.
 */

/**
 * Progress log keeps only the most recent lines (rolling window).
 * 展开后面板最多 6 行内容：4 行日志 + 可能的一行瞬态 thinking + 固定的 metadata 行。
 */
const MAX_PROGRESS_LINES = 4;
/** Progress line content (without the `tool:` / `text:` prefix) is capped at 21 chars; longer text is folded to the first/last 9 chars joined by ` … `. */
const MAX_PROGRESS_CHARS_PER_LINE = 21;
/**
 * 进度内容会被 pi 按 markdown 渲染，这些标记字符会改变显示效果（代码块、粗体、
 * 链接、标题等），因此在进日志前统一删掉。
 */
const PROGRESS_MARKDOWN_MARKERS_RE = /[`*_~[\]<>#|]/g;

/** 进度面板要展示的运行统计（`runAgent` 的 `result.usage`）。 */
export interface ProgressUsage {
  turns: number;
  cost: number;
  contextTokens: number;
}

/** 一次子代理运行的进度状态机：改状态用 `noteX`，取文本用 `render`。 */
export interface SubagentProgress {
  /** 工具调用开始：合并进当前 `tool:` 行。 */
  noteToolCall(rawName: string): void;
  /** 一个完成的 text 块：作为 `text:` 行写入并打断工具合并。 */
  noteTextBlock(content: string): void;
  /** thinking 开始：打开瞬态行（计数从 0 开始）。 */
  thinkingStart(): void;
  /** thinking 增量：累加字符数。 */
  thinkingDelta(length: number): void;
  /** thinking 结束：关闭瞬态行。 */
  thinkingEnd(): void;
  /** 渲染面板：滚动窗口 + 瞬态 thinking 行 + footer。 */
  render(usage: ProgressUsage, model?: string): string;
}

/**
 * Fold over-long progress line content: keep the first/last 9 chars joined by
 * ` … ` (space, ellipsis, space), so the folded line never exceeds
 * `MAX_PROGRESS_CHARS_PER_LINE` chars (9 + 3 + 9 = 21). Shorter text is
 * returned as-is.
 */
function foldProgressLine(text: string): string {
  if (text.length <= MAX_PROGRESS_CHARS_PER_LINE) {
    return text;
  }
  const keep = Math.floor((MAX_PROGRESS_CHARS_PER_LINE - 3) / 2);
  return `${text.slice(0, keep)} … ${text.slice(-keep)}`;
}

/**
 * 进度行是「单行内容 + markdown 渲染」：内容里的换行会打乱按行滚动的窗口，
 * markdown 标记会改变渲染效果。先删掉标记字符，再把换行/制表符/连续空格折成
 * 单个空格并去掉首尾空白，保证一条日志恒为一行。
 */
function sanitizeProgressLine(text: string): string {
  return text.replaceAll(PROGRESS_MARKDOWN_MARKERS_RE, "").replaceAll(/\s+/g, " ").trim();
}

/**
 * token 计数的可读格式。进度面板 footer 与 spawn_agent 的输出截断提示共用，
 * 改动会同时影响两处。
 */
export function formatTokens(count: number): string {
  if (count < 1000) {
    return count.toString();
  }
  if (count < 10_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  if (count < 1_000_000) {
    return `${Math.round(count / 1000)}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsageStats(usage: ProgressUsage, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) {
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  }
  if (usage.cost) {
    parts.push(`$${usage.cost.toFixed(4)}`);
  }
  if (usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) {
    parts.push(model);
  }
  return parts.join(" ");
}

function toolSegment(name: string, count: number): string {
  return count > 1 ? `${name} x ${count}` : name;
}

/**
 * Create the progress state machine for one subagent run.
 *
 * `maxLines` only controls the rolling window of log lines — the transient
 * thinking line and the footer ride outside it. Defaults to
 * `MAX_PROGRESS_LINES`.
 */
export function createSubagentProgress(options: {
  /** 面板标题（子代理名）。 */
  name: string;
  /** 滚动窗口行数，缺省 4。 */
  maxLines?: number;
}): SubagentProgress {
  const maxLines = options.maxLines ?? MAX_PROGRESS_LINES;
  let logLines: string[] = [];
  // 工具调用行合并:连续的 tool_execution_start 事件合并在同一 `tool:` 行
  // (如 `tool: read x 2, glob`),相同工具名连续出现时计为 `name x N`,
  // 不同名按调用顺序罗列;只有写入日志行的事件(text 块)打断合并,thinking
  // 不写日志行、也不打断合并。
  let toolLineSegments: string[] = [];
  let toolLine: { name: string; count: number } | undefined;
  // 思考中状态：thinkingStart 打开、thinkingDelta 累计字符数、thinkingEnd
  // 关闭；非 undefined 时 render 在 footer 上方插一行瞬态 thinking 状态。
  let thinkingChars: number | undefined;

  function pushLogLine(line: string) {
    logLines.push(line);
    if (logLines.length > maxLines) {
      logLines = logLines.slice(-maxLines);
    }
    // 写进日志的新行都会打断工具调用合并,下一批调用另起一行。
    toolLine = undefined;
  }

  function appendToolLine(rawName: string) {
    const name = sanitizeProgressLine(rawName);
    const firstInBatch = toolLine === undefined;
    if (toolLine === undefined) {
      toolLineSegments = [];
      toolLine = { name, count: 1 };
    } else if (toolLine.name === name) {
      toolLine.count++;
    } else {
      toolLineSegments.push(toolSegment(toolLine.name, toolLine.count));
      toolLine = { name, count: 1 };
    }
    const parts = [...toolLineSegments, toolSegment(toolLine.name, toolLine.count)].join(", ");
    const line = `tool: ${foldProgressLine(parts)}`;
    if (firstInBatch) {
      logLines.push(line);
      if (logLines.length > maxLines) {
        logLines = logLines.slice(-maxLines);
      }
    } else {
      logLines[logLines.length - 1] = line;
    }
  }

  return {
    noteToolCall: appendToolLine,
    noteTextBlock(content) {
      pushLogLine(`text: ${foldProgressLine(sanitizeProgressLine(content))}`);
    },
    thinkingStart() {
      thinkingChars = 0;
    },
    thinkingDelta(length) {
      thinkingChars = (thinkingChars ?? 0) + length;
    },
    thinkingEnd() {
      thinkingChars = undefined;
    },
    render(usage, model) {
      // 最后一行固定是「子代理名 + 运行中统计」：名字用 code span 标出，进度流里
      // 一眼能看出属于哪个 subagent；usage 与它同行，TUI 始终能看到实时 token 开销。
      // 这行位于滚动窗口之外，因此永远不会被挤掉。
      const usageLine = formatUsageStats(usage, model);
      const name = sanitizeProgressLine(options.name);
      const footer = usageLine ? `\`${name}\` ${usageLine}` : `\`${name}\``;
      const lines = [...logLines];
      if (thinkingChars !== undefined) {
        lines.push(`thinking ( ${thinkingChars} chars )`);
      }
      lines.push(footer);
      return lines.join("\n");
    },
  };
}
