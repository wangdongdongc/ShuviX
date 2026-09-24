/**
 * notificationService —— **内存会话**（从系统打开的 md 窗口）的事件不进桌面通知。
 *
 * 契约：
 *   - 内存会话的对话在它自己的窗口里，主窗口的列表里没有它：它的 ChatEvent 一条都不交给决策器；
 *     普通会话照旧交；
 *   - 内存会话的子会话同为内存会话（按父会话推定）—— 它的事件同样不交；
 *   - 会话删掉之后迟到的事件（`wasEphemeral`）也不交：那条会话已经不存在，通知点开也找不到它。
 *
 * 判定走的是**真的** sessionService.create / delete 与真的 sessionRecords（内存会话的「是 / 曾是」
 * 只有那里知道）；mock 面沿用 sessionServiceEphemeral.test.ts，再加上通知服务自己的几件
 * （electron、决策器工厂、悬浮窗服务）。决策器是个间谍：「交没交」= `handleEvent` 有没有收到。
 *
 *   NE-1 内存会话的 agent_end / input_request / text_delta → 一条都不交；普通会话的原样交
 *   NE-2 内存父会话的子会话（内存）→ 不交；对照：持久父会话的子会话 → 交
 *   NE-3 内存会话删除之后迟到的事件 → 不交（它的子会话一样）
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

const table = vi.hoisted(() => new Map<string, unknown>())

const mocks = vi.hoisted(() => {
  const rows = (): Map<string, Record<string, unknown>> =>
    table as unknown as Map<string, Record<string, unknown>>
  const clone = <T>(v: T): T => structuredClone(v)
  return {
    handleEvent: vi.fn(),
    createNotificationCenter: vi.fn(),
    daoInsert: vi.fn((s: Record<string, unknown>) => {
      rows().set(s.id as string, clone(s))
    }),
    daoFindById: vi.fn((id: string) => {
      const r = rows().get(id)
      return r ? clone(r) : undefined
    }),
    daoFindAll: vi.fn(() => [...rows().values()].map((r) => clone(r))),
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
    daoDeleteById: vi.fn((id: string) => {
      rows().delete(id)
    })
  }
})

vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  }
}))
vi.mock('@shuvix/agent-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shuvix/agent-runtime')>()),
  createNotificationCenter: mocks.createNotificationCenter
}))
vi.mock('../pinnedChatService', () => ({ focusFloating: vi.fn(), isPinned: vi.fn(() => false) }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    insert: mocks.daoInsert,
    findById: mocks.daoFindById,
    findAll: mocks.daoFindAll,
    findByProjectId: vi.fn(() => []),
    findChildren: mocks.daoFindChildren,
    findByProjectAndNotebookPath: vi.fn(),
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    updateSettings: vi.fn(),
    updateTitle: vi.fn(),
    updateProjectId: vi.fn(),
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
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: vi.fn(async () => ({})),
  addSessionTreePin: vi.fn(),
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
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn(async () => {}) } }))
vi.mock('../toolAggregator', () => ({
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({
  buildAllowEntry: (type: string, path: string) => `${type}(${path})`
}))
vi.mock('../agentService', () => ({
  agentService: { getProfile: vi.fn(), isSessionProfile: vi.fn() }
}))
vi.mock('../agentSession', () => ({ AgentSession: { create: vi.fn() } }))
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

type SessionServiceModule = typeof import('../sessionService')
type NotificationModule = typeof import('../notificationService')
let sessionService: SessionServiceModule['sessionService']
let notifications: NotificationModule

beforeAll(async () => {
  mocks.createNotificationCenter.mockReturnValue({
    handleEvent: mocks.handleEvent,
    sessionOpened: vi.fn()
  })
  ;({ sessionService } = await import('../sessionService'))
  notifications = await import('../notificationService')
  notifications.initNotificationService({ getMainWindow: () => null, ensureMainWindow: () => {} })
})

beforeEach(() => {
  table.clear()
  sessionRecords.clearEphemeralForTests()
  mocks.handleEvent.mockClear()
})

const EPH = { ephemeral: true }

/** 会让决策器弹通知的那几类事件（一轮结束、等人回答）外加一条逐 token 的 */
function eventsFor(sessionId: string): ChatEvent[] {
  return [
    { type: 'text_delta', sessionId, delta: 'x' } as ChatEvent,
    {
      type: 'input_request',
      sessionId,
      request: { id: `req-${sessionId}`, kind: 'ask', toolName: 'edit', createdAt: 1 }
    } as unknown as ChatEvent,
    { type: 'agent_end', sessionId } as ChatEvent
  ]
}

function deliver(sessionId: string): void {
  for (const event of eventsFor(sessionId)) notifications.notifyOnChatEvent(event)
}

function delivered(sessionId: string): number {
  return mocks.handleEvent.mock.calls.filter((c) => (c[0] as ChatEvent).sessionId === sessionId)
    .length
}

describe('NE-1 内存会话', () => {
  it('NE-1 内存会话的事件一条都不交；普通会话的原样交', () => {
    const md = sessionService.create({ title: 'a.md', notebookPath: 'a.md' }, EPH)
    const normal = sessionService.create({ title: 'kept' })
    expect(sessionRecords.isEphemeral(md.id)).toBe(true)

    deliver(md.id)
    deliver(normal.id)

    expect(delivered(md.id)).toBe(0)
    expect(delivered(normal.id)).toBe(3)
    expect(mocks.handleEvent.mock.calls.map((c) => c[0])).toEqual(eventsFor(normal.id))
  })
})

describe('NE-2 内存会话的子会话', () => {
  it('NE-2 内存父会话的子会话（同为内存）→ 不交', () => {
    const parent = sessionService.create({ notebookPath: 'a.md' }, EPH)
    const child = sessionService.create({ parentId: parent.id })
    expect(sessionRecords.isEphemeral(child.id)).toBe(true)

    deliver(child.id)
    expect(delivered(child.id)).toBe(0)
  })

  it('NE-2 对照：持久父会话的子会话 → 交', () => {
    const parent = sessionService.create({ title: 'kept' })
    const child = sessionService.create({ parentId: parent.id })
    expect(sessionRecords.isEphemeral(child.id)).toBe(false)

    deliver(child.id)
    expect(delivered(child.id)).toBe(3)
  })
})

describe('NE-3 删掉之后迟到的事件', () => {
  it('NE-3 内存会话（连同它的子会话）删除之后，迟到的事件不交', async () => {
    const md = sessionService.create({ notebookPath: 'a.md' }, EPH)
    const child = sessionService.create({ parentId: md.id })
    await sessionService.delete(md.id)
    expect(sessionRecords.isEphemeral(md.id)).toBe(false)
    expect(sessionRecords.wasEphemeral(md.id)).toBe(true)
    expect(sessionRecords.wasEphemeral(child.id)).toBe(true)

    deliver(md.id)
    deliver(child.id)
    expect(mocks.handleEvent).not.toHaveBeenCalled()
  })

  it('NE-3 删除之前交过事件的内存会话，删除之后也不交（判定不靠第一次记下的结果）', async () => {
    const md = sessionService.create({ notebookPath: 'a.md' }, EPH)
    const normal = sessionService.create({ title: 'kept' })
    deliver(md.id)
    await sessionService.delete(md.id)
    deliver(md.id)
    deliver(normal.id)
    expect(delivered(md.id)).toBe(0)
    expect(delivered(normal.id)).toBe(3)
  })
})
