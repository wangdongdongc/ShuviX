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
  /**
   * 发一条任意 CDP 命令、回它的 result（协议错误抛）。`eval` 之外的少数几件事靠它 ——
   * 例如 `Input.insertText`：CodeMirror 6 不认合成的 keydown / beforeinput，往编辑器里「打字」
   * 只能走浏览器自己的可信输入（见 pages.ts 的 markdownWindowPane）。
   */
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  close(): void
}

/** 列出实例的调试目标（/json） */
export async function listTargets(port: number): Promise<CdpTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json`)
  return (await res.json()) as CdpTarget[]
}

/**
 * 副窗口的 hash —— 它们与主窗口加载同一个 renderer 入口，只靠 hash 区分。
 * 漏掉任何一个，那个窗口一开着 harness 就可能把它当成主窗口（浏览器窗口由 spec 经侧栏按钮 /
 * openWindow 打开，漏掉它会让 browser 区的 spec 时好时坏）。
 */
const SECONDARY_WINDOW_HASHES = [
  '#settings',
  '#pinned-chat',
  '#widget-window',
  '#browser-window',
  '#markdown-window'
]

/**
 * 主窗口页面判别（区别于各副窗口与 devtools 目标）。
 *
 * `appUrl` 给定时还要求 target 属于**该 checkout 的产物目录** —— 端口被别的实例占着时
 * Chromium 不报错也不换端口，`/json` 回的是那个实例的 target，长相与自己的一模一样
 * （见 launch.ts 的端口说明）。
 */
export function isMainPage(t: CdpTarget, appUrl?: string): boolean {
  if (t.type !== 'page' || !t.url.includes('out/renderer')) return false
  if (SECONDARY_WINDOW_HASHES.some((hash) => t.url.includes(hash))) return false
  return !appUrl || t.url.startsWith(appUrl)
}

/** 浏览器独立窗口的页面判别 */
export function isBrowserWindowPage(t: CdpTarget, appUrl?: string): boolean {
  if (t.type !== 'page' || !t.url.includes('out/renderer') || !t.url.includes('#browser-window')) {
    return false
  }
  return !appUrl || t.url.startsWith(appUrl)
}

/**
 * 从系统打开的 md 窗口（#markdown-window?sessionId=…&path=…）的页面判别。
 * 一个文件一个窗口，所以可能有好几个 —— 按 hash 里的 path 区分（见 markdownWindowOf）。
 */
export function isMarkdownWindowPage(t: CdpTarget, appUrl?: string): boolean {
  if (t.type !== 'page' || !t.url.includes('out/renderer') || !t.url.includes('#markdown-window')) {
    return false
  }
  return !appUrl || t.url.startsWith(appUrl)
}

/** md 窗口 target 的 hash 解开（与渲染端 MarkdownWindowShell.parseHash 同一种读法） */
export function markdownWindowOf(t: CdpTarget): { sessionId: string; path: string } | null {
  const at = t.url.indexOf('#markdown-window')
  if (at < 0) return null
  const hash = t.url.slice(at + 1)
  const q = hash.indexOf('?')
  if (q < 0) return null
  const params = new URLSearchParams(hash.slice(q + 1))
  const sessionId = params.get('sessionId')
  const path = params.get('path')
  return sessionId && path ? { sessionId, path } : null
}

/**
 * 连一个页面 target。
 *
 * socket 一关（页面被关、窗口被销毁、target 崩了），在途与之后的 `eval` 一律**失败**，不挂着：
 * 没有这条时，`eval('window.close()')` 与回包赛跑输掉的那一次会永远等不到回包（`.catch` 也接不住
 * —— 根本没有 rejection），`until` 卡在那一拍上查不了自己的截止时间，最后只剩 vitest 光秃秃的
 * 60s 用例超时、没有现场（AM-9 的偶发超时就是这么来的）。`until` 把轮询期的失败当「未就绪」，
 * 所以失败只会把「无限挂起」变成「有界超时 + 现场」。关着的 socket 上 `send` 是静默丢弃的，
 * 所以之后的调用也要先看状态。
 */
export function connect(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolveClient, rejectClient) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 0
    let closed = false
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

    /** 发一条命令、等它的应答（socket 已关则立刻失败，理由见上） */
    const send = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        throw new Error(`CDP socket closed: ${wsUrl}`)
      }
      const id = ++nextId
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    }

    ws.onopen = () => {
      resolveClient({
        send,
        async eval<T>(expression: string): Promise<T> {
          const result = await send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
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
    ws.onclose = () => {
      closed = true
      for (const { reject } of pending.values()) reject(new Error(`CDP socket closed: ${wsUrl}`))
      pending.clear()
      // 还没 open 就关了：连接本身失败（已 resolve 过的话这句是 no-op）
      rejectClient(new Error(`CDP socket closed before open: ${wsUrl}`))
    }
  })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 超时现场取证 —— `launchApp` 注册，`until` 超时时调一次，产物拼进错误消息。
 *
 * 为什么做成全局注册而不是给 until 加参数：调用点有上百处，逐处传 dump 函数是纯噪声，
 * 而想知道的东西（页面态 / 消息行 / 页内报错）每处都一样。注册失败或 dump 自己出错一律
 * 静默降级 —— 取证是附赠品，不能把一次失败变成另一种失败。
 */
type TimeoutDiagnostic = () => string | Promise<string>
let diagnostic: TimeoutDiagnostic | null = null

export function setTimeoutDiagnostic(fn: TimeoutDiagnostic | null): void {
  diagnostic = fn
}

async function forensics(): Promise<string> {
  if (!diagnostic) return ''
  try {
    const text = await Promise.race([
      Promise.resolve(diagnostic()),
      sleep(3000).then(() => '(diagnostic timed out)')
    ])
    return text ? `\n--- page at timeout ---\n${text}` : ''
  } catch (e) {
    return `\n--- page at timeout: dump failed: ${(e as Error).message} ---`
  }
}

/**
 * 轮询直到 fn 返回真值；超时抛错（带 what 说明 + 现场取证）。
 *
 * 错误消息里带 **polls / 每轮耗时**：这一个数就把两类失败分开了 —— 轮询次数接近
 * `timeoutMs / 400`（本例 ~62）说明每次 eval 都很快、渲染进程活着，是**状态压根没到**；
 * 次数远小于它说明每次往返都在等，是**机器或渲染进程被拖住**。没有这个数的时候，两种
 * 失败在日志里长得一模一样，只能靠反复重跑对照去猜（那正是它一直难查的原因）。
 */
export async function until<T>(
  fn: () => T | Promise<T>,
  what: string,
  timeoutMs = 25_000
): Promise<NonNullable<T>> {
  const t0 = Date.now()
  let polls = 0
  let slowest = 0
  for (;;) {
    let value: T | undefined
    const p0 = Date.now()
    try {
      value = await fn()
    } catch {
      /* 轮询期错误视为未就绪 */
    }
    polls++
    slowest = Math.max(slowest, Date.now() - p0)
    if (value) return value as NonNullable<T>
    const elapsed = Date.now() - t0
    if (elapsed > timeoutMs) {
      const stats = `after ${(elapsed / 1000).toFixed(1)}s, ${polls} polls, slowest poll ${slowest}ms`
      throw new Error(`timeout waiting: ${what} (${stats})${await forensics()}`)
    }
    await sleep(400)
  }
}
