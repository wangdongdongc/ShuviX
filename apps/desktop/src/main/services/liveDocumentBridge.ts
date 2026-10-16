/**
 * 协作编辑的主进程一侧 —— 把 agent 的 doc_* 工具调用转给正显示着那份文档的编辑器，等它的答复；
 * 没有编辑器显示它时交给调用方给的磁盘回落（tools/doc.ts）执行。
 *
 * 文档的事实源是那个编辑器的缓冲（见 chat-protocol liveDocument.ts），所以读与改都得在渲染进程里
 * 做：这里只是一条有来有回的管道。**挂接由编辑器自己报**（渲染端 useCoEditing：CM6 视图建好时 attach、
 * 销毁时 detach，带一个自己取的 attachId）—— 主窗口切走 / 切回一条笔记本会话、从系统打开的 md 窗口、
 * 固定窗口，都是同一条路。同一条会话可能同时有几个编辑器挂着（两个窗口开着同一条笔记、重挂载时的交接），
 * 请求发给**最后挂上的那个**；它摘下了就轮到前一个，都摘下了就走磁盘。窗口销毁 / 整页重载（主框架导航）
 * 时摘掉它挂的全部。detach 让发给那个编辑器、还在等的请求立刻失败，而不是等到超时。
 *
 * 答复经 IPC `liveDoc:respond` 回来，**只认发请求的那个 webContents**：preload 的 window.api 会跟着
 * 窗口导航到任何页面，别的窗口不该能替这份文档作答。网络客户端没有 webContents，挂不上 —— 它开着的
 * 笔记本走磁盘回落，编辑器再经三方合并把改动并进来。
 *
 * **同一条会话的请求逐个执行**（发给编辑器的与走磁盘的同一条队）：pi 缺省并行执行一条消息里的几次
 * 工具调用，而编辑器那边本来就逐个执行（一次修改可能要等用户停手好几秒）。若一起发出，排在后面的
 * 请求会在还没轮到执行时就把自己的超时耗光 —— 所以这里排队，前一个了结才发下一个，超时从真正发出那一刻算；
 * 发给编辑器还是走磁盘，也到轮到它时才定。
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
  attachId: string
  sender: WebContents
  resolve: (result: LiveDocResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

interface Attachment {
  attachId: string
  sender: WebContents
}

/** sessionId → 显示着这份文档的编辑器（后挂上的在后） */
const targets = new Map<string, Attachment[]>()
const pending = new Map<string, Pending>()
/** sessionId → 这条会话上一个请求了结时 resolve 的 Promise（排队用） */
const lanes = new Map<string, Promise<unknown>>()
/** 已经挂了生命周期监听的窗口 */
const watched = new WeakSet<WebContents>()

const EDITOR_CLOSED =
  'The editor showing this document closed before the change was confirmed. Call doc_read to see the document as it is now.'

/** 一个编辑器显示着这条会话的文档（同一个 attachId 再报一次 = 挪到最后） */
export function attachLiveDocument(
  sessionId: string,
  webContents: WebContents,
  attachId: string
): void {
  watchSender(webContents)
  const list = (targets.get(sessionId) ?? []).filter((a) => a.attachId !== attachId)
  list.push({ attachId, sender: webContents })
  targets.set(sessionId, list)
}

/**
 * 那个编辑器不显示了：摘掉，发给它、还在等的请求立刻失败。给了 `webContents` 就只摘它自己挂的那一个 ——
 * IPC 经它进来，别的窗口摘不掉不属于自己的编辑器
 */
export function detachLiveDocument(
  sessionId: string,
  attachId: string,
  webContents?: WebContents
): void {
  drop(
    (sid, a) =>
      sid === sessionId && a.attachId === attachId && (!webContents || a.sender === webContents),
    EDITOR_CLOSED
  )
}

function currentTarget(sessionId: string): Attachment | null {
  const list = targets.get(sessionId)
  if (!list) return null
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].sender.isDestroyed()) return list[i]
  }
  return null
}

/** 摘掉满足条件的挂接，并让发给它们的在途请求失败 */
function drop(match: (sessionId: string, a: Attachment) => boolean, reason: string): void {
  for (const [sessionId, list] of targets) {
    const kept = list.filter((a) => !match(sessionId, a))
    if (kept.length === list.length) continue
    if (kept.length === 0) targets.delete(sessionId)
    else targets.set(sessionId, kept)
  }
  for (const [requestId, p] of pending) {
    if (!match(p.sessionId, { attachId: p.attachId, sender: p.sender })) continue
    settle(requestId)?.reject(new Error(reason))
  }
}

/**
 * 窗口销毁、整页重载（主框架导航；hash 路由不算）、渲染进程崩溃都让它挂的编辑器作废 —— 重载后的页面会
 * 自己再挂；崩溃的页面不会答复，留着它只会让每次调用都等到超时，而不是落到磁盘上
 */
function watchSender(sender: WebContents): void {
  if (watched.has(sender)) return
  watched.add(sender)
  const dropAll = (): void => drop((_sid, a) => a.sender === sender, EDITOR_CLOSED)
  sender.once('destroyed', dropAll)
  sender.on('did-navigate', dropAll)
  sender.on('render-process-gone', dropAll)
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
 * 执行一次 doc_* 操作：轮到它时有编辑器显示着这份文档就交给编辑器，否则调 `onDisk`（磁盘回落）。
 * 编辑器没答复 / 中途摘下 / 被中止（signal）都以 Error 结束；操作本身失败（原文对不上等）是
 * `{ ok: false }` 的正常结果，由工具翻译给 agent。
 */
export function requestLiveDocument(
  sessionId: string,
  op: LiveDocOp,
  signal: AbortSignal | undefined,
  onDisk: () => Promise<LiveDocResult>
): Promise<LiveDocResult> {
  // 已中止的 signal 不会再触发 abort 事件：当场了结，不排队、不发、也不走磁盘
  if (signal?.aborted) return Promise.reject(new Error('Aborted.'))
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
        if (signal?.aborted) throw new Error('Aborted.')
        const target = currentTarget(sessionId)
        const result = target
          ? await sendLiveDocument(sessionId, target, op, signal)
          : await onDisk()
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
  target: Attachment,
  op: LiveDocOp,
  signal?: AbortSignal
): Promise<LiveDocResult> {
  const { sender, attachId } = target
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
      reject(new Error('The editor showing this document did not respond in time.'))
    }, timeoutMs)
    pending.set(requestId, {
      sessionId,
      attachId,
      sender,
      resolve,
      reject,
      timer,
      cleanup: () => signal?.removeEventListener('abort', onAbort)
    })
    const request: LiveDocRequest = { requestId, sessionId, attachId, op }
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
