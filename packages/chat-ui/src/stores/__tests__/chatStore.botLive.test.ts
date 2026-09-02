/**
 * chatStore 的 bot live 三切片（A2）—— bot_activity / bot_mailbox / bot_cohort_silent
 * 三个事件的唯一写入点，与选择器的稳定引用契约。
 *
 * 这三张 per-session 表驱动的是对话尾部占位卡、用户消息下的回执与输入卡内的沉默提示；
 * 「删键而不是存空值」不是洁癖 —— 选择器靠「键不在」回落到稳定的空引用，存空对象会让
 * zustand + useSyncExternalStore 在每次快照上拿到新引用，直接进无限重渲染循环。
 *
 * useChatStore 是模块级单例：每条用例在 beforeEach 里把三张表与活动会话整体重置。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useChatStore,
  selectBotActivities,
  selectBotMailbox,
  type BotMailboxSnapshot
} from '../chatStore'

const S1 = 'live-s1'
const S2 = 'live-s2'

const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

/** 一条 bot_activity 事件（相位由用例指定） */
const activity = (
  botName: string,
  phase: string,
  messageId = 'm1'
): { botName: string; displayName: string; phase: string; messageId?: string } => ({
  botName,
  displayName: botName.toUpperCase(),
  phase,
  messageId
})

const MAILBOX: BotMailboxSnapshot = {
  active: { messageSeq: 1, messageId: 'm1' },
  queued: [{ messageSeq: 2, messageId: 'm2', queuedAt: 1000 }]
}

beforeEach(() => {
  useChatStore.setState({
    activeSessionId: S1,
    sessionBotActivities: {},
    sessionBotMailbox: {}
  } as never)
})

describe('handleBotActivity —— live 相位 upsert 与收摊', () => {
  it('A2-D1 三个 live 相位逐个 upsert；同 bot 的相位推进覆盖同一键', () => {
    for (const phase of ['started', 'queued', 'working'] as const) {
      store().handleBotActivity(S1, activity('scout', phase))
      const snap = store().sessionBotActivities[S1].scout
      expect(snap).toMatchObject({
        botName: 'scout',
        displayName: 'SCOUT',
        phase,
        messageId: 'm1'
      })
      expect(typeof snap.at).toBe('number')
    }
    // 相位推进是**覆盖同键**，不是逐相位铺一张卡
    expect(Object.keys(store().sessionBotActivities[S1])).toEqual(['scout'])
    // 另一个成员另起一键，互不覆盖
    store().handleBotActivity(S1, activity('ranger', 'started'))
    expect(Object.keys(store().sessionBotActivities[S1]).sort()).toEqual(['ranger', 'scout'])
  })

  it('A2-D2 ended / silent 删 bot 键；最后一个成员删掉整条会话键', () => {
    store().handleBotActivity(S1, activity('scout', 'working'))
    store().handleBotActivity(S1, activity('ranger', 'queued'))

    store().handleBotActivity(S1, activity('scout', 'ended'))
    expect(store().sessionBotActivities[S1]).not.toHaveProperty('scout')
    expect(store().sessionBotActivities[S1]).toHaveProperty('ranger')

    store().handleBotActivity(S1, activity('ranger', 'silent'))
    // 会话一个在飞成员都不剩：连会话键一起删，选择器回落稳定空引用
    expect(store().sessionBotActivities).not.toHaveProperty(S1)
  })

  it('A2-D3 ended 对无条目 bot → 空 patch，别会话的切片引用不变', () => {
    store().handleBotActivity(S2, activity('other', 'working'))
    const beforeAll = store().sessionBotActivities
    const beforeS2 = beforeAll[S2]

    store().handleBotActivity(S1, activity('nobody', 'ended'))

    // 空 patch = 顶层 map 引用原样（不是重建了一份等值对象）
    expect(store().sessionBotActivities).toBe(beforeAll)
    expect(store().sessionBotActivities[S2]).toBe(beforeS2)
  })

  it('A2-D5 未知相位（paused）按 ended 同款删键 —— live 集合是白名单', () => {
    store().handleBotActivity(S1, activity('scout', 'working'))
    store().handleBotActivity(S1, activity('scout', 'paused'))
    expect(store().sessionBotActivities).not.toHaveProperty(S1)
  })
})

describe('setBotMailbox —— 空快照即删键', () => {
  it('A2-D6 空快照删 bot 键 → 最后一个删会话键；absent 时空快照 no-op；active 非空 + queued 空 ≠ 空快照', () => {
    store().setBotMailbox(S1, 'scout', MAILBOX)
    store().setBotMailbox(S1, 'ranger', MAILBOX)
    expect(Object.keys(store().sessionBotMailbox[S1]).sort()).toEqual(['ranger', 'scout'])

    store().setBotMailbox(S1, 'scout', { active: null, queued: [] })
    expect(store().sessionBotMailbox[S1]).not.toHaveProperty('scout')

    store().setBotMailbox(S1, 'ranger', { active: null, queued: [] })
    expect(store().sessionBotMailbox).not.toHaveProperty(S1)

    // 本来就没有条目时再收一份空快照：空 patch，引用不变
    const before = store().sessionBotMailbox
    store().setBotMailbox(S1, 'scout', { active: null, queued: [] })
    expect(store().sessionBotMailbox).toBe(before)

    // active 非空 + queued 空是**正在处理**，不是空快照 —— 必须存下
    const activeOnly: BotMailboxSnapshot = {
      active: { messageSeq: 3, messageId: 'm3' },
      queued: []
    }
    store().setBotMailbox(S1, 'scout', activeOnly)
    expect(store().sessionBotMailbox[S1].scout).toEqual(activeOnly)
  })
})

describe('clearBotLiveState —— messages_reloaded 的一把扫', () => {
  it('A2-D8 两表同清且只清本会话；全空时返回空 patch（两表引用都不变）', () => {
    for (const sid of [S1, S2]) {
      store().handleBotActivity(sid, activity('scout', 'working'))
      store().setBotMailbox(sid, 'scout', MAILBOX)
    }

    store().clearBotLiveState(S1)
    expect(store().sessionBotActivities).not.toHaveProperty(S1)
    expect(store().sessionBotMailbox).not.toHaveProperty(S1)
    // 只清本会话：后台会话的在飞展示原样
    expect(store().sessionBotActivities[S2]).toBeDefined()
    expect(store().sessionBotMailbox[S2]).toBeDefined()

    // 全空（本会话已无三表条目）再清一次：空 patch，三表引用都不变
    const a = store().sessionBotActivities
    const m = store().sessionBotMailbox
    store().clearBotLiveState(S1)
    expect(store().sessionBotActivities).toBe(a)
    expect(store().sessionBotMailbox).toBe(m)
  })
})

describe('选择器 —— 无数据时的稳定空引用', () => {
  it('A2-D9 两个选择器无数据时返回稳定空引用（两次 toBe 同一对象）', () => {
    // zustand + useSyncExternalStore 的硬要求：数据未变时 selector 必须返回同一引用，
    // 否则 "getSnapshot should be cached" + 无限重渲染
    const s = useChatStore.getState()
    expect(selectBotActivities(s)).toBe(selectBotActivities(s))
    expect(selectBotMailbox(s)).toBe(selectBotMailbox(s))

    // 无活动会话时同样回落同一份空引用（不是另一个空对象）
    useChatStore.setState({ activeSessionId: null } as never)
    const s2 = useChatStore.getState()
    expect(selectBotActivities(s2)).toBe(selectBotActivities(s))
    expect(selectBotMailbox(s2)).toBe(selectBotMailbox(s))
  })
})
