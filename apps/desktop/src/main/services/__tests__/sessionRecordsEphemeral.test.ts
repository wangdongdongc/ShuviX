/**
 * sessionRecords —— 会话行的唯一出入口，在持久会话（`sessions` 表）与**内存会话**（只在进程内存里、
 * 从不落库）之间分流。
 *
 * 契约分两半：
 *   - **点查点改两边一模一样**（A-P 平行表：同一组用例跑两遍，一遍落库、一遍 `{ ephemeral: true }`）。
 *     调用方拿到的是同一种形状 —— 缺键回 null、null 列是 null 不是 undefined、每次读到的都是新对象、
 *     patch 语义、重复 id 抛错。哪一边在某个细节上走偏，读它的人（形态判定、继承、日历…）就会在
 *     两种会话上给出不同答案，而且只在内存会话上出错 —— 那正是最少被人手点到的一侧；
 *   - **列表查询只见持久会话，内存会话有自己的几条规矩**（A-L）：不进 findAll / 按项目 / 按笔记本路径，
 *     子会话按父会话所在的一边找，不记活跃，删了也记得它曾是内存会话。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 内存库，同 sessionDaoChromeTab.test）：按顺序跑全部迁移建表，
 * BaseDao 换成直接在这个库上 prepare。时间用假时钟钉住（updatedAt / lastActiveAt 要比较）。
 *
 *   P1  insert 时 projectId / parentId 为 null → findById 读回 null（不是 undefined），其余字段相等
 *   P2  pick 只回点名的键，settings 解析成对象；pick(['id']) → { id }
 *   P3  pickSettings 的值类型往返：对象 / 数组 / 字符串 / 数字 / true / 显式存的 null；缺键 → null
 *   P4  未知 id：findById / pick / pickSettings → undefined；update* 不抛
 *   P5  updateSettings patch：其余键保留；undefined 跳过；对象 / 数组整值替换（不深合并）；
 *       updatedAt = 新的 now；lastActiveAt 不动
 *   P6  updateSettings({}) / ({k: undefined}) → 什么都不变，updatedAt 不 bump
 *   P7  updateSettings({k: null}) → 键在、值为 null
 *   P8  updateTitle / updateProjectId(null) 改字段且只 bump updatedAt；touch 只 bump updatedAt
 *   P9  读出来的是新对象：改返回值（含 settings.enabledTools 数组）不影响下一次读
 *   P10 写入后调用方再改自己手里的对象（insert 的 session、updateSettings 传的数组）漏不进来
 *   P11 deleteById → findById undefined；再删一次无操作
 *   P12 重复 id insert 抛错（落库：SQLite UNIQUE；内存：自己的错误）
 *
 *   L1  findAll 只有持久会话
 *   L2  findByProjectId 不含同项目的内存会话
 *   L3  findByProjectAndNotebookPath 无视内存笔记本会话（有持久孪生回孪生，没有回 undefined）
 *   L4  findChildren(内存父) → 它的内存子会话，按 createdAt 升序；删掉的消失；没有 → []
 *   L5  findChildren 不跨边：内存父不回挂在它下面的持久行；持久父不回指向它的内存行
 *   L6  touchActive(内存) 不动 lastActiveAt 也不动 updatedAt；持久对照 bump lastActiveAt
 *   L7  isEphemeral / wasEphemeral 的真值表
 *   L8  deleteById(内存) 从不碰 SQLite：同 id 的库行、并排的持久行都还在
 *   L9  insert 撞上活着的内存 id / 已删的内存 id / （内存 insert 时）库里已有的 id → 抛错，原行不动
 *   L10 clearEphemeralForTests 清空内存行与已删记忆，不碰库
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('../../dao/database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return holder.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (holder.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => holder.db } }
})
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations } from '../../dao/migrations'
import { sessionDao } from '../../dao/sessionDao'
import type { Session, SessionSettings } from '../../dao/types'
import { sessionRecords } from '../sessionRecords'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

/** 建会话时的时钟；之后的写入把时钟拨到 LATER，好分辨谁 bump 了哪一列 */
const T0 = 1_000_000
const LATER = 2_000_000

const BINDING = { installId: 'i1', runId: 'r1', tabId: 5 }

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: `title ${id}`,
    projectId: null,
    parentId: null,
    settings: {},
    createdAt: T0,
    updatedAt: T0,
    lastActiveAt: T0,
    ...patch
  }
}

/** 测试里要塞进 settings 的「类型之外」的键（数字、显式 null） */
const loose = (settings: Record<string, unknown>): SessionSettings => settings as SessionSettings
/** 同上，给 pickSettings 点名这些键 */
const looseKeys = (...keys: string[]): Array<keyof SessionSettings> =>
  keys as unknown as Array<keyof SessionSettings>

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  sessionRecords.clearEphemeralForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ─── A-P 平行表：两边一模一样 ─────────────────────────────────────────────

describe.each([
  ['persisted', undefined],
  ['ephemeral', { ephemeral: true }]
] as const)('A-P 点查点改（%s）', (_kind, opt) => {
  const insert = (s: Session): void => sessionRecords.insert(s, opt)

  it('P1 projectId / parentId 为 null 读回 null（不是 undefined），其余字段相等', () => {
    const s = session('s1', { settings: { enabledTools: ['mcp:ssh'], bot: 'scout' } })
    insert(s)
    const row = sessionRecords.findById('s1')
    expect(row).toBeDefined()
    expect(row!.projectId).toBeNull()
    expect(row!.parentId).toBeNull()
    expect(row).toEqual(s)
  })

  it('P1 非空的 projectId / parentId 原样读回', () => {
    insert(session('s1', { projectId: 'p1', parentId: 'P' }))
    expect(sessionRecords.findById('s1')).toMatchObject({ projectId: 'p1', parentId: 'P' })
  })

  it('P2 pick 只回点名的键，settings 是对象；pick([id]) → { id }', () => {
    insert(session('s1', { projectId: 'p1', settings: { enabledTools: ['a'] } }))
    const picked = sessionRecords.pick('s1', ['projectId', 'settings'])
    expect(Object.keys(picked!).sort()).toEqual(['projectId', 'settings'])
    expect(picked).toEqual({ projectId: 'p1', settings: { enabledTools: ['a'] } })
    expect(typeof picked!.settings).toBe('object')
    expect(sessionRecords.pick('s1', ['id'])).toEqual({ id: 's1' })
  })

  it('P3 pickSettings 的值类型往返；缺键 → null', () => {
    insert(
      session('s1', {
        settings: loose({
          chromeTab: BINDING,
          enabledTools: ['mcp:ssh', 'skill:x'],
          bot: 'scout',
          count: 42,
          autoAllow: true,
          cleared: null
        })
      })
    )
    const picked = sessionRecords.pickSettings(
      's1',
      looseKeys('chromeTab', 'enabledTools', 'bot', 'count', 'autoAllow', 'cleared', 'agentProfile')
    ) as Record<string, unknown>
    expect(picked).toEqual({
      chromeTab: BINDING,
      enabledTools: ['mcp:ssh', 'skill:x'],
      bot: 'scout',
      count: 42,
      autoAllow: true,
      cleared: null,
      agentProfile: null
    })
    // 逐个钉类型：对象读成 JSON 文本、true 读成 1、null 读成缺键，这几种走偏在这里一眼可见
    expect(typeof picked.chromeTab).toBe('object')
    expect(Array.isArray(picked.enabledTools)).toBe(true)
    expect(typeof picked.count).toBe('number')
    expect(picked.autoAllow).toBe(true)
    expect('cleared' in picked && picked.cleared === null).toBe(true)
    expect('agentProfile' in picked && picked.agentProfile === null).toBe(true)
  })

  it('P4 未知 id：读回 undefined，写不抛', () => {
    insert(session('s1'))
    expect(sessionRecords.findById('nope')).toBeUndefined()
    expect(sessionRecords.pick('nope', ['id', 'settings'])).toBeUndefined()
    expect(sessionRecords.pickSettings('nope', ['bot'])).toBeUndefined()
    expect(() => {
      sessionRecords.updateTitle('nope', 't')
      sessionRecords.updateSettings('nope', { bot: 'x' })
      sessionRecords.updateProjectId('nope', 'p')
      sessionRecords.touch('nope')
      sessionRecords.touchActive('nope')
    }).not.toThrow()
    // 旁边那条没被误伤
    expect(sessionRecords.findById('s1')).toEqual(session('s1'))
  })

  it('P5 updateSettings：patch 语义，整值替换，只 bump updatedAt', () => {
    insert(
      session('s1', {
        settings: {
          bot: 'scout',
          chromeTab: BINDING,
          enabledTools: ['a', 'b'],
          allowList: ['Read(/x)']
        }
      })
    )
    vi.setSystemTime(LATER)
    sessionRecords.updateSettings('s1', {
      chromeTab: { installId: 'i2', runId: 'r2', tabId: 9 },
      enabledTools: ['c'],
      allowList: undefined,
      autoAllow: true
    })
    const row = sessionRecords.findById('s1')!
    expect(row.settings).toEqual({
      // 没点名的键保留
      bot: 'scout',
      // 对象整值替换（不深合并：不会留下旧对象上的键）
      chromeTab: { installId: 'i2', runId: 'r2', tabId: 9 },
      // 数组整值替换（不拼接）
      enabledTools: ['c'],
      // undefined 跳过：原值还在
      allowList: ['Read(/x)'],
      autoAllow: true
    })
    expect(row.updatedAt).toBe(LATER)
    expect(row.lastActiveAt).toBe(T0)
    expect(row.createdAt).toBe(T0)
  })

  it('P5 对象整值替换：新对象少了的键不会从旧对象里漏回来', () => {
    insert(session('s1', { settings: loose({ obj: { a: 1, b: 2 } }) }))
    sessionRecords.updateSettings('s1', loose({ obj: { a: 3 } }))
    expect(sessionRecords.pickSettings('s1', looseKeys('obj'))).toEqual({
      obj: { a: 3 }
    })
  })

  it('P6 空 patch / 全 undefined 的 patch → 什么都不变，updatedAt 不 bump', () => {
    insert(session('s1', { settings: { bot: 'scout' } }))
    vi.setSystemTime(LATER)
    sessionRecords.updateSettings('s1', {})
    sessionRecords.updateSettings('s1', { bot: undefined, autoAllow: undefined })
    expect(sessionRecords.findById('s1')).toEqual(session('s1', { settings: { bot: 'scout' } }))
  })

  it('P7 updateSettings({k: null}) → 键在、值为 null', () => {
    insert(session('s1', { settings: { bot: 'scout' } }))
    sessionRecords.updateSettings('s1', loose({ bot: null, fresh: null }))
    const settings = sessionRecords.findById('s1')!.settings as Record<string, unknown>
    expect('bot' in settings).toBe(true)
    expect(settings.bot).toBeNull()
    expect('fresh' in settings).toBe(true)
    expect(settings.fresh).toBeNull()
    expect(sessionRecords.pickSettings('s1', ['bot'])).toEqual({ bot: null })
  })

  it('P8 updateTitle / updateProjectId(null) / touch：改字段，只 bump updatedAt', () => {
    insert(session('s1', { projectId: 'p1' }))

    vi.setSystemTime(LATER)
    sessionRecords.updateTitle('s1', '新标题')
    expect(sessionRecords.findById('s1')).toMatchObject({
      title: '新标题',
      updatedAt: LATER,
      lastActiveAt: T0
    })

    vi.setSystemTime(LATER + 1)
    sessionRecords.updateProjectId('s1', null)
    const moved = sessionRecords.findById('s1')!
    expect(moved.projectId).toBeNull()
    expect(moved.updatedAt).toBe(LATER + 1)
    expect(moved.lastActiveAt).toBe(T0)

    vi.setSystemTime(LATER + 2)
    sessionRecords.touch('s1')
    expect(sessionRecords.findById('s1')).toEqual(
      session('s1', { title: '新标题', projectId: null, updatedAt: LATER + 2 })
    )
  })

  it('P9 读出来的是新对象：改返回值不影响下一次读', () => {
    insert(session('s1', { settings: { enabledTools: ['a'], chromeTab: BINDING } }))

    const found = sessionRecords.findById('s1')!
    found.title = 'mutated'
    found.settings.enabledTools!.push('leak')
    found.settings.chromeTab!.tabId = 99

    const picked = sessionRecords.pick('s1', ['settings'])!
    picked.settings.enabledTools!.push('leak2')

    const ps = sessionRecords.pickSettings('s1', ['enabledTools', 'chromeTab'])!
    ps.enabledTools!.push('leak3')
    ps.chromeTab!.tabId = 100

    expect(sessionRecords.findById('s1')).toEqual(
      session('s1', { settings: { enabledTools: ['a'], chromeTab: BINDING } })
    )
    expect(sessionRecords.pickSettings('s1', ['enabledTools', 'chromeTab'])).toEqual({
      enabledTools: ['a'],
      chromeTab: BINDING
    })
  })

  it('P10 写入后调用方改自己手里的对象，漏不进存储', () => {
    const s = session('s1', { settings: { enabledTools: ['a'], chromeTab: { ...BINDING } } })
    insert(s)
    s.title = 'mutated'
    s.settings.enabledTools!.push('leak')
    s.settings.chromeTab!.tabId = 99
    s.settings.bot = 'sneaky'

    const tools = ['x', 'y']
    const binding = { ...BINDING, tabId: 7 }
    sessionRecords.updateSettings('s1', { enabledTools: tools, chromeTab: binding })
    tools.push('leak2')
    binding.tabId = 8

    const row = sessionRecords.findById('s1')!
    expect(row.title).toBe('title s1')
    expect(row.settings).toEqual({ enabledTools: ['x', 'y'], chromeTab: { ...BINDING, tabId: 7 } })
  })

  it('P11 deleteById → 查不到；再删一次无操作', () => {
    insert(session('s1'))
    insert(session('s2'))
    sessionRecords.deleteById('s1')
    expect(sessionRecords.findById('s1')).toBeUndefined()
    expect(sessionRecords.pick('s1', ['id'])).toBeUndefined()
    expect(() => sessionRecords.deleteById('s1')).not.toThrow()
    expect(sessionRecords.findById('s2')).toEqual(session('s2'))
  })

  it('P12 重复 id insert 抛错，原行不动', () => {
    insert(session('s1', { title: 'first' }))
    expect(() => insert(session('s1', { title: 'second' }))).toThrow()
    expect(sessionRecords.findById('s1')!.title).toBe('first')
  })
})

// ─── A-L 列表查询与内存会话独有的规矩 ────────────────────────────────────

const EPH = { ephemeral: true }

describe('A-L 列表查询只见持久会话', () => {
  it('L1 findAll 只有持久会话', () => {
    sessionRecords.insert(session('keep'))
    sessionRecords.insert(session('mem'), EPH)
    expect(sessionRecords.findAll().map((s) => s.id)).toEqual(['keep'])
  })

  it('L2 findByProjectId 不含同项目的内存会话', () => {
    sessionRecords.insert(session('keep', { projectId: 'p1' }))
    sessionRecords.insert(session('mem', { projectId: 'p1' }), EPH)
    expect(sessionRecords.findByProjectId('p1').map((s) => s.id)).toEqual(['keep'])
  })

  it('L3 findByProjectAndNotebookPath 无视内存笔记本会话', () => {
    sessionRecords.insert(
      session('mem', { projectId: 'p1', settings: { notebookPath: 'notes/a.md' } }),
      EPH
    )
    expect(sessionRecords.findByProjectAndNotebookPath('p1', 'notes/a.md')).toBeUndefined()

    // 有持久孪生（同项目同路径）时回孪生，而不是那条内存会话
    sessionRecords.insert(
      session('twin', { projectId: 'p1', settings: { notebookPath: 'notes/a.md' } })
    )
    expect(sessionRecords.findByProjectAndNotebookPath('p1', 'notes/a.md')?.id).toBe('twin')
  })

  it('L4 findChildren(内存父)：内存子会话按 createdAt 升序；删掉的消失；没有 → []', () => {
    sessionRecords.insert(session('P'), EPH)
    // 故意乱序插入：顺序得来自 createdAt，不是插入序
    sessionRecords.insert(session('c3', { parentId: 'P', createdAt: T0 + 3 }), EPH)
    sessionRecords.insert(session('c1', { parentId: 'P', createdAt: T0 + 1 }), EPH)
    sessionRecords.insert(session('c2', { parentId: 'P', createdAt: T0 + 2 }), EPH)
    sessionRecords.insert(session('other', { parentId: 'Q', createdAt: T0 }), EPH)

    const children = sessionRecords.findChildren('P')
    expect(children.map((s) => s.id)).toEqual(['c1', 'c2', 'c3'])
    // 回的是完整会话（与 DAO 同形），不是只有 id
    expect(children[0]).toEqual(session('c1', { parentId: 'P', createdAt: T0 + 1 }))

    sessionRecords.deleteById('c2')
    expect(sessionRecords.findChildren('P').map((s) => s.id)).toEqual(['c1', 'c3'])

    sessionRecords.insert(session('lonely'), EPH)
    expect(sessionRecords.findChildren('lonely')).toEqual([])
  })

  it('L5 findChildren 不跨边', () => {
    sessionRecords.insert(session('memP'), EPH)
    sessionRecords.insert(session('dbP'))
    // 一条持久行挂在内存父下面（sessionService 不会这么建，但行本身是可能的）
    sessionRecords.insert(session('dbChildOfMem', { parentId: 'memP' }))
    // 一条内存行指向持久父
    sessionRecords.insert(session('memChildOfDb', { parentId: 'dbP' }), EPH)

    expect(sessionRecords.findChildren('memP')).toEqual([])
    expect(sessionRecords.findChildren('dbP')).toEqual([])
  })
})

describe('A-L 内存会话独有的规矩', () => {
  it('L6 touchActive：内存会话什么都不动；持久对照 bump lastActiveAt（不动 updatedAt）', () => {
    sessionRecords.insert(session('mem'), EPH)
    sessionRecords.insert(session('keep'))
    vi.setSystemTime(LATER)

    sessionRecords.touchActive('mem')
    sessionRecords.touchActive('keep')

    expect(sessionRecords.findById('mem')).toMatchObject({ lastActiveAt: T0, updatedAt: T0 })
    expect(sessionRecords.findById('keep')).toMatchObject({ lastActiveAt: LATER, updatedAt: T0 })
  })

  it('L7 isEphemeral / wasEphemeral 真值表', () => {
    sessionRecords.insert(session('mem'), EPH)
    sessionRecords.insert(session('keep'))
    sessionRecords.insert(session('keepGone'))

    expect(sessionRecords.isEphemeral('mem')).toBe(true)
    expect(sessionRecords.wasEphemeral('mem')).toBe(false)

    for (const id of ['keep', 'keepGone', 'unknown']) {
      expect(sessionRecords.isEphemeral(id)).toBe(false)
      expect(sessionRecords.wasEphemeral(id)).toBe(false)
    }

    sessionRecords.deleteById('mem')
    sessionRecords.deleteById('keepGone')

    expect(sessionRecords.isEphemeral('mem')).toBe(false)
    expect(sessionRecords.wasEphemeral('mem')).toBe(true)
    // 删掉的持久会话不是「曾经的内存会话」
    expect(sessionRecords.isEphemeral('keepGone')).toBe(false)
    expect(sessionRecords.wasEphemeral('keepGone')).toBe(false)
  })

  it('L8 deleteById(内存) 从不碰 SQLite', () => {
    sessionRecords.insert(session('mem'), EPH)
    sessionRecords.insert(session('keep'))
    // 绕过 sessionRecords 在库里放一条同 id 的行：若删内存会话时也发了 DELETE，它会跟着没掉
    sessionDao.insert(session('mem', { title: 'stored twin' }))
    const daoDelete = vi.spyOn(sessionDao, 'deleteById')

    sessionRecords.deleteById('mem')

    expect(daoDelete).not.toHaveBeenCalled()
    expect(sessionDao.findById('mem')?.title).toBe('stored twin')
    expect(sessionDao.findById('keep')).toEqual(session('keep'))
  })

  it('L9 撞上活着的内存 id → 两种 insert 都抛，原行不动', () => {
    sessionRecords.insert(session('mem', { title: 'original' }), EPH)
    expect(() => sessionRecords.insert(session('mem', { title: 'db' }))).toThrow()
    expect(() => sessionRecords.insert(session('mem', { title: 'mem2' }), EPH)).toThrow()
    expect(sessionRecords.findById('mem')!.title).toBe('original')
    expect(sessionRecords.isEphemeral('mem')).toBe(true)
    // 持久那一侧也没被写进去
    expect(sessionDao.findById('mem')).toBeUndefined()
  })

  it('L9 撞上已删的内存 id → 两种 insert 都抛，库里也不落', () => {
    sessionRecords.insert(session('gone'), EPH)
    sessionRecords.deleteById('gone')
    expect(() => sessionRecords.insert(session('gone'))).toThrow()
    expect(() => sessionRecords.insert(session('gone'), EPH)).toThrow()
    expect(sessionDao.findById('gone')).toBeUndefined()
    expect(sessionRecords.findById('gone')).toBeUndefined()
    expect(sessionRecords.isEphemeral('gone')).toBe(false)
    expect(sessionRecords.wasEphemeral('gone')).toBe(true)
  })

  it('L9 内存 insert 撞上库里已有的 id → 抛，库行不动、不被遮住', () => {
    sessionRecords.insert(session('keep', { title: 'stored' }))
    expect(() => sessionRecords.insert(session('keep', { title: 'shadow' }), EPH)).toThrow()
    expect(sessionRecords.isEphemeral('keep')).toBe(false)
    expect(sessionRecords.findById('keep')!.title).toBe('stored')
    expect(sessionDao.findById('keep')!.title).toBe('stored')
  })

  it('L10 clearEphemeralForTests 清空内存行与已删记忆，不碰库', () => {
    sessionRecords.insert(session('mem'), EPH)
    sessionRecords.insert(session('gone'), EPH)
    sessionRecords.deleteById('gone')
    sessionRecords.insert(session('keep'))

    sessionRecords.clearEphemeralForTests()

    expect(sessionRecords.isEphemeral('mem')).toBe(false)
    expect(sessionRecords.findById('mem')).toBeUndefined()
    expect(sessionRecords.wasEphemeral('gone')).toBe(false)
    expect(sessionRecords.findById('keep')).toEqual(session('keep'))
    // 已删记忆清掉后，那个 id 又能用了
    expect(() => sessionRecords.insert(session('gone'), EPH)).not.toThrow()
  })
})
