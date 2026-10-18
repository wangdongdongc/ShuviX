/**
 * 子会话运行器的「查看现场」（`inspect`，docs/sub-session-design.md §19.7）与 `userIntervened` 信号（§19.10 第 18 条）。
 *
 * 钉的是：
 *   - **只读**：开着的会话直接读视图，没开的 peek 一次，从不创建、不发送、不建任务，也不受「这一轮是谁发起的」限制；
 *   - **准入与 read 同一套**：越权 / 不存在 / 省略 id 的补全 / 调用方形态 / 旧格式会话拒绝；
 *   - **读不了就说读不了**：没有存储、读视图失败都给明确的回话（不是一个吓人的异常、也不是凭空的「没有这一条」）；
 *   - **`userIntervened`**：父会话最近一次发进去的消息之后人又说过话 —— 有来源记录 = 不是人打的；系统通知不算；
 *     读不了就当没有。在 read / wait / 完成通知 / inspect 上带，list 与回执（prompt / answer，§20 起一律只回执）不带。
 *     判法与大纲、自动审查同一份（`authorsOf`，§19.7 2026-10-17 裁决第 4 条）：只有最近一条用户消息被判为人打的
 *     （没有记录、且在第一条有记录的消息之后）才是 true；整条都没有记录的分不清，不算（AUTH-I1..4）。
 *
 * mock 手法照 subSessionRunner.test.ts（那一份归另一组用例，这里照抄形状，假子会话补上 `sessionView()` /
 * `inputSources()` / `respondToInput()`）。用例编号 WP4-xx 对应测试设计清单。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type {
  AssistantBlock,
  ChatMessage,
  UserTextMeta
} from '@shuvix/chat-protocol/types/chatMessage'
import type { ChoiceInputRequest, InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { QueuedInputView } from '@shuvix/chat-protocol/types/sessionView'
import { SessionClosedError } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  pick: vi.fn<(id: string, cols: string[]) => unknown>(),
  findChildren: vi.fn<(id: string) => Array<Record<string, unknown>>>(),
  create: vi.fn(),
  updateTitle: vi.fn(),
  pinAgentProfile: vi.fn(),
  resolveRunConfig: vi.fn(),
  getAgentSession: vi.fn(),
  peekAgentSession: vi.fn(),
  ensureAgentSession: vi.fn(),
  deliver: vi.fn(),
  gatewayPrompt: vi.fn(),
  recordSessionModel: vi.fn(),
  recordSessionThinkingLevel: vi.fn(),
  findLastBySession: vi.fn(),
  warn: vi.fn(),
  durable: { value: true }
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.pick,
    findChildren: mocks.findChildren
  }
}))
vi.mock('../../services/sessionService', () => ({
  sessionService: {
    create: mocks.create,
    updateTitle: mocks.updateTitle,
    pinAgentProfile: mocks.pinAgentProfile,
    resolveRunConfig: mocks.resolveRunConfig,
    getAgentSession: mocks.getAgentSession,
    peekAgentSession: mocks.peekAgentSession,
    ensureAgentSession: mocks.ensureAgentSession,
    deliverSubSessionNotice: mocks.deliver
  }
}))
vi.mock('../../frontend/core', () => ({ chatGateway: { prompt: mocks.gatewayPrompt } }))
vi.mock('../../services/messageService', () => ({
  messageService: { findLastBySession: mocks.findLastBySession }
}))
vi.mock('../../services/sessionStorage', () => ({
  isDurableSession: () => mocks.durable.value,
  recordSessionModel: mocks.recordSessionModel,
  recordSessionThinkingLevel: mocks.recordSessionThinkingLevel
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() })
}))

type Mod = typeof import('../subSessionRunner')
let runner: Mod['subSessionRunner']
let registry: typeof import('../taskRegistry')

const PARENT = 'parent-1'
const CHILD = 'child-1'

// ─────────────────────────── 视图夹具 ───────────────────────────

const U = (id: string, content: string, meta?: UserTextMeta): ChatMessage => ({
  id,
  sessionId: CHILD,
  role: 'user',
  type: 'text',
  content,
  model: '',
  createdAt: 0,
  metadata: meta ?? null
})

const A = (id: string, blocks: AssistantBlock[]): ChatMessage => ({
  id,
  sessionId: CHILD,
  role: 'assistant',
  type: 'message',
  blocks,
  content: blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''),
  model: 'm',
  createdAt: 0,
  metadata: null
})

const TX = (text: string): AssistantBlock => ({ type: 'text', text })
const TOOL = (id: string): AssistantBlock => ({
  type: 'tool',
  toolCallId: id,
  toolName: 'read',
  args: { path: 'a.ts' },
  result: 'ok'
})

interface FakeView {
  messages: ChatMessage[]
  live: null
  asks: InputRequest[]
  queue: QueuedInputView[]
  run: { state: 'idle' | 'busy' | 'interrupted' }
}

const viewOf = (messages: ChatMessage[], queue: QueuedInputView[] = []): FakeView => ({
  messages,
  live: null,
  asks: [],
  queue,
  run: { state: 'idle' }
})

/** 来源表：这些用户消息是 `from` 会话发的（缺省父会话） */
const sourcesOf = (ids: string[], from = PARENT): Map<string, unknown> =>
  new Map(ids.map((id) => [id, { kind: 'parent-session', sessionId: from }]))

type Mock = ReturnType<typeof vi.fn>

/** 一个假的子会话门面：状态 getter + 读路径 + 介入的几个入口（都只记账） */
interface FakeAgent {
  isStreaming: boolean
  isInterrupted: boolean
  pendingInputCount: number
  pendingInputSummaries: string[]
  drivenRun: unknown
  /** 挂着的询问（给了就用它；否则按摘要还原成权限卡） */
  pending: InputRequest[] | null
  view: FakeView
  sources: Map<string, unknown>
  abort: Mock
  notify: Mock
  steer: Mock
  admitSteer: Mock
  respondToInput: Mock
  lastAnswer: Mock
  requestState: Mock
  resumeInterrupted: Mock
  taskLiveness: Mock
  sessionView: Mock
  inputSources: Mock
  pendingInputs: () => InputRequest[]
}

function fakeAgent(
  over: Partial<{ isStreaming: boolean; pendingInputCount: number; isInterrupted: boolean }> = {}
): FakeAgent {
  const agent: FakeAgent = {
    isStreaming: over.isStreaming ?? false,
    isInterrupted: over.isInterrupted ?? false,
    pendingInputCount: over.pendingInputCount ?? 0,
    pendingInputSummaries: [],
    drivenRun: undefined,
    pending: null,
    view: viewOf([]),
    sources: new Map<string, unknown>(),
    abort: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn(),
    admitSteer: vi.fn(),
    respondToInput: vi.fn().mockReturnValue(true),
    lastAnswer: vi.fn().mockResolvedValue(undefined),
    requestState: vi.fn().mockResolvedValue('none'),
    resumeInterrupted: vi.fn().mockResolvedValue({}),
    taskLiveness: vi.fn().mockResolvedValue(undefined),
    sessionView: vi.fn(async (): Promise<FakeView> => agent.view),
    inputSources: vi.fn(async (): Promise<Map<string, unknown>> => agent.sources),
    pendingInputs: (): InputRequest[] =>
      agent.pending ??
      agent.pendingInputSummaries.map((summary, i) => {
        const [toolName, ...rest] = summary.split(': ')
        return { id: `ask-${i}`, kind: 'ask', toolName, command: rest.join(': '), createdAt: 0 }
      })
  }
  return agent
}

/** 没开着的子会话被 peek 打开之后的那个门面 */
let closedChild: FakeAgent

/** 运行时报来的一次 driven 落定（与 subSessionRunner.test.ts 同形） */
function settled(
  over: Partial<{ requestId: string; background: boolean }> = {}
): Parameters<Mod['subSessionRunner']['onDrivenSettled']>[0] {
  return {
    sessionId: CHILD,
    parentId: PARENT,
    requestId: over.requestId ?? 'subsession:parent-1:1',
    background: over.background ?? true,
    conversationId: 1 as never,
    submissionId: 42 as never,
    noticeRequestId: `subsession-done:${CHILD}:42`,
    result: {},
    record: { status: 'done' }
  }
}

const CHILD_ROW = { id: CHILD, title: 'Child', updatedAt: 2 }

function defaultWorld(): void {
  mocks.pick.mockImplementation((id: string) => {
    if (id === PARENT) return { settings: {}, parentId: null, title: 'Parent', updatedAt: 1 }
    if (id === CHILD) return { settings: {}, parentId: PARENT, title: 'Child', updatedAt: 2 }
    return undefined
  })
  mocks.findChildren.mockReturnValue([CHILD_ROW])
  mocks.getAgentSession.mockReturnValue(undefined)
  closedChild = fakeAgent()
  mocks.peekAgentSession.mockImplementation(
    async (id: string) => mocks.getAgentSession(id) ?? (id === CHILD ? closedChild : undefined)
  )
  mocks.ensureAgentSession.mockImplementation(async (id: string) => mocks.getAgentSession(id))
  mocks.deliver.mockResolvedValue(undefined)
  mocks.durable.value = true
  mocks.gatewayPrompt.mockResolvedValue({})
  mocks.findLastBySession.mockResolvedValue(undefined)
  mocks.resolveRunConfig.mockResolvedValue({ model: null, thinkingLevel: 'medium' })
  mocks.pinAgentProfile.mockResolvedValue({ success: true, applied: { tools: [] } })
  mocks.create.mockReturnValue({ id: CHILD, title: 'Child' })
}

beforeAll(async () => {
  runner = (await import('../subSessionRunner')).subSessionRunner
  registry = await import('../taskRegistry')
})

beforeEach(() => {
  vi.useRealTimers()
  registry.taskRegistry.killAll()
  runner.resetForTests()
  for (const fn of Object.values(mocks)) if (typeof fn === 'function') fn.mockReset()
  defaultWorld()
})

const err = (r: unknown): string => (r as { error: string }).error

type Inspected = Extract<Awaited<ReturnType<Mod['subSessionRunner']['inspect']>>, { info: unknown }>

async function inspect(query: Record<string, unknown> = {}, childId = CHILD): Promise<Inspected> {
  const res = await runner.inspect({ parentId: PARENT, childId, query })
  if ('error' in res) throw new Error(`unexpected error: ${res.error}`)
  return res
}

/** 让下一次 gatewayPrompt 挂住；返回放行它的函数 */
function holdGateway(): () => void {
  let release!: () => void
  mocks.gatewayPrompt.mockReturnValue(
    new Promise<Record<string, never>>((r) => {
      release = () => r({})
    })
  )
  return release
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────── inspect ───────────────────────────

describe('inspect —— 只读地看子会话现场', () => {
  it('WP4-104 开着的子会话：读一次视图与来源，读者是父会话；状态取自运行时', async () => {
    const open = fakeAgent({ isStreaming: true })
    open.view = viewOf([U('1', 'go'), A('2', [TX('ok')])])
    open.sources = sourcesOf(['1'])
    mocks.getAgentSession.mockImplementation((id: string) => (id === CHILD ? open : undefined))

    const res = await inspect()
    expect(Object.keys(res).sort()).toEqual(['info', 'result'])
    expect(open.sessionView).toHaveBeenCalledTimes(1)
    expect(open.inputSources).toHaveBeenCalledTimes(1)
    expect(mocks.peekAgentSession).not.toHaveBeenCalled()
    expect(res.info).toMatchObject({ id: CHILD, title: 'Child', status: 'running' })
    expect(res.result.kind).toBe('outline')
    expect((res.result as { lines: string[] }).lines).toEqual(['#1 [you] go', '#2.0 reply: ok'])
  })

  it('WP4-105 没开着、存储在 → peek 读：从不创建、不发送、不动它、不建任务、不算驱动', async () => {
    closedChild.view = viewOf([U('1', 'go'), A('2', [TX('done')])])
    const res = await inspect()
    // 没有来源记录：分不清是谁写的（§19.7 裁决第 4 条），不是 [user]
    expect((res.result as { lines: string[] }).lines).toEqual([
      '#1 [unattributed] go',
      '#2.0 reply: done'
    ])
    expect(mocks.peekAgentSession).toHaveBeenCalledWith(CHILD)
    expect(mocks.ensureAgentSession).not.toHaveBeenCalled()
    expect(mocks.gatewayPrompt).not.toHaveBeenCalled()
    for (const fn of [
      closedChild.abort,
      closedChild.notify,
      closedChild.respondToInput,
      closedChild.steer,
      closedChild.admitSteer,
      closedChild.resumeInterrupted
    ]) {
      expect(fn).not.toHaveBeenCalled()
    }
    expect(registry.taskRegistry.list(PARENT)).toEqual([])
    const listed = runner.list(PARENT) as { subSessions: Array<{ driven: boolean }> }
    expect(listed.subSessions.map((s) => s.driven)).toEqual([false])
  })

  it('WP4-106 还没有存储：大纲为空；item → 「什么都还没发生」；match → 零命中；空的 item / match 视同没给', async () => {
    mocks.peekAgentSession.mockResolvedValue(undefined)
    const empty = {
      kind: 'outline',
      lines: [],
      turnFrom: 0,
      turnTo: 0,
      turnCount: 0,
      shown: 0,
      total: 0,
      earlierTurns: false
    }
    expect((await inspect()).result).toEqual(empty)
    expect((await inspect({ item: '' })).result).toEqual(empty)
    expect((await inspect({ match: '   ' })).result).toEqual(empty)
    for (const item of ['#3', '  #3 ']) {
      expect(await runner.inspect({ parentId: PARENT, childId: CHILD, query: { item } })).toEqual({
        error: 'No item #3 — nothing has happened in that sub-session yet.'
      })
    }
    expect((await inspect({ match: ' x ' })).result).toEqual({
      kind: 'match',
      query: 'x',
      lines: [],
      hits: 0,
      shown: 0
    })
    expect(mocks.ensureAgentSession).not.toHaveBeenCalled()
  })

  it('WP4-107 旧格式子会话：拒绝（说清用 read 拿答复），不为此打开它', async () => {
    mocks.durable.value = false
    const msg = err(await runner.inspect({ parentId: PARENT, childId: CHILD, query: {} }))
    expect(msg).toContain('created by an earlier version of ShuviX')
    expect(msg).toContain('"read-sub-session"')
    expect(mocks.peekAgentSession).not.toHaveBeenCalled()
    expect(mocks.getAgentSession).not.toHaveBeenCalled()
  })

  it('WP4-108 别人的 / 不存在的子会话 → 与 read 同一套错误（列出合法 id），不碰对方', async () => {
    mocks.pick.mockImplementation((id: string) => {
      if (id === PARENT) return { settings: {}, parentId: null }
      if (id === 'stranger') return { settings: {}, parentId: 'other-parent', title: 'S' }
      return undefined
    })
    mocks.findChildren.mockReturnValue([{ id: 'mine-1', title: 'Mine', updatedAt: 1 }])
    for (const target of ['stranger', 'ghost']) {
      const msg = err(await runner.inspect({ parentId: PARENT, childId: target, query: {} }))
      expect(msg).toContain('is not a sub-session of this session')
      expect(msg).toContain('mine-1')
      const viaRead = err(await runner.read(PARENT, target))
      expect(msg).toBe(viaRead)
    }
    expect(mocks.peekAgentSession.mock.calls.map(([id]) => id)).not.toContain('stranger')
  })

  it('WP4-109 省略 id：恰好一条就补全；没有 / 多于一条给出下一步', async () => {
    closedChild.view = viewOf([U('1', 'go')])
    expect((await inspect({}, '')).info.id).toBe(CHILD)

    mocks.findChildren.mockReturnValue([])
    expect(err(await runner.inspect({ parentId: PARENT, childId: '', query: {} }))).toMatch(
      /No sub-sessions yet/
    )

    mocks.findChildren.mockReturnValue([CHILD_ROW, { id: 'child-2', title: 'Two', updatedAt: 3 }])
    const msg = err(await runner.inspect({ parentId: PARENT, childId: '', query: {} }))
    expect(msg).toMatch(/Which sub-session\?/)
    expect(msg).toContain(CHILD)
    expect(msg).toContain('child-2')
  })

  it('WP4-110 调用方不是普通会话：笔记本 / 子会话自己 / 没有会话', async () => {
    const call = (): ReturnType<Mod['subSessionRunner']['inspect']> =>
      runner.inspect({ parentId: PARENT, childId: CHILD, query: {} })
    mocks.pick.mockReturnValue({ settings: { notebookPath: 'n.md' }, parentId: null })
    expect(err(await call())).toBe('Notebook sessions cannot have sub-sessions.')
    mocks.pick.mockReturnValue({ settings: {}, parentId: 'someone' })
    expect(err(await call())).toMatch(/already a sub-session/)
    mocks.pick.mockReturnValue(undefined)
    expect(err(await call())).toMatch(/not attached to a session/)
  })

  it.each([true, false])(
    'WP4-111 不受「这一轮是谁发起的」限制：用户自己发起的一轮（streaming=%s、没有驱动记录）照样看',
    async (streaming) => {
      const open = fakeAgent({ isStreaming: streaming })
      // 父会话先发过一条（锚点），这一轮是人在它之后自己起的
      open.view = viewOf([
        U('1', 'task'),
        A('2', [TX('done')]),
        U('3', 'user started this'),
        A('4', [TOOL('c1')])
      ])
      open.sources = sourcesOf(['1'])
      mocks.getAgentSession.mockImplementation((id: string) => (id === CHILD ? open : undefined))
      const res = await inspect()
      expect(res.info.status).toBe(streaming ? 'running' : 'idle')
      expect(res.info.driven).toBe(false)
      expect((res.result as { lines: string[] }).lines[0]).toBe('#3 [user] user started this')
    }
  )

  it('WP4-112 大纲报错（编号不存在）→ {error}，不带 info', async () => {
    closedChild.view = viewOf([U('1', 'go')])
    for (const query of [{ item: '#999' }, { before: '#999' }]) {
      expect(await runner.inspect({ parentId: PARENT, childId: CHILD, query })).toEqual({
        error: 'No item #999 in this conversation. Take a ref from the outline.'
      })
    }
  })

  it.each(['inputSources', 'sessionView'] as const)(
    'WP4-113 读视图时会话恰好关了（%s 抛）→ 明确的「再试一次」，记一条 warn；之后 list / read 照常',
    async (which) => {
      closedChild.view = viewOf([U('1', 'go')])
      closedChild[which].mockRejectedValueOnce(new SessionClosedError(CHILD))
      const res = await runner.inspect({ parentId: PARENT, childId: CHILD, query: {} })
      expect(res).toEqual({
        error:
          'Could not read sub-session "Child" right now (it was just closed or is being reopened). Try again.'
      })
      expect(mocks.warn).toHaveBeenCalledTimes(1)
      expect(String(mocks.warn.mock.calls[0][0])).toContain(CHILD)

      expect(runner.list(PARENT)).toHaveProperty('subSessions')
      closedChild.lastAnswer.mockResolvedValue({ text: 'DONE.' })
      expect(await runner.read(PARENT, CHILD)).toMatchObject({ answer: 'DONE.' })
      expect((await inspect()).result.kind).toBe('outline')
    }
  )

  it('WP4-114 查询原样交给大纲：turns / item / match / before 各得到对应的结果', async () => {
    closedChild.view = viewOf([
      U('1', 'q1'),
      A('2', [TX('a')]),
      U('3', 'q2'),
      A('4', [TX('b')]),
      U('5', 'q3'),
      A('6', [TX('needle here')])
    ])
    const turns = (await inspect({ turns: 2 })).result as { kind: string; turnFrom: number }
    expect(turns).toMatchObject({ kind: 'outline', turnFrom: 2 })
    expect((await inspect({ item: '#2.0' })).result).toEqual({
      kind: 'item',
      ref: '#2.0',
      lines: ['reply:', 'a']
    })
    expect((await inspect({ match: 'needle' })).result).toMatchObject({
      kind: 'match',
      hits: 1,
      lines: ['#6.0 reply: needle here']
    })
    expect((await inspect({ before: '#2.0' })).result).toMatchObject({
      kind: 'outline',
      lines: ['#1 [unattributed] q1']
    })
  })

  it('§19.10-18 inspect 的 info 也带 userIntervened（人在父会话最后一条消息之后说过话）', async () => {
    closedChild.view = viewOf([
      U('1', 'task'),
      A('2', [TX('a')]),
      U('3', 'human'),
      A('4', [TX('b')])
    ])
    closedChild.sources = sourcesOf(['1'])
    expect((await inspect()).info.userIntervened).toBe(true)

    closedChild.view = viewOf([U('1', 'task'), A('2', [TX('a')])])
    expect((await inspect()).info).not.toHaveProperty('userIntervened')

    // 整条都没有来源记录（升级之前的子会话）：分不清 → 不报「用户插过话」，大纲里也是 [unattributed]
    closedChild.view = viewOf([U('1', 'old task'), A('2', [TX('a')]), U('3', 'typed')])
    closedChild.sources = new Map()
    const old = await inspect()
    expect(old.info).not.toHaveProperty('userIntervened')
    expect((old.result as { lines: string[] }).lines).toContain('#3 [unattributed] typed')
  })
})

// ─────────────────────────── userIntervened ───────────────────────────

async function readInfo(): Promise<Record<string, unknown>> {
  const res = await runner.read(PARENT, CHILD)
  if ('error' in res) throw new Error(res.error)
  return res.info as unknown as Record<string, unknown>
}

describe('userIntervened —— 人在子会话里插过话的那个便宜信号', () => {
  const NOTICE: UserTextMeta = { isSystemNotice: true }
  const INJECTION: UserTextMeta = { isInstructionInjection: true }

  it.each<[string, ChatMessage[], string[], boolean]>([
    ['WP4-115 最后一条用户消息是父会话发的 → 不带', [U('1', 'p'), A('2', [TX('a')])], ['1'], false],
    [
      'WP4-116 父会话发过之后用户又说了话 → true',
      [U('1', 'p'), A('2', [TX('a')]), U('3', 'human'), A('4', [TX('b')])],
      ['1'],
      true
    ],
    [
      'WP4-117 用户先说、父会话后发 → 不带',
      [U('1', 'human'), A('2', [TX('a')]), U('3', 'p')],
      ['3'],
      false
    ],
    [
      'WP4-118 系统通知 / 指令注入不算：跳过它们落到人打的那条 → true',
      [
        U('1', 'p'),
        U('2', 'human'),
        A('3', [TX('a')]),
        U('4', '<background-task id="x">done</background-task>', NOTICE),
        U('5', '# AGENTS.md', INJECTION)
      ],
      ['1'],
      true
    ],
    [
      'WP4-118 父会话的消息之后只有系统通知 → 不带',
      [U('1', 'p'), A('2', [TX('a')]), U('3', '<background-task id="x"/>', NOTICE)],
      ['1'],
      false
    ],
    [
      'WP4-119 父会话的引导（带来源）算父会话的 → 不带',
      [U('1', 'human task'), A('2', [TOOL('c1')]), U('3', 'parent steer')],
      ['3'],
      false
    ],
    ['WP4-120 没有用户消息 → 不带', [A('1', [TX('hello')])], [], false],
    [
      'WP4-120 只有通知 → 不带',
      [U('1', '<sub-session id="x"/>', NOTICE), A('2', [TX('a')])],
      [],
      false
    ],
    [
      '§19.10-18 来源是别的会话：有来源记录 = 不是人打的 → 不带',
      [U('1', 'p'), A('2', [TX('a')]), U('3', 'other parent')],
      ['1', '3'],
      false
    ],
    [
      'AUTH-I1 整条都没有来源记录（升级之前的子会话）：最后一条分不清作者 → 不带',
      [U('1', 'old task'), A('2', [TX('a')]), U('3', 'typed later')],
      [],
      false
    ],
    [
      'AUTH-I2 锚点之前的旧消息 + 锚点 + 人打的 → true',
      [U('1', 'old task'), U('2', 'p'), A('3', [TX('a')]), U('4', 'human')],
      ['2'],
      true
    ],
    [
      'AUTH-I3 父会话 → 人 → 父会话：最近一条是父会话发的 → 不带（只看最近一条用户消息）',
      [U('1', 'p'), U('2', 'human'), A('3', [TX('a')]), U('4', 'p again')],
      ['1', '4'],
      false
    ]
  ])('%s', async (_label, messages, fromParent, expected) => {
    closedChild.view = viewOf(messages)
    closedChild.sources = sourcesOf(fromParent)
    const info = await readInfo()
    if (expected) expect(info.userIntervened).toBe(true)
    else expect(info).not.toHaveProperty('userIntervened')
  })

  it('AUTH-I4 认不出的来源（读来源时失败闭合补的 sessionId 空串）也立锚点：之后人打的 → true；它自己是最近一条 → 不带', async () => {
    closedChild.view = viewOf([
      U('1', 'written by something newer'),
      A('2', [TX('a')]),
      U('3', 'human')
    ])
    closedChild.sources = sourcesOf(['1'], '')
    expect((await readInfo()).userIntervened).toBe(true)

    closedChild.view = viewOf([U('1', 'p'), U('2', 'human'), U('3', 'written by something newer')])
    closedChild.sources = new Map<string, unknown>([
      ['1', { kind: 'parent-session', sessionId: PARENT }],
      ['3', { kind: 'parent-session', sessionId: '' }]
    ])
    expect(await readInfo()).not.toHaveProperty('userIntervened')
  })

  it('WP4-121 只在排队里、还没落下的人类输入不算', async () => {
    closedChild.view = viewOf(
      [U('1', 'p'), A('2', [TOOL('c1')])],
      [{ submissionId: 9, mode: 'steer', text: 'human steer', imageCount: 0 }]
    )
    closedChild.sources = sourcesOf(['1'])
    expect(await readInfo()).not.toHaveProperty('userIntervened')
  })

  it('WP4-122 读不了就当没有：旧格式（不 peek）、没有存储、sessionView / inputSources 抛（各一条 warn），read 照常交回答复', async () => {
    const intervened = viewOf([U('1', 'p'), A('2', [TX('a')]), U('3', 'human')])

    mocks.durable.value = false
    mocks.findLastBySession.mockResolvedValue({ role: 'assistant', content: 'OLD.' })
    expect(await runner.read(PARENT, CHILD)).toMatchObject({ answer: 'OLD.' })
    expect(await readInfo()).not.toHaveProperty('userIntervened')
    expect(mocks.peekAgentSession).not.toHaveBeenCalled()
    mocks.durable.value = true

    mocks.peekAgentSession.mockResolvedValue(undefined)
    expect(await readInfo()).not.toHaveProperty('userIntervened')

    mocks.peekAgentSession.mockImplementation(async () => closedChild)
    closedChild.view = intervened
    closedChild.sources = sourcesOf(['1'])
    closedChild.lastAnswer.mockResolvedValue({ text: 'DONE.' })
    for (const which of ['sessionView', 'inputSources'] as const) {
      mocks.warn.mockClear()
      closedChild[which].mockRejectedValueOnce(new Error('boom'))
      const res = await runner.read(PARENT, CHILD)
      if ('error' in res) throw new Error(res.error)
      expect(res.info).not.toHaveProperty('userIntervened')
      expect(res.answer).toBe('DONE.')
      expect(mocks.warn).toHaveBeenCalledTimes(1)
      expect(String(mocks.warn.mock.calls[0][0])).toContain(CHILD)
    }
    // 读得了的时候确实是 true（上面的「不带」不是因为视图本身）
    expect((await readInfo()).userIntervened).toBe(true)
  })

  describe('WP4-123 在哪些路上带', () => {
    beforeEach(() => {
      closedChild.view = viewOf([
        U('1', 'p'),
        A('2', [TX('a')]),
        U('3', 'human'),
        A('4', [TX('b')])
      ])
      closedChild.sources = sourcesOf(['1'])
      closedChild.lastAnswer.mockResolvedValue({ text: 'DONE.' })
    })

    it('带：read', async () => {
      expect((await readInfo()).userIntervened).toBe(true)
    })

    it('带：wait（逐条子会话的结果）', async () => {
      const res = await runner.wait({ parentId: PARENT, timeoutSeconds: 5 })
      if ('error' in res) throw new Error(res.error)
      expect(res.results.map((r) => r.userIntervened)).toEqual([true])
    })

    // 原「带：前台 prompt 的答复」「带：前台 answer-sub-session 落定」被 §20 取消：prompt / answer 一律只回执，
    // 没有答复可带（不带的那一面见下面的 BG-42）

    it('带：后台跑完的完成通知（开标签上）', async () => {
      await runner.onDrivenSettled(settled())
      expect(mocks.deliver).toHaveBeenCalledTimes(1)
      const notice = mocks.deliver.mock.calls[0][1] as string
      expect(notice.split('\n')[0]).toMatch(
        new RegExp(
          `^<sub-session id="${CHILD}" title="Child" status="idle" user-intervened="true">$`
        )
      )

      mocks.deliver.mockClear()
      closedChild.view = viewOf([U('1', 'p'), A('2', [TX('a')])])
      await runner.onDrivenSettled(settled({ requestId: 'subsession:parent-1:2' }))
      expect(mocks.deliver.mock.calls[0][1] as string).not.toContain('user-intervened')
    })

    it('WP4-125 不带：崩溃之后重跑、这一轮已经落定 —— 回执「已经结束」（finished），没有快照；答复留给 read（那里照带）', async () => {
      closedChild.requestState.mockResolvedValue('settled')
      const res = await runner.prompt({
        parentId: PARENT,
        childId: CHILD,
        message: 'go',
        requestId: 'subsession:parent-1:7'
      })
      expect(mocks.gatewayPrompt).not.toHaveBeenCalled()
      expect(res).toEqual({ kind: 'finished', id: CHILD })
      expect((await readInfo()).userIntervened).toBe(true)
    })

    it('不带：list', () => {
      const listed = runner.list(PARENT)
      if ('error' in listed) throw new Error(listed.error)
      expect(listed.subSessions[0]).not.toHaveProperty('userIntervened')
    })

    it('不带：回执（回执里根本没有快照）', async () => {
      const release = holdGateway()
      expect(await runner.prompt({ parentId: PARENT, childId: CHILD, message: 'go' })).toEqual({
        kind: 'started',
        id: CHILD
      })
      release()
      await tick()
      // 原来这里还有「前台超时降级的回执」一段：§20 没有超时降级了
    })

    it('BG-42 不带：确认窗里停下来询问、当场交回的那一次（快照在、人插过话也不带）', async () => {
      const open = fakeAgent()
      open.view = closedChild.view
      open.sources = closedChild.sources
      mocks.getAgentSession.mockImplementation((id: string) => (id === CHILD ? open : undefined))
      const release = holdGateway()
      const pending = runner.prompt({ parentId: PARENT, childId: CHILD, message: 'go' })
      // 等到任务建出来（确认窗是 50ms，tick 只走 10ms）
      await tick()
      const question: ChoiceInputRequest = {
        id: 'q1',
        kind: 'choice',
        toolName: 'ask',
        createdAt: 0,
        question: 'Keep it?',
        options: [{ label: 'Yes', description: '' }]
      }
      open.isStreaming = true
      open.pendingInputCount = 1
      open.pending = [question]
      runner.onAskRaised(CHILD, question)
      const res = (await pending) as { kind: string; info?: Record<string, unknown> }
      expect(res.kind).toBe('input')
      expect(res.info).toBeDefined()
      expect(res.info).not.toHaveProperty('userIntervened')
      // 读得了的时候确实是 true（上面的「不带」不是因为视图本身）
      expect((await readInfo()).userIntervened).toBe(true)
      release()
    })

    it('BG-42 不带：answer-sub-session 的两种回执（又停下来问的 input、接着跑的 started）', async () => {
      const open = fakeAgent()
      open.view = closedChild.view
      open.sources = closedChild.sources
      mocks.getAgentSession.mockImplementation((id: string) => (id === CHILD ? open : undefined))
      const release = holdGateway()
      expect(await runner.prompt({ parentId: PARENT, childId: CHILD, message: 'go' })).toEqual({
        kind: 'started',
        id: CHILD
      })
      const ask = (id: string): ChoiceInputRequest => ({
        id,
        kind: 'choice',
        toolName: 'ask',
        createdAt: 0,
        question: `${id}?`,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' }
        ]
      })
      open.isStreaming = true
      open.pending = [ask('q1'), ask('q2')]
      open.pendingInputCount = 2
      runner.onAskRaised(CHILD, ask('q1'))
      // 应答：先从表里移除，再调落定钩子（与真 PendingInputRequests 同序）
      open.respondToInput.mockImplementation((requestId: string) => {
        open.pending = (open.pending ?? []).filter((r) => r.id !== requestId)
        open.pendingInputCount = open.pending.length
        runner.onAskResolved(CHILD, requestId)
        return true
      })
      // 答掉 q1、q2 还挂着：当场交回 input（带快照）
      const first = (await runner.answer({
        parentId: PARENT,
        childId: CHILD,
        askId: 'q1',
        selections: ['Yes']
      })) as { kind: string; info?: Record<string, unknown> }
      expect(first.kind).toBe('input')
      expect(first.info).toBeDefined()
      expect(first.info).not.toHaveProperty('userIntervened')
      // 答掉最后一道：过完确认窗就回执 started，没有快照
      const second = await runner.answer({
        parentId: PARENT,
        childId: CHILD,
        askId: 'q2',
        selections: ['No']
      })
      expect(second).toEqual({ kind: 'started', id: CHILD })
      release()
    })
  })

  it('WP4-124 wait 多条：各算各的，只标插过话的那一条', async () => {
    const ids = ['c1', 'c2', 'c3']
    const agents = new Map(ids.map((id) => [id, fakeAgent()]))
    for (const [id, agent] of agents) {
      agent.view =
        id === 'c2'
          ? viewOf([U('1', 'p'), A('2', [TX('a')]), U('3', 'human')])
          : viewOf([U('1', 'p'), A('2', [TX('a')])])
      agent.sources = sourcesOf(['1'])
      agent.lastAnswer.mockResolvedValue({ text: `answer ${id}` })
    }
    mocks.pick.mockImplementation((id: string) => {
      if (id === PARENT) return { settings: {}, parentId: null, title: 'Parent', updatedAt: 1 }
      if (ids.includes(id)) return { settings: {}, parentId: PARENT, title: id, updatedAt: 2 }
      return undefined
    })
    mocks.findChildren.mockReturnValue(ids.map((id) => ({ id, title: id, updatedAt: 2 })))
    mocks.peekAgentSession.mockImplementation(async (id: string) => agents.get(id))
    const res = await runner.wait({ parentId: PARENT, timeoutSeconds: 5 })
    if ('error' in res) throw new Error(res.error)
    expect(res.results.map((r) => [r.id, r.userIntervened ?? false])).toEqual([
      ['c1', false],
      ['c2', true],
      ['c3', false]
    ])
  })
})
