/**
 * 协作编辑的主进程一侧 —— 把 agent 的 doc_* 工具调用转给开着那份文档的窗口，等它的答复。
 *
 * 文档的事实源是那个窗口的编辑器缓冲（见 chat-protocol liveDocument.ts），所以读与改都得在渲染进程里
 * 做：这里只是一条有来有回的管道。一条会话至多挂一个窗口（markdownWindowService 开窗时 attach、
 * 关窗时 detach —— detach 让还在等的请求立刻失败，而不是等到超时）。
 *
 * 答复经 IPC `liveDoc:respond` 回来，**只认发请求的那个 webContents**：preload 的 window.api 会跟着
 * 窗口导航到任何页面，别的窗口不该能替这份文档作答。
 *
 * **同一条会话的请求逐个发**：pi 缺省并行执行一条消息里的几次工具调用，而窗口那边本来就逐个执行
 * （一次修改可能要等用户停手好几秒）。若一起发出，排在后面的请求会在还没轮到执行时就把自己的超时
 * 耗光 —— 所以这里排队，前一个了结才发下一个，超时从真正发出那一刻算。
 */
import type { WebContents } from 'electron'
import { randomUUID } from 'crypto'
import type { LiveDocOp, LiveDocRequest, LiveDocResult } from '@shuvix/chat-protocol/liveDocument'
import { createLogger } from '../logger'

const log = createLogger('LiveDocument')

/** 读几乎是即时的；改可能要等用户停手（渲染端最多等 10s），留足余量 */
const READ_TIMEOUT_MS = 15_000
const EDIT_TIMEOUT_MS = 45_000

interface Pending {
  sessionId: string
  sender: WebContents
  resolve: (result: LiveDocResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

/** sessionId → 开着这份文档的窗口 */
const targets = new Map<string, WebContents>()
const pending = new Map<string, Pending>()
/** sessionId → 这条会话上一个请求了结时 resolve 的 Promise（排队用） */
const lanes = new Map<string, Promise<unknown>>()

export function attachLiveDocument(sessionId: string, webContents: WebContents): void {
  targets.set(sessionId, webContents)
}

/** 窗口关了：解绑，并让这条会话还在等的请求立刻失败 */
export function detachLiveDocument(sessionId: string): void {
  targets.delete(sessionId)
  for (const [requestId, p] of pending) {
    if (p.sessionId !== sessionId) continue
    settle(requestId)?.reject(new Error('The document window was closed.'))
  }
}

function settle(requestId: string): Pending | undefined {
  const p = pending.get(requestId)
  if (!p) return undefined
  pending.delete(requestId)
  clearTimeout(p.timer)
  p.cleanup()
  return p
}

/**
 * 把一次操作交给这份文档的窗口执行，等它的结果。
 * 没有窗口 / 窗口没答复 / 被中止（signal）都以 Error 结束；操作本身失败（原文对不上等）是
 * `{ ok: false }` 的正常结果，由工具翻译给 agent。
 */
export function requestLiveDocument(
  sessionId: string,
  op: LiveDocOp,
  signal?: AbortSignal
): Promise<LiveDocResult> {
  const previous = lanes.get(sessionId) ?? Promise.resolve()
  let finish: () => void = () => {}
  const settled = new Promise<void>((r) => (finish = r))
  lanes.set(sessionId, settled)
  void settled.then(() => {
    if (lanes.get(sessionId) === settled) lanes.delete(sessionId)
  })
  return new Promise<LiveDocResult>((resolve, reject) => {
    let done = false
    // 排队期间被中止：立刻以中止了结，轮到它时也不发（前面那个可能还要等用户停手好几秒）
    const onQueuedAbort = (): void => {
      if (done) return
      done = true
      reject(new Error('Aborted.'))
    }
    signal?.addEventListener('abort', onQueuedAbort, { once: true })
    void previous.then(async () => {
      signal?.removeEventListener('abort', onQueuedAbort)
      try {
        if (done) return
        const result = await sendLiveDocument(sessionId, op, signal)
        done = true
        resolve(result)
      } catch (err) {
        done = true
        reject(err as Error)
      } finally {
        finish()
      }
    })
  })
}

function sendLiveDocument(
  sessionId: string,
  op: LiveDocOp,
  signal?: AbortSignal
): Promise<LiveDocResult> {
  const sender = targets.get(sessionId)
  if (!sender || sender.isDestroyed()) {
    return Promise.reject(new Error('No document window is open for this session.'))
  }
  if (signal?.aborted) return Promise.reject(new Error('Aborted.'))
  const requestId = randomUUID()
  return new Promise<LiveDocResult>((resolve, reject) => {
    const onAbort = (): void => {
      if (!settle(requestId)) return
      // 让渲染端收掉这次调用的虚影、别再等用户停手
      if (!sender.isDestroyed()) sender.send('liveDoc:cancel', { requestId })
      reject(new Error('Aborted.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeoutMs = op.kind === 'read' ? READ_TIMEOUT_MS : EDIT_TIMEOUT_MS
    const timer = setTimeout(() => {
      if (!settle(requestId)) return
      if (!sender.isDestroyed()) sender.send('liveDoc:cancel', { requestId })
      log.warn(`请求超时 session=${sessionId} op=${op.kind}`)
      reject(new Error('The document window did not respond in time.'))
    }, timeoutMs)
    pending.set(requestId, {
      sessionId,
      sender,
      resolve,
      reject,
      timer,
      cleanup: () => signal?.removeEventListener('abort', onAbort)
    })
    const request: LiveDocRequest = { requestId, sessionId, op }
    sender.send('liveDoc:request', request)
  })
}

/** IPC `liveDoc:respond` 的落点：只认发这次请求的那个窗口 */
export function resolveLiveDocumentResponse(
  sender: WebContents,
  requestId: string,
  result: LiveDocResult
): void {
  const p = pending.get(requestId)
  if (!p) return
  if (p.sender !== sender) {
    log.warn(`拒绝来自别的窗口的答复 request=${requestId}`)
    return
  }
  settle(requestId)?.resolve(result)
}
