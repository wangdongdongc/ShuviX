/**
 * 会话 fork 的宿主编排（services/sessionFork.ts 的 `forkSession`）—— 假宿主 + 真 sessionRecords / sessionService
 * （内存 SQLite 跑真迁移）+ 存储拷贝 / 拷贝收尾换成记录型假件。契约在 chat-protocol 的 sessionFork.ts。
 *
 *   SF-1  源会话不存在 → no_session，不 peek、不插行、不广播
 *   SF-2  形态不给（隐藏项目 / 笔记本 / 标签页 / 内存会话 / 旧格式存储）→ not_forkable，不 peek
 *   SF-3  messageId 写法不规范 → invalid_target，在任何 peek 之前
 *   SF-4  messageId 不在源会话视图里 / 是一条用户消息 → invalid_target，whileIdle 不调
 *   SF-5  源会话在忙 / 被中断 / whileIdle 拒绝 busy → busy；不拷、不建文件、不插行、不广播
 *   SF-6  空的源会话（没有存储）、不给 messageId → 成功：同项目同父、标题规则、当前存储类型、不拷、不 open，恰一次广播
 *   SF-7  空的源会话给了 messageId → invalid_target
 *   SF-8  整段 fork：copy(源, 新)、收尾先于插行、不 branchAt / 不 open、一次广播、新 id ≠ 源
 *   SF-9  从回复分支：open(新) 再 branchAt(条目 id)
 *   SF-10 branchAt 拒绝 not_found / invalid_target → invalid_target，fork 的行 / 存储 / artifacts 都删掉；closed → failed
 *   SF-11 设置抄什么、不抄什么（项目源会话：工作目录不抄，它在项目根）；数组是拷贝
 *   SF-12 标题：en / zh、fork 的 fork、缺省标题留缺省
 *   SF-13 顶层源 → parentId null；子会话源 → 同一父会话、档案钉子保留、父会话的子会话里有 fork
 *   SF-14 行还没进库时出错（拷贝 / 收尾 / 打开存储 / 插行）→ failed，删 fork 的存储，无行、无广播
 *   SF-15 行已进库之后出错（拷 artifacts / open / branchAt 抛错）→ failed，走完整删除
 *   SF-16 whileIdle 答 closed（或 viewSnapshot 抛 SessionClosedError）一次 → 再 peek 一次成功；两次 → failed
 *   SF-17 从不 reject（各处注入失败都回 `{ success: false }`）
 *   临时会话（不属于任何项目）—— fork 共用源会话的工作目录（`settings.workingDirectory`，见 sessionService 的
 *   insertForkRow；删除时的去留在 sessionServiceForkWorkspace.test.ts）：
 *   SF-18 空的 / 整段 / 从回复分支三条路都成功：projectId / parentId null、标题与存储类型照旧、
 *         workingDirectory = 源会话的临时工作区、恰一次广播
 *   SF-19 临时会话的不给形态（标签页 / 笔记本 / 内存会话 / 旧格式 / 未知存储）→ not_forkable，不 peek、
 *         不插行、拒绝不建源会话的文件夹
 *   SF-20 半成品的收场（branchAt 拒绝、拷 artifacts / open / branchAt 抛错、行进库之前出错）从不碰源会话的
 *         文件夹与里面的文件；fork 的行没了，也没有 temp_workspace/<fork>
 *   SF-21 源会话自带 workingDirectory（它本身是 fork / 一个用户目录）→ fork 抄同一个值
 *   SF-22 临时子会话做源：同一父会话，workingDirectory = 那条子会话自己的 temp_workspace/<子会话>（钉住现状）
 *   SF-23 临时源会话在忙 → busy，不插行
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeHost, resetFakeHost, type FakeDurableSession } from './support/fakeSessionHost'

const holder = vi.hoisted(() => ({ db: null as unknown, root: '' }))

const mocks = vi.hoisted(() => ({
  /** 拷存储：记下实参与那一刻 fork 的行在不在 */
  copy: vi.fn<(from: string, to: string) => Promise<void>>(),
  openFile: vi.fn<(sessionId: string) => Promise<unknown>>(),
  deleteStorage: vi.fn<(sessionId: string) => Promise<void>>(),
  reset: vi.fn<(storage: unknown) => Promise<void>>(),
  listChanged: vi.fn<() => void>(),
  artifactCalls: [] as Array<[string, string]>,
  artifactsFail: false
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
// 临时工作区那几个（getTempWorkspaceBase / getTempWorkspace / tempWorkspaceOwnerOf）用真的 —— userData 指到
// 每个用例自己的临时目录（electron 换掉），真的 getTempWorkspace 会把目录建出来，「拒绝时没建出源会话的
// 文件夹」于是断在真盘上；其余数据目录照旧落在临时目录里
vi.mock('electron', () => ({
  app: {
    getPath: () => join(holder.root, 'userData'),
    getAppPath: () => join(holder.root, 'userData'),
    isPackaged: false
  }
}))
vi.mock('../../utils/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/paths')>()),
  getSessionsDir: () => join(holder.root, 'sessions'),
  getToolResultsBase: () => join(holder.root, 'tool_results'),
  getSessionArtifactsDir: (sid: string) => join(holder.root, 'artifacts', sid)
}))
// 存储路由留真的（isDurableSession 按行的存储类型判）；拷贝 / 按路径打开 / 删除换成记录型假件
vi.mock('../sessionStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessionStorage')>()),
  copyDurableStorage: mocks.copy,
  openDurableStorageFile: mocks.openFile,
  deleteSessionStorage: mocks.deleteStorage
}))
vi.mock('@shuvix/agent-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shuvix/agent-runtime')>()),
  resetForkedSessionState: mocks.reset
}))
// artifacts 的拷贝留真的（目录在临时目录里），外面包一层：记调用、可注入失败
vi.mock('../artifacts/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../artifacts/store')>()
  return {
    ...actual,
    copySessionArtifacts: (from: string, to: string) => {
      mocks.artifactCalls.push([from, to])
      if (mocks.artifactsFail) throw new Error('artifacts copy failed')
      actual.copySessionArtifacts(from, to)
    }
  }
})
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../agentSession', async () =>
  (await import('./support/fakeSessionHost')).agentSessionModuleMock()
)
// 真的 i18next 实例（en / zh 两份真文案）：标题规则读 agent.defaultTitle / agent.forkTitle
vi.mock('../../i18n', async () => {
  const { default: i18next } = await import('i18next')
  const en = (await import('@shuvix/chat-protocol/i18n/locales/en.json')).default
  const zh = (await import('@shuvix/chat-protocol/i18n/locales/zh.json')).default
  const instance = i18next.createInstance()
  await instance.init({
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    resources: { en: { translation: en }, zh: { translation: zh } }
  })
  return {
    t: instance.t.bind(instance),
    changeLanguage: (lang: string) => void instance.changeLanguage(lang)
  }
})
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: mocks.listChanged,
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn(async () => {}) } }))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: (tools: string[]) => tools }))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../agentService', () => ({
  agentService: { getProfile: (name: string) => ({ name }), isSessionProfile: () => true }
}))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../sandbox', () => ({ cleanupSession: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { SessionClosedError } from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { emptySessionView, type SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { migrations } from '../../dao/migrations'
import type { Session, SessionSettings } from '../../dao/types'
import { changeLanguage } from '../../i18n'
import { getTempWorkspace, getTempWorkspaceBase } from '../../utils/paths'
import { sessionRecords } from '../sessionRecords'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let forkSession: (typeof import('../sessionFork'))['forkSession']
let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ forkSession } = await import('../sessionFork'))
  ;({ sessionService } = await import('../sessionService'))
})

const SRC = 'src-session'
const PROJECT = 'proj-1'
/** 拷贝收尾拿到的「存储」—— 一个记号对象，看它是不是原样交给了 resetForkedSessionState */
const STORAGE = { storage: 'fork' }

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.root = mkdtempSync(join(tmpdir(), 'shuvix-fork-unit-'))
  sessionRecords.clearEphemeralForTests()
  resetFakeHost()
  vi.clearAllMocks()
  mocks.artifactCalls.length = 0
  mocks.artifactsFail = false
  mocks.copy.mockResolvedValue(undefined)
  mocks.openFile.mockResolvedValue(STORAGE)
  mocks.reset.mockResolvedValue(undefined)
  mocks.deleteStorage.mockResolvedValue(undefined)
  mocks.listChanged.mockReset()
  changeLanguage('en')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(holder.root, { recursive: true, force: true })
})

afterAll(() => {
  changeLanguage('en')
})

// ─── 种子 ─────────────────────────────────────

function seedRow(patch: Partial<Session> = {}, options: { ephemeral?: boolean } = {}): Session {
  const session: Session = {
    id: SRC,
    title: 'Plan the trip',
    projectId: PROJECT,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: { enabledTools: [] },
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...patch
  }
  sessionRecords.insert(session, options)
  return session
}

function message(id: string, role: 'user' | 'assistant'): ChatMessage {
  return (
    role === 'user'
      ? {
          id,
          sessionId: SRC,
          role,
          type: 'text',
          content: `u${id}`,
          model: '',
          createdAt: 1,
          metadata: null
        }
      : {
          id,
          sessionId: SRC,
          role,
          type: 'message',
          content: `a${id}`,
          model: 'faux-1',
          createdAt: 1,
          blocks: [],
          metadata: null
        }
  ) as ChatMessage
}

/** U1 A2 U3 A4 */
function twoTurnView(sessionId = SRC): SessionView {
  return {
    ...emptySessionView(sessionId),
    source: 'durable',
    conversationId: 1,
    messages: [
      message('1', 'user'),
      message('2', 'assistant'),
      message('3', 'user'),
      message('4', 'assistant')
    ]
  }
}

/** 源会话的存储在、开着，视图是两轮对话 */
function openSource(patch: Partial<FakeDurableSession> = {}): FakeDurableSession {
  return fakeHost.put(SRC, { view: twoTurnView(), ...patch })
}

const rowIds = (): string[] =>
  (
    (holder.db as DatabaseSync).prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{
      id: string
    }>
  ).map((r) => r.id)

const forkIdOf = (result: Awaited<ReturnType<typeof forkSession>>): string => {
  if (!result.success) throw new Error(`fork refused: ${result.reason}`)
  return result.sessionId
}

const artifactsDir = (sid: string): string => join(holder.root, 'artifacts', sid)

function seedArtifacts(sid: string): void {
  mkdirSync(artifactsDir(sid), { recursive: true })
  writeFileSync(join(artifactsDir(sid), 'chart.svg'), '<svg/>', 'utf-8')
}

/** 这一组用例里谁都没被建、没被写 */
function expectNothingCreated(): void {
  expect(rowIds().filter((id) => id !== SRC && id !== 'P')).toEqual([])
  expect(mocks.listChanged).not.toHaveBeenCalled()
  expect(mocks.reset).not.toHaveBeenCalled()
  expect(fakeHost.callsOf('open')).toEqual([])
  expect(mocks.artifactCalls).toEqual([])
}

// ─── SF-1 / SF-2 / SF-3：只读校验 ─────────────────

describe('SF-1..3 read-only checks before anything is touched', () => {
  it('SF-1 unknown source → no_session; no peek, no insert, no broadcast', async () => {
    expect(await forkSession({ sessionId: 'missing' })).toEqual({
      success: false,
      reason: 'no_session'
    })
    expect(fakeHost.calls).toEqual([])
    expect(rowIds()).toEqual([])
    expect(mocks.copy).not.toHaveBeenCalled()
    expect(mocks.listChanged).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<Session>, { ephemeral?: boolean }]>([
    ['hidden project', { projectId: '__agents__' }, {}],
    ['notebook session', { settings: { notebookPath: 'notes/a.md' } }, {}],
    [
      'Chrome tab session',
      { settings: { chromeTab: { installId: 'i', runId: 'r', tabId: 7 } } as SessionSettings },
      {}
    ],
    ['ephemeral session (with a forced projectId)', { projectId: PROJECT }, { ephemeral: true }],
    ['legacy storage kind', { storageKind: 'harness-v3-jsonl' }, {}],
    ['unknown storage kind', { storageKind: 'durable-sqlite-9' as Session['storageKind'] }, {}]
  ])('SF-2 %s → not_forkable; no peek', async (_label, patch, options) => {
    seedRow(patch, options)
    openSource()
    fakeHost.calls.length = 0
    expect(await forkSession({ sessionId: SRC })).toEqual({
      success: false,
      reason: 'not_forkable'
    })
    expect(await forkSession({ sessionId: SRC, messageId: '2' })).toEqual({
      success: false,
      reason: 'not_forkable'
    })
    expect(fakeHost.calls).toEqual([])
    expect(fakeHost.get(SRC)!.calls).toEqual([])
    expect(mocks.copy).not.toHaveBeenCalled()
    expectNothingCreated()
  })

  it.each(['abc', '', '0', '-1', '1.5', '01', ' 2', '2 ', '1e3', '9007199254740993'])(
    'SF-3 malformed messageId %j → invalid_target before any peek',
    async (messageId) => {
      seedRow()
      openSource()
      fakeHost.calls.length = 0
      expect(await forkSession({ sessionId: SRC, messageId })).toEqual({
        success: false,
        reason: 'invalid_target'
      })
      expect(fakeHost.calls).toEqual([])
      expect(fakeHost.get(SRC)!.calls).toEqual([])
      expect(mocks.copy).not.toHaveBeenCalled()
      expectNothingCreated()
    }
  )
})

// ─── SF-4 / SF-5 / SF-7：拷贝之前的拒绝 ─────────────────

describe('SF-4/5/7 refusals before the copy', () => {
  it.each([
    ['absent from the source view', '99'],
    ['a user message', '3']
  ])('SF-4 messageId %s → invalid_target; whileIdle never called', async (_label, messageId) => {
    seedRow()
    const source = openSource()
    expect(await forkSession({ sessionId: SRC, messageId })).toEqual({
      success: false,
      reason: 'invalid_target'
    })
    expect(source.callsOf('whileIdle')).toEqual([])
    expect(mocks.copy).not.toHaveBeenCalled()
    expect(mocks.deleteStorage).not.toHaveBeenCalled()
    expectNothingCreated()
  })

  it.each<[string, Partial<FakeDurableSession>]>([
    ['busy', { busy: true }],
    ['interrupted', { interrupted: true }],
    ["whileIdle refuses 'busy'", { idleRefusal: 'busy' }]
  ])('SF-5 source %s → busy; no copy, file, row or broadcast', async (_label, patch) => {
    seedRow()
    const source = openSource(patch)
    for (const messageId of [undefined, '2']) {
      expect(
        await forkSession(
          messageId === undefined ? { sessionId: SRC } : { sessionId: SRC, messageId }
        )
      ).toEqual({ success: false, reason: 'busy' })
    }
    expect(source.callsOf('whileIdle')).toHaveLength(2)
    expect(mocks.copy).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.deleteStorage).not.toHaveBeenCalled()
    expect(rowIds()).toEqual([SRC])
    expectNothingCreated()
  })

  it('SF-7 empty source (no storage) with a messageId → invalid_target', async () => {
    seedRow()
    expect(await forkSession({ sessionId: SRC, messageId: '2' })).toEqual({
      success: false,
      reason: 'invalid_target'
    })
    expect(fakeHost.callsOf('peek')).toEqual([SRC])
    expect(mocks.copy).not.toHaveBeenCalled()
    expect(rowIds()).toEqual([SRC])
    expectNothingCreated()
  })
})

// ─── SF-6 / SF-8 / SF-9：成功的三条路 ─────────────────

describe('SF-6/8/9 successful forks', () => {
  it('SF-6 empty source without messageId → an empty sibling: same project / parent, fork title, current storage kind, no copy, no open, one broadcast after the insert', async () => {
    seedRow({ settings: { enabledTools: ['mcp:browser'], thinkingLevel: 'high' } })
    let rowAtBroadcast: Session | undefined
    let forkIdSeen: string | undefined
    mocks.listChanged.mockImplementation(() => {
      const rows = rowIds().filter((id) => id !== SRC)
      forkIdSeen = rows[0]
      rowAtBroadcast = forkIdSeen === undefined ? undefined : sessionRecords.findById(forkIdSeen)
    })

    const result = await forkSession({ sessionId: SRC })
    const forkId = forkIdOf(result)

    expect(forkId).not.toBe(SRC)
    const fork = sessionRecords.findById(forkId)!
    expect(fork).toMatchObject({
      projectId: PROJECT,
      parentId: null,
      title: 'Plan the trip · fork',
      storageKind: 'durable-sqlite-1',
      settings: { enabledTools: ['mcp:browser'], thinkingLevel: 'high' }
    })
    expect(mocks.copy).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.reset).not.toHaveBeenCalled()
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.storages.has(forkId)).toBe(false)
    expect(mocks.listChanged).toHaveBeenCalledTimes(1)
    expect(forkIdSeen).toBe(forkId)
    expect(rowAtBroadcast?.id).toBe(forkId)
    // 源会话的行原样
    expect(sessionRecords.findById(SRC)).toMatchObject({ title: 'Plan the trip' })
  })

  it('SF-8 whole fork: copy(source, fork) inside whileIdle, reset before insert, no branchAt / open, one broadcast, fork id ≠ source', async () => {
    seedRow()
    const source = openSource()
    const order: string[] = []
    mocks.copy.mockImplementation(async () => void order.push('copy'))
    mocks.openFile.mockImplementation(async (id) => {
      order.push(`openFile:${sessionRecords.findById(id) ? 'row' : 'no-row'}`)
      return STORAGE
    })
    mocks.reset.mockImplementation(async () => {
      const forks = rowIds().filter((id) => id !== SRC)
      order.push(`reset:${forks.length === 0 ? 'no-row' : 'row'}`)
    })
    mocks.listChanged.mockImplementation(() => void order.push('broadcast'))

    const forkId = forkIdOf(await forkSession({ sessionId: SRC }))

    expect(forkId).not.toBe(SRC)
    expect(mocks.copy.mock.calls).toEqual([[SRC, forkId]])
    expect(mocks.openFile.mock.calls).toEqual([[forkId]])
    expect(mocks.reset.mock.calls).toEqual([[STORAGE]])
    expect(order).toEqual(['copy', 'openFile:no-row', 'reset:no-row', 'broadcast'])
    expect(source.callsOf('whileIdle')).toHaveLength(1)
    expect(source.callsOf('branchAt')).toEqual([])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.get(forkId)).toBeUndefined()
    expect(mocks.listChanged).toHaveBeenCalledTimes(1)
    expect(sessionRecords.findById(forkId)).toMatchObject({
      projectId: PROJECT,
      storageKind: 'durable-sqlite-1'
    })
    expect(mocks.deleteStorage).not.toHaveBeenCalled()
  })

  it('SF-9 reply fork: the copy, then host.open(fork) and branchAt(numeric entry id) on the fork', async () => {
    seedRow()
    const source = openSource()
    const forkId = forkIdOf(await forkSession({ sessionId: SRC, messageId: '2' }))

    expect(mocks.copy.mock.calls).toEqual([[SRC, forkId]])
    expect(fakeHost.callsOf('open')).toEqual([forkId])
    const fork = fakeHost.get(forkId)!
    expect(fork.callsOf('branchAt')).toEqual([['branchAt', 2]])
    // 分支只在 fork 上，源会话从不被分支
    expect(source.callsOf('branchAt')).toEqual([])
    expect(source.callsOf('viewSnapshot')).toHaveLength(1)
    expect(mocks.listChanged).toHaveBeenCalledTimes(1)
    expect(sessionRecords.findById(forkId)).toBeDefined()
    expect(mocks.deleteStorage).not.toHaveBeenCalled()
  })
})

// ─── SF-10：branchAt 拒绝 ─────────────────

describe('SF-10 branchAt refused on the fork', () => {
  it.each<['not_found' | 'invalid_target' | 'closed', 'invalid_target' | 'failed']>([
    ['not_found', 'invalid_target'],
    ['invalid_target', 'invalid_target'],
    ['closed', 'failed']
  ])(
    'SF-10 branchAt → %s ⇒ %s; fork row, storage and artifacts are removed, source untouched',
    async (refusal, reason) => {
      seedRow()
      seedArtifacts(SRC)
      const source = openSource()
      fakeHost.configure = (session) => {
        if (session.sessionId !== SRC) session.branchResult = { ok: false, reason: refusal }
      }

      expect(await forkSession({ sessionId: SRC, messageId: '4' })).toEqual({
        success: false,
        reason
      })

      const forkId = mocks.copy.mock.calls[0]![1]
      expect(fakeHost.instances.get(forkId)![0]!.callsOf('branchAt')).toEqual([['branchAt', 4]])
      // 完整删除：行、宿主那一侧的存储（假宿主的 delete = 生产里 deleteStorage 的那条路）、artifacts 目录
      expect(rowIds()).toEqual([SRC])
      expect(fakeHost.callsOf('delete')).toEqual([forkId])
      expect(fakeHost.storages.has(forkId)).toBe(false)
      expect(existsSync(artifactsDir(forkId))).toBe(false)
      // 源会话：行、artifacts、句柄都原样
      expect(existsSync(join(artifactsDir(SRC), 'chart.svg'))).toBe(true)
      expect(sessionRecords.findById(SRC)).toBeDefined()
      expect(source.closed).toBe(false)
      expect(fakeHost.callsOf('delete')).not.toContain(SRC)
    }
  )
})

// ─── SF-11 / SF-12 / SF-13：新行的形状 ─────────────────

describe('SF-11..13 the fork row', () => {
  it('SF-11 project source: run config, selections, bot, pin and grants are copied; a stored working dir (a project session works in the project root), title origin, lock / run mirrors are not; arrays are copies', async () => {
    seedRow({
      parentId: null,
      settings: {
        enabledTools: ['mcp:browser', '-skill:builtin:drawing'],
        knowledgeBases: ['notes'],
        bot: 'alice',
        agentProfile: 'coding',
        model: { provider: 'faux', modelId: 'faux-1' },
        thinkingLevel: 'low',
        allowList: ['Read(/a)', 'Write(/b)'],
        workingDirectory: '/somewhere',
        titleOrigin: 'auto',
        agentLocked: true,
        runState: 'busy'
      }
    })
    openSource()
    const forkId = forkIdOf(await forkSession({ sessionId: SRC }))
    const fork = sessionRecords.findById(forkId)!

    expect(fork.settings).toEqual({
      enabledTools: ['mcp:browser', '-skill:builtin:drawing'],
      knowledgeBases: ['notes'],
      bot: 'alice',
      agentProfile: 'coding',
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'low',
      allowList: ['Read(/a)', 'Write(/b)']
    })
  })

  it('SF-11 explicit empty selections stay explicit ([] is not "never chosen")', async () => {
    seedRow({ settings: { enabledTools: [], knowledgeBases: [] } })
    openSource()
    const forkId = forkIdOf(await forkSession({ sessionId: SRC }))
    const settings = sessionRecords.findById(forkId)!.settings
    expect(settings.enabledTools).toEqual([])
    expect(settings.knowledgeBases).toEqual([])
  })

  it('SF-11 insertForkRow (project source): notebookPath / chromeTab / workingDirectory never reach the fork, and its arrays / model are copies of the source object', () => {
    const source: Session = {
      id: 'shape',
      title: 'Shape',
      projectId: PROJECT,
      parentId: null,
      storageKind: 'durable-sqlite-1',
      settings: {
        enabledTools: ['mcp:a'],
        knowledgeBases: ['kb'],
        allowList: ['Read(/x)'],
        model: { provider: 'p', modelId: 'm' },
        notebookPath: 'notes/a.md',
        chromeTab: { installId: 'i', runId: 'r', tabId: 3 },
        workingDirectory: '/wd'
      } as SessionSettings,
      createdAt: 1,
      updatedAt: 1,
      lastActiveAt: 1
    }
    const fork = sessionService.insertForkRow(source, 'fork-shape')
    expect(fork.settings).toEqual({
      enabledTools: ['mcp:a'],
      knowledgeBases: ['kb'],
      allowList: ['Read(/x)'],
      model: { provider: 'p', modelId: 'm' }
    })
    fork.settings.enabledTools!.push('mcp:b')
    fork.settings.knowledgeBases!.push('kb2')
    fork.settings.allowList!.push('Write(/y)')
    fork.settings.model!.modelId = 'changed'
    expect(source.settings.enabledTools).toEqual(['mcp:a'])
    expect(source.settings.knowledgeBases).toEqual(['kb'])
    expect(source.settings.allowList).toEqual(['Read(/x)'])
    expect(source.settings.model).toEqual({ provider: 'p', modelId: 'm' })
    // 落库的那一行同样没有那三样
    const stored = sessionRecords.findById('fork-shape')!.settings
    expect(stored).not.toHaveProperty('notebookPath')
    expect(stored).not.toHaveProperty('chromeTab')
    expect(stored).not.toHaveProperty('workingDirectory')
  })

  it('SF-11 changing the fork afterwards leaves the source row alone', async () => {
    seedRow({ settings: { enabledTools: ['mcp:a'], knowledgeBases: ['kb'] } })
    openSource()
    const forkId = forkIdOf(await forkSession({ sessionId: SRC }))
    sessionRecords.updateSettings(forkId, { enabledTools: ['mcp:z'], knowledgeBases: [] })
    expect(sessionRecords.findById(SRC)!.settings).toEqual({
      enabledTools: ['mcp:a'],
      knowledgeBases: ['kb']
    })
  })

  it('SF-12 title: en "X · fork", zh "X · 分支", fork of a fork, default title kept', async () => {
    seedRow({ title: 'Trip' })
    openSource()
    const en = forkIdOf(await forkSession({ sessionId: SRC }))
    expect(sessionRecords.findById(en)!.title).toBe('Trip · fork')

    // fork 的 fork：fork 本身也得是开着的、有存储的会话
    fakeHost.put(en, { view: twoTurnView(en) })
    const second = forkIdOf(await forkSession({ sessionId: en }))
    expect(sessionRecords.findById(second)!.title).toBe('Trip · fork · fork')

    changeLanguage('zh')
    const zh = forkIdOf(await forkSession({ sessionId: SRC }))
    expect(sessionRecords.findById(zh)!.title).toBe('Trip · 分支')
  })

  it.each([
    ['en', 'New Chat'],
    ['zh', '新对话']
  ])(
    'SF-12 a source still on the default title (%s) → the fork keeps the default title',
    async (lang, defaultTitle) => {
      changeLanguage(lang)
      seedRow({ title: defaultTitle })
      openSource()
      const forkId = forkIdOf(await forkSession({ sessionId: SRC }))
      expect(sessionRecords.findById(forkId)!.title).toBe(defaultTitle)
    }
  )

  it('SF-13 top-level source → the fork is top-level too', async () => {
    seedRow({ parentId: null })
    openSource()
    const forkId = forkIdOf(await forkSession({ sessionId: SRC }))
    expect(sessionRecords.findById(forkId)!.parentId).toBeNull()
  })

  it('SF-13 sub-session source → same parent, the agentProfile pin is kept, the parent lists the fork as its child', async () => {
    sessionRecords.insert({
      id: 'P',
      title: 'Parent',
      projectId: PROJECT,
      parentId: null,
      storageKind: 'durable-sqlite-1',
      settings: {},
      createdAt: 0,
      updatedAt: 0,
      lastActiveAt: 0
    })
    seedRow({ parentId: 'P', settings: { enabledTools: [], agentProfile: 'coding' } })
    openSource()
    const forkId = forkIdOf(await forkSession({ sessionId: SRC }))

    const fork = sessionRecords.findById(forkId)!
    expect(fork.parentId).toBe('P')
    expect(fork.projectId).toBe(PROJECT)
    expect(fork.settings.agentProfile).toBe('coding')
    expect(sessionService.resolveAgentProfileName(forkId)).toBe('coding')
    expect(
      sessionRecords
        .findChildren('P')
        .map((s) => s.id)
        .sort()
    ).toEqual([SRC, forkId].sort())
    // 源会话本身不是任何 fork 的父
    expect(sessionRecords.findChildren(SRC)).toEqual([])
  })
})

// ─── SF-14 / SF-15：出错收场 ─────────────────

describe('SF-14/15 failure cleanup', () => {
  it.each<[string, () => void]>([
    ['the storage copy throws', () => mocks.copy.mockRejectedValueOnce(new Error('disk full'))],
    ['the reset throws', () => mocks.reset.mockRejectedValueOnce(new Error('corrupt'))],
    [
      'opening the copied storage throws',
      () => mocks.openFile.mockRejectedValueOnce(new Error('cannot open'))
    ],
    [
      'inserting the row throws',
      () =>
        vi.spyOn(sessionRecords, 'insert').mockImplementationOnce(() => {
          throw new Error('constraint')
        })
    ]
  ])(
    'SF-14 before the row exists: %s → failed, the fork storage is deleted, no row, no broadcast',
    async (_label, inject) => {
      seedRow()
      seedArtifacts(SRC)
      openSource()
      inject()

      expect(await forkSession({ sessionId: SRC, messageId: '2' })).toEqual({
        success: false,
        reason: 'failed'
      })
      const forkId = mocks.copy.mock.calls[0]![1]
      expect(mocks.deleteStorage.mock.calls).toEqual([[forkId]])
      expect(rowIds()).toEqual([SRC])
      expect(mocks.listChanged).not.toHaveBeenCalled()
      expect(mocks.artifactCalls).toEqual([])
      expect(fakeHost.callsOf('open')).toEqual([])
      expect(existsSync(artifactsDir(forkId))).toBe(false)
    }
  )

  it.each<[string, () => void]>([
    ['copying the artifacts throws', () => (mocks.artifactsFail = true)],
    [
      'host.open(fork) throws',
      () => vi.spyOn(fakeHost, 'open').mockRejectedValueOnce(new Error('cannot open'))
    ],
    [
      'branchAt throws',
      () => {
        fakeHost.configure = (session) => {
          if (session.sessionId !== SRC) {
            session.branchAt = async () => {
              throw new Error('branch blew up')
            }
          }
        }
      }
    ]
  ])(
    'SF-15 after the row exists: %s → failed and a full delete (row, host storage, artifacts)',
    async (_label, inject) => {
      seedRow()
      seedArtifacts(SRC)
      openSource()
      inject()

      expect(await forkSession({ sessionId: SRC, messageId: '2' })).toEqual({
        success: false,
        reason: 'failed'
      })
      const forkId = mocks.copy.mock.calls[0]![1]
      expect(rowIds()).toEqual([SRC])
      expect(fakeHost.callsOf('delete')).toEqual([forkId])
      expect(fakeHost.storages.has(forkId)).toBe(false)
      expect(existsSync(artifactsDir(forkId))).toBe(false)
      expect(readFileSync(join(artifactsDir(SRC), 'chart.svg'), 'utf-8')).toBe('<svg/>')
    }
  )
})

// ─── SF-16：句柄恰好被关掉 ─────────────────

describe('SF-16 the source handle closes between peek and work', () => {
  it("SF-16 whileIdle answers 'closed' once → a second peek, then success", async () => {
    seedRow()
    const source = openSource()
    vi.spyOn(source, 'whileIdle').mockResolvedValueOnce({ ok: false, reason: 'closed' })

    const forkId = forkIdOf(await forkSession({ sessionId: SRC }))
    expect(fakeHost.callsOf('peek')).toEqual([SRC, SRC])
    expect(mocks.copy.mock.calls).toEqual([[SRC, forkId]])
    expect(sessionRecords.findById(forkId)).toBeDefined()
  })

  it('SF-16 viewSnapshot throws SessionClosedError once → a second peek, then success (reply fork)', async () => {
    seedRow()
    const source = openSource()
    vi.spyOn(source, 'viewSnapshot').mockRejectedValueOnce(new SessionClosedError(SRC))

    const forkId = forkIdOf(await forkSession({ sessionId: SRC, messageId: '2' }))
    expect(fakeHost.callsOf('peek')).toEqual([SRC, SRC])
    expect(source.callsOf('whileIdle')).toHaveLength(1)
    expect(fakeHost.instances.get(forkId)![0]!.callsOf('branchAt')).toEqual([['branchAt', 2]])
  })

  it("SF-16 whileIdle answers 'closed' twice → failed; nothing created, no storage to delete", async () => {
    seedRow()
    const source = openSource({ idleRefusal: 'closed' })
    expect(await forkSession({ sessionId: SRC })).toEqual({ success: false, reason: 'failed' })
    expect(fakeHost.callsOf('peek')).toEqual([SRC, SRC])
    expect(source.callsOf('whileIdle')).toHaveLength(2)
    expect(mocks.copy).not.toHaveBeenCalled()
    expect(rowIds()).toEqual([SRC])
    expectNothingCreated()
  })

  it('SF-16 viewSnapshot throws SessionClosedError twice → failed', async () => {
    seedRow()
    const source = openSource()
    vi.spyOn(source, 'viewSnapshot').mockRejectedValue(new SessionClosedError(SRC))
    expect(await forkSession({ sessionId: SRC, messageId: '2' })).toEqual({
      success: false,
      reason: 'failed'
    })
    expect(fakeHost.callsOf('peek')).toEqual([SRC, SRC])
    expect(mocks.copy).not.toHaveBeenCalled()
    expectNothingCreated()
  })
})

// ─── SF-17：从不 reject ─────────────────

describe('SF-17 forkSession never rejects', () => {
  it.each<[string, (source: FakeDurableSession) => void]>([
    [
      'viewSnapshot throws a plain error',
      (s) => void vi.spyOn(s, 'viewSnapshot').mockRejectedValue(new Error('boom'))
    ],
    [
      'whileIdle throws a plain error',
      (s) => void vi.spyOn(s, 'whileIdle').mockRejectedValue(new Error('boom'))
    ],
    [
      'the cleanup delete after a refused branch throws as well',
      () => {
        fakeHost.configure = (session) => {
          if (session.sessionId !== SRC) session.branchResult = { ok: false, reason: 'not_found' }
        }
        fakeHost.deleteError = new Error('delete failed')
      }
    ],
    [
      'the cleanup delete after a thrown open throws as well',
      () => {
        vi.spyOn(fakeHost, 'open').mockRejectedValue(new Error('cannot open'))
        fakeHost.deleteError = new Error('delete failed')
      }
    ]
  ])('SF-17 %s → resolves to { success: false }', async (_label, inject) => {
    seedRow()
    const source = openSource()
    inject(source)
    const result = await forkSession({ sessionId: SRC, messageId: '2' })
    expect(result.success).toBe(false)
  })

  // 契约说 forkSession「从不抛出」：真 SessionHost 的 peek 在打开存储出错（坏文件）时会抛（agent-runtime
  // durable/sessionHost.ts 的 create → openStorage），那也必须收成 `{ success: false, reason: 'failed' }`
  it('SF-17 peek of the source throws → resolves to failed', async () => {
    seedRow()
    openSource()
    vi.spyOn(fakeHost, 'peek').mockRejectedValue(new Error('storage is corrupt'))
    await expect(forkSession({ sessionId: SRC })).resolves.toEqual({
      success: false,
      reason: 'failed'
    })
  })
})

// ─── SF-18..23：临时会话（不属于任何项目）—— fork 共用源会话的工作目录 ─────────────────

/** 某条会话的临时工作区（真的 utils/paths：<userData>/temp_workspace/<id>）；只拼路径、不建 */
const tempOf = (sid: string): string => join(getTempWorkspaceBase(), sid)

/** 源会话的临时工作区建出来，放一个文件 —— 收场的各条路都不许碰它 */
function seedSourceFolder(): string {
  const dir = getTempWorkspace(SRC)
  writeFileSync(join(dir, 'notes.txt'), 'mine', 'utf-8')
  return dir
}

function expectSourceFolderIntact(dir: string): void {
  expect(dir).toBe(tempOf(SRC))
  expect(readFileSync(join(dir, 'notes.txt'), 'utf-8')).toBe('mine')
}

describe('SF-18 temp sources fork and share the source working folder', () => {
  it.each<[string, 'empty' | 'whole' | 'reply']>([
    ['an empty source (no storage)', 'empty'],
    ['a whole copy', 'whole'],
    ['a reply fork', 'reply']
  ])(
    'SF-18 %s → success: projectId / parentId null, fork title, current storage kind, workingDirectory = the source temp folder, one broadcast',
    async (_label, mode) => {
      seedRow({ projectId: null, settings: { enabledTools: ['mcp:ssh'], thinkingLevel: 'low' } })
      if (mode !== 'empty') openSource()

      const result = await forkSession(
        mode === 'reply' ? { sessionId: SRC, messageId: '2' } : { sessionId: SRC }
      )
      const forkId = forkIdOf(result)

      expect(sessionRecords.findById(forkId)).toMatchObject({
        projectId: null,
        parentId: null,
        title: 'Plan the trip · fork',
        storageKind: 'durable-sqlite-1',
        settings: {
          enabledTools: ['mcp:ssh'],
          thinkingLevel: 'low',
          workingDirectory: tempOf(SRC)
        }
      })
      expect(sessionService.getById(forkId)!.workingDirectory).toBe(tempOf(SRC))
      expect(sessionService.getById(SRC)!.workingDirectory).toBe(tempOf(SRC))
      expect(existsSync(tempOf(SRC))).toBe(true)
      expect(existsSync(tempOf(forkId))).toBe(false)
      expect(mocks.listChanged).toHaveBeenCalledTimes(1)
      expect(mocks.copy.mock.calls).toEqual(mode === 'empty' ? [] : [[SRC, forkId]])
      if (mode === 'reply') {
        expect(fakeHost.get(forkId)!.callsOf('branchAt')).toEqual([['branchAt', 2]])
      }
      // 源会话的行原样（没被写进 workingDirectory）
      expect(sessionRecords.findById(SRC)!.settings).toEqual({
        enabledTools: ['mcp:ssh'],
        thinkingLevel: 'low'
      })
    }
  )

  it('SF-18 a temp source still on the default title → the fork keeps the default title', async () => {
    seedRow({ projectId: null, title: 'New Chat' })
    openSource()
    const forkId = forkIdOf(await forkSession({ sessionId: SRC }))
    expect(sessionRecords.findById(forkId)!.title).toBe('New Chat')
    expect(sessionRecords.findById(forkId)!.settings.workingDirectory).toBe(tempOf(SRC))
  })
})

describe('SF-19 temp shapes that are not forkable', () => {
  it.each<[string, Partial<Session>, { ephemeral?: boolean }]>([
    [
      'Chrome tab session (no project)',
      {
        projectId: null,
        settings: { chromeTab: { installId: 'i', runId: 'r', tabId: 7 } } as SessionSettings
      },
      {}
    ],
    ['notebook session (no project)', { projectId: null, settings: { notebookPath: 'a.md' } }, {}],
    ['in-memory temp session', { projectId: null }, { ephemeral: true }],
    [
      'temp session on the legacy storage',
      { projectId: null, storageKind: 'harness-v3-jsonl' },
      {}
    ],
    [
      'temp session on an unknown storage kind',
      { projectId: null, storageKind: 'durable-sqlite-9' as Session['storageKind'] },
      {}
    ]
  ])(
    'SF-19 %s → not_forkable; no peek, no row, the source folder is not created',
    async (_label, patch, options) => {
      seedRow(patch, options)
      openSource()
      fakeHost.calls.length = 0
      for (const params of [{ sessionId: SRC }, { sessionId: SRC, messageId: '2' }]) {
        expect(await forkSession(params)).toEqual({ success: false, reason: 'not_forkable' })
      }
      expect(fakeHost.calls).toEqual([])
      expect(fakeHost.get(SRC)!.calls).toEqual([])
      expect(mocks.copy).not.toHaveBeenCalled()
      expectNothingCreated()
      expect(existsSync(tempOf(SRC))).toBe(false)
      expect(existsSync(getTempWorkspaceBase())).toBe(false)
    }
  )
})

describe("SF-20 half-made forks of a temp source never touch the source's folder", () => {
  it.each<['not_found' | 'invalid_target' | 'closed', 'invalid_target' | 'failed']>([
    ['not_found', 'invalid_target'],
    ['invalid_target', 'invalid_target'],
    ['closed', 'failed']
  ])('SF-20 branchAt → %s ⇒ %s', async (refusal, reason) => {
    seedRow({ projectId: null })
    const folder = seedSourceFolder()
    openSource()
    fakeHost.configure = (session) => {
      if (session.sessionId !== SRC) session.branchResult = { ok: false, reason: refusal }
    }

    expect(await forkSession({ sessionId: SRC, messageId: '4' })).toEqual({
      success: false,
      reason
    })
    const forkId = mocks.copy.mock.calls[0]![1]
    expect(rowIds()).toEqual([SRC])
    expect(existsSync(tempOf(forkId))).toBe(false)
    expectSourceFolderIntact(folder)
  })

  it.each<[string, () => void]>([
    ['copying the artifacts throws', () => (mocks.artifactsFail = true)],
    [
      'host.open(fork) throws',
      () => vi.spyOn(fakeHost, 'open').mockRejectedValueOnce(new Error('cannot open'))
    ],
    [
      'branchAt throws',
      () => {
        fakeHost.configure = (session) => {
          if (session.sessionId !== SRC) {
            session.branchAt = async () => {
              throw new Error('branch blew up')
            }
          }
        }
      }
    ],
    ['the storage copy throws', () => mocks.copy.mockRejectedValueOnce(new Error('disk full'))],
    ['the reset throws', () => mocks.reset.mockRejectedValueOnce(new Error('corrupt'))],
    [
      'opening the copied storage throws',
      () => mocks.openFile.mockRejectedValueOnce(new Error('cannot open'))
    ],
    [
      'inserting the row throws',
      () =>
        vi.spyOn(sessionRecords, 'insert').mockImplementationOnce(() => {
          throw new Error('constraint')
        })
    ]
  ])(
    'SF-20 %s → failed; the fork row is gone and the source folder is intact',
    async (_l, inject) => {
      seedRow({ projectId: null })
      const folder = seedSourceFolder()
      openSource()
      inject()

      expect(await forkSession({ sessionId: SRC, messageId: '2' })).toEqual({
        success: false,
        reason: 'failed'
      })
      const forkId = mocks.copy.mock.calls[0]![1]
      expect(rowIds()).toEqual([SRC])
      expect(existsSync(tempOf(forkId))).toBe(false)
      expectSourceFolderIntact(folder)
    }
  )
})

describe('SF-21..23 temp sources: carried working dirs, sub-session sources, busy', () => {
  it.each<[string, () => string]>([
    ['itself a fork (points at another session temp folder)', () => tempOf('original-src')],
    ['a user folder', () => '/Users/me/docs']
  ])(
    'SF-21 a source that already carries workingDirectory (%s) → the fork gets the same value',
    async (_label, carried) => {
      const dir = carried()
      seedRow({ projectId: null, settings: { enabledTools: [], workingDirectory: dir } })
      openSource()
      const forkId = forkIdOf(await forkSession({ sessionId: SRC }))

      expect(sessionRecords.findById(forkId)!.settings.workingDirectory).toBe(dir)
      expect(sessionService.getById(forkId)!.workingDirectory).toBe(dir)
      // 源会话自己的临时工作区没被问出来
      expect(existsSync(tempOf(SRC))).toBe(false)
      expect(existsSync(tempOf(forkId))).toBe(false)
    }
  )

  it("SF-22 temp sub-session source → same parent; workingDirectory = that child's own temp folder", async () => {
    sessionRecords.insert({
      id: 'P',
      title: 'Parent',
      projectId: null,
      parentId: null,
      storageKind: 'durable-sqlite-1',
      settings: {},
      createdAt: 0,
      updatedAt: 0,
      lastActiveAt: 0
    })
    seedRow({ projectId: null, parentId: 'P' })
    openSource()
    const forkId = forkIdOf(await forkSession({ sessionId: SRC }))

    const fork = sessionRecords.findById(forkId)!
    expect(fork.parentId).toBe('P')
    expect(fork.projectId).toBeNull()
    expect(fork.settings.workingDirectory).toBe(tempOf(SRC))
    expect(fork.settings.workingDirectory).not.toBe(tempOf('P'))
  })

  it('SF-23 a busy temp source → busy; no row', async () => {
    seedRow({ projectId: null })
    openSource({ busy: true })
    expect(await forkSession({ sessionId: SRC })).toEqual({ success: false, reason: 'busy' })
    expect(rowIds()).toEqual([SRC])
    expectNothingCreated()
  })
})
