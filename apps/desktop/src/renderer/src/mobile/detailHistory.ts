/**
 * 对话页上面再推入的「详情」那一层在浏览器历史里的记号 —— 详情首页一条、某一段的子页再一条，返回键 / 返回手势
 * 一层一层退。这两条历史条目照样带着对话页（与会话页第二层）的记号，退回来落在哪一条上，下面那几层都还开着。
 */
import type { SessionConfigSection } from '@shuvix/app-shell'

export const DETAIL_HISTORY_MARK = 'shuvixMobileDetail'

/** 详情那一层此刻在哪一页：首页，或某一段的子页 */
export type MobileDetailPage = 'index' | SessionConfigSection

const SECTIONS: readonly SessionConfigSection[] = [
  'extensions',
  'knowledge',
  'paths',
  'sessions',
  'widgets'
]

/** 一条历史条目的 state 说的是详情的哪一页；不是详情的条目 → null */
export function detailPageOf(state: unknown): MobileDetailPage | null {
  const value = (state as Record<string, unknown> | null)?.[DETAIL_HISTORY_MARK]
  if (value === 'index') return 'index'
  return SECTIONS.includes(value as SessionConfigSection) ? (value as SessionConfigSection) : null
}

/** 这一条在对话页那一条上面第几层：不在详情里 0，详情首页 1，子页 2（关对话页时要一起退掉） */
export function detailDepthOf(state: unknown): number {
  const page = detailPageOf(state)
  return page === null ? 0 : page === 'index' ? 1 : 2
}
