/**
 * sessionService —— 无项目会话**自带的工作目录**（`create(params, { workingDirectory })`）。
 *
 * 契约（从系统打开的 md 窗口是今天唯一的写入方：工作目录就是那个文件所在的目录）：
 *   - 工作目录的口径：项目根 → 无项目会话的 settings.workingDirectory → 临时工作区；
 *     getById、Agent 上下文（initAgent / 建运行时）读的都是同一个答案；
 *   - options.workingDirectory 只给**不属于任何项目的根会话**：有项目时忽略（不存、用项目根）；
 *     子会话不看 options —— 父会话无项目就随父会话的目录，父会话有项目就是项目根；
 *   - 它是主进程内部的选项：混在 params 里的 workingDirectory 不算数；
 *   - 删除会话**不动**这个目录（那是用户自己的），只清临时工作区。
 *
 * mock 面沿用 sessionServiceEphemeral.test.ts（sessionRecords 是真的、DAO 是内存表上的 spy、
 * `AgentSession.create` 可捕获）；差别是 `getTempWorkspace` 换成一个间谍 —— 「没有退回临时工作区」
 * 就是「它没被问过」—— 并且像真的那样把目录建出来，所以「删除之后临时工作区不在了」是在真盘上断的。
 *
 *   WD-1  无项目 + {workingDirectory} → 存进 settings；getById / initAgent / 运行时都用它；
 *         删除之前从没问过临时工作区（持久 / 内存两种会话各一遍）
 *   WD-2  有项目 + {workingDirectory} → 不存；工作目录是项目根
 *   WD-3  有项目父会话的子会话 + {workingDirectory} → 不存；工作目录是项目根
 *   WD-3b 无项目、有自带目录的父会话 → 子会话随父会话的目录，子会话自己给的另一个目录不算；
 *         父会话没有自带目录 → 子会话给的也不算（临时工作区）
 *   WD-4  不给 → 临时工作区（照旧）
 *   WD-5  删除：自带目录与里面的文件原样都在；临时工作区删完不在
 *   WD-6  params 里混进来的 workingDirectory 不算数
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 持久会话那一侧的「库」：DAO spy 背后的内存表 */
const table = vi.hoisted(() => new Map<string, unknown>())

const mocks = vi.hoisted(() => {
  const rows = (): Map<string, Record<string, unknown>> =>
    table as unknown as Map<string, Record<string, unknown>>
  const clone = <T>(v: T): T => structuredClone(v)
  return {
    /** 临时工作区的根（beforeAll 里指到真的临时目录） */
    tempRoot: { dir: '' },
    getTempWorkspace: vi.fn<(sid: string) => string>(),
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
    readSessionRunConfig: vi.fn(),
    agentCreate:
      vi.fn<(params: { sessionId: string; workingDirectory: string }) => Promise<unknown>>(),
    closeSession: vi.fn<(sessionId: string) => Promise<void>>(),
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
    touch: vi.fn(),
    touchActive: vi.fn()
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
  readSessionRunConfig: mocks.readSessionRunConfig,
  addSessionTreePin: vi.fn(),
  appendModelChange: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: mocks.getTempWorkspace,
  getToolResultsBase: () => join(mocks.tempRoot.dir, 'tool-results'),
  getSessionArtifactsDir: (sid: string) => join(mocks.tempRoot.dir, 'artifacts', sid),
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
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
  killBySession: vi.fn(),
  setBgTaskNotifier: vi.fn()
}))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
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

/** 用户自己的目录（md 所在目录）：真的，里面放一份文件 */
let userDir: string
const USER_FILE = 'a.md'
const PROJECT_ROOT = '/nonexistent/shuvix-unit/project-root'

beforeAll(async () => {
  mocks.tempRoot.dir = mkdtempSync(join(tmpdir(), 'shuvix-wd-'))
  ;({ sessionService } = await import('../sessionService'))
})

afterAll(() => {
  rmSync(mocks.tempRoot.dir, { recursive: true, force: true })
})

beforeEach(() => {
  table.clear()
  sessionRecords.clearEphemeralForTests()
  vi.clearAllMocks()
  userDir = mkdtempSync(join(mocks.tempRoot.dir, 'user-dir-'))
  writeFileSync(join(userDir, USER_FILE), '# mine\n')
  // 与真的 getTempWorkspace 同一个副作用：问一次就把目录建出来
  mocks.getTempWorkspace.mockImplementation((sid) => {
    const dir = join(mocks.tempRoot.dir, 'temp_workspace', sid)
    mkdirSync(dir, { recursive: true })
    return dir
  })
  mocks.readSessionRunConfig.mockResolvedValue({})
  mocks.closeSession.mockResolvedValue(undefined)
  mocks.projectPick.mockImplementation((id: string) =>
    id === 'p1' ? { path: PROJECT_ROOT, settings: {} } : undefined
  )
  mocks.agentCreate.mockImplementation(async () => ({
    invalidate: vi.fn(async () => {}),
    destroy: vi.fn(async () => {})
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const tempOf = (sid: string): string => join(mocks.tempRoot.dir, 'temp_workspace', sid)

/** 三处读工作目录的地方一起取（getById / initAgent / 建运行时时交给 AgentSession 的那个） */
async function workingDirectories(sid: string): Promise<{
  getById: string | null | undefined
  initAgent: string
  runtime: string | undefined
}> {
  const getById = sessionService.getById(sid)?.workingDirectory
  const init = await sessionService.initAgent(sid)
  expect(init.success).toBe(true)
  await sessionService.ensureAgentSession(sid)
  const runtime = mocks.agentCreate.mock.calls.find((c) => c[0].sessionId === sid)?.[0]
    .workingDirectory
  return { getById, initAgent: init.workingDirectory, runtime }
}

describe('WD-1 无项目会话自带工作目录', () => {
  it.each([
    ['持久会话', false],
    ['内存会话', true]
  ])('WD-1 %s：存进 settings，三处读到的都是它，从没问过临时工作区', async (_label, ephemeral) => {
    const s = sessionService.create(
      { title: 'a.md', notebookPath: USER_FILE },
      { ephemeral, workingDirectory: userDir }
    )
    expect(sessionRecords.isEphemeral(s.id)).toBe(ephemeral)
    expect(s.settings.workingDirectory).toBe(userDir)
    expect(sessionService.getById(s.id)?.settings.workingDirectory).toBe(userDir)

    expect(await workingDirectories(s.id)).toEqual({
      getById: userDir,
      initAgent: userDir,
      runtime: userDir
    })
    expect(mocks.getTempWorkspace).not.toHaveBeenCalled()
    expect(existsSync(tempOf(s.id))).toBe(false)
  })
})

describe('WD-2 / WD-3 有项目时忽略', () => {
  it('WD-2 项目会话 + {workingDirectory} → 不存，工作目录是项目根', async () => {
    const s = sessionService.create({ projectId: 'p1' }, { workingDirectory: userDir })
    expect(s.settings).not.toHaveProperty('workingDirectory')
    expect(sessionService.getById(s.id)?.settings).not.toHaveProperty('workingDirectory')
    expect(await workingDirectories(s.id)).toEqual({
      getById: PROJECT_ROOT,
      initAgent: PROJECT_ROOT,
      runtime: PROJECT_ROOT
    })
    expect(mocks.getTempWorkspace).not.toHaveBeenCalled()
  })

  it('WD-3 有项目父会话的子会话 + {workingDirectory} → 不存，工作目录是项目根', async () => {
    const parent = sessionService.create({ projectId: 'p1' })
    const child = sessionService.create({ parentId: parent.id }, { workingDirectory: userDir })
    expect(child.projectId).toBe('p1')
    expect(child.settings).not.toHaveProperty('workingDirectory')
    expect(await workingDirectories(child.id)).toEqual({
      getById: PROJECT_ROOT,
      initAgent: PROJECT_ROOT,
      runtime: PROJECT_ROOT
    })
  })
})

describe('WD-3b 子会话随父会话', () => {
  it.each([
    ['持久父', false],
    ['内存父', true]
  ])(
    'WD-3b %s有自带目录 → 子会话用父会话的目录，自己给的另一个目录不算',
    async (_label, ephemeral) => {
      const parent = sessionService.create(
        { notebookPath: USER_FILE },
        { ephemeral, workingDirectory: userDir }
      )
      const otherDir = mkdtempSync(join(mocks.tempRoot.dir, 'other-'))
      const child = sessionService.create(
        { parentId: parent.id },
        { ephemeral, workingDirectory: otherDir }
      )
      expect(child.projectId).toBeNull()
      expect(child.settings.workingDirectory).toBe(userDir)
      expect(await workingDirectories(child.id)).toEqual({
        getById: userDir,
        initAgent: userDir,
        runtime: userDir
      })
      expect(mocks.getTempWorkspace).not.toHaveBeenCalled()
    }
  )

  it('WD-3b 父会话没有自带目录 → 子会话给的也不算，退回它自己的临时工作区', async () => {
    const parent = sessionService.create({})
    const child = sessionService.create({ parentId: parent.id }, { workingDirectory: userDir })
    expect(child.settings).not.toHaveProperty('workingDirectory')
    const wd = await workingDirectories(child.id)
    expect(wd).toEqual({
      getById: tempOf(child.id),
      initAgent: tempOf(child.id),
      runtime: tempOf(child.id)
    })
  })
})

describe('WD-4 ~ WD-6', () => {
  it('WD-4 不给 → 临时工作区（照旧）', async () => {
    const s = sessionService.create({ title: 'plain' })
    expect(s.settings).not.toHaveProperty('workingDirectory')
    expect(await workingDirectories(s.id)).toEqual({
      getById: tempOf(s.id),
      initAgent: tempOf(s.id),
      runtime: tempOf(s.id)
    })
    expect(mocks.getTempWorkspace).toHaveBeenCalledWith(s.id)
  })

  it.each([
    ['持久会话', false],
    ['内存会话', true]
  ])('WD-5 %s删除：自带目录与文件原样都在；临时工作区删完不在', async (_label, ephemeral) => {
    const s = sessionService.create(
      { notebookPath: USER_FILE },
      { ephemeral, workingDirectory: userDir }
    )
    await sessionService.ensureAgentSession(s.id)

    await sessionService.delete(s.id)

    expect(sessionService.getById(s.id)).toBeUndefined()
    expect(existsSync(userDir)).toBe(true)
    expect(readFileSync(join(userDir, USER_FILE), 'utf8')).toBe('# mine\n')
    expect(existsSync(tempOf(s.id))).toBe(false)
  })

  it('WD-5 对照：普通无项目会话删除时，它的临时工作区（连同里面的文件）被清掉', async () => {
    const s = sessionService.create({})
    const temp = sessionService.getById(s.id)!.workingDirectory as string
    writeFileSync(join(temp, 'scratch.txt'), 'x')
    await sessionService.delete(s.id)
    expect(existsSync(temp)).toBe(false)
  })

  it('WD-6 params 里混进来的 workingDirectory 不算数', async () => {
    const s = sessionService.create({
      title: 'x',
      workingDirectory: userDir
    } as unknown as Parameters<typeof sessionService.create>[0])
    expect(s.settings).not.toHaveProperty('workingDirectory')
    expect(sessionService.getById(s.id)?.workingDirectory).toBe(tempOf(s.id))
  })
})
