/**
 * P3-07 · 投影支撑的读取（S：真 SessionHost —— 单例经 `resetSessionHostForTests` 换上 faux 模型 —— + 真
 * sessionService / 网关 / 门面 / messageService / sessionDayPromptService（真 DAO）/ artifact 工具 + 临时目录里
 * 的真 SQLite 会话存储与 artifacts 目录）。
 *
 *   02 基本一致：messageService.listBySession = freshMount 的 messages；id 是 String(entryId)；D1 的内容与
 *      inlineTokens、payload 不出现；通知 isSystemNotice；工具块已回填
 *   07 读你所写：gateway.prompt 落定之后立刻 list —— 有投影挂着 / 没有都含最终回答、= freshMount
 *   09 关掉的会话：host.close 之后 list → peek 重开、与关之前相同；从不 open、什么都不续跑
 *   10 宿主封存之后 list 是 [] 且不抛；内存会话从内存给出投影、盘上没有文件
 *   11 旧格式照旧：恰好是 readLegacyTranscript(id).messages、宿主从不参与；没有行 → []；不认识的存储
 *      类型 → [] 且不建文件
 *   12 findLastBySession = 列表的最后一个（回答 / error_event / 通知，谁在最后就是谁）；空列表 → undefined
 *   13 网关 listMessages 与门面 listChatMessages 都 = listBySession
 *   14 artifact list / adopt：列出 svg 图、adopt 落盘并 recordRead、再 list 不再列它
 *   15 同一轮里的图（工具运行前 assistant 条目已落）；fork 指针把图那条消息排除之后 list 说 none
 *   16 空闲 prompt：恰一行 session_day_prompts，entryId = String(user 条目 id) = 列表里那条 user 的 id；
 *      day = localDayKey(now)、touchActive 一次；firstEntryOnDay 交回它；注入 today（日期通知在前）也一样
 *   17 被拒（忙）的发送不入账；内联 Token 的发送记的是 `pi.user` 条目 id
 *   19 忙时 steer 在放下时按放下的条目入账；空闲 followUp 在受理时入账
 *   20 隐藏项目的会话照记，但不出现在 sessionsOnDay
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DurableSession, SessionHostDeps } from '@shuvix/agent-runtime'
import type { ConversationId, EntryId, ToolRegistration } from '@earendil-works/pi-durable'
import { fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: '',
  artifacts: ''
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  getProfile: vi.fn<(name: string) => unknown>(),
  recordRead: vi.fn<(sessionId: string, path: string) => void>()
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
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => holder.sessionsDir,
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => holder.toolResults,
  getSessionArtifactsDir: (sid: string) => `${holder.artifacts}/${sid}`,
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
vi.mock('../agentRuntimeAdapters', () => ({
  electronEventSink: {
    broadcast: (event: Record<string, unknown>) => mocks.broadcast(event),
    hasUserInputCapability: () => true
  }
}))
vi.mock('../settingsService', () => ({ settingsService: { get: () => undefined } }))
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
vi.mock('../sandbox', () => ({ cleanupSession: vi.fn() }))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: vi.fn() },
  hookService: { abortSessionRuns: vi.fn() }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: async () => null,
  isDefaultTitle: () => false
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({
  clearSession: vi.fn(),
  recordRead: mocks.recordRead
}))
vi.mock('../../tools/allTools', () => ({}))
vi.mock('../toolRegistry', () => ({
  getBuiltinToolEntries: () => [],
  getPlatformBuiltinToolEntries: () => [],
  registerBuiltinTool: vi.fn()
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

import { executeTool } from '@shuvix/agent-runtime/tools/testing/invokeTool'
import { KNOWLEDGE_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import { migrations } from '../../dao/migrations'
import { localDayKey } from '../../dao/sessionDayPromptDao'
import type { Session } from '../../dao/types'
import type { ToolContext } from '../toolContext'
import { sessionRecords } from '../sessionRecords'
import { clearMemoryStoragesForTests, readLegacyTranscript } from '../sessionStorage'
import { getSessionHost, resetSessionHostForTests } from '../sessionHost'
import { SessionStateDoc } from '@shuvix/agent-runtime'
import { backgroundContext as BG } from '@shuvix/agent-runtime'
import {
  answer,
  callTool,
  fauxKit,
  held,
  stalled,
  testDepsOverrides,
  toolsToolHost,
  waitFor,
  withTimeout,
  type FauxKit
} from './support/realHost'
import { assistant, legacyJsonl, notice, user } from './support/transcriptTwins'
import {
  freshMount,
  readTool
} from '../../../../../../packages/agent-runtime/src/durable/projection/__tests__/projectorSupport'
import { allEntries } from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/transcript'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let sessionService: (typeof import('../sessionService'))['sessionService']
let messageService: (typeof import('../messageService'))['messageService']
let chatGateway: (typeof import('../../frontend/core/DefaultChatGateway'))['chatGateway']
let dayPrompts: typeof import('../sessionDayPromptService')
let ArtifactTool: (typeof import('../../tools/artifact'))['ArtifactTool']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ messageService } = await import('../messageService'))
  ;({ chatGateway } = await import('../../frontend/core/DefaultChatGateway'))
  dayPrompts = await import('../sessionDayPromptService')
  // eslint-disable-next-line boundaries/dependencies -- S 用例有意让真的 artifact 工具读真的 messageService（产品里是工具引用服务，这里只是从服务的用例里把它构造出来）
  ;({ ArtifactTool } = await import('../../tools/artifact'))
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
const TIMEOUT = 25000

function insert(id: string, patch: Partial<Session> = {}, ephemeral = false): string {
  sessionRecords.insert(
    {
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
    },
    ephemeral ? { ephemeral: true } : undefined
  )
  return id
}

type DayRow = { sessionId: string; entryId: string; day: string; timestamp: number }
const dayRows = (sessionId: string): DayRow[] =>
  (holder.db as DatabaseSync)
    .prepare(
      'SELECT sessionId, entryId, day, timestamp FROM session_day_prompts WHERE sessionId = ?'
    )
    .all(sessionId) as DayRow[]

/** 每个会话都带上这些工具（artifact 工具按会话 id 现造） */
function toolHostWith(
  extra: (sessionId: string) => ToolRegistration[] = () => []
): ReturnType<typeof toolsToolHost> {
  return toolsToolHost((sessionId) => [
    new ArtifactTool({ sessionId } as ToolContext),
    readTool(),
    ...extra(sessionId)
  ])
}

/** 换一个宿主（关掉现在的，按新的 faux 套件与覆盖建新的单例） */
async function newHost(extra: Partial<SessionHostDeps> = {}): Promise<FauxKit> {
  await withTimeout(getSessionHost().closeAll(), 15000, 'closeAll').catch(() => undefined)
  const next = fauxKit()
  resetSessionHostForTests(testDepsOverrides(next, { toolHost: toolHostWith(), ...extra }))
  return next
}

const openSession = (id: string): DurableSession => {
  const session = getSessionHost().get(id)
  if (session === undefined) throw new Error(`session ${id} is not open`)
  return session
}

const textOf = (result: { content: unknown[] }): string =>
  (result.content[0] as { text: string }).text

const svgFigure = (title: string): string =>
  [
    `Here is ${title}:`,
    '',
    '```svg',
    `<svg viewBox="0 0 10 10" role="img" aria-label="${title}">`,
    '<rect width="10" height="10"/>',
    '</svg>',
    '```'
  ].join('\n')

let kit: FauxKit

beforeEach(async () => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-p307-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-p307-tr-'))
  holder.artifacts = mkdtempSync(join(tmpdir(), 'shuvix-p307-art-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  mocks.broadcast.mockClear()
  mocks.recordRead.mockClear()
  mocks.getProfile.mockImplementation((name) => profile(name))
  kit = fauxKit()
  resetSessionHostForTests(testDepsOverrides(kit, { toolHost: toolHostWith() }))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await withTimeout(getSessionHost().closeAll(), 15000, 'closeAll in afterEach').catch(
    () => undefined
  )
  resetSessionHostForTests()
  rmSync(holder.sessionsDir, { recursive: true, force: true })
  rmSync(holder.toolResults, { recursive: true, force: true })
  rmSync(holder.artifacts, { recursive: true, force: true })
})

const K1: Record<string, InlineToken> = {
  k1: { type: 'cmd', id: 'deploy', displayText: '/deploy', payload: 'PAYLOAD-K1' }
}
const D1_TEXT = 'run {{shuvixInlineToken:k1}} please'

// ─────────────────────────── 列表 ───────────────────────────

describe('P3-07 list parity (S)', () => {
  it(
    'P3-07-02 basic parity: list = freshMount messages; ids String(entryId); D1 content and tokens, no payload; notice and tool block',
    async () => {
      insert('s1')
      kit.queue(answer('A1'))
      expect(await chatGateway.prompt('s1', D1_TEXT, undefined, K1)).toEqual({})
      kit.queue(callTool('read', { path: 'x' }, 'c1'), answer('A2'))
      expect(await chatGateway.prompt('s1', 'read it')).toEqual({})
      const session = openSession('s1')
      expect(
        (await session.writeNotice({ text: 'a notice', kind: 'background', requestId: 'n1' }))
          .status
      ).toBe('submitted')

      const listed = await messageService.listBySession('s1')
      expect(listed).toStrictEqual((await freshMount(session)).messages)
      const ids = new Set((await allEntries(await session.currentConversation())).map((e) => e.id))
      for (const message of listed) expect(ids.has(Number(message.id) as EntryId)).toBe(true)
      expect(listed[0]!.content).toBe(D1_TEXT)
      expect(listed[0]!.metadata).toStrictEqual({ inlineTokens: K1 })
      // payload 只在 metadata.inlineTokens 里（P3-03 起的约定），从不进任何 content
      for (const message of listed) expect(message.content).not.toContain('PAYLOAD-K1')
      expect(listed.at(-1)!.metadata).toStrictEqual({ isSystemNotice: true })
      const tool = listed
        .flatMap((m) => (m.role === 'assistant' && m.type === 'message' ? m.blocks : []))
        .find((b) => b.type === 'tool')
      expect(tool).toMatchObject({ toolCallId: 'c1', result: 'read x' })
    },
    TIMEOUT
  )

  it(
    'P3-07-07 read-your-writes: right after gateway.prompt resolves the list has the final answer and = freshMount, with and without a mounted projector',
    async () => {
      insert('s1')
      insert('s2')
      kit.queue(answer('warm'))
      expect(await chatGateway.prompt('s1', 'warm up')).toEqual({})
      const proj = await openSession('s1').projector()
      const h = proj.acquire()
      kit.queue(answer('FINAL-1'))
      expect(await chatGateway.prompt('s1', 'x')).toEqual({})
      const mounted = await messageService.listBySession('s1')
      expect(mounted.at(-1)!.content).toBe('FINAL-1')
      expect(mounted).toStrictEqual((await freshMount(openSession('s1'))).messages)
      h.release()

      kit.queue(answer('FINAL-2'))
      expect(await chatGateway.prompt('s2', 'y')).toEqual({})
      const bare = await messageService.listBySession('s2')
      expect(bare.at(-1)!.content).toBe('FINAL-2')
      expect(bare).toStrictEqual((await freshMount(openSession('s2'))).messages)
    },
    TIMEOUT
  )

  it(
    'P3-07-09 closed session with storage: peek reopens it, the list equals the one before the close; open is never called, nothing resumes',
    async () => {
      insert('s1')
      kit.queue(answer('A1'))
      expect(await chatGateway.prompt('s1', 'U1')).toEqual({})
      const before = await messageService.listBySession('s1')
      await getSessionHost().close('s1')
      expect(getSessionHost().get('s1')).toBeUndefined()
      const host = getSessionHost()
      const open = vi.spyOn(host, 'open')
      const peek = vi.spyOn(host, 'peek')
      expect(await messageService.listBySession('s1')).toStrictEqual(before)
      expect(open).not.toHaveBeenCalled()
      expect(peek).toHaveBeenCalledWith('s1')
      const reopened = openSession('s1')
      expect(reopened.runState).toBe('idle')
      expect(reopened.isBusy()).toBe(false)
      expect(kit.requests).toHaveLength(1)
    },
    TIMEOUT
  )

  it(
    'P3-07-10 after closeAll the list is [] and does not throw; an ephemeral session lists from memory, with no file on disk',
    async () => {
      insert('mem', {}, true)
      kit.queue(answer('in memory'))
      expect(await chatGateway.prompt('mem', 'hi')).toEqual({})
      expect((await messageService.listBySession('mem')).map((m) => m.content)).toEqual([
        'hi',
        'in memory'
      ])
      expect(readdirSync(holder.sessionsDir)).toEqual([])

      insert('s1')
      kit.queue(answer('A1'))
      expect(await chatGateway.prompt('s1', 'U1')).toEqual({})
      await getSessionHost().closeAll()
      expect(await messageService.listBySession('s1')).toEqual([])
      expect(await messageService.findLastBySession('s1')).toBeUndefined()
    },
    TIMEOUT
  )

  it('P3-07-11 legacy unchanged: exactly readLegacyTranscript(id).messages, never the host; a missing row → []; an unknown kind → [] and no file', async () => {
    insert('old', { storageKind: 'harness-v3-jsonl' })
    writeFileSync(
      join(holder.sessionsDir, 'old.jsonl'),
      legacyJsonl('old', [user(1000, 'hello'), assistant(2000, 'hi there'), notice(3000, 'bg')])
    )
    const host = getSessionHost()
    const peek = vi.spyOn(host, 'peek')
    const open = vi.spyOn(host, 'open')
    const listed = await messageService.listBySession('old')
    expect(listed.length).toBeGreaterThan(0)
    expect(listed).toStrictEqual(readLegacyTranscript('old')!.messages)
    expect(await messageService.findLastBySession('old')).toStrictEqual(listed.at(-1))

    expect(await messageService.listBySession('ghost')).toEqual([])

    insert('future', { storageKind: 'durable-sqlite-99' as Session['storageKind'] })
    expect(await messageService.listBySession('future')).toEqual([])
    expect(open).not.toHaveBeenCalled()
    expect(peek.mock.calls.map(([id]) => id)).toEqual(['future'])
    expect(readdirSync(holder.sessionsDir)).toEqual(['old.jsonl'])
  })

  it(
    'P3-07-12 findLastBySession = the last element of the list (answer, error_event or notice, whichever is last); an empty list → undefined',
    async () => {
      insert('s1')
      expect(await messageService.findLastBySession('s1')).toBeUndefined()
      kit.queue(answer('A1'))
      expect(await chatGateway.prompt('s1', 'U1')).toEqual({})
      let listed = await messageService.listBySession('s1')
      expect(await messageService.findLastBySession('s1')).toStrictEqual(listed.at(-1))
      expect(listed.at(-1)!.content).toBe('A1')

      kit.queue({ ...answer(''), stopReason: 'error', errorMessage: 'kaput', content: [] })
      expect((await chatGateway.prompt('s1', 'U2')).code).toBe('model_error')
      listed = await messageService.listBySession('s1')
      expect(listed.at(-1)!.type).toBe('error_event')
      expect(await messageService.findLastBySession('s1')).toStrictEqual(listed.at(-1))

      await openSession('s1').writeNotice({ text: 'later', kind: 'background', requestId: 'n' })
      listed = await messageService.listBySession('s1')
      expect(listed.at(-1)!.metadata).toStrictEqual({ isSystemNotice: true })
      expect(await messageService.findLastBySession('s1')).toStrictEqual(listed.at(-1))
    },
    TIMEOUT
  )

  it(
    'P3-07-13 gateway listMessages and AgentSession.listChatMessages both equal listBySession',
    async () => {
      insert('s1')
      kit.queue(answer('A1'))
      expect(await chatGateway.prompt('s1', 'U1')).toEqual({})
      const listed = await messageService.listBySession('s1')
      expect(listed.map((m) => m.content)).toEqual(['U1', 'A1'])
      expect(await chatGateway.listMessages('s1')).toStrictEqual(listed)
      expect(await sessionService.getAgentSession('s1')!.listChatMessages()).toStrictEqual(listed)
    },
    TIMEOUT
  )
})

// ─────────────────────────── artifact ───────────────────────────

describe('P3-07 artifact reads (S)', () => {
  it(
    'P3-07-14 list and adopt: the svg figure is offered, adopt writes it and records the read, a second list no longer offers it',
    async () => {
      insert('s1')
      kit.queue(answer(svgFigure('T')))
      expect(await chatGateway.prompt('s1', 'draw T')).toEqual({})
      const tool = new ArtifactTool({ sessionId: 's1' } as ToolContext)
      const first = textOf(await executeTool(tool, 'c-list', { action: 'list' } as never))
      expect(first).toContain('Figures in the transcript not yet adopted (1)')
      expect(first).toContain('[1] T')

      const adopted = await executeTool(tool, 'c-adopt', { action: 'adopt', ref: '1' } as never)
      expect(textOf(adopted)).toContain('Adopted "T" as t.svg.')
      const path = join(holder.artifacts, 's1', 't.svg')
      expect(existsSync(path)).toBe(true)
      expect(mocks.recordRead).toHaveBeenCalledWith('s1', path)

      const second = textOf(await executeTool(tool, 'c-list', { action: 'list' } as never))
      expect(second).toContain('Figures in the transcript not yet adopted: none.')
      expect(second).toContain('t.svg')
    },
    TIMEOUT
  )

  it(
    'P3-07-15 a figure in the same turn is listed by the tool (the assistant entry is committed first); after a fork pointer that excludes it, list says none',
    async () => {
      insert('s1')
      kit.queue(
        {
          ...answer(''),
          content: [
            fauxText(svgFigure('Same Turn')),
            fauxToolCall('artifact', { action: 'list' }, { id: 'c-art' })
          ],
          stopReason: 'toolUse'
        },
        answer('done')
      )
      expect(await chatGateway.prompt('s1', 'draw and list')).toEqual({})
      const listed = await messageService.listBySession('s1')
      const block = listed
        .flatMap((m) => (m.role === 'assistant' && m.type === 'message' ? m.blocks : []))
        .find((b) => b.type === 'tool' && b.toolCallId === 'c-art')
      expect(block).toBeDefined()
      expect(String((block as { result?: unknown }).result)).toContain(
        'Figures in the transcript not yet adopted (1)'
      )
      expect(String((block as { result?: unknown }).result)).toContain('[1] Same Turn')

      // fork 在 user 条目上：图所在的 assistant 条目不在新指针的视图里
      const session = openSession('s1')
      const [u1] = await allEntries(await session.currentConversation())
      await session.harness.commit(async (tx) => {
        const fork = await tx.forkConversation(1 as ConversationId, u1!.id, {
          ownership: { kind: 'ownerless' }
        })
        ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
      }, BG)
      expect((await messageService.listBySession('s1')).map((m) => m.content)).toEqual([
        'draw and list'
      ])
      const tool = new ArtifactTool({ sessionId: 's1' } as ToolContext)
      expect(textOf(await executeTool(tool, 'c-list', { action: 'list' } as never))).toContain(
        'Figures in the transcript not yet adopted: none.'
      )
    },
    TIMEOUT
  )
})

// ─────────────────────────── 日历 ───────────────────────────

describe('P3-07 day prompts by entry id (S)', () => {
  it(
    'P3-07-16 idle prompt: one row, entryId = String(user entry id) = the listed user id; today; touchActive once; firstEntryOnDay returns it',
    async () => {
      insert('s1')
      const touch = vi.spyOn(sessionRecords, 'touchActive')
      kit.queue(answer('A1'))
      expect(await chatGateway.prompt('s1', 'hi')).toEqual({})
      const userEntry = (await allEntries(await openSession('s1').currentConversation())).find(
        (e) => e.kind === 'pi.user'
      )!
      const listedUser = (await messageService.listBySession('s1')).find((m) => m.role === 'user')!
      const rows = dayRows('s1')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.entryId).toBe(String(userEntry.id))
      expect(rows[0]!.entryId).toBe(listedUser.id)
      expect(rows[0]!.day).toBe(localDayKey(Date.now()))
      expect(touch.mock.calls.filter(([id]) => id === 's1')).toHaveLength(1)
      expect(dayPrompts.firstEntryOnDay('s1', rows[0]!.day)).toBe(listedUser.id)
    },
    TIMEOUT
  )

  it(
    'P3-07-16 with today injected (a date notice precedes the user entry) the row is the user entry, never the notice',
    async () => {
      let today = '2026-10-04'
      kit = await newHost({ today: () => today })
      insert('s1')
      kit.queue(answer('A1'))
      expect(await chatGateway.prompt('s1', 'first day')).toEqual({})
      today = '2026-10-05'
      kit.queue(answer('A2'))
      expect(await chatGateway.prompt('s1', 'next day')).toEqual({})
      const listed = await messageService.listBySession('s1')
      const dateNotice = listed.find(
        (m) => (m.metadata as { isSystemNotice?: boolean } | null)?.isSystemNotice === true
      )!
      const second = listed.find((m) => m.role === 'user' && m.content === 'next day')!
      expect(listed.indexOf(dateNotice)).toBe(listed.indexOf(second) - 1)
      const first = listed.find((m) => m.role === 'user' && m.content === 'first day')!
      const rows = dayRows('s1')
      expect(rows.map((r) => r.entryId)).toEqual([first.id, second.id])
      expect(rows.map((r) => r.entryId)).not.toContain(dateNotice.id)
      expect(dayPrompts.firstEntryOnDay('s1', rows[0]!.day)).toBe(first.id)
    },
    TIMEOUT
  )

  it(
    'P3-07-17 a busy refusal leaves no row; an inline-token send records the pi.user entry id',
    async () => {
      insert('s1')
      const stall = stalled()
      kit.queue(stall.step)
      const pending = chatGateway.prompt('s1', D1_TEXT, undefined, K1)
      await stall.reached
      const userEntry = (await allEntries(await openSession('s1').currentConversation())).find(
        (e) => e.kind === 'pi.user'
      )!
      expect((await chatGateway.prompt('s1', 'second')).code).toBe('busy')
      expect(dayRows('s1').map((r) => r.entryId)).toEqual([String(userEntry.id)])
      const listedUser = (await messageService.listBySession('s1')).find((m) => m.role === 'user')!
      expect(listedUser.id).toBe(String(userEntry.id))
      expect(listedUser.metadata).toStrictEqual({ inlineTokens: K1 })
      await sessionService.getAgentSession('s1')!.abort()
      await withTimeout(pending, 5000, 'aborted prompt')
      expect(dayRows('s1')).toHaveLength(1)
    },
    TIMEOUT
  )

  it(
    'P3-07-19 a steer while busy is recorded at placement with the placed id; an idle followUp at admission',
    async () => {
      insert('s1')
      const first = held(callTool('read', { path: 'a' }, 'c1'))
      kit.queue(first.step, answer('after steer'))
      const pending = chatGateway.prompt('s1', 'start')
      await first.reached
      const facade = sessionService.getAgentSession('s1')!
      await facade.steer('mid-run')
      // 排着队：还没有条目，所以还没有行
      expect(dayRows('s1')).toHaveLength(1)
      first.release()
      expect(await withTimeout(pending, 8000, 'run with steer')).toEqual({})
      await waitFor(() => dayRows('s1').length === 2, 3000, 'steer row')
      const listed = await messageService.listBySession('s1')
      const steered = listed.find((m) => m.role === 'user' && m.content === 'mid-run')!
      expect(dayRows('s1').map((r) => r.entryId)).toContain(steered.id)

      kit.queue(answer('followed'))
      await facade.followUp('next one')
      const followed = (await messageService.listBySession('s1')).find(
        (m) => m.role === 'user' && m.content === 'next one'
      )!
      expect(dayRows('s1').map((r) => r.entryId)).toContain(followed.id)
      expect(dayRows('s1')).toHaveLength(3)
      await waitFor(() => openSession('s1').runState === 'idle', 5000, 'idle')
    },
    TIMEOUT
  )

  it(
    'P3-07-20 a hidden-project session is recorded but filtered out of sessionsOnDay',
    async () => {
      insert('hidden', { projectId: KNOWLEDGE_PROJECT_ID })
      insert('visible')
      kit.queue(answer('h'), answer('v'))
      expect(await chatGateway.prompt('hidden', 'in a hidden project')).toEqual({})
      expect(await chatGateway.prompt('visible', 'in the open')).toEqual({})
      expect(dayRows('hidden')).toHaveLength(1)
      expect(dayRows('visible')).toHaveLength(1)
      const day = dayRows('hidden')[0]!.day
      expect(dayPrompts.sessionsOnDay(day).map((s) => s.id)).toEqual(['visible'])
    },
    TIMEOUT
  )
})
