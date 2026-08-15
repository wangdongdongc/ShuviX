/**
 * 最小 CDP 客户端 —— Node 22+ 全局 WebSocket / fetch，零额外依赖。
 *
 * 只封装 e2e 需要的一件事：对页面执行 Runtime.evaluate（returnByValue + awaitPromise），
 * 页内异常转为带截断详情的 Error 抛出。
 */

export interface CdpTarget {
  type: string
  url: string
  webSocketDebuggerUrl: string
}

export interface CdpClient {
  /** 在页面上下文执行表达式（自动 await Promise，按值返回） */
  eval<T = unknown>(expression: string): Promise<T>
  close(): void
}

/** 列出实例的调试目标（/json） */
export async function listTargets(port: number): Promise<CdpTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json`)
  return (await res.json()) as CdpTarget[]
}

/** 主窗口页面判别（区别于设置窗口 #settings 与 devtools 目标） */
export function isMainPage(t: CdpTarget): boolean {
  return t.type === 'page' && t.url.includes('out/renderer') && !t.url.includes('#settings')
}

export function connect(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolveClient, rejectClient) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 0
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

    ws.onopen = () => {
      resolveClient({
        async eval<T>(expression: string): Promise<T> {
          const id = ++nextId
          const result = await new Promise<unknown>((resolve, reject) => {
            pending.set(id, { resolve, reject })
            ws.send(
              JSON.stringify({
                id,
                method: 'Runtime.evaluate',
                params: { expression, returnByValue: true, awaitPromise: true }
              })
            )
          })
          const r = result as {
            exceptionDetails?: unknown
            result?: { value?: unknown }
          }
          if (r.exceptionDetails) {
            throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 800))
          }
          return r.result?.value as T
        },
        close() {
          ws.close()
        }
      })
    }
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number
        error?: unknown
        result?: unknown
      }
      if (!msg.id || !pending.has(msg.id)) return
      const { resolve, reject } = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
    ws.onerror = () => rejectClient(new Error(`CDP connect failed: ${wsUrl}`))
  })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 轮询直到 fn 返回真值；超时抛错（带 what 说明） */
export async function until<T>(
  fn: () => T | Promise<T>,
  what: string,
  timeoutMs = 25_000
): Promise<NonNullable<T>> {
  const t0 = Date.now()
  for (;;) {
    let value: T | undefined
    try {
      value = await fn()
    } catch {
      /* 轮询期错误视为未就绪 */
    }
    if (value) return value as NonNullable<T>
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting: ${what}`)
    await sleep(400)
  }
}
