/**
 * DefaultChatGateway 的 `resendSources`（docs/sub-session-design.md §19.7，2026-10-17 落地时定的第 2 条）：
 * 「重新生成」与「回退后原样重发」沿用原来的来源 —— 回退掉一条**子会话**里有来源记录的用户消息时，网关记下它的
 * 原文与来源；紧接着的那一次（不是被驱动的）`prompt` 原文一字不差、两分钟之内，就把来源交给 `AgentSession.prompt`
 * 的第 5 个参数。不管用没用上都撤掉；改过的文字不沿用；顶层会话不记。否则父会话写的话经一次重发就成了人的话。
 *
 *   RS-01 子会话、回退掉父会话代发的那条 → 原样重发带上它的来源（原样、连 title），其余参数照旧
 *   RS-02 只沿用紧接着的那一次：再发一次同样的话不带
 *   RS-03 改过的文字不沿用，记录照样撤掉（之后再发原文也不带）
 *   RS-04 两分钟窗口：差 1ms 还算，恰好两分钟不算
 *   RS-05 顶层会话不记：不读来源、不读视图，重发不带
 *   RS-06 被回退的那条没有来源（人打的）→ 不记
 *   RS-07 回退被拒（false）→ 不记，也不清 agent 状态
 *   RS-08 紧接着到来的是被驱动的发送 → 不沿用（来源由 drive 给），记录照样撤掉
 *   RS-09 读不了来源 / 视图（抛错）、找不到那条消息 → 当没有，回退照常
 *   RS-10 子会话没开着 → peek 读；peek 不到 → 不记
 *   RS-11 记录按会话分开：别的会话的发送不用它、也不撤它
 *   RS-12 带内联 Token 的重发：按标记态原文比对，沿用来源，展开 / 侧车照旧
 *
 * mock 骨架照抄 chatGatewaySteerDriven.test.ts，另替身 sessionRecords（`{parentId}`）与 messageService 的回退。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'

const mocks = vi.hoisted(() => ({
  ensureAgentSession: vi.fn(),
  getAgentSession: vi.fn(),
  peekAgentSession: vi.fn(),
  clearAgentScopedState: vi.fn(),
  rollbackToMessage: vi.fn<(sessionId: string, messageId: string) => Promise<boolean>>(),
  pick: vi.fn<(id: string, fields: string[]) => unknown>(),
  frontendBroadcast: vi.fn()
}))

vi.mock('../../../tools/allTools', () => ({}))
vi.mock('../../../services/toolRegistry', () => ({
  getBuiltinToolEntries: () => [],
  getPlatformBuiltinToolEntries: () => []
}))
// 会话权限表（services/acl）不在这组用例里：空表（真的那份落 SQLite，这里不起库）
vi.mock('../../../services/acl', () => ({
  sessionAcl: { pathView: () => ({ read: [], write: [] }), sandboxEntries: () => [] }
}))
vi.mock('../../../services/sessionService', () => ({
  sessionService: {
    ensureAgentSession: mocks.ensureAgentSession,
    getAgentSession: mocks.getAgentSession,
    peekAgentSession: mocks.peekAgentSession,
    clearAgentScopedState: mocks.clearAgentScopedState,
    resolveAgentProfileName: vi.fn()
  }
}))
vi.mock('../../../services/messageService', () => ({
  messageService: { rollbackToMessage: mocks.rollbackToMessage }
}))
vi.mock('../../../services/sessionRecords', () => ({ sessionRecords: { pick: mocks.pick } }))
vi.mock('../../../services/sessionStorage', () => ({
  storageRefusalOf: () => undefined,
  recordSessionModel: vi.fn(),
  recordSessionThinkingLevel: vi.fn()
}))
vi.mock('../../../services/userInputBroker', () => ({ respondToUserInput: vi.fn() }))
vi.mock('../../../services/builtinMcp/dbConnections', () => ({
  dbManager: { getConnectionInfo: vi.fn() }
}))
vi.mock('../../../services/mcpService', () => ({ mcpService: { getAllToolInfos: () => [] } }))
vi.mock('../../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: { findById: vi.fn(), touchActive: vi.fn() }
}))
vi.mock('../../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../../services/agentService', () => ({ agentService: { getProfile: vi.fn() } }))
vi.mock('../ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: mocks.frontendBroadcast }
}))
vi.mock('../../../services/sessionDayPromptService', () => ({ recordUserEntry: vi.fn() }))

// 每条用例一个新网关：resendSources 是实例上的状态，单例会把上一条用例的记录带进下一条
let Gateway: (typeof import('../DefaultChatGateway'))['DefaultChatGateway']

beforeAll(async () => {
  ;({ DefaultChatGateway: Gateway } = await import('../DefaultChatGateway'))
})

const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const
const TASK = 'delete legacy/ entirely'
/** 子会话 c1 的父会话是 P1；顶层会话 t1 没有父会话 */
const PARENTS: Record<string, string | null> = { c1: 'P1', c2: 'P1', t1: null }
const DRIVE = {
  requestId: 'subsession:P1:3',
  driven: { parentId: 'P1', background: false }
}

interface FakeMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

/** 回退要读的那一面：来源表 + 视图里的消息 */
function agentWith(
  messages: FakeMessage[],
  sources: Array<[string, unknown]>
): { inputSources: ReturnType<typeof vi.fn>; sessionView: ReturnType<typeof vi.fn> } {
  return {
    inputSources: vi.fn(async () => new Map(sources)),
    sessionView: vi.fn(async () => ({ messages }))
  }
}

/** 子会话 c1 的现场：u1 是父会话代发的任务，u2 是人打的 */
const CHILD_MESSAGES: FakeMessage[] = [
  { id: 'u1', role: 'user', content: TASK },
  { id: 'a1', role: 'assistant', content: 'done' },
  { id: 'u2', role: 'user', content: 'typed by a human' }
]

let gateway: InstanceType<typeof Gateway>
let prompt: ReturnType<typeof vi.fn>

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  gateway = new Gateway()
  prompt = vi.fn(async () => ({}))
  mocks.ensureAgentSession.mockResolvedValue({ prompt })
  mocks.pick.mockImplementation((id) =>
    id in PARENTS ? { parentId: PARENTS[id] ?? null } : undefined
  )
  mocks.rollbackToMessage.mockResolvedValue(true)
  const open = agentWith(CHILD_MESSAGES, [['u1', PARENT]])
  mocks.getAgentSession.mockImplementation((id: string) => (id === 'c1' ? open : undefined))
})

afterEach(() => {
  vi.useRealTimers()
})

/** 第 n 次 session.prompt 的第 5 个参数（来源） */
const sourceOf = (n: number): unknown => prompt.mock.calls[n]?.[4]

describe('DefaultChatGateway.resendSources（§19.7）', () => {
  it('RS-01 子会话、回退掉父会话代发的那条 → 紧接着原样重发带上它的来源（原样、连 title），其余参数照旧', async () => {
    expect(await gateway.rollbackMessage('c1', 'u1')).toBe(true)
    expect(mocks.rollbackToMessage).toHaveBeenCalledWith('c1', 'u1')
    expect(mocks.clearAgentScopedState).toHaveBeenCalledWith('c1')
    await gateway.prompt('c1', TASK)
    expect(prompt.mock.calls).toStrictEqual([[TASK, undefined, undefined, undefined, PARENT]])
  })

  it('RS-02 只沿用紧接着的那一次：再发一次同样的话不带来源', async () => {
    await gateway.rollbackMessage('c1', 'u1')
    await gateway.prompt('c1', TASK)
    await gateway.prompt('c1', TASK)
    expect(sourceOf(0)).toStrictEqual(PARENT)
    expect(sourceOf(1)).toBeUndefined()
  })

  it.each([
    ['多一个字', `${TASK}, but keep README`],
    ['首尾空白不同', ` ${TASK}`],
    ['大小写不同', TASK.toUpperCase()]
  ])('RS-03 改过的文字（%s）不沿用，记录照样撤掉（之后再发原文也不带）', async (_l, edited) => {
    await gateway.rollbackMessage('c1', 'u1')
    await gateway.prompt('c1', edited)
    await gateway.prompt('c1', TASK)
    expect(sourceOf(0)).toBeUndefined()
    expect(sourceOf(1)).toBeUndefined()
  })

  it.each([
    [119_999, PARENT],
    [120_000, undefined],
    [600_000, undefined]
  ] as const)('RS-04 两分钟窗口：回退之后 %sms 重发 → 来源 %o', async (elapsed, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    await gateway.rollbackMessage('c1', 'u1')
    vi.setSystemTime(1_000_000 + elapsed)
    await gateway.prompt('c1', TASK)
    expect(sourceOf(0)).toStrictEqual(expected)
  })

  it('RS-05 顶层会话不记：不读来源、不读视图，重发不带', async () => {
    const top = agentWith([{ id: 'u1', role: 'user', content: TASK }], [['u1', PARENT]])
    mocks.getAgentSession.mockImplementation((id: string) => (id === 't1' ? top : undefined))
    expect(await gateway.rollbackMessage('t1', 'u1')).toBe(true)
    expect(top.inputSources).not.toHaveBeenCalled()
    expect(top.sessionView).not.toHaveBeenCalled()
    await gateway.prompt('t1', TASK)
    expect(sourceOf(0)).toBeUndefined()
  })

  it('RS-06 被回退的那条没有来源（人打的）→ 不记，重发不带', async () => {
    await gateway.rollbackMessage('c1', 'u2')
    await gateway.prompt('c1', 'typed by a human')
    expect(sourceOf(0)).toBeUndefined()
  })

  it('RS-07 回退被拒（false）→ 不记，也不清 agent 状态', async () => {
    mocks.rollbackToMessage.mockResolvedValue(false)
    expect(await gateway.rollbackMessage('c1', 'u1')).toBe(false)
    expect(mocks.clearAgentScopedState).not.toHaveBeenCalled()
    await gateway.prompt('c1', TASK)
    expect(sourceOf(0)).toBeUndefined()
  })

  it('RS-08 紧接着到来的是被驱动的发送 → 不沿用（来源由 drive 给，第 5 个参数为空），记录照样撤掉', async () => {
    await gateway.rollbackMessage('c1', 'u1')
    await gateway.prompt('c1', TASK, undefined, undefined, DRIVE)
    expect(prompt.mock.calls[0]).toStrictEqual([TASK, undefined, undefined, DRIVE, undefined])
    await gateway.prompt('c1', TASK)
    expect(sourceOf(1)).toBeUndefined()
  })

  describe('RS-09 读不了就当没有，回退照常', () => {
    it.each(['inputSources', 'sessionView'] as const)('%s 抛错', async (which) => {
      const open = agentWith(CHILD_MESSAGES, [['u1', PARENT]])
      open[which].mockRejectedValue(new Error('boom'))
      mocks.getAgentSession.mockReturnValue(open)
      expect(await gateway.rollbackMessage('c1', 'u1')).toBe(true)
      expect(mocks.rollbackToMessage).toHaveBeenCalledWith('c1', 'u1')
      await gateway.prompt('c1', TASK)
      expect(sourceOf(0)).toBeUndefined()
    })

    it('来源表里有、视图里找不到那条用户消息', async () => {
      mocks.getAgentSession.mockReturnValue(agentWith([], [['u1', PARENT]]))
      expect(await gateway.rollbackMessage('c1', 'u1')).toBe(true)
      await gateway.prompt('c1', TASK)
      expect(sourceOf(0)).toBeUndefined()
    })
  })

  it('RS-10 子会话没开着 → peek 读来源；peek 不到 → 不记', async () => {
    mocks.getAgentSession.mockReturnValue(undefined)
    mocks.peekAgentSession.mockResolvedValue(agentWith(CHILD_MESSAGES, [['u1', PARENT]]))
    await gateway.rollbackMessage('c1', 'u1')
    expect(mocks.peekAgentSession).toHaveBeenCalledWith('c1')
    await gateway.prompt('c1', TASK)
    expect(sourceOf(0)).toStrictEqual(PARENT)

    mocks.peekAgentSession.mockResolvedValue(undefined)
    await gateway.rollbackMessage('c1', 'u1')
    await gateway.prompt('c1', TASK)
    expect(sourceOf(1)).toBeUndefined()
  })

  it('RS-11 记录按会话分开：别的会话发同样的话不带来源、也不撤掉这一条', async () => {
    await gateway.rollbackMessage('c1', 'u1')
    await gateway.prompt('c2', TASK)
    await gateway.prompt('c1', TASK)
    expect(sourceOf(0)).toBeUndefined()
    expect(sourceOf(1)).toStrictEqual(PARENT)
  })

  it('RS-12 带内联 Token 的重发：按标记态原文比对，沿用来源；模型收展开后的全文，侧车照旧', async () => {
    const marked = 'run {{shuvixInlineToken:k}} now'
    const tokens = { k: { type: 'cmd', id: 'x', displayText: '/x', payload: 'PAYLOAD' } } as never
    mocks.getAgentSession.mockReturnValue(
      agentWith([{ id: 'u9', role: 'user', content: marked }], [['u9', PARENT]])
    )
    await gateway.rollbackMessage('c1', 'u9')
    await gateway.prompt('c1', marked, undefined, tokens)
    const [text, images, display, drive, source] = prompt.mock.calls[0]!
    expect(text).toBe(resolveTokensForAgent(marked, tokens))
    expect(text).not.toBe(marked)
    expect(images).toBeUndefined()
    expect(display).toStrictEqual({ content: marked, tokens })
    expect(drive).toBeUndefined()
    expect(source).toStrictEqual(PARENT)
  })
})
