/**
 * DefaultChatGateway 的 `resendSources`（docs/sub-session-design.md §19.7，2026-10-17 落地时定的第 2 条）：
 * 「重新生成」与「回退后原样重发」沿用原来的来源 —— 回退掉一条**子会话**里有来源记录的用户消息时，网关记下它的
 * 原文与来源；紧接着的那一次（不是被驱动的）`prompt` 原文一字不差、两分钟之内，就把来源交给 `AgentSession.prompt`
 * 的第 5 个参数。不管用没用上都撤掉；改过的文字不沿用。顶层会话里别的会话代发的那条同样沿用（2026-10-20：会话权限表
 * 授权的会话也能往顶层会话里发消息）。否则别的会话写的话经一次重发就成了人的话。
 *
 *   RS-01 子会话、回退掉父会话代发的那条 → 原样重发带上它的来源（原样、连 title），其余参数照旧
 *   RS-02 只沿用紧接着的那一次：再发一次同样的话不带
 *   RS-03 改过的文字不沿用，记录照样撤掉（之后再发原文也不带）
 *   RS-04 两分钟窗口：差 1ms 还算，恰好两分钟不算
 *   RS-05 顶层会话里别的会话代发的那条同样沿用；人打的不带
 *   RS-06 被回退的那条没有来源（人打的）→ 不记
 *   RS-07 回退被拒（false）→ 不记，也不清 agent 状态
 *   RS-08 紧接着到来的是被驱动的发送 → 不沿用（来源由 drive 给），记录照样撤掉
 *   RS-09 读不了来源 / 视图（抛错）、找不到那条消息 → 当没有，回退照常
 *   RS-10 子会话没开着 → peek 读；peek 不到 → 不记
 *   RS-11 记录按会话分开：别的会话的发送不用它、也不撤它
 *   RS-12 带内联 Token 的重发：按标记态原文比对，沿用来源，展开 / 侧车照旧
 *   RS-13 一切都在网络客户端的操作上下文里（2026-10-21 起网关按连接盖章）：沿用的来源压过连接的章；用不上沿用的
 *         （紧接着再发一次、改过的文字、被回退的是人打的）→ 连接的章 remote；被驱动的发送 → 不盖章
 *   RS-14 回退一条触发消息后原样重发（标记文本 + Token），在网络连接的上下文里：模型文本、侧车与首发相同，来源 trigger
 *   RS-15 回退后只发 message（回填草稿的样子）：来源是连接的章，没有侧车，模型文本只有 message
 *   RS-16 这之前的运行（长文本、没有侧车）重发：来源 trigger，全文不变，不再加说明
 *   GW-2  别的会话发来的那条的重新生成（标记文本 + Token，没有 drive）：说明恰一次，来源沿用（压过连接的章），全文与首发
 *         逐字相同；运行中发来的那条发回「去掉插话说明的标记文本」也比对成功，全文 = 首发减插话后缀；对照：人发的没有说明
 *   GW-3  回退后只发原文（回填草稿的样子）：沿用驱动来源（`ownWords`），模型文本只有原文、没有说明；改过字不沿用；
 *         对照：触发消息同样回填仍是连接的章（RS-15）
 *
 * mock 骨架照抄 chatGatewaySteerDriven.test.ts，另替身 sessionRecords（`{parentId}`）与 messageService 的回退。
 * operationContext 用真的（RS-13）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TRIGGER_EVENT_NOTE_TEXT, triggerEventMessage } from '@shuvix/chat-protocol/triggerEvent'
import { withSessionSender } from '@shuvix/chat-protocol/sessionSender'
import {
  MID_RUN_NOTE_SEPARATOR,
  MID_RUN_NOTE_TEXT,
  midRunNoteDisplay,
  tokensWithoutMidRunNote,
  withoutMidRunNote
} from '@shuvix/chat-protocol/midRunNote'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { ClientContext } from '../../../ipc/registry'
import { createClientContext, operationContext } from '../../../utils/operationContext'

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
vi.mock('../../../services/sessionRecords', () => ({
  sessionRecords: {
    pick: mocks.pick,
    drivingSourceOf: (_id: string, driverId: string, title?: string) =>
      title
        ? { kind: 'parent-session', sessionId: driverId, title }
        : { kind: 'parent-session', sessionId: driverId }
  }
}))
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
  metadata?: { inlineTokens?: Record<string, unknown> }
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
    expect(prompt.mock.calls).toStrictEqual([
      [TASK, undefined, undefined, undefined, PARENT, undefined]
    ])
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

  it('RS-05 顶层会话里别的会话代发的那条（经会话权限表被授权的会话，2026-10-20）→ 同样沿用；人打的照旧不带', async () => {
    const OTHER = { kind: 'session', sessionId: 'A1', title: 'Driver' } as const
    const top = agentWith(
      [
        { id: 'u1', role: 'user', content: TASK },
        { id: 'u2', role: 'user', content: 'typed by a human' }
      ],
      [['u1', OTHER]]
    )
    mocks.getAgentSession.mockImplementation((id: string) => (id === 't1' ? top : undefined))
    expect(await gateway.rollbackMessage('t1', 'u1')).toBe(true)
    await gateway.prompt('t1', TASK)
    expect(sourceOf(0)).toStrictEqual(OTHER)
    expect(await gateway.rollbackMessage('t1', 'u2')).toBe(true)
    await gateway.prompt('t1', 'typed by a human')
    expect(sourceOf(1)).toBeUndefined()
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
    const sent = withSessionSender(TASK, undefined, {
      kind: 'parent-session',
      sessionId: DRIVE.driven.parentId
    })
    expect(prompt.mock.calls[0]).toStrictEqual([
      sent.text,
      undefined,
      sent.display,
      DRIVE,
      undefined,
      undefined
    ])
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

describe('RS-13 网络客户端的上下文里：沿用的来源压过连接的章，其余按连接盖章', () => {
  const netCtx: ClientContext = {
    client: { kind: 'network', id: 'ws:4', remoteAddress: '192.168.1.20', userAgent: 'UA' },
    transport: 'network'
  }
  const REMOTE = {
    kind: 'remote',
    clientId: 'ws:4',
    address: '192.168.1.20',
    userAgent: 'UA'
  } as const
  /** 整段流程都在同一个网络客户端的操作上下文里跑（回退与发送都是它发起的） */
  const remotely = <T>(fn: () => Promise<T>): Promise<T> =>
    operationContext.run(createClientContext(netCtx, 'c1'), fn)

  it('RS-13 RS-01 的流程：回退掉父会话代发的那条、原样重发 → 沿用的 PARENT，不是 remote', async () => {
    await remotely(async () => {
      expect(await gateway.rollbackMessage('c1', 'u1')).toBe(true)
      await gateway.prompt('c1', TASK)
    })
    expect(prompt.mock.calls).toStrictEqual([
      [TASK, undefined, undefined, undefined, PARENT, undefined]
    ])
  })

  it('RS-13 紧接着再发一次同样的话 → remote（沿用的只给一次）', async () => {
    await remotely(async () => {
      await gateway.rollbackMessage('c1', 'u1')
      await gateway.prompt('c1', TASK)
      await gateway.prompt('c1', TASK)
    })
    expect(sourceOf(0)).toStrictEqual(PARENT)
    expect(sourceOf(1)).toStrictEqual(REMOTE)
  })

  it('RS-13 改过的文字 → remote；之后再发原文也是 remote', async () => {
    await remotely(async () => {
      await gateway.rollbackMessage('c1', 'u1')
      await gateway.prompt('c1', `${TASK}, but keep README`)
      await gateway.prompt('c1', TASK)
    })
    expect(sourceOf(0)).toStrictEqual(REMOTE)
    expect(sourceOf(1)).toStrictEqual(REMOTE)
  })

  it('RS-13 RS-06 被回退的是人打的那条 → 重发是 remote', async () => {
    await remotely(async () => {
      await gateway.rollbackMessage('c1', 'u2')
      await gateway.prompt('c1', 'typed by a human')
    })
    expect(prompt.mock.calls).toStrictEqual([
      ['typed by a human', undefined, undefined, undefined, REMOTE, undefined]
    ])
  })

  it('RS-13 RS-08 紧接着到来的是被驱动的发送 → 第 5 个参数 undefined（不盖连接的章）；记录撤掉，下一次是 remote', async () => {
    await remotely(async () => {
      await gateway.rollbackMessage('c1', 'u1')
      await gateway.prompt('c1', TASK, undefined, undefined, DRIVE)
      await gateway.prompt('c1', TASK)
    })
    const sent = withSessionSender(TASK, undefined, {
      kind: 'parent-session',
      sessionId: DRIVE.driven.parentId
    })
    expect(prompt.mock.calls[0]).toStrictEqual([
      sent.text,
      undefined,
      sent.display,
      DRIVE,
      undefined,
      undefined
    ])
    expect(sourceOf(1)).toStrictEqual(REMOTE)
  })

  describe('触发消息（chat-protocol triggerEvent.ts）', () => {
    const TRIGGER = {
      kind: 'trigger',
      trigger: 'timer.fired',
      sourceId: 'timer:builtin:minute',
      bot: 'ticker'
    } as const
    const M = 'Tick check-in.'
    const FENCE = '<trigger_event trigger="timer.fired">\nfiredAt: x\n</trigger_event>'
    const built = triggerEventMessage({
      message: M,
      fence: FENCE,
      trigger: 'timer.fired',
      firedLabel: '11-02 18:00'
    })
    /** 顶层会话 t1 的现场：u9 是触发器发的，投影里的 content 是标记态 */
    const triggerRun = (content: string): void => {
      mocks.getAgentSession.mockReturnValue(
        agentWith([{ id: 'u9', role: 'user', content }], [['u9', TRIGGER]])
      )
    }

    it('RS-14 回退后原样重发（标记文本 + Token）：prompt 收到与首发相同的模型文本与侧车，来源 trigger（压过连接的章）', async () => {
      triggerRun(built.display.content)
      await remotely(async () => {
        expect(await gateway.rollbackMessage('t1', 'u9')).toBe(true)
        await gateway.prompt('t1', built.display.content, undefined, built.display.tokens)
      })
      const [text, images, display, drive, source] = prompt.mock.calls[0]!
      expect(text).toBe(built.text)
      expect(text).toBe(`${M}\n\n${FENCE}\n\n${TRIGGER_EVENT_NOTE_TEXT}`)
      expect(images).toBeUndefined()
      expect(display).toStrictEqual(built.display)
      expect(drive).toBeUndefined()
      expect(source).toStrictEqual(TRIGGER)
    })

    it('RS-15 回退后只发 message（回填草稿再发）：来源是连接的章，没有侧车，模型文本只有 message', async () => {
      triggerRun(built.display.content)
      await remotely(async () => {
        expect(await gateway.rollbackMessage('t1', 'u9')).toBe(true)
        await gateway.prompt('t1', M)
      })
      expect(prompt.mock.calls).toStrictEqual([
        [M, undefined, undefined, undefined, REMOTE, undefined]
      ])
    })

    it('RS-16 这之前的运行（长文本、没有侧车）重发：来源 trigger，全文不变，不再加说明', async () => {
      const long = `${M}\n\n${FENCE}`
      triggerRun(long)
      await remotely(async () => {
        expect(await gateway.rollbackMessage('t1', 'u9')).toBe(true)
        await gateway.prompt('t1', long)
      })
      expect(prompt.mock.calls).toStrictEqual([
        [long, undefined, undefined, undefined, TRIGGER, undefined]
      ])
      expect(prompt.mock.calls[0]![0]).not.toContain(TRIGGER_EVENT_NOTE_TEXT)
    })
  })
})

describe('别的会话发来的那条：回退之后再发（sessionSender.ts）', () => {
  const netCtx: ClientContext = {
    client: { kind: 'network', id: 'ws:4', remoteAddress: '192.168.1.20', userAgent: 'UA' },
    transport: 'network'
  }
  const REMOTE = {
    kind: 'remote',
    clientId: 'ws:4',
    address: '192.168.1.20',
    userAgent: 'UA'
  } as const
  const remotely = <T>(fn: () => Promise<T>): Promise<T> =>
    operationContext.run(createClientContext(netCtx, 'c1'), fn)
  const SOURCE = { kind: 'parent-session', sessionId: 'P1' } as const
  const TITLE = '重构 parser'

  beforeEach(() => {
    // 驱动方 P1 有标题：说明里带上它，不进来源
    mocks.pick.mockImplementation((id) =>
      id === 'P1'
        ? { title: TITLE, parentId: null }
        : id in PARENTS
          ? { parentId: PARENTS[id] ?? null }
          : undefined
    )
  })

  /** 第一次发：真走 drive，返回 session.prompt 收到的模型文本与侧车 */
  async function firstSend(): Promise<{
    text: string
    display: { content: string; tokens: Record<string, never> }
  }> {
    await gateway.prompt('c1', TASK, undefined, undefined, DRIVE)
    const [text, , display] = prompt.mock.calls[0]!
    expect(text).toBe(withSessionSender(TASK, undefined, { ...SOURCE, title: TITLE }).text)
    prompt.mockClear()
    return { text, display }
  }

  /** 投影里这条的样子：标记态 content + inlineTokens；来源表里是 drive 给的来源 */
  function viewOfSent(content: string, tokens: Record<string, unknown>): void {
    const agent = agentWith(
      [{ id: 'u1', role: 'user', content, metadata: { inlineTokens: tokens } }],
      [['u1', SOURCE]]
    )
    mocks.getAgentSession.mockImplementation((id: string) => (id === 'c1' ? agent : undefined))
  }
  const occurrences = (text: string, needle: string): number => text.split(needle).length - 1

  it('GW-2 重新生成（标记文本 + Token，没有 drive）：说明恰一次，来源沿用（压过连接的章），全文与首发逐字相同', async () => {
    const first = await firstSend()
    viewOfSent(first.display.content, first.display.tokens)
    await remotely(async () => {
      expect(await gateway.rollbackMessage('c1', 'u1')).toBe(true)
      await gateway.prompt('c1', first.display.content, undefined, first.display.tokens)
    })
    const [text, images, display, drive, source] = prompt.mock.calls[0]!
    expect(text).toBe(first.text)
    expect(occurrences(text, '[Sent by')).toBe(1)
    expect(images).toBeUndefined()
    expect(display).toStrictEqual(first.display)
    expect(drive).toBeUndefined()
    expect(source).toStrictEqual(SOURCE)
  })

  it('GW-2 运行中发来的那条：回退后发「去掉插话说明的标记文本」比对成功、来源沿用，全文 = 首发减插话后缀', async () => {
    const first = await firstSend()
    const noted = midRunNoteDisplay(TASK, first.display)
    const firstFull = `${first.text}${MID_RUN_NOTE_SEPARATOR}${MID_RUN_NOTE_TEXT}`
    viewOfSent(noted.content, noted.tokens)
    // useChatActions 发回来的样子
    const content = withoutMidRunNote(noted.content, noted.tokens)
    const tokens = tokensWithoutMidRunNote(noted.tokens)
    expect(content).toBe(first.display.content)
    await remotely(async () => {
      expect(await gateway.rollbackMessage('c1', 'u1')).toBe(true)
      await gateway.prompt('c1', content, undefined, tokens)
    })
    const [text, , display, , source] = prompt.mock.calls[0]!
    expect(source).toStrictEqual(SOURCE)
    expect(`${text}${MID_RUN_NOTE_SEPARATOR}${MID_RUN_NOTE_TEXT}`).toBe(firstFull)
    expect(text).toBe(first.text)
    expect(text).not.toContain(MID_RUN_NOTE_TEXT)
    expect(display).toStrictEqual(first.display)
  })

  it('GW-2 对照：不是被驱动的 IPC prompt 没有侧车、没有说明', async () => {
    await remotely(async () => {
      await gateway.prompt('c1', 'typed by a human')
    })
    expect(prompt.mock.calls).toStrictEqual([
      ['typed by a human', undefined, undefined, undefined, REMOTE, undefined]
    ])
  })

  it('GW-3 回退后只发原文（回填草稿的样子）：沿用驱动来源，模型文本只有原文，没有说明，没有侧车', async () => {
    const first = await firstSend()
    viewOfSent(first.display.content, first.display.tokens)
    await remotely(async () => {
      expect(await gateway.rollbackMessage('c1', 'u1')).toBe(true)
      await gateway.prompt('c1', TASK)
    })
    expect(prompt.mock.calls).toStrictEqual([
      [TASK, undefined, undefined, undefined, SOURCE, undefined]
    ])
  })

  it('GW-3 运行中发来的那条同样：两枚系统 Token 都不算原文', async () => {
    const first = await firstSend()
    const noted = midRunNoteDisplay(TASK, first.display)
    viewOfSent(noted.content, noted.tokens)
    await remotely(async () => {
      expect(await gateway.rollbackMessage('c1', 'u1')).toBe(true)
      await gateway.prompt('c1', TASK)
    })
    expect(prompt.mock.calls).toStrictEqual([
      [TASK, undefined, undefined, undefined, SOURCE, undefined]
    ])
  })

  it('GW-3 改过的文字是人的话：连接的章，只给一次的记录撤掉', async () => {
    const first = await firstSend()
    viewOfSent(first.display.content, first.display.tokens)
    await remotely(async () => {
      expect(await gateway.rollbackMessage('c1', 'u1')).toBe(true)
      await gateway.prompt('c1', `${TASK}, but keep README`)
      await gateway.prompt('c1', TASK)
    })
    expect(sourceOf(0)).toStrictEqual(REMOTE)
    expect(sourceOf(1)).toStrictEqual(REMOTE)
  })

  it('GW-3 对照：触发消息回填原文仍是连接的章（RS-15），ownWords 只给驱动来源', async () => {
    const TRIGGER = { kind: 'trigger', trigger: 'timer.fired', bot: 'ticker' } as const
    const built = triggerEventMessage({
      message: TASK,
      fence: '<trigger_event trigger="timer.fired">\nfiredAt: x\n</trigger_event>',
      trigger: 'timer.fired',
      firedLabel: '11-02 18:00'
    })
    mocks.getAgentSession.mockReturnValue(
      agentWith(
        [
          {
            id: 'u9',
            role: 'user',
            content: built.display.content,
            metadata: { inlineTokens: built.display.tokens }
          }
        ],
        [['u9', TRIGGER]]
      )
    )
    await remotely(async () => {
      expect(await gateway.rollbackMessage('t1', 'u9')).toBe(true)
      await gateway.prompt('t1', TASK)
    })
    expect(prompt.mock.calls).toStrictEqual([
      [TASK, undefined, undefined, undefined, REMOTE, undefined]
    ])
  })
})
