/**
 * 知识库源候选的两块纯逻辑：
 *
 *   - searchKnowledgeEntries（B5）：标题前缀 > 标题子串 > 描述子串；同分标题短者优先、
 *     再按条目 id 字典序（确定性）；limit 截断。
 *   - KnowledgeProvider 的事件订阅（D1）：knowledge.changed 重拉全部有表会话；
 *     session.configChanged（启用库勾选的广播，不产生 knowledge.changed）按载荷圈定、
 *     只重拉该会话已有的表 —— 没拉过的会话不预取，别的会话不无谓重拉。
 *   - 会话源（XS-67）：searchSessionMentions 的排名与 SessionProvider 的就绪 / 候选形态 / 事件订阅。
 *
 * 宿主事件流的替身把每个 provider 的订阅都收下（knowledge 与 session 两个源各订一次），fire 发给全部。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeMentionEntry } from '@shuvix/chat-protocol/knowledge'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'

const mocks = vi.hoisted(() => ({
  listKnowledgeEntries: vi.fn(),
  listSessions: vi.fn(),
  /** 宿主有没有会话列表（mentions.listSessions；扩展没有） */
  hasListSessions: { current: true },
  /** BaseProvider 懒订阅时捕获的事件回调（每个 load 过的源一个） */
  appEventListeners: new Set<(e: AppEvent) => void>()
}))

vi.mock('../../api/chatApi', () => ({
  getSessionChannelApi: () => ({
    mentions: {
      listKnowledgeEntries: mocks.listKnowledgeEntries,
      ...(mocks.hasListSessions.current ? { listSessions: mocks.listSessions } : {})
    },
    events: {
      subscribe: (cb: (e: AppEvent) => void) => {
        mocks.appEventListeners.add(cb)
        return () => mocks.appEventListeners.delete(cb)
      }
    }
  })
}))

import type { SessionMentionEntry } from '@shuvix/chat-protocol/sessionMention'
import {
  getAtMentionProviders,
  searchKnowledgeEntries,
  searchSessionMentions
} from '../atMentionProviders'

/** 发一条宿主事件给所有订阅了的源 */
const fire = (e: AppEvent): void => {
  for (const listener of mocks.appEventListeners) listener(e)
}

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

// ── 会话源 ──

function sess(
  id: string,
  title: string,
  lastActiveAt: number,
  over: Partial<SessionMentionEntry> = {}
): SessionMentionEntry {
  return { id, title, lastActiveAt, ...over }
}

/**
 * XS-67 searchSessionMentions：标题前缀(3) > 标题子串(2) > 项目名 / 父会话标题子串(1)；同分最近活跃在前、
 * 再按 id 字典序；空 query 按最近活跃；limit 截断（缺省 12）；大小写不敏感；无命中 []
 */
describe('searchSessionMentions（XS-67）', () => {
  const entries = [
    // 越往下越近活跃：只按最近活跃排的话顺序正好反过来
    sess('s-prefix', 'Deploy pipeline', 100),
    sess('s-sub', 'Fix the deploy script', 200),
    sess('s-project', 'Notes', 300, { projectName: 'deploy-tools' }),
    sess('s-parent', 'Child task', 400, { parentTitle: 'Deploy review', projectName: 'misc' }),
    sess('s-miss', 'Unrelated', 500, { projectName: 'other' })
  ]
  const ids = (list: SessionMentionEntry[]): string[] => list.map((e) => e.id)

  it('XS-67 标题前缀 > 标题子串 > 项目名 / 父会话标题子串；同分最近活跃在前', () => {
    expect(ids(searchSessionMentions(entries, 'deploy'))).toEqual([
      's-prefix',
      's-sub',
      's-parent',
      's-project'
    ])
  })

  it('XS-67 同分同时间按 id 字典序（确定性）', () => {
    const same = [
      sess('s-b', 'Alpha one', 50),
      sess('s-a', 'Alpha two', 50),
      sess('s-c', 'Alpha', 60)
    ]
    expect(ids(searchSessionMentions(same, 'alpha'))).toEqual(['s-c', 's-a', 's-b'])
  })

  it('XS-67 空 query（含只有空白）按最近活跃取；limit 截断', () => {
    expect(ids(searchSessionMentions(entries, ''))).toEqual([
      's-miss',
      's-parent',
      's-project',
      's-sub',
      's-prefix'
    ])
    expect(ids(searchSessionMentions(entries, '   ', 2))).toEqual(['s-miss', 's-parent'])
    expect(ids(searchSessionMentions(entries, 'deploy', 1))).toEqual(['s-prefix'])
  })

  it('XS-67 缺省 limit 12', () => {
    const many = Array.from({ length: 15 }, (_, i) => sess(`m${i}`, `Session ${i}`, i))
    const hits = searchSessionMentions(many, '')
    expect(hits).toHaveLength(12)
    expect(hits[0].id).toBe('m14')
    expect(hits[11].id).toBe('m3')
  })

  it('XS-67 大小写不敏感（query 首尾空白不算）；无命中返回空', () => {
    expect(ids(searchSessionMentions(entries, '  DEPLOY P '))).toEqual(['s-prefix'])
    expect(ids(searchSessionMentions(entries, 'TOOLS'))).toEqual(['s-project'])
    expect(ids(searchSessionMentions(entries, 'REVIEW'))).toEqual(['s-parent'])
    expect(searchSessionMentions(entries, 'nothing-like-this')).toEqual([])
    expect(searchSessionMentions([], 'deploy')).toEqual([])
    expect(searchSessionMentions([], '')).toEqual([])
  })
})

/**
 * XS-67 SessionProvider：拉之前不就绪；宿主没有 mentions.listSessions → 永不就绪、没有候选；候选形态；
 * session.listChanged / session.titleChanged 重拉每一张表，session.configChanged / knowledge.changed 不拉
 */
describe('SessionProvider（XS-67）', () => {
  const provider = getAtMentionProviders().find((p) => p.source === 'session')!
  const loadAndSettle = async (sid: string, list: SessionMentionEntry[]): Promise<void> => {
    mocks.listSessions.mockResolvedValue(list)
    provider.load(sid)
    await vi.waitFor(() => expect(provider.ready(sid)).toBe(true))
  }
  const fetchedSids = (from: number): string[] =>
    mocks.listSessions.mock.calls.slice(from).map((c) => (c[0] as { sessionId: string }).sessionId)

  beforeEach(() => {
    mocks.hasListSessions.current = true
    mocks.listSessions.mockReset()
    // 知识源也收事件（knowledge.changed 会让它重拉）—— 给它一个空表，别让它拿到 undefined
    mocks.listKnowledgeEntries.mockReset().mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    mocks.hasListSessions.current = true
  })

  it('XS-67 注册为 session 源', () => {
    expect(provider).toBeDefined()
    expect(provider.source).toBe('session')
  })

  it('XS-67 拉之前不就绪、搜不到；拉完就绪，按会话 id 要表', async () => {
    expect(provider.ready('xs-a')).toBe(false)
    expect(provider.search('xs-a', '')).toEqual([])
    await loadAndSettle('xs-a', [sess('s1', 'One', 1)])
    expect(mocks.listSessions).toHaveBeenCalledWith({ sessionId: 'xs-a' })
    expect(provider.search('xs-a', '').map((s) => s.label)).toEqual(['One'])
    // 别的会话的表还没拉
    expect(provider.ready('xs-a-other')).toBe(false)
  })

  it('XS-67 宿主没有 mentions.listSessions：永不就绪、没有候选', async () => {
    mocks.hasListSessions.current = false
    const listener = vi.fn()
    const unsubscribe = provider.subscribe(listener)
    provider.load('xs-nohost')
    // load 是 fire-and-forget：等几轮微任务 + 一个宏任务落定
    await new Promise((r) => setTimeout(r, 0))
    expect(provider.ready('xs-nohost')).toBe(false)
    expect(provider.search('xs-nohost', '')).toEqual([])
    expect(provider.search('xs-nohost', 'one')).toEqual([])
    expect(mocks.listSessions).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('XS-67 候选形态：detail = 父会话标题 ?? 项目名；displayText = session:<标题>；消歧 = 项目名 ?? id 尾 6 位', async () => {
    await loadAndSettle('xs-shape', [
      sess('sess-aaaaaa111111', 'Child of planner', 30, {
        parentTitle: 'Planner',
        projectName: 'Website'
      }),
      sess('sess-bbbbbb222222', 'Project chat', 20, { projectName: 'Website' }),
      sess('sess-cccccc333333', 'Loose chat', 10)
    ])
    expect(provider.search('xs-shape', '')).toEqual([
      {
        source: 'session',
        label: 'Child of planner',
        detail: 'Planner',
        displayText: 'session:Child of planner',
        disambiguator: 'Website',
        ref: { kind: 'session', sessionId: 'sess-aaaaaa111111', title: 'Child of planner' }
      },
      {
        source: 'session',
        label: 'Project chat',
        detail: 'Website',
        displayText: 'session:Project chat',
        disambiguator: 'Website',
        ref: { kind: 'session', sessionId: 'sess-bbbbbb222222', title: 'Project chat' }
      },
      {
        source: 'session',
        label: 'Loose chat',
        displayText: 'session:Loose chat',
        disambiguator: '333333',
        ref: { kind: 'session', sessionId: 'sess-cccccc333333', title: 'Loose chat' }
      }
    ])
    // 没有父会话也没有项目：没有 detail 这个键（不是 undefined 值）
    const loose = provider.search('xs-shape', 'loose')
    expect(loose).toHaveLength(1)
    expect(Object.keys(loose[0])).not.toContain('detail')
    // 搜索走 searchSessionMentions（limit 透传）
    expect(provider.search('xs-shape', '', 1).map((s) => s.label)).toEqual(['Child of planner'])
  })

  it.each(['session.listChanged', 'session.titleChanged'] as const)(
    'XS-67 %s：重拉每一张表',
    async (type) => {
      await loadAndSettle(`xs-ev-${type}-1`, [sess('s1', 'Old one', 1)])
      await loadAndSettle(`xs-ev-${type}-2`, [sess('s2', 'Old two', 1)])
      vi.useFakeTimers()
      const before = mocks.listSessions.mock.calls.length

      mocks.listSessions.mockResolvedValue([sess('s9', 'Renamed', 2)])
      fire(type === 'session.listChanged' ? { type } : { type, sessionId: 's1', title: 'Renamed' })
      // 防抖期内不拉
      await vi.advanceTimersByTimeAsync(100)
      expect(mocks.listSessions.mock.calls.length).toBe(before)
      await vi.advanceTimersByTimeAsync(200)

      const refetched = fetchedSids(before)
      expect(refetched).toContain(`xs-ev-${type}-1`)
      expect(refetched).toContain(`xs-ev-${type}-2`)
      // 每张表各拉一次（不重复）
      expect(new Set(refetched).size).toBe(refetched.length)
      expect(provider.search(`xs-ev-${type}-1`, '').map((s) => s.label)).toEqual(['Renamed'])
      expect(provider.search(`xs-ev-${type}-2`, '').map((s) => s.label)).toEqual(['Renamed'])
    }
  )

  it('XS-67 session.configChanged、knowledge.changed：不重拉会话表', async () => {
    await loadAndSettle('xs-quiet', [sess('s1', 'Stays', 1)])
    vi.useFakeTimers()
    const before = mocks.listSessions.mock.calls.length
    mocks.listSessions.mockResolvedValue([sess('s9', 'Should not appear', 2)])

    fire({ type: 'session.configChanged', sessionId: 'xs-quiet' })
    await vi.advanceTimersByTimeAsync(300)
    fire({ type: 'knowledge.changed' })
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.listSessions.mock.calls.length).toBe(before)
    expect(provider.search('xs-quiet', '').map((s) => s.label)).toEqual(['Stays'])
  })
})
