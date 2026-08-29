/**
 * 按行消费输出流：data 事件按 buffer 边界切分，行可能跨多个 chunk，
 * 这里拼接缓冲后按 \n 逐行回调（回调不含换行符）。
 * 回调返回 false 可提前停止消费；流的 error 会以 rejection 形式抛出。
 */
export async function forEachLine(
  stream: NodeJS.ReadableStream,
  callback: (line: string) => boolean | void,
): Promise<void> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (callback(line) === false) return;
    }
  }
}
