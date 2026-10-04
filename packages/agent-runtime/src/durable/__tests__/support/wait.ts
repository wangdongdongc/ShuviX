/**
 * 真实计时器下的等待工具。打开 Harness 的测试文件绝不用 vi.useFakeTimers —— durable 的节流、
 * 重试退避、关停都跑在真实时间上。所有 abort / close / continue / delete 都包一层 withTimeout，
 * 挂住时报清楚是哪一步，而不是整个用例超时。
 */

/** 轮询 `check`（5ms 一次）直到成立；超时抛出带标签的错误 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  label = 'condition'
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`)
    await sleep(5)
  }
}

/** `promise` 在 `ms` 内落定，否则以带标签的错误拒绝 */
export function withTimeout<T>(promise: Promise<T>, ms = 5000, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export interface Deferred<T = void> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** signal 一中止就以其 reason 拒绝（给「等到被取消为止」的处理函数用） */
export function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
