/**
 * sessionService —— **协作编辑会话**（`create(params, { coEdit: true })`）的形态与根档案。
 *
 * 契约（sessionService.create / resolveAgentProfileName 的注释 + dao/types/session.ts 的 coEdit）：
 *   - `options.coEdit` 只对**根上的笔记本会话**有意义：带 notebookPath 的根会话才写下 `settings.coEdit`，
 *     根档案由形态推出基座 `coedit`；
 *   - 没有 notebookPath、是子会话、或者 coEdit 混在 params 里（渲染层经 IPC 能给的只有 params）→ 不算数；
 *   - 分支次序：Chrome 标签页（tab）先于一切；coEdit 先于笔记本与 bot；coEdit 没有 notebookPath 不是一种形态。
 *
 * mock 面整份沿用 sessionServiceEphemeral.test.ts：sessionRecords 是真的，只替掉它底下的 dao/sessionDao
 * （每个方法都是 spy、背后一张内存表），`AgentSession.create` 可捕获。
 *
 *   S1 notebookPath + {coEdit:true} → settings.coEdit、档案 coedit、AgentSession.create 收到 'coedit'；
 *      与 ephemeral + workingDirectory 一起给（md 窗口的真实组合）照样成立
 *   S2 不算数：没有 notebookPath / 子会话（父会话是协作会话也一样）/ coEdit 混在 params 里
 *   S3 分支次序：chromeTab + coEdit → tab；bot + coEdit + notebookPath → coedit；
 *      coEdit 没有 notebookPath（行里硬写进去）→ 按项目 chat / work
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

beforeEach(() => {
  table.clear()
  sessionRecords.clearEphemeralForTests()
  vi.clearAllMocks()
  mocks.readSessionRunConfig.mockResolvedValue({})
  mocks.projectPick.mockReturnValue(undefined)
  mocks.closeSession.mockResolvedValue(undefined)
  mocks.agentCreate.mockImplementation(async () => ({
    invalidate: vi.fn(async () => {}),
    destroy: vi.fn(async () => {})
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

type CreateParams = Parameters<typeof sessionService.create>[0]
type CreateOptions = Parameters<typeof sessionService.create>[1]

const create = (params: CreateParams, options?: CreateOptions): Session =>
  sessionService.create(params, options)

const settingsOf = (id: string): Record<string, unknown> =>
  (sessionService.getById(id)?.settings ?? {}) as Record<string, unknown>

/** 把某些键硬写进一条持久会话的行（绕过 create 的规则，造「行里万一有」的形态） */
function stamp(id: string, patch: Record<string, unknown>): void {
  const row = table.get(id) as { settings: Record<string, unknown> }
  row.settings = { ...row.settings, ...patch }
}

describe('S1 协作编辑会话', () => {
  it('notebookPath + { coEdit: true } → settings.coEdit，档案 coedit', () => {
    const s = create({ title: 'a.md', notebookPath: 'a.md' }, { coEdit: true })
    expect(settingsOf(s.id)).toMatchObject({ notebookPath: 'a.md', coEdit: true })
    expect(mocks.daoInsert.mock.calls[0][0]).toMatchObject({
      settings: { notebookPath: 'a.md', coEdit: true }
    })
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('coedit')
  })

  it('md 窗口的真实组合：ephemeral + workingDirectory + coEdit —— 内存行里有 coEdit 与工作目录，档案 coedit', () => {
    const s = create(
      { title: 'a.md', notebookPath: 'a.md' },
      { ephemeral: true, workingDirectory: '/Users/me/docs', coEdit: true }
    )
    expect(sessionRecords.isEphemeral(s.id)).toBe(true)
    expect(mocks.daoInsert).not.toHaveBeenCalled()
    expect(sessionService.getById(s.id)).toMatchObject({
      title: 'a.md',
      projectId: null,
      workingDirectory: '/Users/me/docs',
      settings: { notebookPath: 'a.md', coEdit: true, workingDirectory: '/Users/me/docs' }
    })
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('coedit')
  })

  it('推导结果送进了运行时：AgentSession.create 收到 profileName coedit', async () => {
    const s = create(
      { title: 'a.md', notebookPath: 'a.md' },
      { ephemeral: true, workingDirectory: '/Users/me/docs', coEdit: true }
    )
    await sessionService.ensureAgentSession(s.id)
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1)
    expect(mocks.agentCreate.mock.calls[0][0]).toMatchObject({
      sessionId: s.id,
      profileName: 'coedit',
      workingDirectory: '/Users/me/docs'
    })
  })

  it('coEdit: false / 不给 → 普通笔记本（notebook）', () => {
    const off = create({ notebookPath: 'a.md' }, { coEdit: false })
    const none = create({ notebookPath: 'b.md' })
    for (const s of [off, none]) {
      expect('coEdit' in settingsOf(s.id)).toBe(false)
      expect(sessionService.resolveAgentProfileName(s.id)).toBe('notebook')
    }
  })
})

describe('S2 不算数的 coEdit', () => {
  it('没有 notebookPath → 不写键，按项目 chat / work', () => {
    const scratch = create({ title: 'x' }, { coEdit: true })
    const project = create({ title: 'y', projectId: 'p1' }, { coEdit: true })
    expect('coEdit' in settingsOf(scratch.id)).toBe(false)
    expect('coEdit' in settingsOf(project.id)).toBe(false)
    expect(sessionService.resolveAgentProfileName(scratch.id)).toBe('chat')
    expect(sessionService.resolveAgentProfileName(project.id)).toBe('work')
  })

  it('子会话（带 notebookPath 与 coEdit）→ 不写键；父会话是协作会话也一样', () => {
    const parent = create(
      { title: 'a.md', notebookPath: 'a.md' },
      { ephemeral: true, workingDirectory: '/Users/me/docs', coEdit: true }
    )
    const child = create({ parentId: parent.id, notebookPath: 'a.md' }, { coEdit: true })
    expect('coEdit' in settingsOf(child.id)).toBe(false)
    expect(sessionService.resolveAgentProfileName(child.id)).toBe('notebook')

    const plainChild = create({ parentId: parent.id })
    expect('coEdit' in settingsOf(plainChild.id)).toBe(false)
    expect(sessionService.resolveAgentProfileName(plainChild.id)).toBe('chat')
  })

  it('coEdit 混在 params 里（渲染层经 IPC 能给的只有 params）→ 不算数', () => {
    const s = create({
      title: 'a.md',
      notebookPath: 'a.md',
      coEdit: true
    } as unknown as CreateParams)
    expect('coEdit' in settingsOf(s.id)).toBe(false)
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('notebook')

    const viaSettings = create({
      notebookPath: 'b.md',
      settings: { coEdit: true }
    } as unknown as CreateParams)
    expect('coEdit' in settingsOf(viaSettings.id)).toBe(false)
  })
})

describe('S3 分支次序', () => {
  it('chromeTab + coEdit → tab（标签页会话先于一切，create 也不给它写 coEdit）', () => {
    const s = create(
      {
        notebookPath: 'a.md',
        chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 }
      } as unknown as CreateParams,
      { coEdit: true }
    )
    expect('coEdit' in settingsOf(s.id)).toBe(false)
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('tab')

    // 行里硬写进去也一样
    stamp(s.id, { coEdit: true, notebookPath: 'a.md' })
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('tab')
  })

  it('bot + coEdit + notebookPath → coedit（协作编辑先于 bot）', () => {
    const s = create({ bot: 'scout', notebookPath: 'a.md' }, { coEdit: true })
    expect(settingsOf(s.id)).toMatchObject({ bot: 'scout', coEdit: true, notebookPath: 'a.md' })
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('coedit')
  })

  it('coEdit 没有 notebookPath（行里硬写进去）→ 不是一种形态：无项目 chat / 有项目 work', () => {
    const scratch = create({ title: 'x' })
    const project = create({ title: 'y', projectId: 'p1' })
    stamp(scratch.id, { coEdit: true })
    stamp(project.id, { coEdit: true })
    expect(sessionService.resolveAgentProfileName(scratch.id)).toBe('chat')
    expect(sessionService.resolveAgentProfileName(project.id)).toBe('work')
  })

  it('coEdit + 空串的 notebookPath（行里硬写）→ 同样不是', () => {
    const s = create({ title: 'x' })
    stamp(s.id, { coEdit: true, notebookPath: '' })
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('chat')
  })
})
