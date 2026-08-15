/**
 * 按 key 串行化并发任务：同一 key 的调用排队执行，前一个 settle（无论成败）
 * 后才执行下一个。key 由调用方自定义（如资源 id），每个 `createSeqState()`
 * 返回独立的闭包状态，不同扩展之间不串扰。
 */

export interface SeqState {
  execute<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createSeqState(): SeqState {
  const tails = new Map<string, Promise<unknown>>();

  return {
    execute<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();

      // 等前一个任务 settle 后执行本任务。previous 恒为 resolve（tail 吞掉了错误），
      // 失败不会阻塞后续任务。
      const run = previous.then(() => fn());

      // 本任务的完成占位：永远 resolve，作为下一个任务的等待点。
      // eslint-disable-next-line unicorn/no-useless-undefined -- 显式返回 undefined：吞掉前序错误并归一化为成功占位
      const tail = run.catch(() => undefined);

      tails.set(key, tail);
      void tail.finally(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });

      return run;
    },
  };
}
