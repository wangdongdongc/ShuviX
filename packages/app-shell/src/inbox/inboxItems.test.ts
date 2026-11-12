/**
 * 收件箱的分节（纯函数，node）—— 在跑的两种（S1，2026-11-11）：
 *
 *   INB-1 一条会话归哪一节、带什么 `run`：等你回答 > agent 在干活 > 新回复 > 只剩后台命令；询问数为负按 0 算
 *   INB-2 表里有、会话列表里没有的会话不收
 *   INB-3 运行中：agent 在干活的在前，只剩后台命令的在后，各自最近动过的在前；同一时刻按建立时间，再按 id
 *   INB-4 等你回答不看在跑的种类，只按最近动过
 *   INB-5 只剩后台命令、命令表里没有它（或不给命令表）→ commands 为空
 *   INB-6 不给未读表 → 只剩后台命令的照样在运行中
 *   INB-7 归家：一家在运行中的次序跟着家里最靠前的那条会话；根停着时 rootItem 为 null
 *   INB-8 只剩后台命令、又有新回复的子会话进家里的「新回复」，这一家归新回复
 *
 * 留着的那一条（`held`，2026-11-12 E1：作为新回复打开、读过了还留在原处）：
 *
 *   INH-1 留着的 S 按它那一刻的未读排在新回复里，带 held: true；别的条目没有 held 这个键
 *   INH-2 S 又有了真的未读：只有一条 S，用真的那份，没有 held
 *   INH-3 留着的 S 此刻在跑 / 在等你 / 只剩后台命令 / 后台 agent / 已不在会话表里，各归各处
 *   INH-4 留着的子会话归进父会话那一家的新回复里（带 held），父会话自己没有新回复
 */
import { describe, expect, it } from 'vitest'
import type { Session, SessionRunKind } from '@shuvix/chat-ui'
import type { SessionUnread } from '@shuvix/chat-protocol/sessionUnread'
import { inboxFamiliesOf, inboxSectionsOf, type InboxInput, type InboxSections } from './inboxItems'

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: `Title ${id}`,
    projectId: null,
    parentId: null,
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...over
  }
}
const unreadEntry = (since = 1, failed = false): SessionUnread => ({
  since,
  failed,
  manual: false
})

function sections(input: Partial<InboxInput> & { sessions: Session[] }): InboxSections {
  return inboxSectionsOf({ streaming: {}, askCounts: {}, backgroundRunKinds: {}, ...input })
}

const ids = (items: Array<{ session: { id: string } }>): string[] => items.map((i) => i.session.id)

describe('INB-1 classification', () => {
  interface Case {
    streaming?: Record<string, boolean>
    asks?: number
    bg?: SessionRunKind
    commands?: string[]
    unread?: boolean
  }
  interface Expected {
    section: 'absent' | 'waiting' | 'running' | 'unread'
    run?: SessionRunKind | null
    asks?: number
    commands?: string[]
  }
  it.each<[string, Case, Expected]>([
    ['nothing', {}, { section: 'absent' }],
    ['streaming', { streaming: { s: true } }, { section: 'running', run: 'agent' }],
    [
      'streaming false + bg resident',
      { streaming: { s: false }, bg: 'resident' },
      { section: 'running', run: 'resident' }
    ],
    ['bg agent', { bg: 'agent' }, { section: 'running', run: 'agent' }],
    [
      'bg resident + commands',
      { bg: 'resident', commands: ['a'] },
      { section: 'running', run: 'resident', commands: ['a'] }
    ],
    [
      'streaming + bg resident',
      { streaming: { s: true }, bg: 'resident' },
      { section: 'running', run: 'agent' }
    ],
    ['asks 2', { asks: 2 }, { section: 'waiting', run: null, asks: 2 }],
    [
      'asks + streaming',
      { asks: 1, streaming: { s: true } },
      { section: 'waiting', run: 'agent', asks: 1 }
    ],
    ['asks + resident', { asks: 1, bg: 'resident' }, { section: 'waiting', run: 'resident' }],
    ['asks + unread', { asks: 1, unread: true }, { section: 'waiting', run: null }],
    [
      'streaming + unread',
      { streaming: { s: true }, unread: true },
      { section: 'running', run: 'agent' }
    ],
    ['bg agent + unread', { bg: 'agent', unread: true }, { section: 'running', run: 'agent' }],
    ['resident + unread', { bg: 'resident', unread: true }, { section: 'unread' }],
    ['unread only', { unread: true }, { section: 'unread' }],
    ['askCount -1 alone', { asks: -1 }, { section: 'absent' }],
    [
      'askCount -1 + resident',
      { asks: -1, bg: 'resident' },
      { section: 'running', run: 'resident', asks: 0 }
    ]
  ])('INB-1 %s', (_label, c, expected) => {
    const result = sections({
      sessions: [session('s')],
      streaming: c.streaming ?? {},
      askCounts: c.asks === undefined ? {} : { s: c.asks },
      backgroundRunKinds: c.bg ? { s: c.bg } : {},
      backgroundCommands: c.commands ? { s: c.commands } : {},
      unread: c.unread ? { s: unreadEntry() } : {}
    })
    const where = {
      waiting: ids(result.waiting).includes('s'),
      running: ids(result.running).includes('s'),
      unread: ids(result.unread).includes('s')
    }
    expect(where).toEqual({
      waiting: expected.section === 'waiting',
      running: expected.section === 'running',
      unread: expected.section === 'unread'
    })
    const item = [...result.waiting, ...result.running].find((i) => i.session.id === 's')
    if (expected.section === 'waiting' || expected.section === 'running') {
      expect(item).toBeDefined()
      if (expected.run !== undefined) expect(item!.run).toBe(expected.run)
      if (expected.asks !== undefined) expect(item!.asks).toBe(expected.asks)
      if (expected.commands !== undefined) expect(item!.commands).toEqual(expected.commands)
    }
  })
})

describe('INB-2 sessions missing from the list', () => {
  it('INB-2 an id in the maps but not in sessions lands nowhere', () => {
    const result = sections({
      sessions: [session('present')],
      streaming: { ghost: true },
      askCounts: { ghost: 2 },
      backgroundRunKinds: { ghost: 'resident' },
      backgroundCommands: { ghost: ['x'] },
      unread: { ghost: unreadEntry() }
    })
    expect(result).toEqual({ waiting: [], unread: [], running: [] })
  })
})

describe('INB-3 running order', () => {
  it('INB-3 agent first, then resident; most recent first; createdAt breaks a tie', () => {
    const result = sections({
      sessions: [
        session('R1', { lastActiveAt: 900, createdAt: 3 }),
        session('A1', { lastActiveAt: 100 }),
        session('R2', { lastActiveAt: 900, createdAt: 5 }),
        session('A2', { lastActiveAt: 500 })
      ],
      streaming: { A1: true },
      backgroundRunKinds: { A2: 'agent', R1: 'resident', R2: 'resident' }
    })
    expect(ids(result.running)).toEqual(['A2', 'A1', 'R2', 'R1'])
  })

  it('INB-3 equal lastActiveAt and createdAt → id ascending', () => {
    const result = sections({
      sessions: [session('c'), session('a'), session('b')],
      backgroundRunKinds: { a: 'resident', b: 'resident', c: 'resident' }
    })
    expect(ids(result.running)).toEqual(['a', 'b', 'c'])
  })
})

describe('INB-4 waiting ignores the run kind', () => {
  it('INB-4 most recent first, whatever is running', () => {
    const result = sections({
      sessions: [session('W2', { lastActiveAt: 100 }), session('W1', { lastActiveAt: 900 })],
      streaming: { W2: true },
      askCounts: { W1: 1, W2: 1 },
      backgroundRunKinds: { W1: 'resident' }
    })
    expect(ids(result.waiting)).toEqual(['W1', 'W2'])
  })
})

describe('INB-5 commands', () => {
  it('INB-5 resident with no key in backgroundCommands → []', () => {
    const result = sections({
      sessions: [session('s')],
      backgroundRunKinds: { s: 'resident' },
      backgroundCommands: { other: ['x'] }
    })
    expect(result.running[0].commands).toEqual([])
  })

  it('INB-5 backgroundCommands omitted → []', () => {
    const result = inboxSectionsOf({
      sessions: [session('s')],
      streaming: {},
      askCounts: {},
      backgroundRunKinds: { s: 'resident' }
    })
    expect(result.running[0].commands).toEqual([])
  })
})

describe('INB-6 no unread map', () => {
  it('INB-6 unread omitted → resident stays in running', () => {
    const result = inboxSectionsOf({
      sessions: [session('s')],
      streaming: {},
      askCounts: {},
      backgroundRunKinds: { s: 'resident' }
    })
    expect(ids(result.running)).toEqual(['s'])
    expect(result.unread).toEqual([])
  })
})

describe('INB-7 families', () => {
  it('INB-7 a family is ranked by its foremost member; an idle root has no rootItem', () => {
    const sessions = [
      session('X', { lastActiveAt: 900 }),
      session('Y', { lastActiveAt: 50 }),
      session('C', { parentId: 'Y', lastActiveAt: 100 })
    ]
    const result = sections({
      sessions,
      streaming: { C: true },
      backgroundRunKinds: { X: 'resident' }
    })
    const families = inboxFamiliesOf(result, sessions)
    expect(families.running.map((f) => f.root.id)).toEqual(['Y', 'X'])
    const [y, x] = families.running
    expect(y.rootItem).toBeNull()
    expect(y.running.map((i) => [i.session.id, i.run])).toEqual([['C', 'agent']])
    expect(x.rootItem?.run).toBe('resident')
  })
})

describe('INB-8 a resident child with a new reply', () => {
  it('INB-8 the child sits in family.unread; the family lands in unread', () => {
    const sessions = [session('P'), session('K', { parentId: 'P' })]
    const result = sections({
      sessions,
      backgroundRunKinds: { K: 'resident' },
      unread: { K: unreadEntry() }
    })
    const families = inboxFamiliesOf(result, sessions)
    expect(families.unread.map((f) => f.root.id)).toEqual(['P'])
    expect(families.running).toEqual([])
    const [p] = families.unread
    expect(ids(p.unread)).toEqual(['K'])
    expect(p.running).toEqual([])
  })
})

describe('INH-1 / INH-2 a held unread', () => {
  it('INH-1 the held entry sorts by its own since among the live ones and carries held: true', () => {
    const heldEntry = unreadEntry(200)
    const result = sections({
      sessions: [session('A'), session('S'), session('B')],
      unread: { A: unreadEntry(300), B: unreadEntry(100) },
      held: { sessionId: 'S', unread: heldEntry }
    })
    expect(ids(result.unread)).toEqual(['A', 'S', 'B'])
    const s = result.unread.find((i) => i.session.id === 'S')!
    expect(s).toEqual({ session: s.session, unread: heldEntry, held: true })
    expect(s.unread).toBe(heldEntry)
    for (const id of ['A', 'B']) {
      const item = result.unread.find((i) => i.session.id === id)!
      expect(Object.prototype.hasOwnProperty.call(item, 'held'), id).toBe(false)
    }
    expect(result.waiting).toEqual([])
    expect(result.running).toEqual([])
  })

  it('INH-2 a live unread for the held session wins: one item, the live entry, no held key', () => {
    const live = unreadEntry(500)
    const result = sections({
      sessions: [session('S')],
      unread: { S: live },
      held: { sessionId: 'S', unread: unreadEntry(200) }
    })
    expect(result.unread).toHaveLength(1)
    expect(result.unread[0].unread).toBe(live)
    expect(Object.prototype.hasOwnProperty.call(result.unread[0], 'held')).toBe(false)
  })
})

describe('INH-3 a held session that is doing something else now', () => {
  interface Case {
    streaming?: Record<string, boolean>
    askCounts?: Record<string, number>
    bg?: Record<string, SessionRunKind>
    /** held 指向一条不在会话表里的会话 */
    ghost?: boolean
  }
  interface Expected {
    section: 'absent' | 'waiting' | 'running' | 'unread'
    run?: SessionRunKind
    held?: boolean
  }
  it.each<[string, Case, Expected]>([
    ['streaming', { streaming: { S: true } }, { section: 'running', run: 'agent' }],
    ['asks', { askCounts: { S: 1 } }, { section: 'waiting' }],
    ['background resident', { bg: { S: 'resident' } }, { section: 'unread', held: true }],
    ['background agent', { bg: { S: 'agent' } }, { section: 'running', run: 'agent' }],
    ['not in sessions', { ghost: true }, { section: 'absent' }]
  ])('INH-3 %s', (_label, c, expected) => {
    const result = sections({
      sessions: c.ghost ? [session('other')] : [session('S')],
      streaming: c.streaming ?? {},
      askCounts: c.askCounts ?? {},
      backgroundRunKinds: c.bg ?? {},
      unread: {},
      held: { sessionId: 'S', unread: unreadEntry(200) }
    })
    if (expected.section === 'absent') {
      expect(result).toEqual({ waiting: [], unread: [], running: [] })
      return
    }
    expect({
      waiting: ids(result.waiting),
      unread: ids(result.unread),
      running: ids(result.running)
    }).toEqual({
      waiting: expected.section === 'waiting' ? ['S'] : [],
      unread: expected.section === 'unread' ? ['S'] : [],
      running: expected.section === 'running' ? ['S'] : []
    })
    if (expected.run) expect(result.running[0].run).toBe(expected.run)
    if (expected.held) expect(result.unread[0].held).toBe(true)
  })
})

describe('INH-4 a held child', () => {
  it('INH-4 the held child joins its idle parent family in unread; the root has no unread of its own', () => {
    const sessions = [session('P'), session('K', { parentId: 'P' })]
    const result = sections({
      sessions,
      unread: {},
      held: { sessionId: 'K', unread: unreadEntry(200) }
    })
    const families = inboxFamiliesOf(result, sessions)
    expect(families.unread.map((f) => f.root.id)).toEqual(['P'])
    expect(families.waiting).toEqual([])
    expect(families.running).toEqual([])
    const [p] = families.unread
    expect(p.rootUnread).toBeNull()
    expect(p.rootItem).toBeNull()
    expect(ids(p.unread)).toEqual(['K'])
    expect(p.unread[0].held).toBe(true)
  })
})
