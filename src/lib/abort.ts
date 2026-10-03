/**
 * 把调用方的取消信号与一个本地超时合并成单个 AbortSignal。
 *
 * 调用方可能不传 signal（例如 agent 空闲时的 `ctx.signal`），那时仍然要有超时兜底，
 * 所以本地 `AbortSignal.timeout` 始终生效，两者都触发时以先到者为准。
 */
export function withTimeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
