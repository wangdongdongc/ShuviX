/**
 * 桌面接线的 S 用例：真 SessionHost（单例经 `resetSessionHostForTests` 换上 faux 模型与空 ToolHost）+
 * 真 sessionService / 网关 / 门面 / messageService + 临时目录里的真 SQLite 会话存储。
 *
 *   D10-39(S) 网关 ensure + prompt → 恰一个 agent_created 到达前端注册表；destroyAgent → agent_closing 一对；
 *             锁镜像 true → false
 *   D10-41 删一条正忙的会话：限时落定、文件没了、在途的发送不挂；删行之后没有镜像写回
 *   D10-52 clearMessages（PIN-08）：正忙的 run 先关停；之后没有 agent、镜像 false / idle、界面收到
 *          agent_closing{false}；下一次发送从全新的存储开始
 *   D10-60 messageService.clear：等宿主 delete；旧格式会话的 .jsonl 经 deleteStorage 删掉，存储类型
 *          换成当前类型（PIN-22）
 *   D10-63 退出留下的标记：进程 1 正忙时 closeAll → runState 留 busy、agentLocked 留 true；进程 2 打开 →
 *          interrupted、锁对账为 true；空闲重开写 idle
 *   D10-65 中断发送策略的接线（两种策略各一遍）：进程 2 的 gateway.prompt
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InterruptedSendPolicy } from '@shuvix/agent-runtime'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: ''
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  getProfile: vi.fn<(name: string) => unknown>()
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
vi.mock('../models', () => ({
  getModelRegistry: () => {
    throw new Error('the model registry is not used in these tests')
  },
  providerCredentialPort: { listProviders: () => [] }
}))
vi.mock('../../agents/agentHost', () => ({
  createDesktopToolHost: () => ({
    buildBuiltinTools: () => [],
    resolveAgentTools: async () => ({ sandboxed: false }),
    rebuildAgentTools: () => ({})
  }),
  desktopPromptHost: {},
  desktopPromptVars: () => ({}),
  resolveProfileModelSpec: () => null
}))
// 运行时的事件经桌面的 electronEventSink 到前端注册表（这里直通假的注册表）
vi.mock('../agentRuntimeAdapters', () => ({
  electronEventSink: {
    broadcast: (event: Record<string, unknown>) => mocks.broadcast(event),
    hasUserInputCapability: () => true
  }
}))
vi.mock('../settingsService', () => ({ settingsService: { get: () => undefined } }))
vi.mock('../sessionDayPromptService', () => ({
  recordPromptAdmitted: vi.fn(),
  recordFromUserMessageEvent: vi.fn()
}))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: (tools: string[]) => tools }))
vi.mock('../mcpService', () => ({
  mcpService: { closeSession: async () => {}, getAllToolInfos: () => [] }
}))
vi.mock('../agentService', () => ({
  agentService: { getProfile: mocks.getProfile, isSessionProfile: () => true }
}))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: mocks.broadcast }
}))
vi.mock('../artifacts/store', () => ({ deleteSessionArtifacts: vi.fn() }))
vi.mock('../sandbox', () => ({ cleanupSession: vi.fn(), unpinSession: vi.fn() }))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: vi.fn() },
  hookService: { abortSessionRuns: vi.fn() }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: async () => null,
  isDefaultTitle: () => false
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({ clearSession: vi.fn() }))
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
import { getSessionHost, resetSessionHostForTests } from '../sessionHost'
import {
  answer,
  fauxKit,
  stalled,
  testDepsOverrides,
  transcript,
  waitFor,
  withTimeout,
  type FauxKit
} from './support/realHost'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let sessionService: (typeof import('../sessionService'))['sessionService']
let messageService: (typeof import('../messageService'))['messageService']
let chatGateway: (typeof import('../../frontend/core/DefaultChatGateway'))['chatGateway']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ messageService } = await import('../messageService'))
  ;({ chatGateway } = await import('../../frontend/core/DefaultChatGateway'))
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

const FAUX_SELECTION = { provider: 'faux', modelId: 'faux-1' }

function insert(id: string, patch: Partial<Session> = {}): string {
  sessionRecords.insert({
    id,
    title: id,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: { enabledTools: [], model: FAUX_SELECTION },
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...patch
  })
  return id
}

const settingsOf = (id: string): Record<string, unknown> =>
  (sessionRecords.findById(id)?.settings ?? {}) as Record<string, unknown>

const eventsOf = (type: string, sessionId = 's1'): Array<Record<string, unknown>> =>
  mocks.broadcast.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === type && event.sessionId === sessionId)

/** 换一个「进程」：关掉现在的宿主（若有），按新的 faux 套件与覆盖建一个新的单例 */
async function newProcess(extra: { policy?: InterruptedSendPolicy } = {}): Promise<FauxKit> {
  await withTimeout(getSessionHost().closeAll(), 15000, 'closeAll').catch(() => undefined)
  const kit = fauxKit()
  resetSessionHostForTests(
    testDepsOverrides(kit, extra.policy ? { interruptedSendPolicy: extra.policy } : {})
  )
  return kit
}

let kit: FauxKit

beforeEach(async () => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-host-int-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-host-int-tr-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  mocks.broadcast.mockClear()
  mocks.getProfile.mockImplementation((name) => profile(name))
  kit = fauxKit()
  resetSessionHostForTests(testDepsOverrides(kit))
})

afterEach(async () => {
  await withTimeout(getSessionHost().closeAll(), 15000, 'closeAll in afterEach').catch(
    () => undefined
  )
  resetSessionHostForTests()
  rmSync(holder.sessionsDir, { recursive: true, force: true })
  rmSync(holder.toolResults, { recursive: true, force: true })
})

describe('D10-39(S) agent 事件归运行时', () => {
  it('D10-39 发送 → 恰一个 agent_created；destroyAgent → agent_closing true / false；镜像 true → false', async () => {
    insert('s1')
    kit.queue(answer('a1'))
    expect(await chatGateway.prompt('s1', 'hi')).toEqual({})
    expect(eventsOf('agent_created')).toEqual([{ type: 'agent_created', sessionId: 's1' }])
    expect(settingsOf('s1').agentLocked).toBe(true)
    expect(sessionService.hasAgentRuntime('s1')).toBe(true)

    kit.queue(answer('a2'))
    expect(await chatGateway.prompt('s1', 'again')).toEqual({})
    expect(eventsOf('agent_created')).toHaveLength(1)

    await chatGateway.destroyAgent('s1')
    expect(eventsOf('agent_closing')).toEqual([
      { type: 'agent_closing', sessionId: 's1', closing: true },
      { type: 'agent_closing', sessionId: 's1', closing: false }
    ])
    expect(settingsOf('s1').agentLocked).toBe(false)
    expect(sessionService.hasAgentRuntime('s1')).toBe(false)
  })
})

describe('D10-41 删一条正忙的会话', () => {
  it('D10-41 限时落定、文件没了；在途的发送落定为 closed 或 {}；删行之后没有镜像写回', async () => {
    insert('s1')
    const stall = stalled()
    kit.queue(stall.step)
    const pending = chatGateway.prompt('s1', 'long job')
    await stall.reached
    await waitFor(() => settingsOf('s1').runState === 'busy', 3000, 'busy marker')

    await withTimeout(sessionService.delete('s1'), 10000, 'delete')
    expect(readdirSync(holder.sessionsDir)).toEqual([])
    const result = await withTimeout(pending, 5000, 'pending prompt')
    expect(result.error === undefined || result.code === 'closed').toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sessionRecords.findById('s1')).toBeUndefined()
    expect(
      (holder.db as DatabaseSync).prepare('SELECT id FROM sessions WHERE id = ?').get('s1')
    ).toBeUndefined()
  })
})

describe('D10-52 clearMessages（PIN-08）', () => {
  it('D10-52 正忙的 run 先关停；之后没有 agent、镜像 false / idle、界面收到 agent_closing{false}；下一次发送是全新的存储', async () => {
    insert('s1')
    const stall = stalled()
    kit.queue(stall.step)
    const pending = chatGateway.prompt('s1', 'first')
    await stall.reached
    expect(settingsOf('s1').agentLocked).toBe(true)

    await withTimeout(chatGateway.clearMessages('s1'), 10000, 'clearMessages')
    await withTimeout(pending, 5000, 'pending prompt')
    expect(sessionService.hasAgentRuntime('s1')).toBe(false)
    expect(settingsOf('s1').agentLocked).toBe(false)
    expect(settingsOf('s1').runState).toBe('idle')
    expect(eventsOf('agent_closing').at(-1)).toEqual({
      type: 'agent_closing',
      sessionId: 's1',
      closing: false
    })

    kit.queue(answer('fresh'))
    expect(await chatGateway.prompt('s1', 'second')).toEqual({})
    const session = getSessionHost().get('s1')!
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:second',
      'pi.assistant:fresh'
    ])
  })
})

describe('D10-60 messageService.clear', () => {
  it('D10-60 等宿主 delete（存储文件没了）', async () => {
    insert('s1')
    kit.queue(answer('a'))
    await chatGateway.prompt('s1', 'hi')
    expect(existsSync(join(holder.sessionsDir, 's1.sqlite'))).toBe(true)
    await messageService.clear('s1')
    expect(getSessionHost().get('s1')).toBeUndefined()
    expect(readdirSync(holder.sessionsDir).filter((n) => n.startsWith('s1'))).toEqual([])
  })

  it('D10-60 旧格式会话：.jsonl 经 deleteStorage 删掉，存储类型换成当前类型；之后能当新格式会话用（PIN-22）', async () => {
    insert('old', { storageKind: 'harness-v3-jsonl' })
    writeFileSync(join(holder.sessionsDir, 'old.jsonl'), '{"type":"session","version":3}\n')
    await messageService.clear('old')
    expect(existsSync(join(holder.sessionsDir, 'old.jsonl'))).toBe(false)
    expect(sessionRecords.pick('old', ['storageKind'])?.storageKind).toBe('durable-sqlite-1')

    kit.queue(answer('hello again'))
    expect(await chatGateway.prompt('old', 'hi')).toEqual({})
    expect(existsSync(join(holder.sessionsDir, 'old.sqlite'))).toBe(true)
  })
})

describe('D10-63 退出留下的标记', () => {
  it('D10-63 进程 1 正忙时 closeAll：busy / locked 都留着；进程 2 打开 → interrupted、锁对账为 true', async () => {
    insert('s1')
    const stall = stalled()
    kit.queue(stall.step)
    void chatGateway.prompt('s1', 'long job')
    await stall.reached
    await waitFor(() => settingsOf('s1').runState === 'busy', 3000, 'busy marker')

    await newProcess()
    expect(settingsOf('s1').runState).toBe('busy')
    expect(settingsOf('s1').agentLocked).toBe(true)

    // 进程 2 里把镜像弄脏，看打开时的对账
    sessionRecords.updateSettings('s1', { agentLocked: false })
    await sessionService.ensureAgentSession('s1')
    expect(settingsOf('s1').runState).toBe('interrupted')
    expect(settingsOf('s1').agentLocked).toBe(true)
  })

  it('D10-63 空闲重开写 idle（治好崩溃留下的 busy）', async () => {
    insert('s1')
    kit.queue(answer('a'))
    await chatGateway.prompt('s1', 'hi')
    await newProcess()
    sessionRecords.updateSettings('s1', { runState: 'busy' })
    await sessionService.ensureAgentSession('s1')
    expect(settingsOf('s1').runState).toBe('idle')
  })
})

describe.each(['abort-then-send', 'continue-then-queue'] as const)(
  'D10-65 中断发送策略的接线：%s',
  (policy) => {
    it(`D10-65 ${policy}：进程 2 的 gateway.prompt`, async () => {
      insert('s1')
      resetSessionHostForTests(testDepsOverrides(kit, { interruptedSendPolicy: policy }))
      const stall = stalled()
      kit.queue(stall.step)
      void chatGateway.prompt('s1', 'hello')
      await stall.reached

      const kit2 = await newProcess({ policy })
      if (policy === 'abort-then-send') {
        kit2.queue(answer('new answer'))
        expect(await withTimeout(chatGateway.prompt('s1', 'new'), 10000, 'prompt')).toEqual({})
        expect(kit2.requests).toHaveLength(1)
        const messages = kit2.requests[0]!.messages.filter((m) => m.role === 'user')
        const last = messages.at(-1)!
        expect(typeof last.content === 'string' ? last.content : last.content[0]).toEqual(
          typeof last.content === 'string' ? 'new' : { type: 'text', text: 'new' }
        )
      } else {
        kit2.queue(answer('old answer'), answer('new answer'))
        expect(await withTimeout(chatGateway.prompt('s1', 'new'), 10000, 'prompt')).toEqual({})
        const session = getSessionHost().get('s1')!
        expect(await transcript(await session.currentConversation())).toEqual([
          'pi.user:hello',
          'pi.assistant:old answer',
          'pi.user:new',
          'pi.assistant:new answer'
        ])
      }
      await waitFor(() => settingsOf('s1').runState === 'idle', 3000, 'idle marker')
    })
  }
)
