/**
 * sessionService —— **内存会话**（`create(params, { ephemeral: true })`）的服务层语义。
 *
 * 契约：行只在内存里（sessionRecords）、从不落库；不进列表所以没有列表变化可广播；子会话按父会话
 * 推定（内存父 → 内存子，与 options 无关；持久父 → 持久子，同样与 options 无关）；删除走完整的
 * 清理链但不碰库、不广播；所有写入口落在内存行上，读面（getById / 形态推导）读得到。
 * 父会话是一条**已删掉的内存会话**时拒绝建子会话 —— 那是宿主刚把它删掉，建出来的要么是库里的孤儿，
 * 要么是谁也不会去删的内存会话。
 *
 * mock 面沿用 sessionServiceBuiltinMcpLifetime.test.ts（import 图全换假件、会话运行时换成假宿主）。差别在于 **sessionRecords 是真的**：只替掉它底下的
 * `dao/sessionDao`，而且 DAO 的每个方法都是 spy、背后是一张内存表 —— 「没碰库」就是
 * 「这张表的 spy 没被调」，而持久会话那一侧照样有行可读。会话权限表（services/acl）同样是真的，只替掉它
 * 底下的 `dao/sessionAclDao`（spy + 内存表）与派生行的来源（acl/derive：每条会话一行固定的 system 行）。
 *
 *   S1  create(p, {ephemeral}) 不落库、不广播；isEphemeral；getById 读得到；list() 不含；权限表生成在内存里
 *   S2  对照：create(p) 落库一次 + 广播一次；权限表落进 session_acl
 *   S3  内存父的子会话恒为内存会话（不传 / false / true），继承父的 enabledTools / projectId，并复制父会话
 *       授予的路径（内存里，不碰库）
 *   S4  持久父的子会话传 {ephemeral:true} 仍是持久会话
 *   S5  delete(内存)：行没了、不碰库、不广播；清理链（后台任务 / 运行时与存储（宿主 delete）/ 内置 MCP）各跑一次；
 *       权限表跟着没了
 *   S6  delete(内存父) 连带两条内存子会话：子先于父，什么都不剩，不广播
 *   S7  写入口落在内存行上、不写库，getById 看得见；权限表的授予 / 删除只改内存表
 *   S8  形态推导读内存行：bot → bot，笔记本 → notebook，无项目 → chat（有项目 → work）
 *   S9  params 里混进来的 `ephemeral: true` 不算数 —— 仍是持久会话
 *   S10 父会话是已删的内存会话 → create 抛错，哪儿都不插；对照：父行只是不存在 → 照旧建成持久会话
 *   S11 updateProjectId：内存会话不广播列表变化；持久对照广播
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type { Session } from '../../dao/types'

/** 持久会话那一侧的「库」：DAO spy 背后的内存表 */
const table = vi.hoisted(() => new Map<string, unknown>())
/** 持久会话的权限表（session_acl）：sessionAclDao spy 背后的内存表，sessionId → 行 */
const aclTable = vi.hoisted(() => new Map<string, unknown[]>())

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
    // dao/sessionAclDao —— 持久会话的权限表（背后是 aclTable）；内存会话一次都不该碰到
    aclFindBySession: vi.fn((sid: string) =>
      ((aclTable.get(sid) ?? []) as Array<Record<string, unknown>>).map((r) => clone(r))
    ),
    aclInsert: vi.fn((e: Record<string, unknown>) => {
      const sid = e.sessionId as string
      aclTable.set(sid, [...((aclTable.get(sid) ?? []) as unknown[]), clone(e)])
    }),
    aclUpdateAccess: vi.fn((sid: string, id: string, access: string, at: number) => {
      const row = ((aclTable.get(sid) ?? []) as Array<Record<string, unknown>>).find(
        (r) => r.id === id
      )
      if (!row) return false
      row.access = access
      row.updatedAt = at
      return true
    }),
    aclDeleteById: vi.fn((sid: string, id: string) => {
      const rows = (aclTable.get(sid) ?? []) as Array<Record<string, unknown>>
      aclTable.set(
        sid,
        rows.filter((r) => r.id !== id)
      )
      return rows.some((r) => r.id === id)
    }),
    aclDeleteBySession: vi.fn((sid: string) => {
      const n = ((aclTable.get(sid) ?? []) as unknown[]).length
      aclTable.delete(sid)
      return n
    }),
    broadcastListChanged: vi.fn(),
    broadcastTitleChanged: vi.fn(),
    broadcastConfigChanged: vi.fn(),
    readSessionRunConfig: vi.fn(),
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
    touchActive: mocks.daoTouchActive,
    // 删除时判断临时工作区还有没有会话指着（会话 fork 共用）—— 这组用例里没有 fork
    existsWithWorkingDirectory: vi.fn(() => false)
  }
}))
vi.mock('../../dao/sessionAclDao', () => ({
  sessionAclDao: {
    findBySession: mocks.aclFindBySession,
    insert: mocks.aclInsert,
    updateAccess: mocks.aclUpdateAccess,
    deleteById: mocks.aclDeleteById,
    deleteBySession: mocks.aclDeleteBySession,
    transaction: <T>(fn: () => T): T => fn()
  }
}))
// 权限表的派生行：每条会话一行自己的 system 行（真的 derive 要会话目录、知识库、技能目录）
vi.mock('../acl/derive', () => ({
  derivePathEntries: (sid: string) => [
    {
      source: 'system',
      sourceKey: 'tmp',
      target: `/nonexistent/shuvix-unit/sandbox-tmp/${sid}`,
      access: 'write'
    }
  ],
  derivedKey: (e: { source: string; sourceKey: string; target: string }) =>
    `${e.source}\u0000${e.sourceKey}\u0000${e.target}`
}))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../sessionDayPromptService', () => ({
  recordUserEntry: vi.fn(),
  recordSessionCreated: vi.fn()
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
  isDurableSession: () => true,
  readSessionRunConfig: mocks.readSessionRunConfig,
  recordSessionModel: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => {
  const isSafeSessionId = (id: string): boolean =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
  // 假的临时工作区从不建在盘上（删除时的「目录不在就什么都不查」一步就走完）；口径照真的 utils/paths
  const tempBase = '/nonexistent/shuvix-unit/tmp'
  return {
    getTempWorkspaceBase: () => tempBase,
    getTempWorkspace: (sid: string) => `${tempBase}/${sid}`,
    tempWorkspaceOwnerOf: (dir: string) => {
      const slash = dir.lastIndexOf('/')
      const id = dir.slice(slash + 1)
      return dir.slice(0, slash) === tempBase && isSafeSessionId(id) ? id : undefined
    },
    getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results',
    getSessionArtifactsDir: (sid: string) => `/nonexistent/shuvix-unit/artifacts/${sid}`,
    isSafeSessionId
  }
})
vi.mock('../mcpService', () => ({ mcpService: { closeSession: mocks.closeSession } }))
vi.mock('../toolAggregator', () => ({
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../agentService', () => ({
  agentService: { getProfile: vi.fn(), isSessionProfile: vi.fn() }
}))
// 会话运行时换成假宿主 / 假门面（真模块的依赖图带模型注册表、事件适配器）
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../agentSession', async () =>
  (await import('./support/fakeSessionHost')).agentSessionModuleMock()
)
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
import { sessionAcl } from '../acl'
import { clearMemoryAclForTests } from '../acl/store'
import { agentSessionSpies, fakeHost, resetFakeHost } from './support/fakeSessionHost'

let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

/**
 * 所有「写库」的 DAO spy —— 内存会话的任何操作都不该碰到其中任何一个。权限表的
 * `deleteBySession` 不在其中：删会话时两边的表都删（内存会话删掉之后 isEphemeral 就不再认它，见
 * acl/store 的 deleteAclEverywhere），库那一侧对内存会话是一次删不到任何行的 DELETE
 */
const daoWrites = (): Array<ReturnType<typeof vi.fn>> => [
  mocks.daoInsert,
  mocks.daoUpdateSettings,
  mocks.daoUpdateTitle,
  mocks.daoUpdateProjectId,
  mocks.daoDeleteById,
  mocks.daoTouch,
  mocks.daoTouchActive,
  mocks.aclInsert,
  mocks.aclUpdateAccess,
  mocks.aclDeleteById
]
const expectNoDaoWrites = (): void => {
  for (const spy of daoWrites()) expect(spy).not.toHaveBeenCalled()
}

let clock = 1_000_000

beforeEach(() => {
  table.clear()
  aclTable.clear()
  resetFakeHost()
  sessionRecords.clearEphemeralForTests()
  clearMemoryAclForTests()
  sessionAcl.forgetReconciled()
  vi.clearAllMocks()
  // 子会话按 createdAt 排序：每次 create 拨一下时钟，顺序才是确定的
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
  mocks.readSessionRunConfig.mockResolvedValue({})
  mocks.projectPick.mockReturnValue(undefined)
  mocks.closeSession.mockResolvedValue(undefined)
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
    // 权限表建好了（派生行），但只在内存里：sessionAclDao 一次都没碰
    expect(sessionAcl.entries(s.id).map((e) => [e.source, e.target])).toEqual([
      ['system', `/nonexistent/shuvix-unit/sandbox-tmp/${s.id}`]
    ])
    expect(mocks.aclFindBySession).not.toHaveBeenCalled()
    expect(aclTable.has(s.id)).toBe(false)
    expectNoDaoWrites()
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
    // 权限表落进 session_acl（行进库之后才生成）
    expect(mocks.aclInsert).toHaveBeenCalledTimes(1)
    expect(mocks.aclInsert.mock.calls[0][0]).toMatchObject({ sessionId: s.id, source: 'system' })
    expect(mocks.daoInsert.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.aclInsert.mock.invocationCallOrder[0]
    )
  })
})

describe('S3 / S4 子会话按父会话推定', () => {
  it.each([
    ['不传 options', undefined],
    ['{ ephemeral: false }', { ephemeral: false }],
    ['{ ephemeral: true }', { ephemeral: true }]
  ])('S3 内存父的子会话（%s）恒为内存会话，继承父的勾选 / 项目与授予的路径', (_label, opt) => {
    const parent = create({ projectId: 'p1' }, EPH)
    sessionService.updateEnabledTools(parent.id, ['mcp:ssh', 'skill:x'])
    sessionAcl.grantPath(parent.id, '/Users/u/notes', 'write')
    vi.clearAllMocks()

    const child = create({ parentId: parent.id, projectId: 'elsewhere' }, opt)

    expect(sessionRecords.isEphemeral(child.id)).toBe(true)
    expect(mocks.daoInsert).not.toHaveBeenCalled()
    expect(mocks.broadcastListChanged).not.toHaveBeenCalled()
    expect(sessionService.getById(child.id)).toMatchObject({
      parentId: parent.id,
      projectId: 'p1',
      settings: { enabledTools: ['mcp:ssh', 'skill:x'] }
    })
    expect(sessionRecords.findChildren(parent.id).map((s) => s.id)).toEqual([child.id])
    // 父会话授予的路径复制进子会话的表（新行）；子会话的派生行是它自己的；全在内存里
    expect(sessionAcl.entries(child.id).map((e) => [e.source, e.target, e.access])).toEqual([
      ['user', '/Users/u/notes', 'write'],
      ['system', `/nonexistent/shuvix-unit/sandbox-tmp/${child.id}`, 'write']
    ])
    expect(mocks.aclFindBySession).not.toHaveBeenCalled()
    expectNoDaoWrites()
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
  it('S5 delete(内存)：行没了、不碰库、不广播；清理链各跑一次；权限表跟着没了', async () => {
    const s = create({}, EPH)
    sessionAcl.grantPath(s.id, '/Users/u/notes', 'read')
    // 让它开着：删除要先经宿主关掉并删存储
    await sessionService.ensureAgentSession(s.id)
    expect(fakeHost.get(s.id)).toBeDefined()
    vi.clearAllMocks()

    await sessionService.delete(s.id)

    expect(sessionService.getById(s.id)).toBeUndefined()
    expect(sessionRecords.isEphemeral(s.id)).toBe(false)
    expect(sessionRecords.wasEphemeral(s.id)).toBe(true)
    expect(mocks.daoDeleteById).not.toHaveBeenCalled()
    expect(mocks.broadcastListChanged).not.toHaveBeenCalled()
    expectNoDaoWrites()

    // 清理链：后台任务 → 关停运行时并删存储（宿主 delete）→ 内置 MCP
    expect(mocks.killBySession.mock.calls).toEqual([[s.id]])
    expect(agentSessionSpies.destroySessionRuntime.mock.calls).toEqual([[s.id]])
    expect(fakeHost.callsOf('delete')).toEqual([s.id])
    expect(fakeHost.get(s.id)).toBeUndefined()
    expect(mocks.closeSession.mock.calls).toEqual([[s.id]])

    // 权限表：删掉的会话读出空表、授予不补行；库那一侧只有一次删不到任何行的清理
    expect(sessionAcl.entries(s.id)).toEqual([])
    expect(sessionAcl.grantPath(s.id, '/Users/u/late', 'write')).toBeNull()
    expect(mocks.aclDeleteBySession.mock.calls).toEqual([[s.id]])
    expect(mocks.aclFindBySession).not.toHaveBeenCalled()
    expect(aclTable.has(s.id)).toBe(false)
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
    expect(fakeHost.callsOf('delete')).toEqual(order)
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
  it('S7 标题 / 扩展能力 / 知识库 / 权限表：不写库，getById / 权限表看得见', () => {
    const s = create({}, EPH)
    vi.clearAllMocks()

    sessionService.updateTitle(s.id, '自动标题', 'auto')
    expect(sessionService.updateEnabledTools(s.id, ['mcp:ssh', 'bash', 'skill:x'])).toBe(true)
    expect(sessionService.updateKnowledgeBases(s.id, [' notes ', 'notes', 'project'])).toBe(true)
    const a = sessionAcl.grantPath(s.id, '/a', 'read')!
    sessionAcl.grantPath(s.id, '/b', 'read')

    expect(sessionService.getById(s.id)).toMatchObject({
      title: '自动标题',
      settings: {
        titleOrigin: 'auto',
        enabledTools: ['mcp:ssh', 'skill:x'],
        knowledgeBases: ['notes', 'project']
      }
    })
    expect(sessionService.getById(s.id)!.settings).not.toHaveProperty('allowList')
    const granted = (): string[] =>
      sessionAcl
        .entries(s.id)
        .filter((e) => e.source === 'user')
        .map((e) => `${e.access}:${e.target}`)
    expect(granted()).toEqual(['read:/a', 'read:/b'])

    expect(sessionAcl.remove(s.id, a.id)).toBe(true)
    expect(granted()).toEqual(['read:/b'])
    expect(
      sessionAcl.setAccess(
        s.id,
        sessionAcl.entries(s.id).find((e) => e.target === '/b')!.id,
        'write'
      )
    ).toBe(true)
    expect(sessionAcl.pathView(s.id).write).toContain('/b')

    expectNoDaoWrites()
    expect(mocks.aclFindBySession).not.toHaveBeenCalled()
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
