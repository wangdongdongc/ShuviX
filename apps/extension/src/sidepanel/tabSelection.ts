/**
 * 「这条消息带哪些标签页」—— 侧边栏输入卡片顶上那排标签页芯片的状态。
 *
 * 缺省只选中**本标签页**（侧边栏挂着的那一页）；用户可以取消它，也可以从全部标签页里再加选。
 * 发送时，选中的标签页作为行内 token 带在消息开头：气泡里是一排芯片，模型看到的是
 * `[Chrome tab <id>: <标题> — <地址>]`。页面内容**不**随消息附上 —— agent 需要时自己读，那一下读取
 * 过站点门。标题与地址在发送那一刻现取（页面可能早就导航走了）。
 */
import { useSyncExternalStore } from 'react'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { makeTokenMarker } from '@shuvix/chat-protocol/utils/inlineTokens'

export interface SelectedTab {
  id: number
  title: string
  url: string
  favIconUrl?: string
}

let attachedTabId = -1
/** null = 用户没动过：只有本标签页 */
let explicit: number[] | null = null
const listeners = new Set<() => void>()
let snapshot: number[] = []

function recompute(): void {
  snapshot = explicit ?? (attachedTabId >= 0 ? [attachedTabId] : [])
  for (const fn of listeners) fn()
}

export function initTabSelection(tabId: number): void {
  attachedTabId = tabId
  recompute()
}

export function selectedTabIds(): number[] {
  return snapshot
}

export function toggleTab(tabId: number): void {
  const current = new Set(snapshot)
  if (current.has(tabId)) current.delete(tabId)
  else current.add(tabId)
  // 本标签页总在最前
  explicit = [...current].sort((a, b) => (a === attachedTabId ? -1 : b === attachedTabId ? 1 : 0))
  recompute()
}

/** 标签页关了：从选择里拿掉 */
export function dropTab(tabId: number): void {
  if (!snapshot.includes(tabId)) return
  explicit = snapshot.filter((id) => id !== tabId)
  recompute()
}

export function useSelectedTabIds(): number[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshot
  )
}

/** 模型看到的那一行 */
export function tabPayload(tab: SelectedTab): string {
  return `[Chrome tab ${tab.id}: ${tab.title || '(untitled)'} — ${tab.url}]`
}

const TOKEN_UID_PREFIX = 'ctab'

/**
 * 把选中的标签页并进一次发送：每个标签页一个行内 token，标记放在正文前面。
 * 与输入框自己的 token（斜杠命令 / @ 引用）uid 不冲突（前缀不同）；没有选中的就原样返回。
 */
export function withTabTokens(
  text: string,
  tokens: Record<string, InlineToken> | undefined,
  tabs: SelectedTab[]
): { text: string; inlineTokens?: Record<string, InlineToken> } {
  if (tabs.length === 0) return { text, inlineTokens: tokens }
  const merged: Record<string, InlineToken> = { ...(tokens ?? {}) }
  const markers: string[] = []
  tabs.forEach((tab, i) => {
    const uid = `${TOKEN_UID_PREFIX}${i}`
    merged[uid] = {
      type: 'tab',
      id: `chrome-tab:${tab.id}`,
      displayText: tab.title || tab.url || `tab ${tab.id}`,
      payload: tabPayload(tab),
      name: tab.title || undefined
    }
    markers.push(makeTokenMarker(uid))
  })
  return { text: `${markers.join(' ')} ${text}`, inlineTokens: merged }
}

/** 现取选中标签页此刻的标题与地址（关掉了的跳过） */
export async function resolveSelectedTabs(): Promise<SelectedTab[]> {
  const out: SelectedTab[] = []
  for (const id of snapshot) {
    try {
      const tab = await chrome.tabs.get(id)
      out.push({
        id,
        title: tab.title ?? '',
        url: tab.pendingUrl || tab.url || '',
        favIconUrl: tab.favIconUrl || undefined
      })
    } catch {
      /* 已关 */
    }
  }
  return out
}
