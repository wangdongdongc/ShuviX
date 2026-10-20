/**
 * 会话 fork 的真宿主集成（S：真 SessionHost —— 单例经 `resetSessionHostForTests` 换上 faux 模型 —— + 真
 * sessionService / 网关 / messageService / sessionStorage 的拷贝（`VACUUM INTO`）/ artifacts 拷贝 / 日历索引
 * （真 DAO）+ 临时目录里的真 SQLite 会话存储）。mock 面照 rollbackIntegration.test.ts。
 *
 *   SI-1 锁着的源会话 U1 A1 U2 A2 → 整段 fork：消息列表与 id 一样；源会话的行不变；fork 没上锁（init 的
 *        created:false、hasAgentRuntime false）、改扩展能力被接受；源会话照旧锁着
 *   SI-2 从一张「工具调用 + 结果 + 最终回答」的卡分支：fork 的视图 = U1 + 那张卡；在 fork 上发送带的是那段前缀 +
 *        新消息；之后两边各走各的。从卡中间那条工具调用分支：紧跟着的工具结果一起带上
 *   SI-3 artifacts 拷给 fork、fork 读得到；删 fork 只删它自己的目录；源会话没有 artifacts 也照样 fork
 *   SI-4 不拷的：工具大结果目录、日历行（fork 只有自己建成的那一行）、子会话
 *   SI-5 删掉源会话，fork 完好（列表、存储文件、还能发送）
 *   SI-6 两次并发 fork → 两条不同的、各自能用的 fork
 *   SI-7 临时会话（不属于项目）整段 fork：fork 解析出的工作目录（getById / 运行时的 cwd）就是源会话的临时
 *        工作区；删掉源会话 → fork 照样能发送、文件夹与里面的文件都在；再删 fork → 文件夹没了
 *   SI-8 新建的会话与 fork 当天就在日历上（真 SQL）：谁也还没在它们上面发过消息，没有可跳的第一条
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DurableSession } from '@shuvix/agent-runtime'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: '',
  artifacts: '',
  /** electron 的 userData：真的 utils/paths 把临时工作区放在 <userData>/temp_workspace/ 下 */
  userData: ''
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  getProfile: vi.fn<(name: string) => unknown>(),
  listChanged: vi.fn<() => void>()
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
// 临时工作区那几个用真的（userData 指到临时目录）：SI-7 断的是真盘上的共用文件夹
vi.mock('electron', () => ({
  app: {
    getPath: () => holder.userData,
    getAppPath: () => holder.userData,
    isPackaged: false
  }
}))
vi.mock('../../utils/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/paths')>()),
  getSessionsDir: () => holder.sessionsDir,
  getToolResultsBase: () => holder.toolResults,
  getSessionArtifactsDir: (sid: string) => join(holder.artifacts, sid)
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
  broadcastSessionListChanged: mocks.listChanged,
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
vi.mock('../../utils/toolUtils/fileTime', () => ({ clearSession: vi.fn(), recordRead: vi.fn() }))
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
    vars?.title !== undefined ? `${vars.title} · fork` : key
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { migrations } from '../../dao/migrations'
import type { Session } from '../../dao/types'
import { sessionRecords } from '../sessionRecords'
import { clearMemoryStoragesForTests, durableStoragePath } from '../sessionStorage'
import { getSessionHost, resetSessionHostForTests } from '../sessionHost'
import { listArtifacts, readArtifact } from '../artifacts/store'
import { getTempWorkspaceBase } from '../../utils/paths'
import { localDayKey } from '../../dao/sessionDayPromptDao'
import * as calendar from '../sessionDayPromptService'
import {
  answer,
  callTool,
  fauxKit,
  requestTexts,
  testDepsOverrides,
  toolsToolHost,
  withTimeout,
  type FauxKit
} from './support/realHost'
import { readTool } from '../../../../../../packages/agent-runtime/src/durable/projection/__tests__/projectorSupport'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let sessionService: (typeof import('../sessionService'))['sessionService']
let messageService: (typeof import('../messageService'))['messageService']
let chatGateway: (typeof import('../../frontend/core/DefaultChatGateway'))['chatGateway']
let forkSession: (typeof import('../sessionFork'))['forkSession']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ messageService } = await import('../messageService'))
  ;({ chatGateway } = await import('../../frontend/core/DefaultChatGateway'))
  ;({ forkSession } = await import('../sessionFork'))
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

const TIMEOUT = 25000
const PROJECT = 'proj-1'

function insert(id: string, patch: Partial<Session> = {}): string {
  sessionRecords.insert({
    id,
    title: id,
    projectId: PROJECT,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: { enabledTools: [], model: { provider: 'faux', modelId: 'faux-1' } },
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...patch
  })
  return id
}

const dayRowIds = (sessionId: string): string[] =>
  (
    (holder.db as DatabaseSync)
      .prepare('SELECT entryId FROM session_day_prompts WHERE sessionId = ?')
      .all(sessionId) as Array<{ entryId: string }>
  ).map((row) => row.entryId)

const mirrorLocked = (sessionId: string): boolean | undefined =>
  sessionRecords.pickSettings(sessionId, ['agentLocked'])?.agentLocked ?? undefined

const openSession = (id: string): DurableSession => {
  const session = getSessionHost().get(id)
  if (session === undefined) throw new Error(`session ${id} is not open`)
  return session
}

const listed = async (sessionId: string): Promise<string[]> =>
  (await messageService.listBySession(sessionId)).map((m) => `${m.role}:${m.content}`)

const listedIds = async (sessionId: string): Promise<string[]> =>
  (await messageService.listBySession(sessionId)).map((m) => m.id)

async function fork(sessionId: string, messageId?: string): Promise<string> {
  const result = await forkSession(
    messageId === undefined ? { sessionId } : { sessionId, messageId }
  )
  if (!result.success) throw new Error(`fork refused: ${result.reason}`)
  return result.sessionId
}

let kit: FauxKit

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-fork-'))
  holder.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-fork-tr-'))
  holder.artifacts = mkdtempSync(join(tmpdir(), 'shuvix-fork-art-'))
  holder.userData = mkdtempSync(join(tmpdir(), 'shuvix-fork-ud-'))
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
  mocks.broadcast.mockClear()
  mocks.listChanged.mockClear()
  mocks.getProfile.mockImplementation((name) => profile(name))
  kit = fauxKit()
  resetSessionHostForTests(testDepsOverrides(kit, { toolHost: toolsToolHost(() => [readTool()]) }))
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
  rmSync(holder.userData, { recursive: true, force: true })
})

/** U1 A1 U2 A2，锁着 */
async function seedTwoTurns(sessionId: string): Promise<string[]> {
  insert(sessionId)
  kit.queue(answer('A1'))
  expect(await chatGateway.prompt(sessionId, 'U1')).toEqual({})
  kit.queue(answer('A2'))
  expect(await chatGateway.prompt(sessionId, 'U2')).toEqual({})
  expect(await listed(sessionId)).toEqual(['user:U1', 'assistant:A1', 'user:U2', 'assistant:A2'])
  expect(openSession(sessionId).lock).toBeDefined()
  expect(mirrorLocked(sessionId)).toBe(true)
  return listedIds(sessionId)
}

describe('SI session fork against a real host', () => {
  it(
    'SI-1 whole fork of a locked U1 A1 U2 A2: same list and ids; source row unchanged; fork unlocked (init created:false) and its extensions editable; source still locked',
    async () => {
      const ids = await seedTwoTurns('s')
      const sourceBefore = sessionRecords.findById('s')

      const forkId = await fork('s')

      expect(forkId).not.toBe('s')
      expect(await listedIds(forkId)).toEqual(ids)
      expect(await listed(forkId)).toEqual(['user:U1', 'assistant:A1', 'user:U2', 'assistant:A2'])
      expect(sessionRecords.findById('s')).toEqual(sourceBefore)
      expect(mocks.listChanged).toHaveBeenCalledTimes(1)

      // fork：没有 agent（锁属于源会话那一场），扩展能力勾选可改
      expect(openSession(forkId).lock).toBeUndefined()
      expect(mirrorLocked(forkId)).not.toBe(true)
      expect(sessionService.hasAgentRuntime(forkId)).toBe(false)
      expect((await chatGateway.startChat(forkId)).created).toBe(false)
      expect(sessionService.updateEnabledTools(forkId, ['mcp:browser'])).toBe(true)
      expect(sessionRecords.findById(forkId)!.settings.enabledTools).toEqual(['mcp:browser'])

      // 源会话照旧锁着、勾选不可改
      expect(openSession('s').lock).toBeDefined()
      expect(mirrorLocked('s')).toBe(true)
      expect(sessionService.hasAgentRuntime('s')).toBe(true)
      expect(sessionService.updateEnabledTools('s', ['mcp:browser'])).toBe(false)
      expect(sessionRecords.findById('s')!.settings.enabledTools).toEqual([])
    },
    TIMEOUT
  )

  it(
    'SI-2 fork from a tool-call card (call + result + final): fork view = U1 + that card; prompting it sends that prefix + the new message; the two diverge',
    async () => {
      insert('s')
      kit.queue(callTool('read', { path: 'x' }, 'c1'), answer('A1'))
      expect(await chatGateway.prompt('s', 'U1')).toEqual({})
      kit.queue(answer('A2'))
      expect(await chatGateway.prompt('s', 'U2')).toEqual({})
      const source = await messageService.listBySession('s')
      expect(source.map((m) => `${m.role}:${m.content}`)).toEqual([
        'user:U1',
        'assistant:',
        'assistant:A1',
        'user:U2',
        'assistant:A2'
      ])
      const card = source.slice(0, 3).map((m) => m.id)

      const forkId = await fork('s', card[2])

      const view = await messageService.listBySession(forkId)
      expect(view.map((m) => m.id)).toEqual(card)
      // 工具块带着回填的结果
      const toolCard = view[1]
      expect(toolCard?.role).toBe('assistant')
      const block = toolCard?.role === 'assistant' ? toolCard.blocks[0] : undefined
      expect(block).toMatchObject({ type: 'tool', toolCallId: 'c1', result: 'read x' })

      const before = kit.requests.length
      kit.queue(answer('F3'))
      expect(await chatGateway.prompt(forkId, 'U3')).toEqual({})
      expect(kit.requests.length).toBe(before + 1)
      expect(requestTexts(kit, before)).toEqual([
        'user:U1',
        'assistant:[tool:read]',
        'toolResult:read x',
        'assistant:A1',
        'user:U3'
      ])
      expect(await listed(forkId)).toEqual([
        'user:U1',
        'assistant:',
        'assistant:A1',
        'user:U3',
        'assistant:F3'
      ])
      // 源会话不受影响，之后各走各的
      expect(await listed('s')).toEqual([
        'user:U1',
        'assistant:',
        'assistant:A1',
        'user:U2',
        'assistant:A2'
      ])
      kit.queue(answer('S3'))
      expect(await chatGateway.prompt('s', 'U3s')).toEqual({})
      expect(requestTexts(kit, kit.requests.length - 1).slice(-2)).toEqual([
        'assistant:A2',
        'user:U3s'
      ])
      expect((await listed(forkId)).at(-1)).toBe('assistant:F3')
    },
    TIMEOUT
  )

  it(
    'SI-2 forking from the tool-call message itself carries the tool result right after it',
    async () => {
      insert('s')
      kit.queue(callTool('read', { path: 'x' }, 'c1'), answer('A1'))
      expect(await chatGateway.prompt('s', 'U1')).toEqual({})
      const source = await messageService.listBySession('s')
      const callMessage = source[1]!

      const forkId = await fork('s', callMessage.id)

      expect(await listedIds(forkId)).toEqual([source[0]!.id, callMessage.id])
      const before = kit.requests.length
      kit.queue(answer('F2'))
      expect(await chatGateway.prompt(forkId, 'U2')).toEqual({})
      expect(requestTexts(kit, before)).toEqual([
        'user:U1',
        'assistant:[tool:read]',
        'toolResult:read x',
        'user:U2'
      ])
    },
    TIMEOUT
  )

  it(
    'SI-3 artifacts are copied and readable for the fork; deleting the fork removes only its own directory',
    async () => {
      await seedTwoTurns('s')
      mkdirSync(join(holder.artifacts, 's'), { recursive: true })
      writeFileSync(join(holder.artifacts, 's', 'chart.svg'), '<svg><title>Chart</title></svg>')

      const forkId = await fork('s')

      expect(listArtifacts(forkId).map((a) => a.name)).toEqual(['chart.svg'])
      expect(readArtifact(forkId, 'chart.svg')).toBe('<svg><title>Chart</title></svg>')

      await sessionService.delete(forkId)
      expect(existsSync(join(holder.artifacts, forkId))).toBe(false)
      expect(readFileSync(join(holder.artifacts, 's', 'chart.svg'), 'utf-8')).toBe(
        '<svg><title>Chart</title></svg>'
      )
      expect(existsSync(durableStoragePath(forkId))).toBe(false)
      expect(existsSync(durableStoragePath('s'))).toBe(true)
      expect(await listed('s')).toEqual(['user:U1', 'assistant:A1', 'user:U2', 'assistant:A2'])
    },
    TIMEOUT
  )

  it(
    'SI-3 a source without artifacts forks fine and the fork has no artifacts directory',
    async () => {
      await seedTwoTurns('s')
      const forkId = await fork('s')
      expect(existsSync(join(holder.artifacts, forkId))).toBe(false)
      expect(listArtifacts(forkId)).toEqual([])
      expect(await listed(forkId)).toEqual(['user:U1', 'assistant:A1', 'user:U2', 'assistant:A2'])
    },
    TIMEOUT
  )

  it(
    'SI-4 not copied: the tool_results directory, the calendar rows, the children',
    async () => {
      await seedTwoTurns('s')
      mkdirSync(join(holder.toolResults, 's'), { recursive: true })
      writeFileSync(join(holder.toolResults, 's', 'big.txt'), 'x'.repeat(10))
      insert('child', { parentId: 's' })
      expect(dayRowIds('s')).toHaveLength(2)

      const forkId = await fork('s')

      expect(existsSync(join(holder.toolResults, forkId))).toBe(false)
      expect(dayRowIds(forkId)).toEqual(['created'])
      expect(dayRowIds('s')).toHaveLength(2)
      expect(sessionRecords.findChildren(forkId)).toEqual([])
      expect(sessionRecords.findChildren('s').map((c) => c.id)).toEqual(['child'])
      expect(existsSync(join(holder.toolResults, 's', 'big.txt'))).toBe(true)
    },
    TIMEOUT
  )

  it(
    'SI-5 deleting the source leaves the fork intact (list, storage file, can still prompt)',
    async () => {
      const ids = await seedTwoTurns('s')
      const forkId = await fork('s')

      await sessionService.delete('s')
      expect(sessionRecords.findById('s')).toBeUndefined()
      expect(existsSync(durableStoragePath('s'))).toBe(false)

      expect(existsSync(durableStoragePath(forkId))).toBe(true)
      expect(await listedIds(forkId)).toEqual(ids)
      kit.queue(answer('A3'))
      expect(await chatGateway.prompt(forkId, 'U3')).toEqual({})
      expect(await listed(forkId)).toEqual([
        'user:U1',
        'assistant:A1',
        'user:U2',
        'assistant:A2',
        'user:U3',
        'assistant:A3'
      ])
    },
    TIMEOUT
  )

  it(
    'SI-6 two concurrent forks → two distinct forks, each a working copy',
    async () => {
      const ids = await seedTwoTurns('s')

      const [a, b] = await Promise.all([
        forkSession({ sessionId: 's' }),
        forkSession({ sessionId: 's' })
      ])
      if (!a.success || !b.success) throw new Error(`fork refused: ${JSON.stringify([a, b])}`)
      expect(a.sessionId).not.toBe(b.sessionId)

      for (const [forkId, reply] of [
        [a.sessionId, 'FA'],
        [b.sessionId, 'FB']
      ] as const) {
        expect(await listedIds(forkId)).toEqual(ids)
        kit.queue(answer(reply))
        expect(await chatGateway.prompt(forkId, `to ${reply}`)).toEqual({})
      }
      expect((await listed(a.sessionId)).slice(-2)).toEqual(['user:to FA', 'assistant:FA'])
      expect((await listed(b.sessionId)).slice(-2)).toEqual(['user:to FB', 'assistant:FB'])
      expect(await listed('s')).toEqual(['user:U1', 'assistant:A1', 'user:U2', 'assistant:A2'])
    },
    TIMEOUT
  )

  it(
    'SI-7 whole fork of a temp source: the fork resolves to the source temp folder; deleting the source keeps it (the fork still prompts); deleting the fork removes it',
    async () => {
      insert('s', { projectId: null })
      kit.queue(answer('A1'))
      expect(await chatGateway.prompt('s', 'U1')).toEqual({})
      const sDir = join(getTempWorkspaceBase(), 's')
      expect(sessionService.getById('s')!.workingDirectory).toBe(sDir)
      writeFileSync(join(sDir, 'notes.txt'), 'shared')

      const forkId = await fork('s')

      expect(sessionRecords.findById(forkId)).toMatchObject({
        projectId: null,
        parentId: null,
        settings: { workingDirectory: sDir }
      })
      expect(sessionService.getById(forkId)!.workingDirectory).toBe(sDir)
      expect((await sessionService.resolveAgentConfig(forkId)).cwd).toBe(sDir)
      expect(existsSync(join(getTempWorkspaceBase(), forkId))).toBe(false)

      await sessionService.delete('s')
      expect(sessionRecords.findById('s')).toBeUndefined()
      expect(readFileSync(join(sDir, 'notes.txt'), 'utf-8')).toBe('shared')

      kit.queue(answer('F2'))
      expect(await chatGateway.prompt(forkId, 'U2')).toEqual({})
      expect(await listed(forkId)).toEqual(['user:U1', 'assistant:A1', 'user:U2', 'assistant:F2'])
      expect(sessionService.getById(forkId)!.workingDirectory).toBe(sDir)
      expect(readFileSync(join(sDir, 'notes.txt'), 'utf-8')).toBe('shared')

      await sessionService.delete(forkId)
      expect(existsSync(sDir)).toBe(false)
      expect(existsSync(join(getTempWorkspaceBase(), forkId))).toBe(false)
    },
    TIMEOUT
  )

  it(
    "SI-8 a new session and a fork are on today's calendar before anyone prompts them",
    async () => {
      await seedTwoTurns('s')
      const forkId = await fork('s')
      const fresh = sessionService.create({ projectId: PROJECT }).id
      // 源会话今天的开口行删掉：今天的圆点只能来自两条会话的建成行
      ;(holder.db as DatabaseSync)
        .prepare('DELETE FROM session_day_prompts WHERE sessionId = ?')
        .run('s')
      const today = localDayKey(Date.now())
      const [year, month] = today.split('-').map(Number)

      expect(dayRowIds(fresh)).toEqual(['created'])
      expect(
        calendar
          .sessionsOnDay(today)
          .map((s) => s.id)
          .sort()
      ).toEqual([forkId, fresh].sort())
      expect(calendar.daysInMonth(year, month)).toEqual([today])
      expect(calendar.firstEntryOnDay(forkId, today)).toBeNull()
      expect(calendar.firstEntryOnDay(fresh, today)).toBeNull()
    },
    TIMEOUT
  )
})
