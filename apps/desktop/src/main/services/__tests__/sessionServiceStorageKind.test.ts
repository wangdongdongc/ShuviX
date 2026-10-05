/**
 * sessionService.create —— 给新会话盖存储类型的戳（`storageKind`）。
 *
 * 契约：新会话一律用**当前版本**的存储（`CURRENT_SESSION_STORAGE_KIND`），不论它是什么形态
 * （普通 / 笔记本 / 协作编辑 / bot / Chrome 标签页 / 自带工作目录 / 子会话），也不论落不落库；
 * 子会话**不继承**父会话的存储类型 —— 那一列说的是「这条会话的内容当初存成什么格式」，
 * 与父会话无关；渲染层经 IPC 建会话时也挑不了它（params 里混进来的键不算数）。
 *
 * mock 面沿用 sessionServiceEphemeral.test.ts：sessionRecords 是真的，只替掉它底下的
 * `dao/sessionDao`，DAO 的每个方法都是 spy、背后是一张内存表（insert 存下传进来的整个对象）。
 *
 *   SC-1  持久会话：DAO insert 收到的就是 CURRENT；返回值 / getById / list() 都带它
 *   SC-2  内存会话：sessionRecords.pick / getById 回 CURRENT；DAO insert 没被调
 *   SC-3  每一种创建形态都盖 CURRENT
 *   SC-4  不继承：父会话（持久 / 内存）是别的存储类型，子会话照样 CURRENT
 *   SC-5  params 里混进来的 storageKind 不算数
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type { Session } from '../../dao/types'
import {
  CURRENT_SESSION_STORAGE_KIND,
  SESSION_STORAGE_KINDS
} from '@shuvix/chat-protocol/sessionStorageKind'

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
    daoUpdateTitle: vi.fn(),
    daoUpdateProjectId: vi.fn(),
    daoDeleteById: vi.fn((id: string) => {
      rows().delete(id)
    }),
    daoTouch: vi.fn(),
    daoTouchActive: vi.fn(),
    broadcastListChanged: vi.fn(),
    readSessionRunConfig: vi.fn(),
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
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  isDurableSession: () => true,
  readSessionRunConfig: mocks.readSessionRunConfig,
  appendModelChange: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results',
  getSessionArtifactsDir: (sid: string) => `/nonexistent/shuvix-unit/artifacts/${sid}`,
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({
  buildAllowEntry: (type: string, path: string) => `${type}(${path})`
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
  killBySession: vi.fn(),
  setBgTaskNotifier: vi.fn()
}))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: mocks.broadcastListChanged,
  broadcastSessionTitleChanged: vi.fn()
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

let clock = 1_000_000

beforeEach(() => {
  table.clear()
  sessionRecords.clearEphemeralForTests()
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
  mocks.readSessionRunConfig.mockResolvedValue({})
  mocks.projectPick.mockReturnValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 拨一下时钟再建 */
function create(...args: Parameters<typeof sessionService.create>): Session {
  clock += 10
  vi.setSystemTime(clock)
  return sessionService.create(...args)
}

type CreateParams = Parameters<typeof sessionService.create>[0]

const EPH = { ephemeral: true }

/**
 * 一个**不是**当前存储的已知类型：父会话、混进 params 的值都用它，这样「没继承 / 没采纳」
 * 不会因为它恰好等于 CURRENT 而白白通过（存储切换之后这条也照样有意义）
 */
const OTHER_KIND = SESSION_STORAGE_KINDS.find((k) => k !== CURRENT_SESSION_STORAGE_KIND)!

/** 一条直接塞进 sessionRecords 的父会话（绕过 create，好让它带别的存储类型） */
function parentRow(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: `parent ${id}`,
    projectId: 'p1',
    parentId: null,
    storageKind: OTHER_KIND,
    settings: { enabledTools: ['mcp:ssh'] },
    createdAt: clock,
    updatedAt: clock,
    lastActiveAt: clock,
    ...patch
  }
}

/** 三个读面一起看：返回值、sessionRecords 点查、getById */
function expectCurrent(s: Session): void {
  expect(s.storageKind).toBe(CURRENT_SESSION_STORAGE_KIND)
  expect(sessionRecords.pick(s.id, ['storageKind'])).toEqual({
    storageKind: CURRENT_SESSION_STORAGE_KIND
  })
  expect(sessionService.getById(s.id)!.storageKind).toBe(CURRENT_SESSION_STORAGE_KIND)
}

describe('SC-1 / SC-2 新会话盖当前存储', () => {
  it('SC-1 持久会话：DAO insert 收到 CURRENT；返回值 / getById / list() 都带它', () => {
    const s = create({ title: 'kept' })

    expect(OTHER_KIND).toBeDefined()
    expect(mocks.daoInsert).toHaveBeenCalledTimes(1)
    expect(mocks.daoInsert.mock.calls[0][0].storageKind).toBe(CURRENT_SESSION_STORAGE_KIND)
    expectCurrent(s)
    expect(sessionService.list().map((x) => [x.id, x.storageKind])).toEqual([
      [s.id, CURRENT_SESSION_STORAGE_KIND]
    ])
  })

  it('SC-2 内存会话：sessionRecords.pick / getById 回 CURRENT；不落库', () => {
    const s = create({}, EPH)

    expect(sessionRecords.isEphemeral(s.id)).toBe(true)
    expect(mocks.daoInsert).not.toHaveBeenCalled()
    expectCurrent(s)
  })
})

describe('SC-3 每一种创建形态都盖 CURRENT', () => {
  it.each<[string, () => Session]>([
    ['笔记本会话', () => create({ projectId: 'p1', notebookPath: 'notes/a.md' })],
    ['协作编辑会话', () => create({ notebookPath: 'a.md' }, { ...EPH, coEdit: true })],
    ['bot 会话', () => create({ bot: 'scout' })],
    [
      'Chrome 标签页会话',
      () =>
        create({
          chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 }
        } as unknown as CreateParams)
    ],
    ['自带工作目录', () => create({}, { workingDirectory: '/work/dir' })],
    [
      '持久父会话的子会话',
      () => {
        const parent = create({ projectId: 'p1' })
        return create({ parentId: parent.id })
      }
    ],
    [
      '内存父会话的子会话',
      () => {
        const parent = create({}, EPH)
        return create({ parentId: parent.id })
      }
    ]
  ])('%s', (_label, make) => {
    const s = make()
    expectCurrent(s)
  })

  it('形态本身确实建成了（不是建成了普通会话才「碰巧」带 CURRENT）', () => {
    const tab = create({
      chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 }
    } as unknown as CreateParams)
    expect(sessionService.resolveAgentProfileName(tab.id)).toBe('tab')
    const coEdit = create({ notebookPath: 'a.md' }, { ...EPH, coEdit: true })
    expect(sessionService.getById(coEdit.id)!.settings.coEdit).toBe(true)
    const wd = create({}, { workingDirectory: '/work/dir' })
    expect(sessionService.getById(wd.id)!.settings.workingDirectory).toBe('/work/dir')
  })
})

describe('SC-4 / SC-5 存储类型只有一个来源', () => {
  it('SC-4 不继承：持久父会话是别的存储类型 → 子会话 CURRENT', () => {
    sessionRecords.insert(parentRow('P'))
    expect(sessionRecords.pick('P', ['storageKind'])).toEqual({ storageKind: OTHER_KIND })

    const child = create({ parentId: 'P' })

    expect(child.parentId).toBe('P')
    expect(sessionRecords.isEphemeral(child.id)).toBe(false)
    expectCurrent(child)
    // 父会话那一行也没被动
    expect(sessionRecords.pick('P', ['storageKind'])).toEqual({ storageKind: OTHER_KIND })
  })

  it('SC-4 不继承：内存父会话是别的存储类型 → 子会话 CURRENT', () => {
    sessionRecords.insert(parentRow('memP'), EPH)

    const child = create({ parentId: 'memP' })

    expect(sessionRecords.isEphemeral(child.id)).toBe(true)
    expectCurrent(child)
    expect(sessionRecords.pick('memP', ['storageKind'])).toEqual({ storageKind: OTHER_KIND })
  })

  it('SC-5 params 里混进来的 storageKind 不算数', () => {
    const s = create({ title: 'x', storageKind: OTHER_KIND } as never)

    expect(mocks.daoInsert.mock.calls[0][0].storageKind).toBe(CURRENT_SESSION_STORAGE_KIND)
    expectCurrent(s)
    // 也没被当成 settings 的一个键收下
    expect('storageKind' in sessionService.getById(s.id)!.settings).toBe(false)
  })
})
