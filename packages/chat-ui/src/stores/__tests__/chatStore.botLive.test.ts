/**
 * chatStore 的 bot live 两切片（A2）—— bot_activity / bot_mailbox 两个事件的唯一写入点，
 * 与选择器的稳定引用契约。会话是一对一的：每个会话至多一条在飞活动、一份 mailbox 快照。
 *
 * 这两张 per-session 表驱动的是对话尾部的「正在输入」行与用户消息下的排队回执；
 * 「删键而不是存空值」不是洁癖 —— 选择器靠「键不在」回落到稳定的 null，存空对象会让
 * zustand + useSyncExternalStore 在每次快照上拿到新引用，直接进无限重渲染循环。
 *
 * useChatStore 是模块级单例：每条用例在 beforeEach 里把两张表与活动会话整体重置。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useChatStore,
  selectBotActivity,
  selectBotMailbox,
  type BotMailboxSnapshot
} from '../chatStore'

const S1 = 'live-s1'
const S2 = 'live-s2'

const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

/** 一条 bot_activity 事件（相位由用例指定） */
const activity = (
  phase: string,
  messageId = 'm1'
): { botName: string; displayName: string; phase: string; messageId?: string } => ({
  botName: 'scout',
  displayName: 'SCOUT',
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
  it('A2-D1 三个 live 相位逐个 upsert；相位推进覆盖同一条（一个会话一条）', () => {
    for (const phase of ['started', 'queued', 'working'] as const) {
      store().handleBotActivity(S1, activity(phase))
      const snap = store().sessionBotActivities[S1]
      expect(snap).toMatchObject({
        botName: 'scout',
        displayName: 'SCOUT',
        phase,
        messageId: 'm1'
      })
      expect(typeof snap.at).toBe('number')
    }
    // 第二条消息的相位到达：还是覆盖同一条 —— 「正在输入」行只有一行
    store().handleBotActivity(S1, activity('started', 'm2'))
    expect(store().sessionBotActivities[S1]).toMatchObject({ phase: 'started', messageId: 'm2' })
    expect(Object.keys(store().sessionBotActivities)).toEqual([S1])
  })

  it('A2-D2 ended 删会话键；别的会话不受影响', () => {
    store().handleBotActivity(S1, activity('working'))
    store().handleBotActivity(S2, activity('queued'))

    store().handleBotActivity(S1, activity('ended'))
    expect(store().sessionBotActivities).not.toHaveProperty(S1)
    expect(store().sessionBotActivities).toHaveProperty(S2)
  })

  it('A2-D2b 迟到的 ended 认消息：它说的不是当前展示的那条 → 不收摊', () => {
    // 连发两条时，msg1 的 ended 晚于 msg2 的 working 到达（say 发生在 turn 释放独占段
    // 之后，而释放当场就把 msg2 授予了）。无条件删键会把一条**还在跑**的应答连同它的
    // 停止钮从屏幕上抹掉，直到它自己结束都不再回来 —— 这条钉的就是那个真缺陷
    store().handleBotActivity(S1, activity('working', 'm2'))
    store().handleBotActivity(S1, activity('ended', 'm1'))
    expect(store().sessionBotActivities[S1]).toMatchObject({ phase: 'working', messageId: 'm2' })

    // 轮到它自己结束：照常收摊
    store().handleBotActivity(S1, activity('ended', 'm2'))
    expect(store().sessionBotActivities).not.toHaveProperty(S1)
  })

  it('A2-D2c 快照或事件缺 messageId → 按旧口径无条件收摊（防御性回退）', () => {
    store().handleBotActivity(S1, { botName: 'scout', displayName: 'SCOUT', phase: 'working' })
    store().handleBotActivity(S1, activity('ended', 'm1'))
    expect(store().sessionBotActivities).not.toHaveProperty(S1)

    store().handleBotActivity(S1, activity('working', 'm2'))
    store().handleBotActivity(S1, { botName: 'scout', displayName: 'SCOUT', phase: 'ended' })
    expect(store().sessionBotActivities).not.toHaveProperty(S1)
  })

  it('A2-D3 ended 对无条目会话 → 空 patch，顶层与别会话的切片引用不变', () => {
    store().handleBotActivity(S2, activity('working'))
    const beforeAll = store().sessionBotActivities
    const beforeS2 = beforeAll[S2]

    store().handleBotActivity(S1, activity('ended'))

    // 空 patch = 顶层 map 引用原样（不是重建了一份等值对象）
    expect(store().sessionBotActivities).toBe(beforeAll)
    expect(store().sessionBotActivities[S2]).toBe(beforeS2)
  })

  it('A2-D5 未知相位（paused）按 ended 同款删键 —— live 集合是白名单', () => {
    store().handleBotActivity(S1, activity('working'))
    store().handleBotActivity(S1, activity('paused'))
    expect(store().sessionBotActivities).not.toHaveProperty(S1)
  })
})

describe('setBotMailbox —— 空快照即删键', () => {
  it('A2-D6 整份替换；空快照删会话键；absent 时空快照 no-op；active 非空 + queued 空 ≠ 空快照', () => {
    store().setBotMailbox(S1, MAILBOX)
    store().setBotMailbox(S2, MAILBOX)
    expect(Object.keys(store().sessionBotMailbox).sort()).toEqual([S1, S2])

    store().setBotMailbox(S1, { active: null, queued: [] })
    expect(store().sessionBotMailbox).not.toHaveProperty(S1)
    expect(store().sessionBotMailbox[S2]).toEqual(MAILBOX)

    // 本来就没有条目时再收一份空快照：空 patch，引用不变
    const before = store().sessionBotMailbox
    store().setBotMailbox(S1, { active: null, queued: [] })
    expect(store().sessionBotMailbox).toBe(before)

    // active 非空 + queued 空是**正在处理**，不是空快照 —— 必须存下
    const activeOnly: BotMailboxSnapshot = {
      active: { messageSeq: 3, messageId: 'm3' },
      queued: []
    }
    store().setBotMailbox(S1, activeOnly)
    expect(store().sessionBotMailbox[S1]).toEqual(activeOnly)
  })
})

describe('clearBotLiveState —— messages_reloaded 的一把扫', () => {
  it('A2-D8 两表同清且只清本会话；全空时返回空 patch（两表引用都不变）', () => {
    for (const sid of [S1, S2]) {
      store().handleBotActivity(sid, activity('working'))
      store().setBotMailbox(sid, MAILBOX)
    }

    store().clearBotLiveState(S1)
    expect(store().sessionBotActivities).not.toHaveProperty(S1)
    expect(store().sessionBotMailbox).not.toHaveProperty(S1)
    // 只清本会话：后台会话的在飞展示原样
    expect(store().sessionBotActivities[S2]).toBeDefined()
    expect(store().sessionBotMailbox[S2]).toBeDefined()

    // 全空（本会话已无两表条目）再清一次：空 patch，两表引用都不变
    const a = store().sessionBotActivities
    const m = store().sessionBotMailbox
    store().clearBotLiveState(S1)
    expect(store().sessionBotActivities).toBe(a)
    expect(store().sessionBotMailbox).toBe(m)
  })
})

describe('选择器 —— 无数据时的稳定引用', () => {
  it('A2-D9 两个选择器无数据时返回 null（稳定引用），有数据时返回那一条', () => {
    // zustand + useSyncExternalStore 的硬要求：数据未变时 selector 必须返回同一引用，
    // 否则 "getSnapshot should be cached" + 无限重渲染 —— null 天然稳定
    const s = useChatStore.getState()
    expect(selectBotActivity(s)).toBeNull()
    expect(selectBotMailbox(s)).toBeNull()

    store().handleBotActivity(S1, activity('working'))
    store().setBotMailbox(S1, MAILBOX)
    const s1 = useChatStore.getState()
    expect(selectBotActivity(s1)).toBe(s1.sessionBotActivities[S1])
    expect(selectBotMailbox(s1)).toBe(s1.sessionBotMailbox[S1])

    // 无活动会话时回落 null
    useChatStore.setState({ activeSessionId: null } as never)
    const s2 = useChatStore.getState()
    expect(selectBotActivity(s2)).toBeNull()
    expect(selectBotMailbox(s2)).toBeNull()
  })
})
