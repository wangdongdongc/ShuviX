/**
 * Browser history IPC handlers —— 内置浏览器的历史记录（地址栏建议、历史记录页、删除）与地址栏的搜索建议。
 *
 * **只认浏览器窗口外壳发来的**（别的窗口、网络客户端一律当没有）：地址栏与历史记录页都只在浏览器窗口里，
 * 而历史里的网址可能带着登录令牌（重置密码链接、OAuth 回调的 code）。agent 那一侧没有任何读历史的路。
 */

import { defineHandler, type ClientContext } from './registry'
import {
  agentSessionTitle,
  clearHistory,
  fetchSearchSuggestions,
  isHostWebContents,
  listHistory,
  removeHistoryItems,
  removeHistoryUrl,
  suggestHistory
} from '../services/browser'
import type {
  HistoryListQuery,
  HistoryListResult,
  HistorySuggestion
} from '../../shared/browserHistory'

function fromHostWindow(ctx: ClientContext): boolean {
  return ctx.client.kind === 'window' && isHostWebContents(ctx.client.webContentsId)
}

export function registerBrowserHistoryHandlers(): void {
  /** 地址栏建议：用户自己去过的、对得上这段输入的网址（agent 打开的不在里面） */
  defineHandler('browser-history:suggest', (ctx, text: unknown): HistorySuggestion[] =>
    fromHostWindow(ctx) && typeof text === 'string' ? suggestHistory(text) : []
  )

  /** 地址栏的搜索建议（向用户选的搜索引擎要；设置里关了、或这段输入不该送时回空） */
  defineHandler(
    'browser-history:search-suggest',
    async (ctx, text: unknown, engine: unknown): Promise<string[]> =>
      fromHostWindow(ctx) && typeof text === 'string'
        ? fetchSearchSuggestions(text, typeof engine === 'string' ? engine : '')
        : []
  )

  /** 历史记录页的一页 */
  defineHandler('browser-history:list', (ctx, query: unknown): HistoryListResult => {
    if (!fromHostWindow(ctx)) return { items: [], next: null }
    const q = query && typeof query === 'object' ? (query as HistoryListQuery) : {}
    return listHistory(q, agentSessionTitle)
  })

  /** 历史记录页上删几行 */
  defineHandler('browser-history:remove', (ctx, keys: unknown): void => {
    if (fromHostWindow(ctx)) removeHistoryItems(keys)
  })

  /** 地址栏建议上的 Shift+Delete / ×：把这个网址从历史里整个删掉 */
  defineHandler('browser-history:remove-url', (ctx, url: unknown): void => {
    if (fromHostWindow(ctx) && typeof url === 'string') removeHistoryUrl(url)
  })

  /** 删除全部浏览历史（历史记录页、设置页的隐私一节） */
  defineHandler('browser-history:clear', (ctx): void => {
    if (fromHostWindow(ctx)) clearHistory()
  })
}
