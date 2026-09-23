/**
 * sessionService —— **内存会话**（`create(params, { ephemeral: true })`）的服务层语义。
 *
 * 契约：行只在内存里（sessionRecords）、从不落库；不进列表所以没有列表变化可广播；子会话按父会话
 * 推定（内存父 → 内存子，与 options 无关；持久父 → 持久子，同样与 options 无关）；删除走完整的
 * 清理链但不碰库、不广播；所有写入口落在内存行上，读面（getById / 形态推导）读得到。
 * 父会话是一条**已删掉的内存会话**时拒绝建子会话 —— 那是宿主刚把它删掉，建出来的要么是库里的孤儿，
 * 要么是谁也不会去删的内存会话。
 *
 * mock 面沿用 sessionServiceBuiltinMcpLifetime.test.ts（import 图全换假件、真 SessionManager、
 * `AgentSession.create` 可捕获）。差别在于 **sessionRecords 是真的**：只替掉它底下的
 * `dao/sessionDao`，而且 DAO 的每个方法都是 spy、背后是一张内存表 —— 「没碰库」就是
 * 「这张表的 spy 没被调」，而持久会话那一侧照样有行可读。
 *
 *   S1  create(p, {ephemeral}) 不落库、不广播；isEphemeral；getById 读得到；list() 不含
 *   S2  对照：create(p) 落库一次 + 广播一次
 *   S3  内存父的子会话恒为内存会话（不传 / false / true），继承父的 enabledTools / autoAllow / projectId
 *   S4  持久父的子会话传 {ephemeral:true} 仍是持久会话
 *   S5  delete(内存)：行没了、不碰库、不广播；清理链（消息 / 后台任务 / 运行时 / 内置 MCP）各跑一次
 *   S6  delete(内存父) 连带两条内存子会话：子先于父，什么都不剩，不广播
 *   S7  写入口落在内存行上、不写库，getById 看得见
 *   S8  形态推导读内存行：bot → bot，笔记本 → notebook，无项目 → chat（有项目 → work）
 *   S9  params 里混进来的 `ephemeral: true` 不算数 —— 仍是持久会话
 *   S10 父会话是已删的内存会话 → create 抛错，哪儿都不插；对照：父行只是不存在 → 照旧建成持久会话
 *   S11 updateProjectId：内存会话不广播列表变化；持久对照广播
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type { Session } from '../../dao/types'

/** 持久会话那一侧的「库」：DAO spy 背后的内存表 */
const table = vi.hoisted(() => new Map<string, unknown>())

const mocks = vi.hoisted(() => {
  const rows = (): Map<string, Record<string, unknown>> =>
    table as unknown as Map<string, Record<string, unknown>>
  const clone = <T>(v: T): T => structuredClone(v)
  return {
    daoInsert: vi.fn((s: Record<string, unknown>) => {
      if (rows().has(s.id as string)) throw new Error('UNIQUE constraint failed: sessions.id')
      rows().set(s.id as string, clone(s))
    }),
    daoFindById: vi.fn((id: string) => {
      const r = rows().get(id)
      return r ? clone(r) : undefined
    }),
    daoFindAll: vi.fn(() => [...rows().values()].map((r) => clone(r))),
    daoFindByProjectId: vi.fn((pid: string) =>
      [...rows().values()].filter((r) => r.projectId === pid).map((r) => clone(r))
    ),
    daoFindChildren: vi.fn((pid: string) =>
      [...rows().values()].filter((r) => r.parentId === pid).map((r) => clone(r))
    ),
    daoPick: vi.fn((id: string, cols: string[]) => {
      const r = rows().get(id)
      return r ? Object.fromEntries(cols.map((c) => [c, clone(r[c])])) : undefined
    }),
    daoPickSettings: vi.fn((id: string, keys: string[]) => {
      const r = rows().get(id)
      if (!r) return undefined
      const settings = (r.settings ?? {}) as Record<string, unknown>
      return Object.fromEntries(keys.map((k) => [k, k in settings ? clone(settings[k]) : null]))
    }),
    daoUpdateSettings: vi.fn((id: string, patch: Record<string, unknown>) => {
      const r = rows().get(id)
      if (!r) return
      const defined = Object.entries(patch).filter(([, v]) => v !== undefined)
      r.settings = { ...(r.settings as object), ...clone(Object.fromEntries(defined)) }
    }),
    daoUpdateTitle: vi.fn((id: string, title: string) => {
      const r = rows().get(id)
      if (r) r.title = title
    }),
    daoUpdateProjectId: vi.fn((id: string, pid: string | null) => {
      const r = rows().get(id)
      if (r) r.projectId = pid
    }),
    daoDeleteById: vi.fn((id: string) => {
      rows().delete(id)
    }),
    daoTouch: vi.fn(),
    daoTouchActive: vi.fn(),
    broadcastListChanged: vi.fn(),
    broadcastTitleChanged: vi.fn(),
    broadcastConfigChanged: vi.fn(),
    readSessionRunConfig: vi.fn(),
    agentCreate: vi.fn<(params: { sessionId: string }) => Promise<unknown>>(),
    closeSession: vi.fn<(sessionId: string) => Promise<void>>(),
    messageClear: vi.fn(),
    killBySession: vi.fn(),
    projectPick: vi.fn()
  }
})

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    insert: mocks.daoInsert,
    findById: mocks.daoFindById,
    findAll: mocks.daoFindAll,
    findByProjectId: mocks.daoFindByProjectId,
    findChildren: mocks.daoFindChildren,
    findByProjectAndNotebookPath: vi.fn(),
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    updateTitle: mocks.daoUpdateTitle,
    updateProjectId: mocks.daoUpdateProjectId,
    deleteById: mocks.daoDeleteById,
    touch: mocks.daoTouch,
    touchActive: mocks.daoTouchActive
  }
}))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: vi.fn(() => []),
    findEnabled: vi.fn(() => []),
    findEnabledModels: vi.fn(() => [])
  }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../messageService', () => ({ messageService: { clear: mocks.messageClear } }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: mocks.readSessionRunConfig,
  addSessionTreePin: vi.fn(),
  appendModelChange: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results',
  getSessionArtifactsDir: (sid: string) => `/nonexistent/shuvix-unit/artifacts/${sid}`
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: mocks.closeSession } }))
vi.mock('../toolAggregator', () => ({
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({
  buildAllowEntry: (type: string, path: string) => `${type}(${path})`
}))
vi.mock('../agentService', () => ({
  agentService: { getProfile: vi.fn(), isSessionProfile: vi.fn() }
}))
vi.mock('../agentSession', () => ({ AgentSession: { create: mocks.agentCreate } }))
vi.mock('../bgTaskService', () => ({
  killBySession: mocks.killBySession,
  setBgTaskNotifier: vi.fn()
}))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: mocks.broadcastConfigChanged,
  broadcastSessionListChanged: mocks.broadcastListChanged,
  broadcastSessionTitleChanged: mocks.broadcastTitleChanged
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../userInputBroker', () => ({ registerUserInputParticipant: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { sessionRecords } from '../sessionRecords'

let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

// ─── 假 AgentSession：SessionManager 的 dispose 只碰 invalidate / destroy ─────

interface FakeAgent {
  invalidate: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}
const agents = new Map<string, FakeAgent>()

/** 所有「写库」的 DAO spy —— 内存会话的任何操作都不该碰到其中任何一个 */
const daoWrites = (): Array<ReturnType<typeof vi.fn>> => [
  mocks.daoInsert,
  mocks.daoUpdateSettings,
  mocks.daoUpdateTitle,
  mocks.daoUpdateProjectId,
  mocks.daoDeleteById,
  mocks.daoTouch,
  mocks.daoTouchActive
]
const expectNoDaoWrites = (): void => {
  for (const spy of daoWrites()) expect(spy).not.toHaveBeenCalled()
}

let clock = 1_000_000

beforeEach(() => {
  table.clear()
  agents.clear()
  sessionRecords.clearEphemeralForTests()
  vi.clearAllMocks()
  // 子会话按 createdAt 排序：每次 create 拨一下时钟，顺序才是确定的
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
  mocks.readSessionRunConfig.mockResolvedValue({})
  mocks.projectPick.mockReturnValue(undefined)
  mocks.closeSession.mockResolvedValue(undefined)
  mocks.agentCreate.mockImplementation(async (params) => {
    const agent: FakeAgent = { invalidate: vi.fn(async () => {}), destroy: vi.fn(async () => {}) }
    agents.set(params.sessionId, agent)
    return agent
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 拨一下时钟再建：同一毫秒里建的两条子会话分不出先后 */
function create(...args: Parameters<typeof sessionService.create>): Session {
  clock += 10
  vi.setSystemTime(clock)
  return sessionService.create(...args)
}

const EPH = { ephemeral: true }

describe('S1 / S2 建会话', () => {
  it('S1 内存会话：不落库、不广播；isEphemeral；getById 读得到；list() 不含', () => {
    const kept = create({ title: 'kept' })
    vi.clearAllMocks()

    const s = create({ title: 'mem' }, EPH)

    expect(mocks.daoInsert).not.toHaveBeenCalled()
    expect(mocks.broadcastListChanged).not.toHaveBeenCalled()
    expect(sessionRecords.isEphemeral(s.id)).toBe(true)
    expect(table.has(s.id)).toBe(false)
    expect(sessionService.getById(s.id)).toMatchObject({
      id: s.id,
      title: 'mem',
      projectId: null,
      parentId: null,
      settings: { enabledTools: [] },
      workingDirectory: `/nonexistent/shuvix-unit/tmp/${s.id}`
    })
    expect(sessionService.list().map((x) => x.id)).toEqual([kept.id])
  })

  it('S2 对照：持久会话落库一次、广播一次', () => {
    const s = create({ title: 'kept' })
    expect(mocks.daoInsert).toHaveBeenCalledTimes(1)
    expect(mocks.daoInsert.mock.calls[0][0]).toMatchObject({ id: s.id, title: 'kept' })
    expect(mocks.broadcastListChanged).toHaveBeenCalledTimes(1)
    expect(mocks.daoInsert.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.broadcastListChanged.mock.invocationCallOrder[0]
    )
    expect(sessionRecords.isEphemeral(s.id)).toBe(false)
    expect(sessionService.list().map((x) => x.id)).toEqual([s.id])
  })
})

describe('S3 / S4 子会话按父会话推定', () => {
  it.each([
    ['不传 options', undefined],
    ['{ ephemeral: false }', { ephemeral: false }],
    ['{ ephemeral: true }', { ephemeral: true }]
  ])('S3 内存父的子会话（%s）恒为内存会话，继承父的勾选 / 免询问 / 项目', (_label, opt) => {
    const parent = create({ projectId: 'p1' }, EPH)
    sessionService.updateEnabledTools(parent.id, ['mcp:ssh', 'skill:x'])
    sessionService.updateAutoAllow(parent.id, true)
    vi.clearAllMocks()

    const child = create({ parentId: parent.id, projectId: 'elsewhere' }, opt)

    expect(sessionRecords.isEphemeral(child.id)).toBe(true)
    expect(mocks.daoInsert).not.toHaveBeenCalled()
    expect(mocks.broadcastListChanged).not.toHaveBeenCalled()
    expect(sessionService.getById(child.id)).toMatchObject({
      parentId: parent.id,
      projectId: 'p1',
      settings: { enabledTools: ['mcp:ssh', 'skill:x'], autoAllow: true }
    })
    expect(sessionRecords.findChildren(parent.id).map((s) => s.id)).toEqual([child.id])
  })

  it('S4 持久父的子会话传 { ephemeral: true } 仍是持久会话', () => {
    const parent = create({ projectId: 'p1' })
    vi.clearAllMocks()

    const child = create({ parentId: parent.id }, EPH)

    expect(sessionRecords.isEphemeral(child.id)).toBe(false)
    expect(mocks.daoInsert).toHaveBeenCalledTimes(1)
    expect(mocks.daoInsert.mock.calls[0][0]).toMatchObject({
      id: child.id,
      parentId: parent.id,
      projectId: 'p1'
    })
    expect(mocks.broadcastListChanged).toHaveBeenCalledTimes(1)
  })
})

describe('S5 / S6 删除', () => {
  it('S5 delete(内存)：行没了、不碰库、不广播；清理链各跑一次', async () => {
    const s = create({}, EPH)
    // 让它有一个运行时：删除要先关停它（destroy）
    await sessionService.ensureAgentSession(s.id)
    expect(agents.has(s.id)).toBe(true)
    vi.clearAllMocks()

    await sessionService.delete(s.id)

    expect(sessionService.getById(s.id)).toBeUndefined()
    expect(sessionRecords.isEphemeral(s.id)).toBe(false)
    expect(sessionRecords.wasEphemeral(s.id)).toBe(true)
    expect(mocks.daoDeleteById).not.toHaveBeenCalled()
    expect(mocks.broadcastListChanged).not.toHaveBeenCalled()
    expectNoDaoWrites()

    expect(mocks.messageClear.mock.calls).toEqual([[s.id]])
    expect(mocks.killBySession.mock.calls).toEqual([[s.id]])
    expect(agents.get(s.id)!.destroy).toHaveBeenCalledTimes(1)
    expect(mocks.closeSession.mock.calls).toEqual([[s.id]])
  })

  it('S6 delete(内存父) 连带两条内存子会话：子先于父，什么都不剩，不广播', async () => {
    const parent = create({}, EPH)
    const c1 = create({ parentId: parent.id })
    const c2 = create({ parentId: parent.id })
    expect([c1, c2].every((c) => sessionRecords.isEphemeral(c.id))).toBe(true)
    vi.clearAllMocks()

    await sessionService.delete(parent.id)

    const order = [c1.id, c2.id, parent.id]
    expect(mocks.killBySession.mock.calls.map((c) => c[0])).toEqual(order)
    expect(mocks.messageClear.mock.calls.map((c) => c[0])).toEqual(order)
    expect(mocks.closeSession.mock.calls.map((c) => c[0])).toEqual(order)
    for (const id of order) {
      expect(sessionService.getById(id)).toBeUndefined()
      expect(sessionRecords.isEphemeral(id)).toBe(false)
      expect(sessionRecords.wasEphemeral(id)).toBe(true)
    }
    expect(mocks.broadcastListChanged).not.toHaveBeenCalled()
    expectNoDaoWrites()
  })
})

describe('S7 写入口落在内存行上', () => {
  it('S7 标题 / 免询问 / 扩展能力 / 知识库 / 允许列表：不写库，getById 看得见', () => {
    const s = create({}, EPH)
    vi.clearAllMocks()

    sessionService.updateTitle(s.id, '自动标题', 'auto')
    sessionService.updateAutoAllow(s.id, true)
    expect(sessionService.updateEnabledTools(s.id, ['mcp:ssh', 'bash', 'skill:x'])).toBe(true)
    expect(sessionService.updateKnowledgeBases(s.id, [' notes ', 'notes', 'project'])).toBe(true)
    sessionService.addAllowListPaths(s.id, 'read', ['/a', '/b'])

    expect(sessionService.getById(s.id)).toMatchObject({
      title: '自动标题',
      settings: {
        titleOrigin: 'auto',
        autoAllow: true,
        enabledTools: ['mcp:ssh', 'skill:x'],
        knowledgeBases: ['notes', 'project'],
        allowList: ['read(/a)', 'read(/b)']
      }
    })

    sessionService.removeAllowListEntry(s.id, 'read(/a)')
    expect(sessionService.getById(s.id)!.settings.allowList).toEqual(['read(/b)'])

    expectNoDaoWrites()
    // 自动标题照样通知前端（这与会话落不落库无关）
    expect(mocks.broadcastTitleChanged).toHaveBeenCalledWith(s.id, '自动标题')
  })
})

describe('S8 形态推导读内存行', () => {
  it('S8 bot → bot；笔记本 → notebook；无项目 → chat；有项目 → work', () => {
    const bot = create({ bot: 'scout' }, EPH)
    const notebook = create({ projectId: 'p1', notebookPath: 'notes/a.md' }, EPH)
    const scratch = create({}, EPH)
    const project = create({ projectId: 'p1' }, EPH)
    // 建内存会话时会问库「这个 id 被占了没有」（pick）；那之后的读面一次都不该再问
    vi.clearAllMocks()

    expect(sessionService.isBotSession(bot.id)).toBe(true)
    expect(sessionService.resolveAgentProfileName(bot.id)).toBe('bot')
    expect(sessionService.isBotSession(scratch.id)).toBe(false)
    expect(sessionService.resolveAgentProfileName(notebook.id)).toBe('notebook')
    expect(sessionService.resolveAgentProfileName(scratch.id)).toBe('chat')
    expect(sessionService.resolveAgentProfileName(project.id)).toBe('work')
    // 全程没问过库：这些行本来就不在那儿
    expect(mocks.daoPick).not.toHaveBeenCalled()
    expect(mocks.daoPickSettings).not.toHaveBeenCalled()
  })
})

describe('S9 / S10 / S11 边角', () => {
  it('S9 params 里混进来的 ephemeral: true 不算数 —— 仍是持久会话', () => {
    const s = create({ title: 'x', ephemeral: true } as unknown as Parameters<
      typeof sessionService.create
    >[0])
    expect(sessionRecords.isEphemeral(s.id)).toBe(false)
    expect(mocks.daoInsert).toHaveBeenCalledTimes(1)
    expect(mocks.broadcastListChanged).toHaveBeenCalledTimes(1)
    expect(table.has(s.id)).toBe(true)
  })

  it('S10 父会话是已删的内存会话 → create 抛错，哪儿都不插', async () => {
    const parent = create({}, EPH)
    await sessionService.delete(parent.id)
    vi.clearAllMocks()
    const recordsInsert = vi.spyOn(sessionRecords, 'insert')

    expect(() => create({ parentId: parent.id })).toThrow()
    expect(() => create({ parentId: parent.id }, EPH)).toThrow()

    expect(recordsInsert).not.toHaveBeenCalled()
    expect(mocks.daoInsert).not.toHaveBeenCalled()
    expect(mocks.broadcastListChanged).not.toHaveBeenCalled()
    expect(table.size).toBe(0)
  })

  it('S10 对照：父行只是不存在（从没当过内存会话）→ 照旧建成持久会话', () => {
    const child = create({ parentId: 'gone', projectId: 'p1' })
    expect(sessionRecords.isEphemeral(child.id)).toBe(false)
    expect(mocks.daoInsert).toHaveBeenCalledTimes(1)
    expect(mocks.daoInsert.mock.calls[0][0]).toMatchObject({ parentId: 'gone', projectId: 'p1' })
  })

  it('S11 updateProjectId：内存会话不广播列表变化；持久对照广播', () => {
    const mem = create({}, EPH)
    const kept = create({})
    vi.clearAllMocks()

    sessionService.updateProjectId(mem.id, 'p2')
    expect(mocks.broadcastListChanged).not.toHaveBeenCalled()
    expect(mocks.daoUpdateProjectId).not.toHaveBeenCalled()
    expect(sessionService.getById(mem.id)!.projectId).toBe('p2')

    sessionService.updateProjectId(kept.id, 'p2')
    expect(mocks.broadcastListChanged).toHaveBeenCalledTimes(1)
    expect(mocks.daoUpdateProjectId).toHaveBeenCalledWith(kept.id, 'p2')
  })
})
