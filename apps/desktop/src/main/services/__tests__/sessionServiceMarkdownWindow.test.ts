/**
 * sessionService —— md 窗口的会话（`create(params, { ephemeral, workingDirectory })`）的形态与根档案。
 *
 * 契约（sessionService.create / resolveAgentProfileName 的注释）：
 *   - 笔记本会话只有一种形态：带 notebookPath 的会话根档案恒为 `notebook`，无论它开在主窗口还是 md 窗口里
 *     （协作编辑与否由有没有编辑器挂着决定，不是会话形态）；曾经的 `coedit` 基座与 `settings.coEdit` 已拆掉；
 *   - 早先写下的 `coEdit` 键（行里留着、或调用方还在 options / params 里给）不再算数：不写、不读；
 *   - 分支次序：Chrome 标签页（tab）先于一切；笔记本先于 bot。
 *
 * mock 面整份沿用 sessionServiceEphemeral.test.ts：sessionRecords 是真的，只替掉它底下的 dao/sessionDao
 * （每个方法都是 spy、背后一张内存表），`AgentSession.create` 可捕获。
 *
 *   S1 md 窗口的真实组合（ephemeral + workingDirectory + notebookPath）→ 档案 notebook，送进运行时也是；
 *      行里没有 coEdit 键
 *   S2 遗留的 coEdit：options / params 里给 → 不写键、仍是 notebook；行里硬写 → 不改变推导
 *   S3 分支次序：chromeTab + notebookPath → tab；bot + notebookPath → notebook
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
vi.mock('../../utils/toolUtils/allowList', () => ({
  buildAllowEntry: (type: string, path: string) => `${type}(${path})`
}))
vi.mock('../agentService', () => ({
  agentService: {
    getProfile: vi.fn((name: string) => ({
      name,
      tools: [],
      instructionFiles: [],
      projectAwareness: false
    })),
    isSessionProfile: vi.fn()
  }
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

describe('S1 md 窗口的会话', () => {
  it('ephemeral + workingDirectory + notebookPath → 内存行里有工作目录、没有 coEdit，档案 notebook', () => {
    const s = create(
      { title: 'a.md', notebookPath: 'a.md' },
      { ephemeral: true, workingDirectory: '/Users/me/docs' }
    )
    expect(sessionRecords.isEphemeral(s.id)).toBe(true)
    expect(mocks.daoInsert).not.toHaveBeenCalled()
    expect(sessionService.getById(s.id)).toMatchObject({
      title: 'a.md',
      projectId: null,
      workingDirectory: '/Users/me/docs',
      settings: { notebookPath: 'a.md', workingDirectory: '/Users/me/docs' }
    })
    expect('coEdit' in settingsOf(s.id)).toBe(false)
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('notebook')
  })

  it('推导结果送进了运行时：resolveAgentConfig 给出档案 notebook 与文件所在目录', async () => {
    const s = create(
      { title: 'a.md', notebookPath: 'a.md' },
      { ephemeral: true, workingDirectory: '/Users/me/docs' }
    )
    const config = await sessionService.resolveAgentConfig(s.id)
    expect(config.profile.name).toBe('notebook')
    expect(config.cwd).toBe('/Users/me/docs')
  })
})

describe('S2 遗留的 coEdit 不再算数', () => {
  it('options 里还给 coEdit → 不写键，仍是 notebook', () => {
    const s = create({ title: 'a.md', notebookPath: 'a.md' }, {
      ephemeral: true,
      coEdit: true
    } as unknown as CreateOptions)
    expect('coEdit' in settingsOf(s.id)).toBe(false)
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('notebook')
  })

  it('params 里混着 coEdit（渲染层经 IPC 能给的只有 params）→ 不写键', () => {
    const s = create({
      title: 'a.md',
      notebookPath: 'a.md',
      coEdit: true
    } as unknown as CreateParams)
    expect('coEdit' in settingsOf(s.id)).toBe(false)
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('notebook')
  })

  it('行里留着 coEdit（旧版本写下的）→ 推导不变：有 notebookPath 是 notebook，没有按项目 chat / work', () => {
    const note = create({ notebookPath: 'a.md' })
    const scratch = create({ title: 'x' })
    const project = create({ title: 'y', projectId: 'p1' })
    for (const s of [note, scratch, project]) stamp(s.id, { coEdit: true })
    expect(sessionService.resolveAgentProfileName(note.id)).toBe('notebook')
    expect(sessionService.resolveAgentProfileName(scratch.id)).toBe('chat')
    expect(sessionService.resolveAgentProfileName(project.id)).toBe('work')
  })
})

describe('S3 分支次序', () => {
  it('chromeTab + notebookPath → tab（标签页会话先于一切）', () => {
    const s = create({
      notebookPath: 'a.md',
      chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 }
    } as unknown as CreateParams)
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('tab')

    // 行里硬写进去也一样
    stamp(s.id, { notebookPath: 'a.md' })
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('tab')
  })

  it('bot + notebookPath → notebook（笔记本先于 bot）', () => {
    const s = create({ bot: 'scout', notebookPath: 'a.md' })
    expect(settingsOf(s.id)).toMatchObject({ bot: 'scout', notebookPath: 'a.md' })
    expect(sessionService.resolveAgentProfileName(s.id)).toBe('notebook')
  })
})
