/**
 * DefaultChatGateway.acceptSuggestion —— 采纳一条提议（`suggest` 工具，2026-10-25）：核对它此刻还能采纳（规则在
 * chat-protocol `suggestions.ts`，会话里的消息即真理源），那条的话**取自会话里的工具参数**，以用户的身份发进会话、
 * 来源 = 这次操作的连接 + 提议引用。会话在跑 → steer（等受理）；空闲 → 起一轮（不等这一轮）。送出到那条用户消息
 * 出现在会话里之间，一份进程内的记号挡住同一组的第二次送出。
 *
 *   GA-1  not-found（没有这条消息 / 这次调用 / 这一条）→ 什么都不发；记号不立（随后合法的采纳照常）
 *   GA-2  closed（之后用户说了别的话 / 已采纳过）→ 什么都不发；记号不立
 *   GA-3  空闲 → `session.prompt` 收到会话里的那句话（不是请求里的）+ 来源 `{kind: local, suggestion}`；prompt 还
 *         挂着时就交回 success；网络客户端的上下文 → remote 来源带引用
 *   GA-4  在跑 → `steer(那句话, 来源 + 引用)`，等它受理才交回 success；不 prompt、不 ensure
 *   GA-5  同一组并发两次采纳（同一条 / 别的一条）→ 恰发一次，另一个 closed；成功之后紧接着再点（会话记录还没变）→ closed
 *   GA-6  steer 抛错 → failed + 错误原文；记号撤掉，重试成功
 *   GA-7  空闲时 prompt 交回 `{error}` / 会话打不开 / prompt reject → 记号撤掉，可以再点
 *   GA-8  记号按会话分开：s1 刚送出的那组，不挡 s2 里 id 相同的那组
 *   GA-10 （裁定）会话空闲且送出超过 10 秒 → 记号不再挡（例如回退删掉了采纳的那条，卡片又开着）；9.999 秒还挡；
 *         会话在跑时一直挡，哪怕过了很久
 *   GA-11 （裁定）空闲路径：回退之后待沿用的来源（原文一字不差、窗口之内）**不**顶替提议的来源；那条记录照样撤掉
 *
 * GA-9（IPC 处理函数）在 ipc/__tests__/suggestionHandlers.test.ts。mock 骨架照抄 chatGatewayResendSource.test.ts；
 * operationContext 用真的。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantBlock, ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { SuggestionRef } from '@shuvix/chat-protocol/types/inputOrigin'
import type { ClientContext } from '../../../ipc/registry'
import { createClientContext, operationContext } from '../../../utils/operationContext'

const mocks = vi.hoisted(() => ({
  ensureAgentSession: vi.fn(),
  getAgentSession: vi.fn(),
  peekAgentSession: vi.fn(),
  clearAgentScopedState: vi.fn(),
  listBySession: vi.fn<(sessionId: string) => Promise<unknown[]>>(),
  rollbackToMessage: vi.fn<(sessionId: string, messageId: string) => Promise<boolean>>(),
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
  messageService: {
    listBySession: mocks.listBySession,
    rollbackToMessage: mocks.rollbackToMessage
  }
}))
vi.mock('../../../services/sessionRecords', () => ({ sessionRecords: { pick: vi.fn() } }))
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

// 每条用例一个新网关：记号是实例上的状态
let Gateway: (typeof import('../DefaultChatGateway'))['DefaultChatGateway']

beforeAll(async () => {
  ;({ DefaultChatGateway: Gateway } = await import('../DefaultChatGateway'))
})

// ─── 夹具 ───────────────────────────────────────────────

const ITEMS = [
  { title: 'Add tests', message: 'Yes, also add tests for the parser' },
  { title: 'Update docs', message: 'Please update the README too' },
  { title: 'Ship it', message: 'Go ahead and open the PR' }
]
const REF: SuggestionRef = { messageId: 'a1', toolCallId: 'call_0', index: 1 }
const TEXT = ITEMS[1]!.message

function user(id: string, content: string, sessionId = 's1'): ChatMessage {
  return {
    id,
    sessionId,
    role: 'user',
    type: 'text',
    content,
    model: '',
    createdAt: 0,
    metadata: null
  }
}

function assistant(id: string, blocks: AssistantBlock[], sessionId = 's1'): ChatMessage {
  return {
    id,
    sessionId,
    role: 'assistant',
    type: 'message',
    content: '',
    model: 'm',
    createdAt: 0,
    blocks,
    metadata: null
  }
}

const suggestBlock: AssistantBlock = {
  type: 'tool',
  toolCallId: 'call_0',
  toolName: 'suggest',
  args: { suggestions: ITEMS },
  result: 'Shown 3 suggestions'
}

/** 每条会话的消息列表（listBySession 的替身数据）：缺省都是「a1 里有一组开着的提议」 */
const transcripts = new Map<string, ChatMessage[]>()
const openTranscript = (sessionId: string): ChatMessage[] => [
  user('u1', 'hi', sessionId),
  assistant('a1', [suggestBlock, { type: 'text', text: 'done' }], sessionId)
]

const LOCAL = { kind: 'local' } as const
const windowCtx: ClientContext = {
  client: { kind: 'window', id: 'ipc:7', webContentsId: 7 },
  transport: 'ipc'
}
const netCtx: ClientContext = {
  client: { kind: 'network', id: 'ws:4', remoteAddress: '192.168.1.20', userAgent: 'UA' },
  transport: 'network'
}

/** 在这次操作（本机窗口 / 网络客户端）的上下文里调，与 IPC 处理函数一样 */
const inCtx = <T>(
  fn: () => Promise<T>,
  ctx: ClientContext = windowCtx,
  sessionId = 's1'
): Promise<T> => operationContext.run(createClientContext(ctx, sessionId), fn)

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0))
}

let gateway: InstanceType<typeof Gateway>
/** 打开着的会话（ensureAgentSession 交回的）的 prompt */
let prompt: ReturnType<typeof vi.fn>
/** 每条会话的运行时替身：isStreaming + steer（getAgentSession 交回的） */
const live = new Map<string, { isStreaming: boolean; steer: ReturnType<typeof vi.fn> }>()

function streaming(sessionId: string, steer = vi.fn(async () => {})): ReturnType<typeof vi.fn> {
  live.set(sessionId, { isStreaming: true, steer })
  return steer
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  transcripts.clear()
  live.clear()
  transcripts.set('s1', openTranscript('s1'))
  gateway = new Gateway()
  prompt = vi.fn(async () => ({}))
  mocks.ensureAgentSession.mockImplementation(async () => ({ prompt }))
  mocks.getAgentSession.mockImplementation((id: string) => live.get(id))
  mocks.listBySession.mockImplementation(async (id: string) => transcripts.get(id) ?? [])
})

afterEach(() => {
  vi.useRealTimers()
})

const accept = (
  ref: SuggestionRef = REF,
  sessionId = 's1'
): ReturnType<typeof gateway.acceptSuggestion> =>
  inCtx(() => gateway.acceptSuggestion(sessionId, ref), windowCtx, sessionId)

const sent = (): number =>
  prompt.mock.calls.length + [...live.values()].reduce((n, s) => n + s.steer.mock.calls.length, 0)

// ─── GA-1 / GA-2 ────────────────────────────────────────

describe('GA-1 / GA-2 · 核对不过就什么都不发', () => {
  it.each<[string, SuggestionRef]>([
    ['没有这条消息', { ...REF, messageId: 'nope' }],
    ['消息 id 是一条用户消息', { ...REF, messageId: 'u1' }],
    ['没有这次调用', { ...REF, toolCallId: 'call_9' }],
    ['下标越界', { ...REF, index: 3 }]
  ])('GA-1 %s → not-found，不发；记号不立', async (_label, ref) => {
    expect(await accept(ref)).toStrictEqual({ success: false, reason: 'not-found' })
    await flush()
    expect(mocks.ensureAgentSession).not.toHaveBeenCalled()
    expect(sent()).toBe(0)
    // 记号不立：随后同一组里合法的那一条照常发出
    expect(await accept({ ...ref, messageId: 'a1', toolCallId: 'call_0', index: 0 })).toStrictEqual(
      {
        success: true
      }
    )
    await flush()
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('GA-1 会话里没有任何消息（列表为空）→ not-found', async () => {
    transcripts.set('s1', [])
    expect(await accept()).toStrictEqual({ success: false, reason: 'not-found' })
    expect(mocks.listBySession).toHaveBeenCalledWith('s1')
  })

  it.each<[string, ChatMessage]>([
    ['之后用户说了别的话', user('u2', 'something else')],
    [
      '同组已采纳过一条',
      {
        ...user('u2', ITEMS[0]!.message),
        metadata: { origin: { kind: 'local', suggestion: { ...REF, index: 0 } } }
      } as ChatMessage
    ]
  ])('GA-2 %s → closed，不发；记号不立', async (_label, later) => {
    transcripts.set('s1', [...openTranscript('s1'), later])
    expect(await accept()).toStrictEqual({ success: false, reason: 'closed' })
    await flush()
    expect(sent()).toBe(0)
    expect(mocks.ensureAgentSession).not.toHaveBeenCalled()
    // 记号不立：那句话随回退没了（卡片又开着）→ 立刻就能点
    transcripts.set('s1', openTranscript('s1'))
    expect(await accept()).toStrictEqual({ success: true })
  })
})

// ─── GA-3 / GA-4 ────────────────────────────────────────

describe('GA-3 · 空闲：起一轮，不等它', () => {
  it('GA-3 session.prompt 收到会话里的那句话 + 来源 {local, suggestion}；prompt 还挂着就交回 success', async () => {
    const pending = deferred<object>()
    prompt.mockImplementation(() => pending.promise)
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(prompt.mock.calls).toStrictEqual([
      [TEXT, undefined, undefined, undefined, { ...LOCAL, suggestion: REF }, undefined]
    ])
    expect(mocks.ensureAgentSession).toHaveBeenCalledWith('s1')
    pending.resolve({})
    await flush()
  })

  it('GA-3 交出的引用是拷贝，且只有 messageId / toolCallId / index 三键', async () => {
    const ref = { ...REF }
    await accept(ref)
    await flush()
    const source = prompt.mock.calls[0]?.[4] as { suggestion: SuggestionRef }
    expect(source.suggestion).toStrictEqual(REF)
    expect(source.suggestion).not.toBe(ref)
  })

  it('GA-3 网络客户端的上下文 → remote 来源带上引用', async () => {
    expect(await inCtx(() => gateway.acceptSuggestion('s1', REF), netCtx)).toStrictEqual({
      success: true
    })
    await flush()
    expect(prompt.mock.calls[0]?.[4]).toStrictEqual({
      kind: 'remote',
      clientId: 'ws:4',
      address: '192.168.1.20',
      userAgent: 'UA',
      suggestion: REF
    })
  })

  it('GA-3 采纳之后、在这次操作之外的发送不带引用（派生的上下文不漏出去）', async () => {
    await accept()
    await flush()
    await inCtx(() => gateway.prompt('s1', 'typed by hand'))
    expect(prompt.mock.calls[1]?.[4]).toStrictEqual(LOCAL)
  })
})

describe('GA-4 · 在跑：steer，等它受理', () => {
  it('GA-4 steer(那句话, 来源 + 引用)，steer 受理之前不交回；不 prompt、不 ensure', async () => {
    const admitted = deferred<void>()
    const steer = streaming(
      's1',
      vi.fn(() => admitted.promise)
    )
    let settled = false
    const result = accept().then((r) => {
      settled = true
      return r
    })
    await flush()
    expect(steer.mock.calls).toStrictEqual([[TEXT, { ...LOCAL, suggestion: REF }]])
    expect(settled).toBe(false)
    admitted.resolve()
    expect(await result).toStrictEqual({ success: true })
    expect(prompt).not.toHaveBeenCalled()
    expect(mocks.ensureAgentSession).not.toHaveBeenCalled()
  })
})

// ─── GA-5 ───────────────────────────────────────────────

describe('GA-5 · 同一组只送出一次', () => {
  it.each([
    ['同一条', 1, 1],
    ['同组另一条', 1, 2]
  ])('GA-5 空闲时并发两次（%s）→ 恰发一次，另一个 closed', async (_label, first, second) => {
    const results = await Promise.all([
      accept({ ...REF, index: first }),
      accept({ ...REF, index: second })
    ])
    await flush()
    expect(results).toStrictEqual([{ success: true }, { success: false, reason: 'closed' }])
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0]?.[0]).toBe(ITEMS[first]!.message)
  })

  it('GA-5 在跑时并发两次 → steer 恰一次，另一个 closed', async () => {
    const steer = streaming('s1')
    const results = await Promise.all([accept(), accept({ ...REF, index: 0 })])
    expect(results).toStrictEqual([{ success: true }, { success: false, reason: 'closed' }])
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('GA-5 成功之后紧接着再点（会话记录还没变，组看起来仍开着）→ closed，不再发', async () => {
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(await accept()).toStrictEqual({ success: false, reason: 'closed' })
    expect(await accept({ ...REF, index: 2 })).toStrictEqual({ success: false, reason: 'closed' })
    await flush()
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('GA-5 记号挡在读会话之前：第二次点击连会话都不读', async () => {
    await accept()
    mocks.listBySession.mockClear()
    expect(await accept()).toStrictEqual({ success: false, reason: 'closed' })
    expect(mocks.listBySession).not.toHaveBeenCalled()
  })
})

// ─── GA-6 / GA-7 ────────────────────────────────────────

describe('GA-6 · steer 失败', () => {
  it.each([
    ['an Error', new Error('The conversation is closed'), 'The conversation is closed'],
    ['a string', 'busy', 'busy']
  ] as const)('GA-6 steer 抛 %s → failed + 原文；记号撤掉，重试成功', async (_l, thrown, text) => {
    const steer = streaming(
      's1',
      vi.fn(async () => {
        throw thrown
      })
    )
    expect(await accept()).toStrictEqual({ success: false, reason: 'failed', error: text })
    steer.mockImplementation(async () => {})
    expect(await accept()).toStrictEqual({ success: true })
    expect(steer).toHaveBeenCalledTimes(2)
  })
})

describe('GA-7 · 空闲时起一轮失败', () => {
  it('GA-7 prompt 交回 {error} → 记号撤掉，可以再点', async () => {
    prompt.mockResolvedValueOnce({ error: 'Model refused', code: 'busy' })
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('GA-7 会话打不开（ensureAgentSession 交回 undefined）→ 记号撤掉，可以再点', async () => {
    mocks.ensureAgentSession.mockResolvedValueOnce(undefined)
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(mocks.frontendBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', sessionId: 's1' })
    )
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('GA-7 prompt reject → 不抛出，记号撤掉，可以再点', async () => {
    prompt.mockRejectedValueOnce(new Error('storage gone'))
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(prompt).toHaveBeenCalledTimes(2)
  })
})

// ─── GA-8 ───────────────────────────────────────────────

describe('GA-8 · 记号按会话分开', () => {
  it('GA-8 s1 刚送出的那组不挡 s2 里 id 相同的那组', async () => {
    transcripts.set('s2', openTranscript('s2'))
    expect(await accept(REF, 's1')).toStrictEqual({ success: true })
    expect(await accept(REF, 's2')).toStrictEqual({ success: true })
    await flush()
    expect(mocks.ensureAgentSession.mock.calls.map((c) => c[0])).toStrictEqual(['s1', 's2'])
    // s1 自己的那组仍挡着
    expect(await accept(REF, 's1')).toStrictEqual({ success: false, reason: 'closed' })
  })
})

// ─── GA-10 ──────────────────────────────────────────────

describe('GA-10 · 记号什么时候不再挡（裁定）', () => {
  it('GA-10 空闲、送出 9.999 秒还挡；超过 10 秒（例如回退删掉了采纳的那条）→ 可以再采纳', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    vi.setSystemTime(1_000_000 + 9_999)
    expect(await accept()).toStrictEqual({ success: false, reason: 'closed' })
    vi.setSystemTime(1_000_000 + 10_001)
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('GA-10 会话在跑时一直挡，哪怕过了很久；停下来之后才放', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(2_000_000)
    const steer = streaming('s1')
    expect(await accept()).toStrictEqual({ success: true })
    vi.setSystemTime(2_000_000 + 60_000)
    // steer 还排着（那条用户消息还没落进会话）：组看起来仍开着，但不能再发一遍
    expect(await accept()).toStrictEqual({ success: false, reason: 'closed' })
    expect(await accept({ ...REF, index: 0 })).toStrictEqual({ success: false, reason: 'closed' })
    expect(steer).toHaveBeenCalledTimes(1)
    // 停下来、那句话没进会话（被撤回）→ 卡片开着，可以再点（这回空闲，起一轮）
    live.delete('s1')
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})

// ─── GA-11 ──────────────────────────────────────────────

describe('GA-11 · 待沿用的重发来源不顶替提议的来源（裁定）', () => {
  const PARENT = { kind: 'parent-session', sessionId: 'P1', title: 'Driver' } as const

  /** s1 是空闲的、但运行时开着（回退要读来源）：u9 是父会话代发的，原文恰好等于提议的那句话 */
  function withRolledBackParentMessage(): void {
    const agent = {
      isStreaming: false,
      steer: vi.fn(),
      inputSources: vi.fn(async () => new Map([['u9', PARENT]])),
      sessionView: vi.fn(async () => ({ messages: [user('u9', TEXT)] }))
    }
    mocks.getAgentSession.mockImplementation((id: string) => (id === 's1' ? agent : undefined))
    mocks.rollbackToMessage.mockResolvedValue(true)
  }

  it('GA-11 [对照] 回退之后原样 prompt 一次：沿用 PARENT', async () => {
    withRolledBackParentMessage()
    await inCtx(async () => {
      expect(await gateway.rollbackMessage('s1', 'u9')).toBe(true)
      await gateway.prompt('s1', TEXT)
    })
    expect(prompt.mock.calls[0]?.[4]).toStrictEqual(PARENT)
  })

  it('GA-11 回退之后采纳一条原文相同的提议 → 来源是 {local, suggestion}，不是 PARENT；那条记录照样撤掉', async () => {
    withRolledBackParentMessage()
    await inCtx(async () => {
      expect(await gateway.rollbackMessage('s1', 'u9')).toBe(true)
    })
    expect(await accept()).toStrictEqual({ success: true })
    await flush()
    expect(prompt.mock.calls[0]?.[4]).toStrictEqual({ ...LOCAL, suggestion: REF })
    // 记录已撤：之后再手打同一句也不沿用
    await inCtx(() => gateway.prompt('s1', TEXT))
    expect(prompt.mock.calls[1]?.[4]).toStrictEqual(LOCAL)
  })
})
