/**
 * sessionService / 网关 / 子会话运行器 / messageService 接到 SessionHost 上（单元：假宿主 + 真门面）。
 *
 *   E  D10-35 getAgentSession · D10-36 ensureAgentSession · D10-37 hasAgentRuntime · D10-38 invalidateAgent ·
 *      D10-39(U) 事件归运行时 · D10-40 删除次序（P3-05：含 hub.deleteSession）· D10-42 后台通知 · D10-43 询问参与方 · D10-44 钉档案 ·
 *      D10-45..51 网关 · P3-11-05/06 网关 withdrawQueued（不规范 id、没开、closed → not_found）与没有 nextTurn · P3-10b-08 网关回退不预先销毁（取代 D10-53）· P3-06-30 网关 getAgentInfo（不带 ensure 读门面 / peek；ensure 的次序与拒绝）
 *   F  D10-55 statusOf（P2-10-32：interrupted，开着 / 镜像）· D10-56 被拒的子会话发送 · D10-57 stop（含被中断的）·
 *      D10-58 答复（P2-10-28：lastAnswer）
 *   G  D10-59 列表（P3-07：新格式 = peek → viewSnapshot().messages）· D10-61 旧格式的回退 / 截断 ·
 *      P3-10a-23 旧格式的回退拒绝（桌面守卫）· P3-10b-01..07 回退 / 截断映射到 rollbackTo（id 解析 PIN-01、
 *      拒绝 = 没有目标、closed 再窥视一次 PIN-04）
 *   H  D10-64 closeAll 之后
 * （D10-54 Chrome 侧栏的 respondToInput：channel.test.ts 的 CH-5 钉路由，D10-35 钉 getAgentSession 只看宿主。）
 *
 * sessions 表是真的（node:sqlite 内存库 + 迁移）；sessionService / AgentSession / DefaultChatGateway /
 * subSessionRunner / messageService / sessionStorage / userInputBroker / taskRegistry 是真的；会话运行时是
 * 假宿主（support/fakeSessionHost），其余 DAO 与重的上游换成假件。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentCreationError } from '@shuvix/agent-runtime'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import type { ChatGateway } from '../../frontend/core/ChatGateway'
import { emptySessionView } from '@shuvix/chat-protocol/types/sessionView'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: '',
  notifier: undefined as undefined | ((sessionId: string, text: string) => void)
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  killBySession: vi.fn<(sessionId: string) => void>(),
  closeSession: vi.fn<(sessionId: string) => Promise<void>>(async () => {}),
  abortSessionRuns: vi.fn<(sessionId: string) => void>(),
  fire: vi.fn(),
  getProfile: vi.fn<(name: string) => unknown>(),
  recordUserEntry: vi.fn(),
  clearFileTime: vi.fn<(sessionId: string) => void>(),
  calls: [] as string[]
}))

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
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: () => [],
    findEnabled: () => [],
    findEnabledModels: () => []
  }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: () => undefined } }))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => holder.sessionsDir,
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => holder.toolResults,
  getSessionArtifactsDir: (sid: string) => `/nonexistent/shuvix-unit/artifacts/${sid}`,
  isSafeSessionId: () => true
}))
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../sessionDayPromptService', () => ({
  recordUserEntry: mocks.recordUserEntry
}))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: (tools: string[]) => tools }))
vi.mock('../mcpService', () => ({
  mcpService: { closeSession: mocks.closeSession, getAllToolInfos: () => [] }
}))
vi.mock('../agentService', () => ({
  agentService: { getProfile: mocks.getProfile, isSessionProfile: () => true }
}))
vi.mock('../bgTaskService', () => ({
  killBySession: mocks.killBySession,
  setBgTaskNotifier: (fn: (sessionId: string, text: string) => void) => {
    holder.notifier = fn
  }
}))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: () => null }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: mocks.broadcast }
}))
vi.mock('../artifacts/store', () => ({ deleteSessionArtifacts: vi.fn() }))
vi.mock('../sandbox', () => ({ cleanupSession: vi.fn() }))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: mocks.fire },
  hookService: { abortSessionRuns: mocks.abortSessionRuns }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: async () => null,
  isDefaultTitle: () => false
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({
  clearSession: (sessionId: string) => mocks.clearFileTime(sessionId)
}))
vi.mock('../../tools/allTools', () => ({}))
vi.mock('../toolRegistry', () => ({
  getBuiltinToolEntries: () => [],
  getPlatformBuiltinToolEntries: () => []
}))
vi.mock('../builtinMcp/dbConnections', () => ({
  dbManager: { runtimeStatus: () => undefined, getConnectionInfo: () => undefined }
}))
vi.mock('../builtinMcp/sshServer', () => ({
  sshRuntimeStatuses: () => ({}),
  sshDisconnectRuntime: () => undefined
}))
vi.mock('../skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string>) =>
    vars?.reason !== undefined ? `${key}:${vars.reason}` : key
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { migrations } from '../../dao/migrations'
import type { Session } from '../../dao/types'
import { sessionRecords } from '../sessionRecords'
import { clearMemoryStoragesForTests } from '../sessionStorage'
import { requestUserInputFor, respondToUserInput } from '../userInputBroker'
import {
  FakeDurableSession,
  fakeHost,
  gate,
  lockRecord,
  resetFakeHost
} from './support/fakeSessionHost'
import { getSyncHub, resetSyncHubForTests } from '../../frontend/sync/syncWiring'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let sessionService: (typeof import('../sessionService'))['sessionService']
let messageService: (typeof import('../messageService'))['messageService']
let chatGateway: (typeof import('../../frontend/core/DefaultChatGateway'))['chatGateway']
let subSessionRunner: (typeof import('../subSessionRunner'))['subSessionRunner']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ messageService } = await import('../messageService'))
  ;({ chatGateway } = await import('../../frontend/core/DefaultChatGateway'))
  ;({ subSessionRunner } = await import('../subSessionRunner'))
})

const profile = (name: string): Record<string, unknown> => ({
  name,
  displayName: name,
  description: '',
  tools: [],
  systemPrompt: '',
  instructionFiles: [],
  projectAwareness: false
})

function insert(id: string, patch: Partial<Session> = {}): string {
  sessionRecords.insert({
    id,
    title: id,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: { enabledTools: [] },
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...patch
  })
  return id
}

const settingsOf = (id: string): Record<string, unknown> =>
  (sessionRecords.findById(id)?.settings ?? {}) as Record<string, unknown>

const eventsOf = (type: string): Array<Record<string, unknown>> =>
  mocks.broadcast.mock.calls.map(([event]) => event).filter((event) => event.type === type)

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-runtime-wiring-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-runtime-wiring-tr-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockClear()
  mocks.calls.length = 0
  mocks.getProfile.mockImplementation((name) => profile(name))
  resetFakeHost()
})

afterEach(() => {
  rmSync(holder.sessionsDir, { recursive: true, force: true })
  rmSync(holder.toolResults, { recursive: true, force: true })
})

// ─── E. sessionService ─────────────────────────────────────────────────────

describe('D10-35 getAgentSession', () => {
  it('D10-35 开着 → 门面（同一实例恒是同一个，重开之后是新的）；没开 → undefined，不打开不 peek', async () => {
    insert('s1')
    expect(sessionService.getAgentSession('s1')).toBeUndefined()
    expect(fakeHost.calls).toEqual([])

    const first = fakeHost.put('s1')
    const facade = sessionService.getAgentSession('s1')
    expect(facade?.durable).toBe(first)
    expect(sessionService.getAgentSession('s1')).toBe(facade)

    await fakeHost.close('s1')
    fakeHost.put('s1')
    expect(sessionService.getAgentSession('s1')).not.toBe(facade)
  })
})

describe('D10-36 ensureAgentSession', () => {
  it('D10-36 新格式会话 → 宿主 open 一次、返回门面；不碰锁、不读会话配置', async () => {
    insert('s1')
    const resolveSpy = vi.spyOn(sessionService, 'resolveAgentConfig')
    const facade = await sessionService.ensureAgentSession('s1')
    expect(fakeHost.callsOf('open')).toEqual(['s1'])
    expect(facade?.durable).toBe(fakeHost.get('s1'))
    expect(fakeHost.get('s1')?.callsOf('createAgent')).toEqual([])
    expect(resolveSpy).not.toHaveBeenCalled()
    resolveSpy.mockRestore()
  })

  it.each([
    ['没有这一行', (): void => {}],
    ['旧格式', (): void => void insert('s1', { storageKind: 'harness-v3-jsonl' })],
    [
      '宿主已封存',
      (): void => {
        insert('s1')
        fakeHost.sealed = true
      }
    ]
  ])('D10-36 %s → undefined，不打开、不建文件', async (_label, arrange) => {
    arrange()
    expect(await sessionService.ensureAgentSession('s1')).toBeUndefined()
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(readdirSync(holder.sessionsDir)).toEqual([])
  })
})

describe('D10-37 hasAgentRuntime 矩阵', () => {
  it.each([
    ['开着、锁着', true, true, undefined],
    ['开着、没锁、镜像过时说有', true, false, true],
    ['没开、镜像为真', false, false, true],
    ['没开、镜像为假', false, false, false],
    ['没开、没有镜像', false, false, undefined]
  ] as const)('D10-37 %s', async (_label, open, locked, mirror) => {
    insert('s1', {
      settings: { enabledTools: [], ...(mirror === undefined ? {} : { agentLocked: mirror }) }
    })
    if (open) fakeHost.put('s1', locked ? { lock: lockRecord() } : {})
    const expected = open ? locked : mirror === true
    expect(sessionService.hasAgentRuntime('s1')).toBe(expected)
    expect((await sessionService.initAgent('s1')).created).toBe(expected)
    expect(sessionService.updateEnabledTools('s1', ['skill:a'])).toBe(!expected)
    // initAgent 从不打开会话
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.callsOf('peek')).toEqual([])
  })

  it('D10-37 没有这一行 → false', () => {
    expect(sessionService.hasAgentRuntime('nope')).toBe(false)
  })
})

describe('D10-38 invalidateAgent', () => {
  it('D10-38 开着 → destroyAgent 恰一次，等它落定', async () => {
    insert('s1')
    const destroyGate = gate()
    const session = fakeHost.put('s1', { lock: lockRecord(), destroyGate })
    let settled = false
    const pending = sessionService.invalidateAgent('s1').then(() => (settled = true))
    await flush()
    expect(session.callsOf('destroyAgent')).toHaveLength(1)
    expect(settled).toBe(false)
    destroyGate.release()
    await pending
    expect(sessionService.hasAgentRuntime('s1')).toBe(false)
  })

  it('D10-38 没开但存储在 → peek 打开再销毁；不建新文件', async () => {
    insert('s1', { settings: { enabledTools: [], agentLocked: true } })
    fakeHost.storages.add('s1')
    fakeHost.configure = (session) => (session.lock = lockRecord())
    await sessionService.invalidateAgent('s1')
    expect(fakeHost.callsOf('peek')).toEqual(['s1'])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.get('s1')?.callsOf('destroyAgent')).toHaveLength(1)
    expect(sessionService.hasAgentRuntime('s1')).toBe(false)
  })

  it('D10-38 没有存储 → peek 回 undefined，什么都不建，照样落定', async () => {
    insert('s1')
    await expect(sessionService.invalidateAgent('s1')).resolves.toBeUndefined()
    expect(fakeHost.callsOf('peek')).toEqual(['s1'])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(readdirSync(holder.sessionsDir)).toEqual([])
  })

  it('D10-38 旧格式 → 不 peek、不 open', async () => {
    insert('s1', { storageKind: 'harness-v3-jsonl' })
    await sessionService.invalidateAgent('s1')
    expect(fakeHost.calls).toEqual([])
  })
})

describe('D10-39 agent 事件归运行时（单元面）', () => {
  it('D10-39 sessionService 自己从不广播 agent_created / agent_closing', async () => {
    insert('s1')
    await sessionService.ensureAgentSession('s1')
    fakeHost.get('s1')!.lock = lockRecord()
    await sessionService.invalidateAgent('s1')
    await sessionService.delete('s1')
    expect(eventsOf('agent_created')).toEqual([])
    expect(eventsOf('agent_closing')).toEqual([])
  })
})

describe('D10-40 删除次序', () => {
  it.each([
    ['开着的会话', true],
    ['从没打开过的会话', false]
  ])(
    'D10-40 %s：先删子会话 → 杀后台任务 → 等宿主 delete（挂着时行与结果目录都还在）→ hub.deleteSession → 删行 → 其余',
    async (_label, open) => {
      insert('P')
      insert('c1', { parentId: 'P' })
      if (open) fakeHost.put('P')
      mkdirSync(join(holder.toolResults, 'P'))
      mocks.killBySession.mockImplementation((id) => void mocks.calls.push(`kill:${id}`))
      // P3-05 PIN-07：视图同步撤下会话在宿主 delete 之后、删行之前（每个子会话各一次）
      resetSyncHubForTests()
      const hub = getSyncHub()
      const deleteSession = vi.spyOn(hub, 'deleteSession')
      deleteSession.mockImplementation((id) => void mocks.calls.push(`hub:${id}`))
      const deleteById = sessionRecords.deleteById.bind(sessionRecords)
      const rowSpy = vi.spyOn(sessionRecords, 'deleteById').mockImplementation((id) => {
        mocks.calls.push(`row:${id}`)
        deleteById(id)
      })
      const deleteGate = gate()
      const remove = fakeHost.delete.bind(fakeHost)
      fakeHost.delete = async (id) => {
        mocks.calls.push(`delete:${id}`)
        if (id === 'P') await deleteGate.promise
        await remove(id)
      }

      const pending = sessionService.delete('P')
      await vi.waitFor(() => expect(mocks.calls).toContain('delete:P'))
      expect(mocks.calls).toEqual([
        'kill:c1',
        'delete:c1',
        'hub:c1',
        'row:c1',
        'kill:P',
        'delete:P'
      ])
      expect(deleteSession.mock.calls).toEqual([['c1']])
      expect(sessionRecords.findById('P')).toBeDefined()
      expect(existsSync(join(holder.toolResults, 'P'))).toBe(true)
      // 会话没开着也照样中止 hook run（清理不以「开着」为前提）
      expect(mocks.abortSessionRuns.mock.calls.map(([id]) => id)).toEqual(['c1', 'P'])

      deleteGate.release()
      await pending
      expect(mocks.calls.slice(-3)).toEqual(['delete:P', 'hub:P', 'row:P'])
      expect(deleteSession.mock.calls).toEqual([['c1'], ['P']])
      rowSpy.mockRestore()
      resetSyncHubForTests()
      expect(sessionRecords.findById('P')).toBeUndefined()
      expect(existsSync(join(holder.toolResults, 'P'))).toBe(false)
      expect(mocks.closeSession.mock.calls.map(([id]) => id)).toEqual(['c1', 'P'])
    }
  )
})

describe('D10-42 后台通知（PIN-05）', () => {
  it('D10-42 开着且锁着 → 门面 notify 恰一次', async () => {
    insert('s1')
    const session = fakeHost.put('s1', { lock: lockRecord() })
    holder.notifier!('s1', 'bg done')
    await vi.waitFor(() => expect(session.callsOf('notify')).toEqual([['notify', 'bg done']]))
  })

  it('D10-42 开着但没锁 → 只写通知条目（不为一条通知创建 agent）', async () => {
    insert('s1')
    const session = fakeHost.put('s1')
    holder.notifier!('s1', 'bg done')
    await vi.waitFor(() => expect(session.callsOf('writeNotice')).toHaveLength(1))
    expect(session.callsOf('writeNotice')[0]![1]).toEqual({ text: 'bg done', kind: 'background' })
    expect(session.callsOf('notify')).toEqual([])
  })

  it('D10-42 没开、存储在 → peek（不 open）；锁着走 notify', async () => {
    insert('s1')
    fakeHost.storages.add('s1')
    fakeHost.configure = (session) => (session.lock = lockRecord())
    holder.notifier!('s1', 'bg done')
    await vi.waitFor(() => expect(fakeHost.get('s1')?.callsOf('notify')).toHaveLength(1))
    expect(fakeHost.callsOf('peek')).toEqual(['s1'])
    expect(fakeHost.callsOf('open')).toEqual([])
  })

  it('D10-42 没开、没有存储 → 什么都不建、丢弃', async () => {
    insert('s1')
    holder.notifier!('s1', 'bg done')
    await flush()
    expect(fakeHost.callsOf('peek')).toEqual(['s1'])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(readdirSync(holder.sessionsDir)).toEqual([])
  })

  it('D10-42 / P2-10-40 子会话完成通知走同一条路，带种类与 requestId；bash 那条照旧只有正文', async () => {
    insert('s1')
    const session = fakeHost.put('s1', { lock: lockRecord() })
    await sessionService.deliverSubSessionNotice('s1', 'sub done', 'subsession-done:c1:7')
    expect(session.callsOf('notify')).toEqual([
      ['notify', 'sub done', { kind: 'sub-session', requestId: 'subsession-done:c1:7' }]
    ])
    // 没锁：只写一条通知条目，不为它创建 agent
    insert('s2')
    const unlocked = fakeHost.put('s2')
    await sessionService.deliverSubSessionNotice('s2', 'sub done', 'subsession-done:c2:8')
    expect(unlocked.callsOf('writeNotice')).toEqual([
      ['writeNotice', { text: 'sub done', kind: 'sub-session', requestId: 'subsession-done:c2:8' }]
    ])
    expect(unlocked.callsOf('createAgent')).toEqual([])
    // P2-10-51：bash 的后台通知仍是 notify(text)，没有选项
    holder.notifier!('s1', 'bg done')
    await vi.waitFor(() => expect(session.callsOf('notify')).toHaveLength(2))
    expect(session.callsOf('notify')[1]).toEqual(['notify', 'bg done'])
  })
})

describe('D10-43 询问参与方', () => {
  it('D10-43 claims 只认开着的会话；request 只把 request 交给 DurableSession', async () => {
    insert('s1')
    const request = { id: 'q1', kind: 'ask', toolName: 'bash', createdAt: 0 } as never
    await expect(requestUserInputFor('s1', request)).rejects.toThrow(/not active/)
    const session = fakeHost.put('s1')
    await requestUserInputFor('s1', request)
    expect(session.callsOf('requestUserInput')).toEqual([['requestUserInput', request]])
  })

  it('D10-43 respond 遍历开着的会话、第一个认下就停；一个都没开 → false', () => {
    const response = { kind: 'ask', allowed: true } as never
    expect(respondToUserInput('q1', response)).toBe(false)
    const a = fakeHost.put('a')
    const b = fakeHost.put('b', { respondResult: true })
    const c = fakeHost.put('c', { respondResult: true })
    expect(respondToUserInput('q1', response)).toBe(true)
    expect(a.callsOf('respondToInput')).toHaveLength(1)
    expect(b.callsOf('respondToInput')).toHaveLength(1)
    expect(c.callsOf('respondToInput')).toEqual([])
    expect(sessionService.liveAgentSessions().map((s) => s.sessionId)).toEqual(['a', 'b', 'c'])
  })
})

describe('D10-44 新子会话上钉档案', () => {
  it('D10-44 invalidateAgent 不打开宿主、不建存储；种子落进 settings.model / thinkingLevel', async () => {
    insert('P', {
      settings: { enabledTools: [], model: { provider: 'row', modelId: 'm' }, thinkingLevel: 'low' }
    })
    const child = sessionService.create({ parentId: 'P' })
    mocks.getProfile.mockImplementation((name) =>
      name === 'coding' ? { ...profile('coding'), thinkingLevel: 'high' } : profile(name)
    )
    const result = await sessionService.pinAgentProfile(child.id, 'coding')
    expect(result.success).toBe(true)
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(readdirSync(holder.sessionsDir)).toEqual([])
    expect(settingsOf(child.id).thinkingLevel).toBe('high')
    expect(settingsOf(child.id).agentProfile).toBe('coding')
  })
})

// ─── E. 网关 ───────────────────────────────────────────────────────────────

describe('D10-45 gateway.prompt 成功', () => {
  it('D10-45 门面收到解析过 token 的正文、图片、显示侧车 {content, tokens}；返回 {}，不报错', async () => {
    insert('s1')
    const images = [{ type: 'image' as const, data: 'AAA', mimeType: 'image/png' }]
    const tokens = {
      a1: { type: 'at', id: 'f', displayText: '@f', payload: '/abs/file.ts' }
    }
    const result = await chatGateway.prompt('s1', 'see {{shuvixInlineToken:a1}}', images, tokens)
    expect(result).toEqual({})
    const [, content, options] = fakeHost.get('s1')!.callsOf('submitUser')[0]!
    expect(content).toEqual([{ type: 'text', text: 'see /abs/file.ts' }, ...images])
    expect((options as { display: unknown }).display).toEqual({
      content: 'see {{shuvixInlineToken:a1}}',
      tokens
    })
    expect(eventsOf('error')).toEqual([])
  })
})

describe('D10-46 gateway.prompt 模型被拒（PIN-15）', () => {
  it('D10-46 A：submitUser 回 no_model → 恰一条 error（带 provider 名与模型），回 {error}；不发 agent_created，镜像不动', async () => {
    insert('s1')
    fakeHost.configure = (session) => {
      session.submitResults = [{ error: 'Provider "My Proxy" has no model "x"', code: 'no_model' }]
    }
    const result = await chatGateway.prompt('s1', 'hi')
    expect(result.code).toBe('no_model')
    expect(result.error).toBeTruthy()
    expect(eventsOf('error')).toEqual([
      {
        type: 'error',
        sessionId: 's1',
        error: 'chat.agentNoModel:Provider "My Proxy" has no model "x"'
      }
    ])
    expect(eventsOf('agent_created')).toEqual([])
    expect(settingsOf('s1').agentLocked).toBeUndefined()
  })

  it('D10-46 B：创建也被拒（createAgent 抛 AgentCreationError no_model）→ 同样一条 error', async () => {
    insert('s1')
    fakeHost.configure = (session) => {
      session.createAgentError = new AgentCreationError('no_model', 'Provider "Faux" is disabled')
      session.submitResults = [{ error: 'Provider "Faux" is disabled', code: 'no_model' }]
    }
    const result = await chatGateway.prompt('s1', 'hi')
    expect(result.code).toBe('no_model')
    expect(eventsOf('error')).toHaveLength(1)
    expect(String(eventsOf('error')[0]!.error)).toContain('Provider "Faux" is disabled')
    expect(eventsOf('agent_created')).toEqual([])
  })

  it('D10-46 创建被取消（{}，没有受理）→ 不报错、回 {}', async () => {
    insert('s1')
    fakeHost.configure = (session) => {
      session.admit = false
      session.submitResults = [{}]
    }
    expect(await chatGateway.prompt('s1', 'hi')).toEqual({})
    expect(eventsOf('error')).toEqual([])
  })

  it('D10-46 模型请求失败（model_error）→ 不报 error（失败是会话里的错误条目，经视图上屏，P3-08）；忙 → 不报', async () => {
    insert('s1')
    fakeHost.configure = (session) => {
      session.submitResults = [
        { error: 'overloaded', code: 'model_error' },
        { error: 'busy', code: 'busy' }
      ]
    }
    expect((await chatGateway.prompt('s1', 'a')).code).toBe('model_error')
    expect((await chatGateway.prompt('s1', 'b')).code).toBe('busy')
    expect(eventsOf('error')).toEqual([])
  })
})

describe('D10-47 gateway.prompt 打不开的会话', () => {
  it.each([
    ['没有这一行', (): void => {}, 'Agent 未初始化'],
    [
      '旧格式（只读）',
      (): void => void insert('s1', { storageKind: 'harness-v3-jsonl' }),
      'chat.legacySessionReadOnly'
    ],
    [
      '宿主已封存',
      (): void => {
        insert('s1')
        fakeHost.sealed = true
      },
      'Agent 未初始化'
    ]
  ])('D10-47 %s → 一条 error 与 {error}；什么都不建', async (_label, arrange, message) => {
    arrange()
    expect(await chatGateway.prompt('s1', 'hi')).toEqual({ error: message })
    expect(eventsOf('error')).toEqual([{ type: 'error', sessionId: 's1', error: message }])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(readdirSync(holder.sessionsDir)).toEqual([])
  })
})

describe('D10-48 steer / followUp', () => {
  it('D10-48 会话没开 → error 事件，不打开', async () => {
    insert('s1')
    chatGateway.steer('s1', 'x')
    expect(eventsOf('error')).toHaveLength(1)
    expect(fakeHost.callsOf('open')).toEqual([])
  })

  it('D10-48 受理被拒（模型被拒）→ error 事件', async () => {
    insert('s1')
    const session = fakeHost.put('s1')
    session.followUpResult = { error: 'Provider "Faux" is disabled', code: 'no_model' }
    chatGateway.followUp('s1', 'later')
    await vi.waitFor(() => expect(eventsOf('error')).toHaveLength(1))
    expect(String(eventsOf('error')[0]!.error)).toContain('chat.agentNoModel:')
    expect(session.callsOf('followUp')).toEqual([['followUp', 'later']])
    expect(session.callsOf('steer')).toEqual([])
  })

  it('P3-11-06 网关上没有「下一轮」（Q-P3-09）', () => {
    // @ts-expect-error nextTurn is gone end to end (Q-P3-09)
    const gone: ChatGateway['nextTurn'] = undefined
    expect(gone).toBeUndefined()
    expect('nextTurn' in chatGateway).toBe(false)
  })
})

describe('P3-11-05 网关 withdrawQueued', () => {
  it('P3-11-05 会话没开 → not_found，不 open / peek', async () => {
    insert('s1')
    expect(await chatGateway.withdrawQueued('s1', 3)).toBe('not_found')
    expect(fakeHost.calls).toEqual([])
  })

  it.each<[unknown]>([[0], [-1], [1.5], ['3'], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1]])(
    'P3-11-05 submissionId %s 不是正的安全整数 → not_found，不碰运行时',
    async (id) => {
      insert('s1')
      const session = fakeHost.put('s1')
      expect(await chatGateway.withdrawQueued('s1', id as number)).toBe('not_found')
      expect(session.callsOf('withdrawQueued')).toEqual([])
    }
  )

  it.each([
    ['aborted', 'aborted'],
    ['already_placed', 'already_placed'],
    ['settled', 'settled'],
    ['not_found', 'not_found'],
    ['closed', 'not_found']
  ] as const)('P3-11-05 运行时答 %s → %s', async (runtime, expected) => {
    insert('s1')
    const session = fakeHost.put('s1')
    session.withdrawResult = runtime
    expect(await chatGateway.withdrawQueued('s1', 3)).toBe(expected)
    expect(session.callsOf('withdrawQueued')).toEqual([['withdrawQueued', 3]])
  })
})

describe('D10-49 setModel', () => {
  it('D10-49 锁着（开着）→ false，settings.model 不动，不 open / peek', async () => {
    insert('s1', { settings: { enabledTools: [], model: { provider: 'a', modelId: '1' } } })
    fakeHost.put('s1', { lock: lockRecord() })
    expect(await chatGateway.setModel('s1', 'b', '2')).toBe(false)
    expect(settingsOf('s1').model).toEqual({ provider: 'a', modelId: '1' })
    expect(fakeHost.callsOf('peek')).toEqual([])
  })

  it('D10-49 没开但镜像为真 → false', async () => {
    insert('s1', { settings: { enabledTools: [], agentLocked: true } })
    expect(await chatGateway.setModel('s1', 'b', '2')).toBe(false)
    expect(settingsOf('s1').model).toBeUndefined()
    expect(fakeHost.calls).toEqual([])
  })

  it('D10-49 没锁 → 写 {provider, modelId}，回 true', async () => {
    insert('s1')
    expect(await chatGateway.setModel('s1', 'b', '2')).toBe(true)
    expect(settingsOf('s1').model).toEqual({ provider: 'b', modelId: '2' })
  })
})

describe('D10-50 setThinkingLevel（PIN-07）', () => {
  it('D10-50 设置恒写；开着 → 再现场交给它一次', async () => {
    insert('s1')
    const session = fakeHost.put('s1', { lock: lockRecord() })
    await chatGateway.setThinkingLevel('s1', 'high')
    expect(settingsOf('s1').thinkingLevel).toBe('high')
    expect(session.callsOf('setThinkingLevel')).toEqual([['setThinkingLevel', 'high']])
  })

  it('D10-50 没开、没锁 → 只写设置，不 open / peek', async () => {
    insert('s1')
    await chatGateway.setThinkingLevel('s1', 'low')
    expect(settingsOf('s1').thinkingLevel).toBe('low')
    expect(fakeHost.calls).toEqual([])
  })

  it('D10-50 没开但锁着 → peek 打开再现场交给它（不 open）', async () => {
    insert('s1', { settings: { enabledTools: [], agentLocked: true } })
    fakeHost.storages.add('s1')
    await chatGateway.setThinkingLevel('s1', 'xhigh')
    expect(settingsOf('s1').thinkingLevel).toBe('xhigh')
    expect(fakeHost.callsOf('peek')).toEqual(['s1'])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.get('s1')?.callsOf('setThinkingLevel')).toEqual([['setThinkingLevel', 'xhigh']])
  })
})

describe('D10-51 destroyAgent / abort', () => {
  it('D10-51 destroyAgent → invalidateAgent（等它落定）；不清消息、不广播', async () => {
    insert('s1')
    const session = fakeHost.put('s1', { lock: lockRecord() })
    await chatGateway.destroyAgent('s1')
    expect(session.callsOf('destroyAgent')).toHaveLength(1)
    expect(fakeHost.callsOf('delete')).toEqual([])
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('D10-51 abort：开着 → durable.abort；没开 → 不打开；都回 {success:true}', async () => {
    insert('s1')
    insert('s2')
    const session = fakeHost.put('s1')
    expect(await chatGateway.abort('s1')).toEqual({ success: true })
    expect(session.callsOf('abort')).toHaveLength(1)
    expect(await chatGateway.abort('s2')).toEqual({ success: true })
    expect(fakeHost.callsOf('open')).toEqual([])
  })
})

describe('P3-10b-08 gateway.rollbackMessage 不预先销毁（PIN-03；取代 D10-53）', () => {
  it('P3-10b-08 锁着、在跑：桌面从不 invalidateAgent / destroyAgent，rollbackTo 恰一次；ok → 桌面侧清理恰一次（fileTime）', async () => {
    insert('s1')
    const session = fakeHost.put('s1', { lock: lockRecord(), busy: true, runState: 'busy' })
    const invalidate = vi.spyOn(sessionService, 'invalidateAgent')
    expect(await chatGateway.rollbackMessage('s1', '42')).toBe(true)
    expect(invalidate).not.toHaveBeenCalled()
    expect(session.callsOf('destroyAgent')).toEqual([])
    expect(session.callsOf('rollbackTo')).toEqual([['rollbackTo', 42]])
    expect(mocks.clearFileTime.mock.calls).toEqual([['s1']])
    invalidate.mockRestore()
  })

  it.each([['not_found' as const], ['invalid_target' as const]])(
    'P3-10b-08 被拒（%s）→ false：不清理、不广播，假会话的忙碌与锁原样',
    async (reason) => {
      insert('s1')
      const lock = lockRecord()
      const session = fakeHost.put('s1', {
        lock,
        busy: true,
        runState: 'busy',
        rollbackResult: { ok: false, reason }
      })
      const invalidate = vi.spyOn(sessionService, 'invalidateAgent')
      expect(await chatGateway.rollbackMessage('s1', '42')).toBe(false)
      expect(invalidate).not.toHaveBeenCalled()
      expect(session.callsOf('destroyAgent')).toEqual([])
      expect(session.callsOf('rollbackTo')).toEqual([['rollbackTo', 42]])
      expect(mocks.clearFileTime).not.toHaveBeenCalled()
      expect(mocks.broadcast).not.toHaveBeenCalled()
      expect(session.isBusy()).toBe(true)
      expect(session.runState).toBe('busy')
      expect(session.lock).toBe(lock)
      invalidate.mockRestore()
    }
  )
})

describe('P3-06-30 gateway.getAgentInfo', () => {
  const info = (systemPrompt: string): AgentRuntimeInfo => ({
    systemPrompt,
    model: {
      provider: 'faux',
      id: 'faux-1',
      name: 'faux-1',
      api: 'faux',
      contextWindow: 1,
      maxTokens: 1,
      reasoning: false,
      input: []
    },
    thinkingLevel: 'low',
    tools: [],
    messageCount: 0,
    isStreaming: false
  })
  const RUNS = ['submitUser', 'continue', 'resumeInterrupted', 'steer', 'followUp']

  it('P3-06-30 no ensure, open: reads the facade (the lock conversation, PIN-09); unlocked → null; never opens', async () => {
    insert('s1')
    const session = fakeHost.put('s1', { lock: lockRecord({ conversationId: 3 as never }) })
    session.infos.set(3, info('lock conversation'))
    session.infos.set(1, info('root conversation'))
    expect(await chatGateway.getAgentInfo('s1')).toEqual(info('lock conversation'))
    expect(session.callsOf('agentInfo')).toEqual([['agentInfo', 3]])
    session.lock = undefined
    expect(await chatGateway.getAgentInfo('s1')).toBeNull()
    expect(session.callsOf('agentInfo')).toHaveLength(1)
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.callsOf('peek')).toEqual([])
  })

  it('P3-06-30 no ensure, closed but locked (mirror): peek, never open; nothing runs (PIN-03); not locked → no peek', async () => {
    insert('s1', { settings: { enabledTools: [], agentLocked: true } })
    insert('s2')
    fakeHost.storages.add('s1')
    fakeHost.storages.add('s2')
    fakeHost.configure = (session) => {
      session.lock = lockRecord()
      session.infos.set(1, info('peeked'))
    }
    expect(await chatGateway.getAgentInfo('s1')).toEqual(info('peeked'))
    expect(fakeHost.callsOf('peek')).toEqual(['s1'])
    expect(fakeHost.callsOf('open')).toEqual([])
    const session = fakeHost.get('s1')!
    for (const name of [...RUNS, 'createAgent']) expect(session.callsOf(name)).toEqual([])

    expect(await chatGateway.getAgentInfo('s2')).toBeNull()
    expect(fakeHost.callsOf('peek')).toEqual(['s1'])
  })

  it('P3-06-30 ensure: ensureAgentSession → createAgent() → getRuntimeInfo(); no send / continue / resume', async () => {
    insert('s1')
    fakeHost.configure = (session) => {
      session.lockOnFirstUse = lockRecord()
      session.infos.set(1, info('ensured'))
    }
    expect(await chatGateway.getAgentInfo('s1', { ensure: true })).toEqual(info('ensured'))
    expect(fakeHost.callsOf('open')).toEqual(['s1'])
    const session = fakeHost.get('s1')!
    expect(session.calls.map(([name]) => name)).toEqual(['createAgent', 'agentInfo'])
    for (const name of RUNS) expect(session.callsOf(name)).toEqual([])
  })

  it('P3-06-30 ensure: no_model / cancelled → null without an error event; any other failure rejects', async () => {
    insert('s1')
    const session = fakeHost.put('s1')
    for (const code of ['no_model', 'cancelled'] as const) {
      session.createAgentError = new AgentCreationError(code, `refused: ${code}`)
      expect(await chatGateway.getAgentInfo('s1', { ensure: true })).toBeNull()
    }
    expect(session.callsOf('agentInfo')).toEqual([])
    expect(mocks.broadcast).not.toHaveBeenCalled()
    session.createAgentError = new Error('tool host exploded')
    await expect(chatGateway.getAgentInfo('s1', { ensure: true })).rejects.toThrow(
      'tool host exploded'
    )
    expect(await chatGateway.getAgentInfo('nope', { ensure: true })).toBeNull()
  })
})

// ─── F. 子会话运行器 ─────────────────────────────────────────────────────────

describe('D10-55 statusOf 经门面 / 镜像（P2-10-32）', () => {
  it('D10-55 / P2-10-32 开着：waiting-input > running > interrupted > idle；没开着读镜像：interrupted 与过时的 busy → interrupted，idle / 没有 → idle；从不 open / peek', () => {
    insert('P')
    insert('busy', { parentId: 'P' })
    insert('ask', { parentId: 'P' })
    insert('askInterrupted', { parentId: 'P' })
    insert('interrupted', { parentId: 'P' })
    insert('openIdle', { parentId: 'P' })
    insert('closedInterrupted', {
      parentId: 'P',
      settings: { enabledTools: [], runState: 'interrupted' }
    })
    insert('closedBusy', { parentId: 'P', settings: { enabledTools: [], runState: 'busy' } })
    insert('closedIdle', { parentId: 'P', settings: { enabledTools: [], runState: 'idle' } })
    insert('closed', { parentId: 'P' })
    fakeHost.put('busy', { busy: true })
    fakeHost.put('ask', { pendingInputCount: 1, pendingInputSummaries: ['bash: rm -rf x'] })
    fakeHost.put('askInterrupted', { pendingInputCount: 1, interrupted: true })
    fakeHost.put('interrupted', { interrupted: true, busy: false })
    fakeHost.put('openIdle')
    const listed = subSessionRunner.list('P')
    if ('error' in listed) throw new Error(listed.error)
    const byId = Object.fromEntries(listed.subSessions.map((s) => [s.id, s]))
    expect(byId.busy!.status).toBe('running')
    expect(byId.ask!.status).toBe('waiting-input')
    expect(byId.ask!.blockedOn).toEqual(['bash: rm -rf x'])
    expect(byId.askInterrupted!.status).toBe('waiting-input')
    expect(byId.interrupted!.status).toBe('interrupted')
    expect(byId.openIdle!.status).toBe('idle')
    expect(byId.closedInterrupted!.status).toBe('interrupted')
    expect(byId.closedBusy!.status).toBe('interrupted')
    expect(byId.closedIdle!.status).toBe('idle')
    expect(byId.closed!.status).toBe('idle')
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.callsOf('peek')).toEqual([])
  })
})

describe('D10-56 子会话发送被拒（模型被拒）', () => {
  it('D10-56 回 "NOT delivered" + 原因；子会话收到一条 error；没有任务留着在跑', async () => {
    insert('P')
    insert('c1', { parentId: 'P' })
    fakeHost.configure = (session) => {
      session.submitResults = [{ error: 'Provider "Faux" is disabled', code: 'no_model' }]
    }
    const outcome = await subSessionRunner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      background: false,
      timeoutSeconds: 5,
      requestId: 'subsession:P:56'
    })
    expect('error' in outcome).toBe(true)
    const text = (outcome as { error: string }).error
    expect(text).toContain('NOT delivered')
    expect(text).toContain('Provider "Faux" is disabled')
    expect(eventsOf('error').filter((e) => e.sessionId === 'c1')).toHaveLength(1)
    const listed = subSessionRunner.list('P')
    if ('error' in listed) throw new Error(listed.error)
    expect(listed.subSessions.every((s) => !s.driven)).toBe(true)
  })
})

describe('D10-57 stop', () => {
  it('D10-57 开着的子会话 → durable.abort；没开 → {stopped:false}，不打开', async () => {
    insert('P')
    insert('c1', { parentId: 'P' })
    insert('c2', { parentId: 'P' })
    const session = fakeHost.put('c1', { busy: true })
    expect(await subSessionRunner.stop('P', 'c1')).toEqual({ stopped: true, id: 'c1' })
    expect(session.callsOf('abort')).toHaveLength(1)
    expect(await subSessionRunner.stop('P', 'c2')).toEqual({ stopped: false, id: 'c2' })
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.callsOf('peek')).toEqual([])
  })

  it('D10-57 / P2-10-19b 没开着、镜像说被中断 → peek（不 open）再 abort，{stopped:true}', async () => {
    insert('P')
    insert('c3', { parentId: 'P', settings: { enabledTools: [], runState: 'interrupted' } })
    fakeHost.storages.add('c3')
    fakeHost.configure = (session) => (session.interrupted = true)
    expect(await subSessionRunner.stop('P', 'c3')).toEqual({ stopped: true, id: 'c3' })
    expect(fakeHost.callsOf('peek')).toEqual(['c3'])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.get('c3')!.callsOf('abort')).toHaveLength(1)
  })
})

describe('D10-58 新格式子会话的答复（P2-10-28）', () => {
  it("D10-58 / P2-10-28 前台 prompt 跑完 kind:'answered'，答复取自子会话的 lastAnswer", async () => {
    insert('P')
    insert('c1', { parentId: 'P' })
    fakeHost.configure = (session) => (session.answer = { text: 'DONE.' })
    const outcome = await subSessionRunner.prompt({
      parentId: 'P',
      childId: 'c1',
      message: 'go',
      background: false,
      timeoutSeconds: 5,
      requestId: 'subsession:P:58'
    })
    expect(outcome).toEqual({
      kind: 'answered',
      id: 'c1',
      answer: 'DONE.',
      info: expect.objectContaining({ id: 'c1', status: 'idle' })
    })
  })
})

// ─── G. messageService ─────────────────────────────────────────────────────

describe('D10-59 列表', () => {
  it('D10-59 / P3-07-01 新格式会话没有存储：[] / undefined，宿主只被窥视（从不 open）、不建文件', async () => {
    insert('s1')
    expect(await messageService.listBySession('s1')).toEqual([])
    expect(await messageService.findLastBySession('s1')).toBeUndefined()
    expect(fakeHost.calls).toEqual([
      ['peek', 's1'],
      ['peek', 's1']
    ])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(readdirSync(holder.sessionsDir)).toEqual([])
  })

  it('D10-59 新格式会话有存储：列表 = viewSnapshot().messages（peek 打开，不 open）', async () => {
    insert('s1')
    const durable = fakeHost.put('s1')
    const message = {
      id: '2',
      sessionId: 's1',
      role: 'user',
      type: 'text',
      content: 'hi',
      model: '',
      createdAt: 1,
      metadata: null
    } as const
    durable.view = { ...emptySessionView('s1'), source: 'durable', messages: [message] }
    expect(await messageService.listBySession('s1')).toEqual([message])
    expect(await messageService.findLastBySession('s1')).toEqual(message)
    expect(fakeHost.callsOf('peek')).toEqual(['s1', 's1'])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(durable.callsOf('viewSnapshot')).toHaveLength(2)
  })

  it('D10-59 旧格式会话：走读取器，宿主不参与', async () => {
    insert('old', { storageKind: 'harness-v3-jsonl' })
    expect(await messageService.listBySession('old')).toEqual([])
    expect(fakeHost.calls).toEqual([])
  })
})

describe('D10-61 回退 / 截断', () => {
  it('D10-61 旧格式 → undefined / false（新格式的一半见 P3-10b-01..03）', async () => {
    insert('old', { storageKind: 'harness-v3-jsonl' })
    expect(await messageService.resolveRollbackTarget('old', 'm')).toBeUndefined()
    expect(await messageService.rollbackToMessage('old', 'm')).toBe(false)
    expect(await messageService.truncateAfterMessage('old', 'm')).toBe(false)
  })

  it('P3-10a-23 旧格式会话的拒绝留在桌面守卫里：undefined / false；宿主从不打开、rollbackTo 从不调用', async () => {
    insert('old', { storageKind: 'harness-v3-jsonl' })
    // 即便宿主里恰好有一个同 id 的实例，守卫也不碰它
    const durable = fakeHost.put('old')
    const before = fakeHost.calls.length
    expect(await messageService.resolveRollbackTarget('old', '7')).toBeUndefined()
    expect(await messageService.rollbackToMessage('old', '7')).toBe(false)
    expect(await messageService.truncateAfterMessage('old', '7')).toBe(false)
    expect(fakeHost.calls.slice(before)).toEqual([])
    expect(durable.callsOf('rollbackTo')).toEqual([])
    expect(durable.calls).toEqual([])
  })
})

describe('P3-10b 回退 / 截断映射到 rollbackTo', () => {
  it('P3-10b-01 回退：rollbackTo(42) 恰一次、不带选项 → true；resolveRollbackTarget 给 {targetId:"42"} 且不调 rollbackTo', async () => {
    insert('s1')
    const durable = fakeHost.put('s1', { rollbackResult: { ok: true, conversationId: 7 } })
    expect(await messageService.resolveRollbackTarget('s1', '42')).toEqual({ targetId: '42' })
    expect(durable.callsOf('rollbackTo')).toEqual([])
    expect(await messageService.rollbackToMessage('s1', '42')).toBe(true)
    expect(durable.callsOf('rollbackTo')).toEqual([['rollbackTo', 42]])
  })

  it('P3-10b-02 截断：rollbackTo(42, {keep:true}) 恰一次 → true', async () => {
    insert('s1')
    const durable = fakeHost.put('s1', { rollbackResult: { ok: true, conversationId: 7 } })
    expect(await messageService.truncateAfterMessage('s1', '42')).toBe(true)
    expect(durable.callsOf('rollbackTo')).toEqual([['rollbackTo', 42, { keep: true }]])
  })

  it.each([['not_found' as const], ['invalid_target' as const]])(
    'P3-10b-03 运行时拒绝（%s）= 没有目标：回退 / 截断 / applyRollback 都是 false，不抛',
    async (reason) => {
      insert('s1')
      const durable = fakeHost.put('s1', { rollbackResult: { ok: false, reason } })
      expect(await messageService.rollbackToMessage('s1', '42')).toBe(false)
      expect(await messageService.truncateAfterMessage('s1', '42')).toBe(false)
      expect(await messageService.applyRollback('s1', '42')).toBe(false)
      expect(durable.callsOf('rollbackTo')).toEqual([
        ['rollbackTo', 42],
        ['rollbackTo', 42, { keep: true }],
        ['rollbackTo', 42]
      ])
    }
  )

  it('P3-10b-03 applyRollback(s, null)（「回退到最开头」不再产生）→ false，不碰宿主', async () => {
    insert('s1')
    const durable = fakeHost.put('s1')
    expect(await messageService.applyRollback('s1', null)).toBe(false)
    expect(fakeHost.calls).toEqual([])
    expect(durable.calls).toEqual([])
  })

  it.each([
    'no-such-message',
    '',
    '0',
    '-3',
    '1.5',
    '01',
    '1e3',
    ' 42',
    '9007199254740993',
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
  ])(
    'P3-10b-04 不规范的 id %j（PIN-01）→ undefined / false；宿主不 peek 不 open，rollbackTo 从不调用',
    async (id) => {
      insert('s1')
      const durable = fakeHost.put('s1')
      expect(await messageService.resolveRollbackTarget('s1', id)).toBeUndefined()
      expect(await messageService.rollbackToMessage('s1', id)).toBe(false)
      expect(await messageService.truncateAfterMessage('s1', id)).toBe(false)
      expect(await messageService.applyRollback('s1', id)).toBe(false)
      expect(fakeHost.calls).toEqual([])
      expect(durable.callsOf('rollbackTo')).toEqual([])
    }
  )

  it('P3-10b-04 安全整数的上沿（9007199254740991）仍是条目 id', async () => {
    insert('s1')
    const durable = fakeHost.put('s1', { rollbackResult: { ok: false, reason: 'not_found' } })
    expect(await messageService.resolveRollbackTarget('s1', '9007199254740991')).toEqual({
      targetId: '9007199254740991'
    })
    await messageService.rollbackToMessage('s1', '9007199254740991')
    expect(durable.callsOf('rollbackTo')).toEqual([['rollbackTo', Number.MAX_SAFE_INTEGER]])
  })

  it('P3-10b-05 没有存储：false，只 peek（从不 open）、不建文件、不抛', async () => {
    insert('s1')
    expect(await messageService.rollbackToMessage('s1', '42')).toBe(false)
    expect(await messageService.truncateAfterMessage('s1', '42')).toBe(false)
    expect(fakeHost.calls).toEqual([
      ['peek', 's1'],
      ['peek', 's1']
    ])
    expect(readdirSync(holder.sessionsDir)).toEqual([])
  })

  it('P3-10b-05 宿主已封存（closeAll 之后）：false，不建文件、不抛', async () => {
    insert('s1')
    fakeHost.put('s1')
    await fakeHost.closeAll()
    expect(await messageService.rollbackToMessage('s1', '42')).toBe(false)
    expect(await messageService.truncateAfterMessage('s1', '42')).toBe(false)
    expect(await chatGateway.rollbackMessage('s1', '42')).toBe(false)
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(readdirSync(holder.sessionsDir)).toEqual([])
  })

  /** 第一个句柄答 `closed`，并且（像 LRU / 退出那样）已经被宿主关掉了 */
  function closingFirstHandle(): FakeDurableSession {
    const first = fakeHost.put('s1', { rollbackResult: { ok: false, reason: 'closed' } })
    const rollbackTo = first.rollbackTo.bind(first)
    first.rollbackTo = async (...args) => {
      const result = await rollbackTo(...args)
      await fakeHost.close('s1')
      return result
    }
    return first
  }

  it('P3-10b-06 closed（PIN-04）：恰再窥视一次，在新句柄上再调一次 rollbackTo；结果是那一次的', async () => {
    insert('s1')
    const first = closingFirstHandle()
    fakeHost.configure = (session) => (session.rollbackResult = { ok: true, conversationId: 3 })
    expect(await messageService.rollbackToMessage('s1', '42')).toBe(true)
    expect(fakeHost.callsOf('peek')).toEqual(['s1', 's1'])
    const [, second] = fakeHost.instances.get('s1')!
    expect(first.callsOf('rollbackTo')).toEqual([['rollbackTo', 42]])
    expect(second.callsOf('rollbackTo')).toEqual([['rollbackTo', 42]])
    expect(fakeHost.callsOf('open')).toEqual([])
  })

  it('P3-10b-06 closed 之后新句柄被拒 → 那一次的结果（false）', async () => {
    insert('s1')
    closingFirstHandle()
    fakeHost.configure = (session) =>
      (session.rollbackResult = { ok: false, reason: 'invalid_target' })
    expect(await messageService.truncateAfterMessage('s1', '42')).toBe(false)
    const [, second] = fakeHost.instances.get('s1')!
    expect(second.callsOf('rollbackTo')).toEqual([['rollbackTo', 42, { keep: true }]])
  })

  it('P3-10b-06 两次都 closed → false，没有第三次', async () => {
    insert('s1')
    closingFirstHandle()
    fakeHost.configure = (session) => (session.rollbackResult = { ok: false, reason: 'closed' })
    expect(await messageService.rollbackToMessage('s1', '42')).toBe(false)
    expect(fakeHost.callsOf('peek')).toEqual(['s1', 's1'])
    const handles = fakeHost.instances.get('s1')!
    expect(handles).toHaveLength(2)
    expect(handles.flatMap((h) => h.callsOf('rollbackTo'))).toHaveLength(2)
  })

  it('P3-10b-07 旧格式不变（D10-61 的旧格式一半）：undefined / false，宿主不参与', async () => {
    insert('old', { storageKind: 'harness-v3-jsonl' })
    expect(await messageService.resolveRollbackTarget('old', '42')).toBeUndefined()
    expect(await messageService.rollbackToMessage('old', '42')).toBe(false)
    expect(await messageService.truncateAfterMessage('old', '42')).toBe(false)
    expect(await chatGateway.rollbackMessage('old', '42')).toBe(false)
    expect(fakeHost.calls).toEqual([])
    expect(mocks.clearFileTime).not.toHaveBeenCalled()
  })
})

// ─── H. closeAll 之后 ──────────────────────────────────────────────────────

describe('D10-64 closeAll 之后', () => {
  it('D10-64 ensureAgentSession → undefined；gateway.prompt → 报错；都不抛、不建文件', async () => {
    insert('s1')
    await fakeHost.closeAll()
    expect(await sessionService.ensureAgentSession('s1')).toBeUndefined()
    const result = await chatGateway.prompt('s1', 'late')
    expect(result.error).toBeTruthy()
    expect(readdirSync(holder.sessionsDir)).toEqual([])
  })
})

// 只为让类型检查看见：FakeDurableSession 在本文件里经 fakeHost 间接使用
void FakeDurableSession
