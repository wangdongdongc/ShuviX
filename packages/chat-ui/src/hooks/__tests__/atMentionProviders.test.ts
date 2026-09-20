/**
 * 知识库源候选的两块纯逻辑：
 *
 *   - searchKnowledgeEntries（B5）：标题前缀 > 标题子串 > 描述子串；同分标题短者优先、
 *     再按条目 id 字典序（确定性）；limit 截断。
 *   - KnowledgeProvider 的事件订阅（D1）：knowledge.changed 重拉全部有表会话；
 *     session.configChanged（启用库勾选的广播，不产生 knowledge.changed）按载荷圈定、
 *     只重拉该会话已有的表 —— 没拉过的会话不预取，别的会话不无谓重拉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeMentionEntry } from '@shuvix/chat-protocol/knowledge'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'

const mocks = vi.hoisted(() => ({
  listKnowledgeEntries: vi.fn(),
  /** BaseProvider 懒订阅时捕获的事件回调（本文件只 load knowledge 源，唯一订阅者） */
  appEventListener: { current: null as null | ((e: AppEvent) => void) }
}))

vi.mock('../../api/chatApi', () => ({
  getSessionChannelApi: () => ({
    mentions: { listKnowledgeEntries: mocks.listKnowledgeEntries },
    events: {
      subscribe: (cb: (e: AppEvent) => void) => {
        mocks.appEventListener.current = cb
        return () => {}
      }
    }
  })
}))

import { getAtMentionProviders, searchKnowledgeEntries } from '../atMentionProviders'

function entry(path: string, title: string, description = ''): KnowledgeMentionEntry {
  return {
    path,
    baseName: 'notes',
    bundlePath: `/${path.split('/').slice(2).join('/')}`,
    title,
    description,
    bundleLabel: 'notes'
  }
}

describe('searchKnowledgeEntries（B5）', () => {
  const entries = [
    entry('knowledge/notes/b/auth-guide.md', '认证指南（长版）'),
    entry('knowledge/notes/a/auth.md', '认证'),
    entry('knowledge/notes/c/deploy.md', '部署', '先完成认证再部署'),
    entry('knowledge/notes/d/cache.md', '缓存')
  ]

  it('标题前缀 > 标题子串 > 描述子串', () => {
    const hits = searchKnowledgeEntries(entries, '认证')
    expect(hits.map((h) => h.title)).toEqual(['认证', '认证指南（长版）', '部署'])
  })

  it('同分按标题短者优先、再按条目 id 字典序', () => {
    const same = [
      entry('knowledge/notes/z/ab.md', 'x认证x'),
      entry('knowledge/notes/a/ab.md', 'x认证x')
    ]
    const hits = searchKnowledgeEntries(same, '认证')
    expect(hits[0].path).toBe('knowledge/notes/a/ab.md')
  })

  it('空 query 按条目 id 字典序取前 limit 条；limit 截断', () => {
    const hits = searchKnowledgeEntries(entries, '', 2)
    expect(hits.map((h) => h.path)).toEqual([
      'knowledge/notes/a/auth.md',
      'knowledge/notes/b/auth-guide.md'
    ])
  })

  it('大小写不敏感；无命中返回空', () => {
    expect(
      searchKnowledgeEntries([entry('knowledge/notes/x.md', 'Token Refresh')], 'token')
    ).toHaveLength(1)
    expect(searchKnowledgeEntries(entries, '不存在')).toEqual([])
  })
})

describe('KnowledgeProvider 的事件订阅（D1）', () => {
  const provider = getAtMentionProviders().find((p) => p.source === 'knowledge')!
  const fire = (e: AppEvent): void => mocks.appEventListener.current?.(e)
  /** 等首次 fetch 落定（load 是 fire-and-forget），随后上假时钟接管防抖 */
  const loadAndSettle = async (sid: string, entries: KnowledgeMentionEntry[]): Promise<void> => {
    mocks.listKnowledgeEntries.mockResolvedValue(entries)
    provider.load(sid)
    await vi.waitFor(() => expect(provider.ready(sid)).toBe(true))
  }

  beforeEach(() => {
    mocks.listKnowledgeEntries.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('session.configChanged 只重拉该会话的表（按载荷圈定）', async () => {
    await loadAndSettle('d1-a', [entry('knowledge/notes/a.md', '甲')])
    await loadAndSettle('d1-b', [entry('knowledge/notes/b.md', '乙')])
    vi.useFakeTimers()
    const callsBefore = mocks.listKnowledgeEntries.mock.calls.length

    // 该会话启用库变了 → 只重拉它；别的会话的表不动
    mocks.listKnowledgeEntries.mockResolvedValue([entry('knowledge/notes/a2.md', '甲二')])
    fire({ type: 'session.configChanged', sessionId: 'd1-a' })
    await vi.advanceTimersByTimeAsync(300)
    expect(provider.search('d1-a', '').map((s) => s.label)).toEqual(['甲二'])
    expect(provider.search('d1-b', '').map((s) => s.label)).toEqual(['乙'])
    const refetched = mocks.listKnowledgeEntries.mock.calls.slice(callsBefore)
    expect(refetched).toEqual([[{ sessionId: 'd1-a' }]])
  })

  it('session.configChanged 对没拉过的会话不预取', async () => {
    vi.useFakeTimers()
    const callsBefore = mocks.listKnowledgeEntries.mock.calls.length
    fire({ type: 'session.configChanged', sessionId: 'd1-never-loaded' })
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.listKnowledgeEntries.mock.calls.slice(callsBefore)).toEqual([])
    expect(provider.ready('d1-never-loaded')).toBe(false)
  })

  it('knowledge.changed 重拉全部有表会话（信号事件，无载荷）', async () => {
    await loadAndSettle('d1-c', [entry('knowledge/notes/c.md', '丙')])
    vi.useFakeTimers()
    const callsBefore = mocks.listKnowledgeEntries.mock.calls.length

    mocks.listKnowledgeEntries.mockResolvedValue([entry('knowledge/notes/c2.md', '丙二')])
    fire({ type: 'knowledge.changed' })
    await vi.advanceTimersByTimeAsync(300)
    expect(provider.search('d1-c', '').map((s) => s.label)).toEqual(['丙二'])
    // 有表的会话（含前面用例拉过的）都被重拉
    const refetched = mocks.listKnowledgeEntries.mock.calls
      .slice(callsBefore)
      .map((c) => (c[0] as { sessionId: string }).sessionId)
    expect(refetched).toContain('d1-c')
    expect(refetched).toContain('d1-a')
  })
})
