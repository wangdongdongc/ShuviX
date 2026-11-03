/**
 * 等一个 promise，signal 一落就以它的 reason 失败（底下的事情照样做完，这里只是不再等）。
 *
 * 工具里等重配、等连接都要过它：工具不结束，`conversation.abort` 就不返回，而回退正是先立起闸门、再等这个中止 ——
 * 停在闸门上的重配和等它的工具就互相等死了。
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // 不再等它了，但它之后失败不该变成未处理的拒绝
    promise.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
