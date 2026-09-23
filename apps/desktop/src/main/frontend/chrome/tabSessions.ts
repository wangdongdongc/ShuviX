/**
 * Chrome 标签页会话的生命周期 —— 开、找、关、清孤儿。
 *
 * 一个标签页会话 = 一条普通会话 + `settings.chromeTab`（哪个浏览器、这一轮浏览器运行、哪个标签页）。
 * 它的寿命跟着标签页：
 *  - **开**：侧边栏第一次要会话时（`tabSession.open`）找现成的，没有就建。关掉侧边栏再打开拿回的是
 *    同一条，对话还在；
 *  - **关**：扩展报 `tabs.removed` → 删掉（子会话、临时工作区、工具大结果一并清，见 sessionService.delete）；
 *  - **清孤儿**：扩展每次握手都带 runId 与此刻开着的全部标签页 id。浏览器重启后标签页 id 全换
 *    （runId 也换），桌面没在运行期间关掉的标签页也收不到 `tabs.removed` —— 这两种留下的会话都在
 *    握手时清掉。
 */
import { chromeTabOf, type ChromeTabBinding } from '@shuvix/chat-protocol/chromeTabSession'
import type { BridgeHello } from '@shuvix/chat-protocol/chromeBridge'
import { sessionRecords } from '../../services/sessionRecords'
import { sessionService } from '../../services/sessionService'
import { existingChromeBrowserState, type BridgeConnection } from '../../services/chromeBridge'
import { createLogger } from '../../logger'

const log = createLogger('ChromeTabSessions')

/** 新会话标题里的页面标题长度上限 */
const TITLE_PAGE_CHARS = 60

/** 标签页会话的标题：`Chrome · <页面标题>`（不是默认标题 —— 自动标题 hook 因此不会为它跑一次模型） */
export function tabSessionTitle(pageTitle: string | undefined): string {
  const title = (pageTitle ?? '').trim()
  if (!title) return 'Chrome'
  // 按码点截：按 UTF-16 截会把跨在边界上的 emoji 劈成半个
  const chars = Array.from(title)
  return `Chrome · ${chars.length > TITLE_PAGE_CHARS ? `${chars.slice(0, TITLE_PAGE_CHARS - 1).join('')}…` : title}`
}

/** 某浏览器名下的全部标签页会话 */
export function tabSessionsOf(installId: string): Array<{ id: string; binding: ChromeTabBinding }> {
  const out: Array<{ id: string; binding: ChromeTabBinding }> = []
  for (const session of sessionRecords.findAll()) {
    const binding = chromeTabOf(session.settings)
    if (binding && binding.installId === installId) out.push({ id: session.id, binding })
  }
  return out
}

/** 这条会话是不是这条连接（这个浏览器的这一轮运行）的标签页会话 */
export function connectionOwnsSession(conn: BridgeConnection, sessionId: unknown): boolean {
  if (typeof sessionId !== 'string' || !sessionId) return false
  const info = conn.info
  if (!info) return false
  const binding = chromeTabOf(sessionRecords.pickSettings(sessionId, ['chromeTab']))
  return !!binding && binding.installId === info.installId && binding.runId === info.runId
}

/** 同一个标签页的并发 open 串成一次（面板重开、重连时的重复请求不会建出两条会话） */
const opening = new Map<string, Promise<string>>()

/** 取（没有就建）挂在这个标签页上的会话 */
export async function openTabSession(
  conn: BridgeConnection,
  params: { tabId: number; title?: string }
): Promise<string> {
  const info = conn.info
  if (!info) throw new Error('not-ready')
  if (!Number.isInteger(params?.tabId) || params.tabId < 0) {
    throw new Error('"tabId" must be a Chrome tab id (a non-negative integer).')
  }
  const key = `${info.installId}:${info.runId}:${params.tabId}`
  const inflight = opening.get(key)
  if (inflight) return inflight
  const work = (async () => {
    const existing = tabSessionsOf(info.installId).find(
      (s) => s.binding.runId === info.runId && s.binding.tabId === params.tabId
    )
    if (existing) return existing.id
    const session = sessionService.create({
      title: tabSessionTitle(params.title),
      chromeTab: { installId: info.installId, runId: info.runId, tabId: params.tabId }
    })
    log.info(`opened a tab session for tab ${params.tabId} (${info.browser}) session=${session.id}`)
    return session.id
  })()
  opening.set(key, work)
  try {
    return await work
  } finally {
    opening.delete(key)
  }
}

/** 标签页关了：删掉挂在它上面的会话（这一轮浏览器运行里的） */
export async function closeTabSession(conn: BridgeConnection, tabId: number): Promise<void> {
  const info = conn.info
  if (!info || !Number.isInteger(tabId)) return
  for (const s of tabSessionsOf(info.installId)) {
    if (s.binding.runId !== info.runId || s.binding.tabId !== tabId) continue
    log.info(`tab ${tabId} closed, deleting session=${s.id}`)
    existingChromeBrowserState(info.installId)?.forgetSession(s.id)
    await sessionService.delete(s.id).catch((err) => log.warn(`delete failed: ${err}`))
  }
}

/**
 * 握手时清孤儿：同一个浏览器名下，上一轮浏览器运行留下的、或标签页已经不在的会话。
 * openTabIds 为空（刚启动的浏览器还没报上来）时不按它清 —— 宁可多留一条，不能误删正在用的。
 */
export async function sweepTabSessions(hello: BridgeHello): Promise<void> {
  const open = new Set(hello.openTabIds)
  for (const s of tabSessionsOf(hello.installId)) {
    const stale = s.binding.runId !== hello.runId || (open.size > 0 && !open.has(s.binding.tabId))
    if (!stale) continue
    log.info(`sweeping an orphaned tab session=${s.id} (tab ${s.binding.tabId})`)
    existingChromeBrowserState(hello.installId)?.forgetSession(s.id)
    await sessionService.delete(s.id).catch((err) => log.warn(`delete failed: ${err}`))
  }
}
