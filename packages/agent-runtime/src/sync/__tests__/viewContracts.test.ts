/**
 * 视图同步的契约与链路（`viewContracts.ts`，pi 1.2 / chord2）—— 不起服务端，只测这一份「两端共用」的东西本身。
 * 编号对着测试设计的用例清单第 1 节：
 *
 *   FrameLink（chord `Link` 的通用实现）
 *     FL-1 receive 之前到的帧排队，receive 时按序冲出，之后直接送达
 *     FL-2 收到 bye → 结束：收尾 / 关闭回调各一次（原因原样，缺 / 非字符串 → 'peer closed'），排队的帧丢掉，之后
 *          的帧不理；receive 之前到的 bye 也结束（不排队）
 *     FL-3 close('r')：先给对端发一次 `{t:'bye', reason:'r'}`，再收尾、回调；第二次 close / ended 无事，之后 send
 *          什么都不发
 *     FL-4 send 时传输抛错 → 以 'transport error' 结束，异常不出 send；close 时传输抛错照样以自己的原因结束
 *     FL-5 结束之后登记的回调立刻以 'closed' 调；一个回调抛错不挡别的；收尾抛错（59c23970 起）也被 ended 吞掉 ——
 *          ended / send / close 都不往外抛，关闭回调照跑
 *     FL-6 非对象的值（字符串、null、数组…）原样交给接收方，从不当成 bye
 *   契约
 *     CT-1 松 schema 收下每个生产者的视图（空视图、旧格式视图、完整的 durable 视图；服务端的空 agent 视图与真 agent
 *          视图），缺 `messages` / `v:2` 不收
 *     CT-2 「找不到」= `unavailable` + reason `not_found`，只认它；与 chat-protocol 的 `SYNC_NOT_FOUND` 同值
 *     CT-3 契约名 / 版本、唯一变体 `owner` 的两个状态成员、输入 id 至少一个字符
 *     CT-4 （P3-04-20 的移植）`viewServer.ts` / `services.ts` 不引 electron、不引 node 内建
 *
 * CT-1 的「完整视图」在这里就地拼（没有借 chat-ui 的 `V()`：那个模块会把 chat-ui 的 zustand store 拖进
 * agent-runtime 的单测）。服务端的空 agent 视图没导出，形状照抄 `viewServer.ts` 的 `emptyAgentView`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChordError, forbidden, isChordError, type Frame } from '@earendil-works/chord'
import { SYNC_NOT_FOUND } from '@shuvix/chat-protocol/sync'
import type {
  AssistantMessage,
  ChatMessage,
  UserTextMessage
} from '@shuvix/chat-protocol/types/chatMessage'
import {
  emptySessionView,
  type AgentView,
  type LiveCard,
  type SessionView
} from '@shuvix/chat-protocol/types/sessionView'
import { Value } from 'typebox/value'
import { describe, expect, it, vi } from 'vitest'
import { legacySessionView } from '../services'
import {
  AgentViewContract,
  AvailabilitySchema,
  FrameLink,
  isNotFoundError,
  LooseAgentViewSchema,
  LooseSessionViewSchema,
  NOT_FOUND_REASON,
  notFoundError,
  SessionViewContract,
  VIEW_SERVER_HOST
} from '../viewContracts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 一帧（测试里随便造的形状；chord 的 Frame 类型只在这里断言） */
function frame(n: number): Frame {
  return { t: 'test', n } as unknown as Frame
}

/** 一条链路 + 它的全部记录（发出的帧、收尾、关闭回调，按发生次序记进同一个 `log`） */
function recordedLink(options: { transmitThrows?: boolean; shutdownThrows?: boolean } = {}): {
  readonly link: FrameLink
  readonly sent: unknown[]
  readonly shutdowns: string[]
  readonly log: string[]
} {
  const sent: unknown[] = []
  const shutdowns: string[] = []
  const log: string[] = []
  const link = new FrameLink(
    (value) => {
      log.push(`transmit:${JSON.stringify(value)}`)
      if (options.transmitThrows === true) throw new Error('peer gone')
      sent.push(value)
    },
    (reason) => {
      shutdowns.push(reason)
      log.push(`shutdown:${reason}`)
      if (options.shutdownThrows === true) throw new Error('shutdown boom')
    }
  )
  return { link, sent, shutdowns, log }
}

// ─── FrameLink ─────────────────────────────────────────

describe('FrameLink', () => {
  it('FL-1 frames delivered before receive() are queued, flushed in order, then delivered live', () => {
    const { link } = recordedLink()
    link.deliver(frame(1))
    link.deliver(frame(2))
    link.deliver(frame(3))
    const got: unknown[] = []
    link.receive((value) => got.push(value))
    expect(got).toEqual([frame(1), frame(2), frame(3)])
    link.deliver(frame(4))
    expect(got).toEqual([frame(1), frame(2), frame(3), frame(4)])
    // 冲出去之后队列是空的：再换一个接收方不会重放旧帧
    const second: unknown[] = []
    link.receive((value) => second.push(value))
    expect(second).toEqual([])
    link.deliver(frame(5))
    expect(second).toEqual([frame(5)])
    expect(got).toHaveLength(4)
    expect(link.closed).toBe(false)
  })

  it('FL-2 a bye ends the link once: shutdown and close handlers get its reason, queued frames are dropped, later delivers are ignored', () => {
    const { link, shutdowns, sent } = recordedLink()
    const closes: string[] = []
    link.onClose((reason) => closes.push(reason))
    // bye 在 receive 之前到：不排队，照样结束
    link.deliver(frame(1))
    link.deliver({ t: 'bye', reason: 'x' })
    expect(link.closed).toBe(true)
    expect(shutdowns).toEqual(['x'])
    expect(closes).toEqual(['x'])
    // 排队的帧丢掉了；之后到的帧、又一个 bye 都不理
    const got: unknown[] = []
    link.receive((value) => got.push(value))
    link.deliver(frame(2))
    link.deliver({ t: 'bye', reason: 'again' })
    link.ended('late')
    expect(got).toEqual([])
    expect(shutdowns).toEqual(['x'])
    expect(closes).toEqual(['x'])
    // 收到 bye 不回 bye
    expect(sent).toEqual([])

    // 原因不是字符串 / 没有原因 → 'peer closed'
    for (const bye of [{ t: 'bye' }, { t: 'bye', reason: 42 }, { t: 'bye', reason: null }]) {
      const other = recordedLink()
      const reasons: string[] = []
      other.link.onClose((reason) => reasons.push(reason))
      other.link.receive(() => {
        throw new Error('a bye must never reach the handler')
      })
      other.link.deliver(bye)
      expect(other.link.closed).toBe(true)
      expect(other.shutdowns).toEqual(['peer closed'])
      expect(reasons).toEqual(['peer closed'])
    }
  })

  it('FL-3 close(r) transmits one bye, then shuts down and runs the handlers; a second close / ended does nothing; send after close sends nothing', () => {
    const { link, sent, shutdowns, log } = recordedLink()
    const closes: string[] = []
    link.onClose((reason) => {
      closes.push(reason)
      log.push(`onClose:${reason}`)
    })
    link.close('r')
    expect(sent).toEqual([{ t: 'bye', reason: 'r' }])
    expect(log).toEqual(['transmit:{"t":"bye","reason":"r"}', 'shutdown:r', 'onClose:r'])
    expect(link.closed).toBe(true)

    link.close('again')
    link.ended('late')
    link.send(frame(1))
    expect(sent).toEqual([{ t: 'bye', reason: 'r' }])
    expect(shutdowns).toEqual(['r'])
    expect(closes).toEqual(['r'])

    // 缺省原因 'closed'
    const other = recordedLink()
    other.link.close()
    expect(other.sent).toEqual([{ t: 'bye', reason: 'closed' }])
    expect(other.shutdowns).toEqual(['closed'])
  })

  it('FL-4 a throwing transmit: send ends the link with "transport error" and throws nothing; close still ends with its own reason', () => {
    const failing = recordedLink({ transmitThrows: true })
    const closes: string[] = []
    failing.link.onClose((reason) => closes.push(reason))
    expect(() => failing.link.send(frame(1))).not.toThrow()
    expect(failing.link.closed).toBe(true)
    expect(failing.shutdowns).toEqual(['transport error'])
    expect(closes).toEqual(['transport error'])
    // 结束之后不再碰传输
    const attempts = failing.log.filter((entry) => entry.startsWith('transmit:')).length
    failing.link.send(frame(2))
    expect(failing.log.filter((entry) => entry.startsWith('transmit:')).length).toBe(attempts)

    const closing = recordedLink({ transmitThrows: true })
    const reasons: string[] = []
    closing.link.onClose((reason) => reasons.push(reason))
    expect(() => closing.link.close('mine')).not.toThrow()
    expect(closing.log[0]).toBe('transmit:{"t":"bye","reason":"mine"}')
    expect(closing.shutdowns).toEqual(['mine'])
    expect(reasons).toEqual(['mine'])
  })

  it('FL-5 late onClose gets "closed" at once; a throwing handler does not stop the others; a throwing shutdown is swallowed by ended, send and close', () => {
    // 结束之后登记 → 立刻以 'closed' 调
    const ended = recordedLink()
    ended.link.ended('gone')
    const late = vi.fn()
    ended.link.onClose(late)
    expect(late).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledWith('closed')

    // 一个关闭回调抛错不挡后面的
    const handlers = recordedLink()
    const order: string[] = []
    handlers.link.onClose(() => {
      order.push('first')
      throw new Error('handler boom')
    })
    handlers.link.onClose((reason) => order.push(`second:${reason}`))
    expect(() => handlers.link.ended('bye-bye')).not.toThrow()
    expect(order).toEqual(['first', 'second:bye-bye'])

    // 收尾抛错：ended 直接调
    const direct = recordedLink({ shutdownThrows: true })
    const directCloses: string[] = []
    direct.link.onClose((reason) => directCloses.push(reason))
    expect(() => direct.link.ended('down')).not.toThrow()
    expect(direct.shutdowns).toEqual(['down'])
    expect(directCloses).toEqual(['down'])
    expect(direct.link.closed).toBe(true)

    // 收尾抛错：send 的传输抛错 → ended('transport error') → 收尾抛错，都不出 send
    const viaSend = recordedLink({ transmitThrows: true, shutdownThrows: true })
    const sendCloses: string[] = []
    viaSend.link.onClose((reason) => sendCloses.push(reason))
    expect(() => viaSend.link.send(frame(1))).not.toThrow()
    expect(viaSend.shutdowns).toEqual(['transport error'])
    expect(sendCloses).toEqual(['transport error'])

    // 收尾抛错：close（传输好的 / 也抛错的）
    for (const transmitThrows of [false, true]) {
      const viaClose = recordedLink({ transmitThrows, shutdownThrows: true })
      const closeReasons: string[] = []
      viaClose.link.onClose((reason) => closeReasons.push(reason))
      expect(() => viaClose.link.close('done')).not.toThrow()
      expect(viaClose.shutdowns).toEqual(['done'])
      expect(closeReasons).toEqual(['done'])
      expect(viaClose.link.closed).toBe(true)
    }

    // 收尾抛错：收到 bye 的 deliver
    const viaBye = recordedLink({ shutdownThrows: true })
    const byeReasons: string[] = []
    viaBye.link.onClose((reason) => byeReasons.push(reason))
    expect(() => viaBye.link.deliver({ t: 'bye', reason: 'peer' })).not.toThrow()
    expect(byeReasons).toEqual(['peer'])
  })

  it('FL-6 non-object values are handed to the handler unchanged and are never taken as a bye', () => {
    const { link, shutdowns } = recordedLink()
    const got: unknown[] = []
    // 一部分在 receive 之前到（排队），一部分之后到（直接送达）
    const array = [{ t: 'bye', reason: 'inside an array' }]
    link.deliver('bye')
    link.deliver(null)
    link.receive((value) => got.push(value))
    link.deliver(array)
    link.deliver(42)
    link.deliver(undefined)
    link.deliver(['bye'])
    expect(got).toEqual(['bye', null, array, 42, undefined, ['bye']])
    expect(got[2]).toBe(array)
    expect(link.closed).toBe(false)
    expect(shutdowns).toEqual([])
  })
})

// ─── 契约 ──────────────────────────────────────────────

function userMessage(id: string, content: string): UserTextMessage {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    type: 'text',
    content,
    model: '',
    createdAt: 1,
    metadata: null
  }
}

function assistantMessage(id: string, text: string): AssistantMessage {
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    type: 'message',
    content: text,
    model: 'faux-1',
    createdAt: 2,
    blocks: [
      { type: 'thinking', text: 'hmm' },
      { type: 'text', text },
      {
        type: 'tool',
        toolCallId: 'c1',
        toolName: 'read',
        args: { path: 'a.txt' },
        result: 'contents',
        isError: false
      }
    ],
    metadata: null
  }
}

function liveCardOf(taskId: number): LiveCard {
  const id = `live:${taskId}`
  return {
    id,
    message: { ...assistantMessage(id, 'stream'), blocks: [{ type: 'text', text: 'stream' }] },
    argsText: { c2: '{"path":"b' }
  }
}

/** 一份所有键都有内容的 durable 视图（消息、实时卡、工具进度、在跑、排队、询问、上下文） */
function fullSessionView(): SessionView {
  const messages: ChatMessage[] = [userMessage('1', 'hello'), assistantMessage('2', 'answer')]
  return {
    ...emptySessionView('s1'),
    source: 'durable',
    capabilities: { send: true, rollback: true, continue: true },
    conversationId: 1,
    messages,
    live: liveCardOf(3),
    toolRuns: { c2: { status: 'running', output: 'partial output' }, c1: { status: 'done' } },
    run: { state: 'busy', retry: { attempt: 2, at: 1000, error: 'overloaded' } },
    queue: [{ submissionId: 7, mode: 'followUp', text: 'next please', imageCount: 1 }],
    asks: [
      {
        id: 'R1',
        kind: 'ask',
        toolName: 'bash',
        command: 'rm -rf build',
        description: 'clean the build',
        createdAt: 5
      }
    ],
    context: { usedTokens: 1234 }
  }
}

/** `viewServer.ts` 的 `emptyAgentView`（没导出，形状照抄） */
function serverEmptyAgentView(agentId: string): AgentView {
  return {
    v: 1,
    agentId,
    sessionId: '',
    conversationId: 0,
    messages: [],
    live: null,
    toolRuns: {},
    run: { state: 'idle' },
    context: { usedTokens: null }
  }
}

function fullAgentView(): AgentView {
  return {
    v: 1,
    agentId: 'sub-a1',
    sessionId: 's1',
    conversationId: 2,
    messages: [userMessage('1', 'look'), assistantMessage('2', 'found it')],
    live: liveCardOf(4),
    toolRuns: { c2: { status: 'pending' } },
    run: { state: 'interrupted' },
    context: { usedTokens: 99 }
  }
}

/** 去掉一个键（schema 的必有键） */
function without(value: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }
  delete copy[key]
  return copy
}

describe('view contracts', () => {
  it('CT-1 the loose schemas accept every producer’s view and reject a missing messages / v:2', () => {
    const empty = emptySessionView('s1')
    const legacy = legacySessionView('s1', {
      messages: [userMessage('1', 'old'), assistantMessage('2', 'older')]
    })
    const full = fullSessionView()
    // 完整视图确实是严格 JSON（chord 只收 JSON）
    expect(JSON.parse(JSON.stringify(full))).toEqual(full)
    for (const view of [empty, legacy, full]) {
      expect(Value.Check(LooseSessionViewSchema, view)).toBe(true)
      expect(Value.Check(LooseSessionViewSchema, JSON.parse(JSON.stringify(view)))).toBe(true)
    }
    expect(Value.Check(LooseSessionViewSchema, legacySessionView('s2', { messages: [] }))).toBe(
      true
    )

    for (const view of [serverEmptyAgentView('a1'), fullAgentView()]) {
      expect(Value.Check(LooseAgentViewSchema, view)).toBe(true)
    }

    // 缺 messages / v:2 不收（会话、agent 两种）
    for (const view of [empty, full]) {
      expect(Value.Check(LooseSessionViewSchema, without(view, 'messages'))).toBe(false)
      expect(Value.Check(LooseSessionViewSchema, { ...view, v: 2 })).toBe(false)
    }
    for (const view of [serverEmptyAgentView('a1'), fullAgentView()]) {
      expect(Value.Check(LooseAgentViewSchema, without(view, 'messages'))).toBe(false)
      expect(Value.Check(LooseAgentViewSchema, { ...view, v: 2 })).toBe(false)
    }
    // 两份 schema 互不收对方
    expect(Value.Check(LooseAgentViewSchema, full)).toBe(false)
    expect(Value.Check(LooseSessionViewSchema, fullAgentView())).toBe(false)
  })

  it('CT-2 not-found is unavailable + reason not_found, and only that counts', () => {
    const error = notFoundError('Session s1 was deleted')
    expect(error).toBeInstanceOf(ChordError)
    expect(error.code).toBe('unavailable')
    expect(error.reason).toBe('not_found')
    // chord 在消息前面加上 `code/reason: `
    expect(error.message).toContain('Session s1 was deleted')
    expect(isChordError(error, 'unavailable')).toBe(true)
    expect(isNotFoundError(error)).toBe(true)

    expect(isNotFoundError(new ChordError('unavailable', 'plain'))).toBe(false)
    expect(isNotFoundError(new ChordError('unavailable', 'other', { reason: 'busy' }))).toBe(false)
    expect(isNotFoundError(forbidden())).toBe(false)
    expect(isNotFoundError(new Error('not_found'))).toBe(false)
    expect(isNotFoundError(Object.assign(new Error('x'), { reason: 'not_found' }))).toBe(false)
    expect(isNotFoundError(undefined)).toBe(false)
    expect(isNotFoundError(null)).toBe(false)

    expect(NOT_FOUND_REASON).toBe('not_found')
    expect(SYNC_NOT_FOUND).toBe(NOT_FOUND_REASON)
  })

  it('CT-3 contract names, versions, the owner variant with view + availability, non-empty input ids', () => {
    expect(VIEW_SERVER_HOST).toBe('main')
    const cases = [
      { contract: SessionViewContract, name: 'shuvix.session-view', key: 'sessionId' },
      { contract: AgentViewContract, name: 'shuvix.agent-view', key: 'agentId' }
    ] as const
    for (const { contract, name, key } of cases) {
      expect(contract.name).toBe(name)
      expect(contract.version).toBe(1)
      expect(contract.scope).toBe('remote')
      const variants = contract.description.variants
      expect(Object.keys(variants)).toEqual(['owner'])
      const members = variants.owner!
      expect(Object.keys(members).sort()).toEqual(['availability', 'view'])
      expect(members.view!.kind).toBe('state')
      expect(members.availability!.kind).toBe('state')

      // 输入：恰好一个 id 键，至少一个字符
      expect(Value.Check(contract.input, { [key]: 'x' })).toBe(true)
      expect(Value.Check(contract.input, { [key]: '' })).toBe(false)
      expect(Value.Check(contract.input, {})).toBe(false)
      expect(Value.Check(contract.input, { [key]: 1 })).toBe(false)
      const property = (contract.input as { properties: Record<string, { minLength?: number }> })
        .properties[key]
      expect(property?.minLength).toBe(1)
    }
    // 会话契约的输入不收 agentId，反之亦然
    expect(Value.Check(SessionViewContract.input, { agentId: 'a1' })).toBe(false)
    expect(Value.Check(AgentViewContract.input, { sessionId: 's1' })).toBe(false)

    expect(Value.Check(AvailabilitySchema, 'available')).toBe(true)
    expect(Value.Check(AvailabilitySchema, 'unavailable')).toBe(true)
    expect(Value.Check(AvailabilitySchema, 'gone')).toBe(false)
  })

  it('CT-4 viewServer.ts and services.ts import nothing from electron or node built-ins (P3-04-20)', () => {
    const importsOf = (file: string): string[] => {
      const source = readFileSync(join(HERE, '..', file), 'utf8')
      const out: string[] = []
      const re =
        /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g
      for (const match of source.matchAll(re)) out.push(match[1] ?? match[2] ?? match[3]!)
      return out
    }
    const forbiddenSpecifier = /^(electron|node:|fs$|path$|os$|fs\/|original-fs)/
    for (const file of ['viewServer.ts', 'services.ts']) {
      const imports = importsOf(file)
      expect(imports.length, file).toBeGreaterThan(0)
      expect(
        imports.filter((specifier) => forbiddenSpecifier.test(specifier)),
        file
      ).toEqual([])
    }
  })
})
