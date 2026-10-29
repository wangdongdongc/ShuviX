/**
 * 内置浏览器的历史记录（Chrome 的 History）：哪次导航记成一次访问、记在谁头上，以及地址栏建议、历史记录页的查询。
 *
 * **记在谁头上**（2026-10-29 用户裁定：agent 打开的照记、标出会话，但不进地址栏建议）：每个 tab 记着「最近是谁在
 * 动它」—— agent 的工具调用（noteAgentUse）、agent 开的 tab / agent 点出来的弹出页记成那个会话；用户在地址栏里敲、
 * 点后退前进刷新、在页面里按键或按下鼠标记成用户。提交的导航算到当时的那一方头上。页面里的按键 / 鼠标只有 agent
 * 此刻没在这页上动作时才算用户的（CDP 发的鼠标也会触发 before-mouse-event，见 browserViewService），这一判断由
 * 调用方做 —— 本模块不碰 tab 与 CDP，只管账。
 *
 * **什么算一次访问**：主框架提交的导航；同一个 tab 里同一个地址再提交一次（刷新）不算，页内导航只改了锚点的不算
 * （见 shared/browserHistory.ts 的 inPageVisitCounts）—— 用户从地址栏去的除外，那次总算。只记网页与本地文件。
 *
 * 标题与站点图标随后由页面报上来，记到这个 tab 最近一次真记下的那个地址上（只改了锚点的那次不算）。保留 90 天，记的时候顺手修剪（一天一次）。
 *
 * 落盘的那张表（dao/browserHistoryDao.ts）由宿主启动时注入（setHistoryStore，main/index.ts）—— 与
 * setBrowserSessionHooks 同一个理由：浏览器模块的单测不必拉起数据库。没注入时什么也不记、查询回空。
 */

import { createLogger } from '../../logger'
import type { BrowserHistoryDao } from '../../dao/browserHistoryDao'
import {
  HISTORY_RETENTION_MS,
  historyQueryWords,
  historyUrlOf,
  inPageVisitCounts,
  rankHistory,
  type HistoryActorFilter,
  type HistoryItem,
  type HistoryListQuery,
  type HistoryListResult,
  type HistorySuggestion,
  type HistoryTransition
} from '../../../shared/browserHistory'

const log = createLogger('BrowserHistory')

/** 历史的落盘处（BrowserHistoryDao 的那几个方法） */
export type HistoryStore = Pick<
  BrowserHistoryDao,
  | 'addVisit'
  | 'setTitle'
  | 'setFavicon'
  | 'candidates'
  | 'listGroups'
  | 'removeGroup'
  | 'removeUrl'
  | 'clear'
  | 'pruneBefore'
>

let store: HistoryStore | null = null

/** 宿主启动时注入（main/index.ts）；测试换成自己的 */
export function setHistoryStore(next: HistoryStore | null): void {
  store = next
}

type Actor = { kind: 'user' } | { kind: 'agent'; sessionId: string }

/** 每个 tab 最近是谁在动它；不在表里 = 用户（用户自己开的 tab） */
const actors = new Map<string, Actor>()
/** 用户刚从地址栏让这个 tab 去的：下一次提交的导航记成 typed / generated（太久没提交就作废） */
const pendingTransition = new Map<string, { transition: HistoryTransition; at: number }>()
/** 每个 tab 最近一次提交的地址（能记的那种）：再提交同一个（刷新）、只改锚点都拿它比 */
const lastCommitted = new Map<string, string>()
/** 每个 tab 最近一次真记进历史的地址：之后报上来的标题、图标记到它头上 */
const lastRecorded = new Map<string, string>()

const PENDING_TTL_MS = 60_000
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000
/** 站点图标地址最长多少（data: 地址可能很长；再长就不记，历史记录页回落地球图标） */
const MAX_FAVICON_LENGTH = 16 * 1024
const MAX_TITLE_LENGTH = 1024
let lastPruneAt = 0

/** agent 在这页上动作了（工具调用、agent 开的 tab、agent 点出来的弹出页） */
export function historyNoteAgent(tabId: string, sessionId: string): void {
  actors.set(tabId, { kind: 'agent', sessionId })
}

/** 用户在这页上动作了（页面里的按键 / 鼠标、后退前进刷新） */
export function historyNoteUser(tabId: string): void {
  actors.set(tabId, { kind: 'user' })
}

/** 用户从地址栏 / 新标签页让这个 tab 去一个地址：typed（网址）或 generated（搜索） */
export function historyNoteUserNavigation(
  tabId: string,
  transition: HistoryTransition,
  now = Date.now()
): void {
  historyNoteUser(tabId)
  if (transition === 'link') pendingTransition.delete(tabId)
  else pendingTransition.set(tabId, { transition, at: now })
}

/** 页面自己弹出的新页（不是 agent 点出来的）：跟开它的那页记在同一方头上 */
export function historyCopyActor(fromTabId: string, toTabId: string): void {
  const actor = actors.get(fromTabId)
  if (actor) actors.set(toTabId, actor)
}

/** 主框架加载失败：用户从地址栏去的那次没去成，下一次提交的不再算 typed */
export function historyNoteFailed(tabId: string): void {
  pendingTransition.delete(tabId)
}

/**
 * 主框架提交了一次导航（did-navigate；页内导航 sameDocument）。该记的记一次访问。
 * 不抛：记不下历史不该影响浏览。
 */
export function historyNoteCommit(
  tabId: string,
  url: string,
  opts: { sameDocument: boolean },
  now = Date.now()
): void {
  const stored = historyUrlOf(url)
  if (!stored) {
    // 不记的提交（新开 tab 自己那次 about:blank 之类）不用掉地址栏的标记：回车可能比它先到
    lastCommitted.delete(tabId)
    lastRecorded.delete(tabId)
    return
  }
  const pending = pendingTransition.get(tabId)
  pendingTransition.delete(tabId)
  const typed = pending && now - pending.at <= PENDING_TTL_MS ? pending.transition : null
  const prev = lastCommitted.get(tabId)
  lastCommitted.set(tabId, stored)
  if (!typed) {
    if (prev === stored) return
    if (opts.sameDocument && prev && !inPageVisitCounts(prev, stored)) return
  }
  lastRecorded.set(tabId, stored)
  const actor = actors.get(tabId)
  const sessionId = !typed && actor?.kind === 'agent' ? actor.sessionId : null
  try {
    store?.addVisit({
      url: stored,
      title: '',
      visitedAt: now,
      transition: typed ?? 'link',
      sessionId
    })
    maybePrune(now)
  } catch (err) {
    log.warn('recording a history visit failed', err)
  }
}

/** 页面报了标题：记到这个 tab 最近记下的地址上 */
export function historyNoteTitle(tabId: string, title: string): void {
  const url = lastRecorded.get(tabId)
  const text = title.trim().slice(0, MAX_TITLE_LENGTH)
  if (!url || !text) return
  try {
    store?.setTitle(url, text)
  } catch (err) {
    log.warn('recording a history title failed', err)
  }
}

/** 页面报了站点图标 */
export function historyNoteFavicon(tabId: string, favicon: string | undefined): void {
  const url = lastRecorded.get(tabId)
  if (!url || !favicon || favicon.length > MAX_FAVICON_LENGTH) return
  try {
    store?.setFavicon(url, favicon)
  } catch (err) {
    log.warn('recording a history favicon failed', err)
  }
}

/** tab 关了：忘掉它的账（历史本身留着） */
export function historyForgetTab(tabId: string): void {
  actors.delete(tabId)
  pendingTransition.delete(tabId)
  lastCommitted.delete(tabId)
  lastRecorded.delete(tabId)
}

function maybePrune(now: number): void {
  if (now - lastPruneAt < PRUNE_EVERY_MS) return
  lastPruneAt = now
  store?.pruneBefore(now - HISTORY_RETENTION_MS)
}

// ====== 查询 ======

/** 地址栏建议：用户自己去过的网址里对得上这个输入的，按分数从高到低 */
export function suggestHistory(text: string, limit = 12, now = Date.now()): HistorySuggestion[] {
  const words = historyQueryWords(text).slice(0, 6)
  if (words.length === 0 || !store) return []
  maybePrune(now)
  return rankHistory(text, store.candidates(words, 400), now, limit)
}

const ACTORS: readonly HistoryActorFilter[] = ['all', 'user', 'agent']
const DEFAULT_PAGE = 100
const MAX_PAGE = 500

/** 历史记录页的一页；sessionTitle 由调用方给（本模块不碰会话表） */
export function listHistory(
  q: HistoryListQuery,
  sessionTitle: (sessionId: string) => string,
  now = Date.now()
): HistoryListResult {
  if (!store) return { items: [], next: null }
  maybePrune(now)
  const asked = typeof q.limit === 'number' && Number.isFinite(q.limit) ? q.limit : DEFAULT_PAGE
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(asked)))
  const rows = store.listGroups({
    search: (q.search ?? '').trim(),
    actor: q.actor && ACTORS.includes(q.actor) ? q.actor : 'all',
    before: typeof q.cursor === 'number' && Number.isFinite(q.cursor) ? q.cursor : null,
    limit: limit + 1
  })
  const page = rows.slice(0, limit)
  const items = page.map(
    (r): HistoryItem => ({
      key: `${r.day}|${r.urlId}|${r.sessionId ?? ''}`,
      day: r.day,
      url: r.url,
      title: r.title,
      favicon: r.favicon,
      lastAt: Number(r.lastAt),
      count: Number(r.count),
      ...(r.sessionId ? { sessionId: r.sessionId, sessionTitle: sessionTitle(r.sessionId) } : {})
    })
  )
  return {
    items,
    next: rows.length > limit && page.length > 0 ? Number(page[page.length - 1].lastId) : null
  }
}

/** 历史记录页删几行（key 见 HistoryItem.key；认不出的跳过） */
export function removeHistoryItems(keys: unknown): void {
  if (!Array.isArray(keys)) return
  for (const key of keys) {
    if (typeof key !== 'string') continue
    const m = /^(\d{4}-\d{2}-\d{2})\|(\d+)\|(.*)$/.exec(key)
    if (!m) continue
    store?.removeGroup(m[1], Number(m[2]), m[3] || null)
  }
}

/** 把一个网址从历史里整个删掉（地址栏建议上的 Shift+Delete） */
export function removeHistoryUrl(url: string): void {
  store?.removeUrl(url)
}

/** 删除全部浏览历史 */
export function clearHistory(): void {
  store?.clear()
  log.info('Cleared browsing history')
}
