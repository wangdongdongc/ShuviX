/**
 * 目标的宿主侧（services/goalService.ts，docs/goal-mode-design.md §16）—— `/goal <条件>` 把设目标的那条会话 fork 成这个
 * 目标的**管理员**：记 `settings.goalManagerOf`、换标题、给一行对原会话的「对话」权限、以人的来源把目标发进去。
 *
 * sessions 表与权限表是真的（node:sqlite 内存库 + 迁移；sessionRecords / sessionService / sessionAcl 真件），会话宿主是
 * 假的（support/fakeSessionHost）。`forkSession` 是按脚本给结果的替身 —— 缺省成功：照真的那样经
 * `sessionService.insertForkRow` 插一行（fork 自己的编排在 sessionFork.test.ts）。管理员会话的门面
 * （`sessionService.ensureAgentSession`）是间谍：`maskTexts` / `admitSteer`。文案是「键|参数」的替身，看得清取了哪个键。
 *
 *   GS-1  条件原文：空 / 只有空白 / 超过 4000 字 / 不是字符串 → goal.errorObjectiveLength（带上限），不 fork；
 *         恰 4000 字放行；首尾空白先去掉再量、再发
 *   GS-2  不能设目标的会话（子会话、bot、笔记本、Chrome 标签页、内存会话、不存在的 id）→ goal.errorNotEligible，不 fork；
 *         `eligible` 同一口径；标签页绑定不完整的算普通会话
 *   GS-3  目标的管理员自己（`settings.goalManagerOf`）→ goal.errorManagerSession（不是 NotEligible 那句），不 fork
 *   GS-4  这条会话已有一个还在忙的管理员（在跑 / 在等人回答 / 派出去的活还没回来）→ goal.errorManagerBusy 带它的标题，
 *         不 fork；管理员闲着（含被中断）、忙的是别的会话的管理员 → 照常设
 *   GS-5  fork 被拒：busy → goal.errorBusy；not_forkable / no_session → goal.errorNotEligible；其余 →
 *         goal.errorForkFailed；什么都不留下、不广播
 *   GS-6  成功：fork 的行 goalManagerOf = 原会话 id、标题 = 条件的第一行非空行、titleOrigin 'user'；
 *         grantSession(管理员, 原会话, 'write')（权限表里真有那一行）；发进管理员的是 goalSetMessage 的模型文本 + 显示
 *         侧车，来源 = 给定的 origin（没给就不带 source）；先等会话信号就绪再发；广播一次列表；交回管理员的 id
 *   GS-7  标题：「目标 · <原会话标题>」；原会话还是缺省标题时用目标原文第一行（去首尾空白、封顶 40 字 + `…`、认 CRLF）
 *   GS-8  脱敏：发出去的原文是 maskTexts 换过的那份（模型文本与侧车同一份）；标题是用户的原文；maskTexts 没交回东西
 *         就用原文
 *   GS-9  没发出去（admitSteer 交回 `{ error }` / 抛错 / 拿不到门面 / 脱敏抛错）→ 管理员会话删掉（行与权限表）、
 *         原因原话交回、原会话不动；删不掉也照样交回原因
 *   GS-10 quietRunEnd：管理员有派出去没回来的活（只数 sub-session 任务）→ true，没有 → false；干活的会话这一轮是它的
 *         管理员派的 → true，别的会话派的 / 别人的管理员派的 / 没人派 / 没开着 → false
 *   GS-11 isGoalManager：只看 `settings.goalManagerOf`
 *   GS-12 goalService 用到的六句文案在 en / zh / ja 里都有，带各自的参数位
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance
} from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeHost, resetFakeHost } from './support/fakeSessionHost'

const holder = vi.hoisted(() => ({ db: null as unknown, root: '' }))

const mocks = vi.hoisted(() => ({
  /** forkSession 的替身（缺省实现在 beforeEach 里装：成功、插一行） */
  fork: vi.fn<(params: { sessionId: string; messageId?: string }) => Promise<unknown>>(),
  listChanged: vi.fn<() => void>(),
  /** sessionRunStatus 的脚本：会话 → 状态（缺省 idle） */
  status: new Map<string, string>(),
  /** taskRegistry.runningCount 的脚本：`<会话>:<种类>` → 数 */
  running: new Map<string, number>(),
  signalsReady: vi.fn<(sessionId: string) => Promise<void>>(),
  warn: vi.fn<(message: string) => void>()
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
  getSessionArtifactsDir: (sid: string) => join(holder.root, 'artifacts', sid),
  getBuiltinSkillsDir: () => '/app/skills/en'
}))
// fork 本身的编排不在这里测：按脚本给结果
vi.mock('../sessionFork', () => ({ forkSession: mocks.fork }))
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../agentSession', async () =>
  (await import('./support/fakeSessionHost')).agentSessionModuleMock()
)
// 运行器很重（经它拖进整条派发链）：goalService 只读它的「这条会话此刻在不在一轮当中」
vi.mock('../subSessionRunner', () => ({
  sessionRunStatus: (sessionId: string) => mocks.status.get(sessionId) ?? 'idle'
}))
vi.mock('../sessionSignalSeams', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessionSignalSeams')>()),
  sessionSignalsReady: mocks.signalsReady
}))
// 文案：键 + 参数原样拼出来
vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars === undefined ? key : `${key}|${JSON.stringify(vars)}`
}))
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
vi.mock('../agentService', () => ({
  agentService: { getProfile: (name: string) => ({ name }), isSessionProfile: () => true }
}))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../fileLibrary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fileLibrary')>()),
  copySessionLibraryLinks: vi.fn(),
  removeSessionLibraryLinks: vi.fn()
}))
// 会话权限表（真的，落在同一个内存库的 session_acl 上）的派生行：会话自己的目录按 id 拼出确定的路径
vi.mock('../sandbox', () => ({
  cleanupSession: vi.fn(),
  sessionOwnDirsView: (sid: string, workingDirectory: string) => ({
    workdir: workingDirectory,
    workspaceUnsuitable: null,
    tmp: `/sandbox-tmp/${sid}`,
    artifacts: `/artifacts/${sid}`,
    toolResults: `/tool-results/${sid}`
  }),
  settingDirForAcl: (dir: string) => dir || null
}))
vi.mock('../knowledge/sessionBundle', () => ({ enabledTargets: () => [] }))
vi.mock('../skillService', () => ({ skillService: { enabledSkillRoots: () => [] } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {}, debug: () => {} })
}))

import { goalSetMessage } from '@shuvix/chat-protocol/goalSet'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { GOAL_OBJECTIVE_MAX_CHARS } from '@shuvix/chat-protocol/types/goal'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import { migrations } from '../../dao/migrations'
import type { Session, SessionSettings } from '../../dao/types'
import { sessionAcl } from '../acl'
import { clearMemoryAclForTests } from '../acl/store'
import { sessionRecords } from '../sessionRecords'
import { taskRegistry } from '../taskRegistry'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type GoalModule = typeof import('../goalService')

let goalService: GoalModule['goalService']
let isGoalManager: GoalModule['isGoalManager']
let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ goalService, isGoalManager } = await import('../goalService'))
})

// ─── 夹具 ─────────────────────────────────────

const WORKER = 'worker-1'
const WORKER_TITLE = 'Fix the login flow'
const OBJECTIVE = 'Make the e2e suite green'
const LOCAL: InputOrigin = { kind: 'local' }
const REMOTE: InputOrigin = {
  kind: 'remote',
  clientId: 'ws:4',
  address: '192.168.1.20',
  userAgent: 'UA'
}
const TOO_LONG = `goal.errorObjectiveLength|{"max":${GOAL_OBJECTIVE_MAX_CHARS}}`

/** 管理员会话的门面（ensureAgentSession 的替身交回它）：记下发了什么、按脚本给结果 */
interface Facade {
  maskTexts: ReturnType<typeof vi.fn<(texts: readonly string[]) => Promise<string[]>>>
  admitSteer: ReturnType<
    typeof vi.fn<(text: string, options: Record<string, unknown>) => Promise<{ error?: string }>>
  >
}

let facade: Facade
let ensure: MockInstance<(typeof sessionService)['ensureAgentSession']>
let grant: MockInstance<(typeof sessionAcl)['grantSession']>
/** 发消息那一段的先后（会话信号就绪 → 受理） */
let order: string[]
let forkSeq = 0

function seed(
  id: string,
  patch: Partial<Session> = {},
  options: { ephemeral?: boolean } = {}
): Session {
  const session: Session = {
    id,
    title: id === WORKER ? WORKER_TITLE : id,
    projectId: 'proj-1',
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

/** 一条现成的管理员会话（`goalManagerOf` 指着 workerId） */
const seedManager = (id: string, workerId: string, title = id): Session =>
  seed(id, { title, settings: { enabledTools: [], goalManagerOf: workerId } })

const rowIds = (): string[] =>
  sessionRecords
    .findAll()
    .map((row) => row.id)
    .sort()

/** 设一次目标，要求成功，交回管理员会话的 id */
async function started(objective: unknown = OBJECTIVE, origin?: InputOrigin): Promise<string> {
  const result = await goalService.start(WORKER, objective, origin)
  if (!result.ok) throw new Error(`expected the goal to start: ${result.error}`)
  return result.sessionId
}

/** 发进管理员会话的那一次受理：(模型文本, 选项) */
function sent(): { text: string; options: Record<string, unknown> } {
  expect(facade.admitSteer).toHaveBeenCalledTimes(1)
  const [text, options] = facade.admitSteer.mock.calls[0]!
  return { text, options }
}

/** 模型文本里 `<goal-set id="…">` 的目标 id（宿主现生成的，形如 g_ + 8 位十六进制） */
function goalIdOf(text: string): string {
  const match = /<goal-set id="(g_[0-9a-f]{8})">/.exec(text)
  expect(match, text).not.toBeNull()
  return match![1]!
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.root = mkdtempSync(join(tmpdir(), 'shuvix-goal-unit-'))
  sessionRecords.clearEphemeralForTests()
  sessionAcl.forgetReconciled()
  clearMemoryAclForTests()
  resetFakeHost()
  vi.clearAllMocks()
  mocks.status.clear()
  mocks.running.clear()
  order = []
  forkSeq = 0

  mocks.fork.mockImplementation(async ({ sessionId }) => {
    const source = sessionRecords.findById(sessionId)
    if (!source) return { success: false, reason: 'no_session' }
    const forkId = `fork-${++forkSeq}`
    sessionService.insertForkRow(source, forkId)
    return { success: true, sessionId: forkId }
  })
  mocks.signalsReady.mockImplementation(async (sessionId) => {
    order.push(`ready:${sessionId}`)
  })
  facade = {
    maskTexts: vi.fn(async (texts: readonly string[]) => [...texts]),
    admitSteer: vi.fn(async () => {
      order.push('steer')
      return {}
    })
  }
  ensure = vi
    .spyOn(sessionService, 'ensureAgentSession')
    .mockImplementation(async () => facade as never)
  grant = vi.spyOn(sessionAcl, 'grantSession')
  vi.spyOn(taskRegistry, 'runningCount').mockImplementation(
    (sessionId, kind) => mocks.running.get(`${sessionId}:${kind}`) ?? 0
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(holder.root, { recursive: true, force: true })
})

/** 被拒：给定的那句话，什么都没建、没发、没广播 */
async function expectRefused(
  sessionId: string,
  objective: unknown,
  error: string,
  options: { forked?: boolean } = {}
): Promise<void> {
  const before = rowIds()
  expect(await goalService.start(sessionId, objective, LOCAL)).toEqual({ ok: false, error })
  expect(mocks.fork).toHaveBeenCalledTimes(options.forked ? 1 : 0)
  expect(rowIds()).toEqual(before)
  expect(ensure).not.toHaveBeenCalled()
  expect(grant).not.toHaveBeenCalled()
  expect(facade.admitSteer).not.toHaveBeenCalled()
  expect(mocks.listChanged).not.toHaveBeenCalled()
}

// ─── GS-1：条件原文 ─────────────────────────────

describe('GS-1 the objective', () => {
  it.each<[string, unknown]>([
    ['empty', ''],
    ['whitespace only', '  \n\t '],
    ['4001 characters', 'x'.repeat(GOAL_OBJECTIVE_MAX_CHARS + 1)],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { text: 'ship it' }],
    ['an array', ['ship it']]
  ])('GS-1 %s → goal.errorObjectiveLength with the limit, nothing forked', async (_label, raw) => {
    seed(WORKER)
    await expectRefused(WORKER, raw, TOO_LONG)
  })

  it('GS-1 the length check comes first: an unknown session with an empty objective gets the length sentence', async () => {
    await expectRefused('nope', '', TOO_LONG)
  })

  it('GS-1 exactly 4000 characters pass; surrounding whitespace is trimmed before measuring and sending', async () => {
    seed(WORKER)
    const max = 'x'.repeat(GOAL_OBJECTIVE_MAX_CHARS)
    await started(`  \n${max}\n  `)
    expect(sent().text.startsWith(`${max}\n\n<goal-set id="`)).toBe(true)
  })
})

// ─── GS-2 / GS-3：哪些会话能设 ─────────────────────

describe('GS-2 sessions that cannot have a goal', () => {
  const SHAPES: Array<[string, Partial<Session>, { ephemeral?: boolean }]> = [
    ['a sub-session', { parentId: 'root-1' }, {}],
    ['a bot session', { settings: { enabledTools: [], bot: 'diary' } }, {}],
    ['a notebook session', { settings: { enabledTools: [], notebookPath: 'notes/a.md' } }, {}],
    [
      'a Chrome tab session',
      {
        settings: {
          enabledTools: [],
          chromeTab: { installId: 'i', runId: 'r', tabId: 3 }
        } as SessionSettings
      },
      {}
    ],
    ['an in-memory session', { projectId: null }, { ephemeral: true }]
  ]

  it.each(SHAPES)(
    'GS-2 %s → goal.errorNotEligible, nothing forked; eligible() says no',
    async (_label, patch, options) => {
      const row = seed(WORKER, patch, options)
      expect(goalService.eligible(row)).toBe(false)
      await expectRefused(WORKER, OBJECTIVE, 'goal.errorNotEligible')
    }
  )

  it('GS-2 an unknown session id → goal.errorNotEligible; eligible(undefined) is false', async () => {
    expect(goalService.eligible(undefined)).toBe(false)
    await expectRefused('nope', OBJECTIVE, 'goal.errorNotEligible')
  })

  it('GS-2 a plain top-level session is eligible, in a project or not; an incomplete tab binding does not count as a tab session', () => {
    expect(goalService.eligible(seed(WORKER))).toBe(true)
    expect(goalService.eligible(seed('temp-1', { projectId: null }))).toBe(true)
    expect(
      goalService.eligible(
        seed('half-tab', {
          settings: { enabledTools: [], chromeTab: { tabId: -1 } } as unknown as SessionSettings
        })
      )
    ).toBe(true)
  })
})

describe('GS-3 a goal manager cannot set a goal itself', () => {
  it('GS-3 settings.goalManagerOf → goal.errorManagerSession (not the not-eligible sentence), nothing forked; eligible() says no', async () => {
    seed('w0')
    const manager = seedManager(WORKER, 'w0')
    expect(goalService.eligible(manager)).toBe(false)
    await expectRefused(WORKER, OBJECTIVE, 'goal.errorManagerSession')
  })
})

// ─── GS-4：已有一个还在忙的管理员 ──────────────────

describe('GS-4 an earlier manager of the same worker', () => {
  const busyError = (title: string): string => `goal.errorManagerBusy|${JSON.stringify({ title })}`

  it.each<[string, () => void]>([
    ['is in a turn', () => mocks.status.set('m-old', 'running')],
    ['waits for an answer', () => mocks.status.set('m-old', 'waiting-input')],
    ['has work out that has not come back', () => mocks.running.set('m-old:sub-session', 1)]
  ])(
    'GS-4 the manager %s → goal.errorManagerBusy with its title, nothing forked',
    async (_l, arrange) => {
      seed(WORKER)
      seedManager('m-old', WORKER, 'Ship the report')
      arrange()
      await expectRefused(WORKER, OBJECTIVE, busyError('Ship the report'))
    }
  )

  it('GS-4 an idle or interrupted manager does not block; only sub-session tasks count as work out', async () => {
    seed(WORKER)
    seedManager('m-old', WORKER)
    mocks.status.set('m-old', 'interrupted')
    mocks.running.set('m-old:bash', 3)
    const managerId = await started()
    expect(managerId).not.toBe('m-old')
    expect(rowIds()).toEqual(['m-old', managerId, WORKER].sort())
  })

  it("GS-4 a busy manager of another session does not block; among several managers the busy one's title is reported", async () => {
    seed(WORKER)
    seed('w2')
    seedManager('m-other', 'w2', 'Other goal')
    mocks.status.set('m-other', 'running')
    await started()

    seedManager('m-idle', WORKER, 'Idle one')
    seedManager('m-busy', WORKER, 'Busy one')
    mocks.status.set('m-busy', 'running')
    expect(await goalService.start(WORKER, OBJECTIVE, LOCAL)).toEqual({
      ok: false,
      error: busyError('Busy one')
    })
  })
})

// ─── GS-5：fork 被拒 ───────────────────────────

describe('GS-5 the fork is refused', () => {
  it.each([
    ['busy', 'goal.errorBusy'],
    ['not_forkable', 'goal.errorNotEligible'],
    ['no_session', 'goal.errorNotEligible'],
    ['invalid_target', 'goal.errorForkFailed'],
    ['failed', 'goal.errorForkFailed']
  ])('GS-5 reason %s → %s; nothing is left behind', async (reason, key) => {
    seed(WORKER)
    mocks.fork.mockResolvedValueOnce({ success: false, reason })
    await expectRefused(WORKER, OBJECTIVE, key, { forked: true })
    // 整段 fork：只给源会话的 id，不给消息 id
    expect(mocks.fork.mock.calls).toEqual([[{ sessionId: WORKER }]])
    expect(sessionRecords.findById(WORKER)!.settings.goalManagerOf).toBeUndefined()
  })
})

// ─── GS-6：成功 ─────────────────────────────

describe('GS-6 a goal is set', () => {
  it('GS-6 the fork row becomes the manager: goalManagerOf, title from the objective, titleOrigin user; the worker row is untouched', async () => {
    const worker = seed(WORKER)
    const result = await goalService.start(WORKER, OBJECTIVE, LOCAL)
    expect(result).toEqual({ ok: true, sessionId: 'fork-1' })
    expect(mocks.fork.mock.calls).toEqual([[{ sessionId: WORKER }]])

    const manager = sessionRecords.findById('fork-1')!
    expect(manager.settings.goalManagerOf).toBe(WORKER)
    expect(manager.title).toBe(`goal.managerTitle|${JSON.stringify({ title: WORKER_TITLE })}`)
    expect(manager.settings.titleOrigin).toBe('user')
    expect(manager.parentId).toBeNull()
    expect(isGoalManager('fork-1')).toBe(true)

    const after = sessionRecords.findById(WORKER)!
    expect(after.title).toBe(worker.title)
    expect(after.settings).toEqual(worker.settings)
    expect(isGoalManager(WORKER)).toBe(false)
  })

  it('GS-6 the manager gets one "talk" row on the worker: grantSession(manager, worker, write), and the row is in the table', async () => {
    seed(WORKER)
    const managerId = await started()
    expect(grant.mock.calls).toEqual([[managerId, WORKER, 'write']])
    expect(
      sessionAcl
        .sessionGrants(managerId)
        .map((entry) => [entry.kind, entry.target, entry.access, entry.source])
    ).toEqual([['session', WORKER, 'write', 'user']])
    // 反过来没有：原会话并没有得到对管理员的权限
    expect(sessionAcl.sessionGrants(WORKER)).toEqual([])
  })

  it('GS-6 the message sent into the manager is goalSetMessage (model text + display sidecar) with the given origin as its source', async () => {
    seed(WORKER)
    const managerId = await started(OBJECTIVE, REMOTE)
    expect(ensure.mock.calls).toEqual([[managerId]])
    const { text, options } = sent()
    const expected = goalSetMessage({
      objective: OBJECTIVE,
      goalId: goalIdOf(text),
      worker: { id: WORKER, title: WORKER_TITLE }
    })
    expect(text).toBe(expected.text)
    expect(options).toEqual({ display: expected.display, source: REMOTE })
    // 说明里写的是原会话（干活的那条），不是管理员自己
    expect(text).toContain(`session id ${WORKER}`)
    expect(text).not.toContain(managerId)
  })

  it('GS-6 no origin given → no source key at all; each goal gets its own id', async () => {
    seed(WORKER)
    await started()
    const first = sent()
    expect('source' in first.options).toBe(false)
    expect(Object.keys(first.options)).toEqual(['display'])

    facade.admitSteer.mockClear()
    await started('Another goal')
    expect(goalIdOf(sent().text)).not.toBe(goalIdOf(first.text))
  })

  it('GS-6 order: the row is the manager before anything is sent; session signals are awaited, then the send; one list broadcast at the end', async () => {
    seed(WORKER)
    facade.admitSteer.mockImplementation(async () => {
      order.push('steer')
      const row = sessionRecords.findById('fork-1')!
      // 受理那一刻：身份、标题、权限都已经就位，列表还没广播
      expect(row.settings.goalManagerOf).toBe(WORKER)
      expect(row.title).toBe(`goal.managerTitle|${JSON.stringify({ title: WORKER_TITLE })}`)
      expect(sessionAcl.sessionGrants('fork-1')).toHaveLength(1)
      expect(mocks.listChanged).not.toHaveBeenCalled()
      return {}
    })
    await started()
    expect(order).toEqual(['ready:fork-1', 'steer'])
    expect(mocks.listChanged).toHaveBeenCalledTimes(1)
  })
})

// ─── GS-7：标题 ─────────────────────────────

describe('GS-7 the manager title', () => {
  const titled = (title: string): string => `goal.managerTitle|${JSON.stringify({ title })}`

  it('GS-7 a titled worker: "Goal · <worker title>", whatever the objective says', async () => {
    seed(WORKER)
    const objective = `${'b'.repeat(200)}\nshort`
    const managerId = await started(objective)
    expect(sessionRecords.findById(managerId)!.title).toBe(titled(WORKER_TITLE))
    // 发出去的是整段原文，不是标题
    expect(sent().text.startsWith(`${objective}\n\n<goal-set id="`)).toBe(true)
  })

  // 原会话还是缺省标题（刚建就设目标）：用目标原文的第一行，封顶 40 字
  it.each<[string, string, string]>([
    ['one line', 'Ship the report', 'Ship the report'],
    [
      'the first non-empty line, trimmed',
      '   \n\t\n  Second line is the first with words  \nmore',
      'Second line is the first with words'
    ],
    ['CRLF', 'First line\r\nsecond line', 'First line'],
    ['exactly 40 characters', 'a'.repeat(40), 'a'.repeat(40)],
    ['41 characters', 'a'.repeat(41), `${'a'.repeat(40)}…`],
    ['CJK', '让 e2e 全绿\n并且构建通过', '让 e2e 全绿']
  ])('GS-7 a worker with the default title: %s', async (_label, objective, name) => {
    seed(WORKER, { title: 'agent.defaultTitle' })
    const managerId = await started(objective)
    expect(sessionRecords.findById(managerId)!.title).toBe(titled(name))
  })
})

// ─── GS-8：脱敏 ─────────────────────────────

describe('GS-8 redaction', () => {
  const SECRET = 'sk-proj-SECRETSECRET'
  const MASKED = '{{REDACTED_API_KEY_aaaaaaaa}}'

  it('GS-8 the masked objective is what is sent (model text and sidecar alike)', async () => {
    seed(WORKER)
    facade.maskTexts.mockImplementation(async (texts) =>
      texts.map((text) => text.replaceAll(SECRET, MASKED))
    )
    const objective = `Rotate ${SECRET} everywhere`
    const managerId = await started(objective)
    expect(facade.maskTexts.mock.calls).toEqual([[[objective]]])

    const { text, options } = sent()
    const expected = goalSetMessage({
      objective: `Rotate ${MASKED} everywhere`,
      goalId: goalIdOf(text),
      worker: { id: WORKER, title: WORKER_TITLE }
    })
    expect(text).toBe(expected.text)
    expect(options.display).toEqual(expected.display)
    expect(JSON.stringify([text, options])).not.toContain(SECRET)
    expect(sessionRecords.findById(managerId)!.title).toBe(
      `goal.managerTitle|${JSON.stringify({ title: WORKER_TITLE })}`
    )
  })

  it('GS-8 maskTexts hands back nothing → the objective is sent as written', async () => {
    seed(WORKER)
    facade.maskTexts.mockResolvedValueOnce([])
    await started()
    expect(sent().text.startsWith(`${OBJECTIVE}\n\n<goal-set id="`)).toBe(true)
  })
})

// ─── GS-9：没发出去 ───────────────────────────

describe('GS-9 the goal message is not delivered', () => {
  /** 失败之后：管理员会话没了（行与权限表），原会话原样，列表广播过 */
  function expectRolledBack(worker: Session): void {
    expect(rowIds()).toEqual([WORKER])
    expect(sessionRecords.findById('fork-1')).toBeUndefined()
    expect(sessionAcl.sessionGrants('fork-1')).toEqual([])
    expect(isGoalManager('fork-1')).toBe(false)
    const after = sessionRecords.findById(WORKER)!
    expect(after.title).toBe(worker.title)
    expect(after.settings).toEqual(worker.settings)
    expect(mocks.listChanged).toHaveBeenCalled()
    expect(fakeHost.callsOf('delete')).toEqual(['fork-1'])
  }

  it('GS-9 admitSteer answers { error } → the fork is deleted and the error text is returned as it is', async () => {
    const worker = seed(WORKER)
    facade.admitSteer.mockResolvedValueOnce({ error: 'No model is configured' })
    expect(await goalService.start(WORKER, OBJECTIVE, LOCAL)).toEqual({
      ok: false,
      error: 'No model is configured'
    })
    // 走到了受理那一步：身份与权限都写过，随后一并收回
    expect(grant.mock.calls).toEqual([['fork-1', WORKER, 'write']])
    expectRolledBack(worker)
  })

  it.each<[string, unknown, string]>([
    ['an Error', new Error('storage is gone'), 'storage is gone'],
    ['a plain string', 'boom', 'boom']
  ])(
    'GS-9 admitSteer throws %s → the fork is deleted, the message is returned',
    async (_l, thrown, text) => {
      const worker = seed(WORKER)
      facade.admitSteer.mockRejectedValueOnce(thrown)
      expect(await goalService.start(WORKER, OBJECTIVE, LOCAL)).toEqual({ ok: false, error: text })
      expectRolledBack(worker)
    }
  )

  it('GS-9 no agent session for the fork → goal.errorForkFailed, the fork is deleted, nothing is sent', async () => {
    const worker = seed(WORKER)
    ensure.mockResolvedValueOnce(undefined)
    expect(await goalService.start(WORKER, OBJECTIVE, LOCAL)).toEqual({
      ok: false,
      error: 'goal.errorForkFailed'
    })
    expect(facade.admitSteer).not.toHaveBeenCalled()
    expectRolledBack(worker)
  })

  it('GS-9 masking throws → the fork is deleted, nothing is sent', async () => {
    const worker = seed(WORKER)
    facade.maskTexts.mockRejectedValueOnce(new Error('redaction table locked'))
    expect(await goalService.start(WORKER, OBJECTIVE, LOCAL)).toEqual({
      ok: false,
      error: 'redaction table locked'
    })
    expect(facade.admitSteer).not.toHaveBeenCalled()
    expectRolledBack(worker)
  })

  it('GS-9 deleting the unused fork fails too → still the original error, never a rejection; a warning is logged', async () => {
    seed(WORKER)
    facade.admitSteer.mockResolvedValueOnce({ error: 'No model is configured' })
    vi.spyOn(sessionService, 'delete').mockRejectedValueOnce(new Error('disk busy'))
    expect(await goalService.start(WORKER, OBJECTIVE, LOCAL)).toEqual({
      ok: false,
      error: 'No model is configured'
    })
    expect(mocks.warn.mock.calls.some(([line]) => line.includes('disk busy'))).toBe(true)
    expect(mocks.listChanged).toHaveBeenCalled()
  })

  it('GS-9 after a failed attempt the same session can set the goal again', async () => {
    seed(WORKER)
    facade.admitSteer.mockResolvedValueOnce({ error: 'No model is configured' })
    expect((await goalService.start(WORKER, OBJECTIVE, LOCAL)).ok).toBe(false)
    expect(await goalService.start(WORKER, OBJECTIVE, LOCAL)).toEqual({
      ok: true,
      sessionId: 'fork-2'
    })
    expect(rowIds()).toEqual(['fork-2', WORKER].sort())
  })
})

// ─── GS-10 / GS-11：安静的收尾、管理员身份 ────────────────

describe('GS-10 quietRunEnd', () => {
  const driven = (parentId: string): { drivenRun: never } => ({
    drivenRun: { requestId: 'r1', parentId, background: true, conversationId: 1 } as never
  })

  it('GS-10 a manager: quiet while work it handed out has not come back (sub-session tasks only), otherwise not', () => {
    seed(WORKER)
    seedManager('m1', WORKER)
    expect(goalService.quietRunEnd('m1')).toBe(false)
    mocks.running.set('m1:bash', 2)
    expect(goalService.quietRunEnd('m1')).toBe(false)
    mocks.running.set('m1:sub-session', 1)
    expect(goalService.quietRunEnd('m1')).toBe(true)
    mocks.running.set('m1:sub-session', 0)
    expect(goalService.quietRunEnd('m1')).toBe(false)
  })

  it('GS-10 a manager is judged by its own tasks, never by who drives it', () => {
    seed(WORKER)
    seedManager('m1', WORKER)
    seedManager('m2', 'm1')
    fakeHost.put('m1', driven('m2'))
    expect(goalService.quietRunEnd('m1')).toBe(false)
  })

  it('GS-10 a worker: quiet when this run was sent by its own manager', () => {
    seed(WORKER)
    seedManager('m1', WORKER)
    fakeHost.put(WORKER, driven('m1'))
    expect(goalService.quietRunEnd(WORKER)).toBe(true)
  })

  it.each<[string, () => void]>([
    ['a session that is not a manager', () => void seed('other')],
    ['the manager of a different session', () => void seedManager('other', 'someone-else')],
    ['a session that no longer exists', () => {}]
  ])('GS-10 a worker driven by %s → not quiet', (_label, arrange) => {
    seed(WORKER)
    arrange()
    fakeHost.put(WORKER, driven('other'))
    expect(goalService.quietRunEnd(WORKER)).toBe(false)
  })

  it('GS-10 a worker that is not driven, or not open at all → not quiet', () => {
    seed(WORKER)
    seedManager('m1', WORKER)
    expect(goalService.quietRunEnd(WORKER)).toBe(false)
    fakeHost.put(WORKER)
    expect(goalService.quietRunEnd(WORKER)).toBe(false)
    expect(goalService.quietRunEnd('nope')).toBe(false)
  })
})

describe('GS-11 isGoalManager', () => {
  it('GS-11 only settings.goalManagerOf counts; an empty value and an unknown session do not', () => {
    seed(WORKER)
    seedManager('m1', WORKER)
    seed('blank', { settings: { enabledTools: [], goalManagerOf: '' } })
    expect(isGoalManager('m1')).toBe(true)
    expect(isGoalManager(WORKER)).toBe(false)
    expect(isGoalManager('blank')).toBe(false)
    expect(isGoalManager('nope')).toBe(false)
  })
})

// ─── GS-12：文案在不在 ──────────────────────────

describe('GS-12 the sentences goalService returns exist in every language', () => {
  const KEYS = [
    'errorObjectiveLength',
    'errorNotEligible',
    'errorManagerSession',
    'errorManagerBusy',
    'errorBusy',
    'errorForkFailed'
  ] as const

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ] as const)(
    'GS-12 %s: all six keys are non-empty; the two with parameters carry their slots',
    (_lang, locale) => {
      const goal = locale.goal as Record<string, unknown>
      for (const key of KEYS) {
        expect(typeof goal[key], key).toBe('string')
        expect((goal[key] as string).trim(), key).not.toBe('')
      }
      expect(goal.errorObjectiveLength).toContain('{{max}}')
      expect(goal.errorManagerBusy).toContain('{{title}}')
    }
  )
})
