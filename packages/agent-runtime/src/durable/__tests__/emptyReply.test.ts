/**
 * 空回复追问（`emptyReply.ts`）的纯逻辑：
 *
 *   ER-01 追问正文：`<empty-reply>` 信封，按正文形状认成系统通知、且是空回复追问
 *   ER-02 isEmptyReply：正常停下（stop / 没有调用的 toolUse）、没有工具调用、正文去空白后为空才算空；
 *         思考不算正文；length / error / aborted 一律不算
 *   ER-03 followsToolResult：往回找时跳过 system 段落增量与出错 / 中止的助手消息，看最后一条有效消息
 *   ER-04 hook：只登记 pi.generation 的 onYield；非空回答不读对话；空回答 + 末尾是工具结果 → continue；
 *         读不到对话 / 读失败 → 不表态（失败记一条 warn）；中止原样抛
 *   ER-05 builtinExtension：不给 hook 就没有 `hooks` 键，给了就带上
 *
 * 整条链（真会话里续跑、自我封顶、用户输入优先、派生 agent）在 integration/emptyReply.test.ts 与
 * spawn.emptyReply.test.ts；三处装内置扩展都带 hook 在 lock.hooks.test.ts。
 */
import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type Message
} from '@earendil-works/pi-ai'
import {
  GenerationTask,
  type ConversationId,
  type HookApi,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import {
  isEmptyReplyNoticeText,
  isSystemNoticeText
} from '@shuvix/chat-protocol/systemNoticeContract'
import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_REPLY_NOTICE_TEXT,
  emptyReplyHook,
  followsToolResult,
  isEmptyReply,
  type EmptyReplyHookDeps
} from '../emptyReply'
import { builtinExtension, SHUVIX_BUILTIN_EXTENSION } from '../lock'

type StopReason = AssistantMessage['stopReason']
type Content = Parameters<typeof fauxAssistantMessage>[0]

const reply = (content: Content, stopReason: StopReason = 'stop'): AssistantMessage =>
  fauxAssistantMessage(content, { stopReason })

const toolResult: Message = {
  role: 'toolResult',
  toolCallId: 'c1',
  toolName: 'read',
  content: [{ type: 'text', text: 'alpha' }],
  isError: false,
  timestamp: 0
}
const system = { role: 'system', content: '', timestamp: 0 } as unknown as Message
const user: Message = { role: 'user', content: 'go', timestamp: 0 }
const assistant = (stopReason: StopReason): Message =>
  fauxAssistantMessage([fauxText('x')], {
    stopReason,
    ...(stopReason === 'error' ? { errorMessage: 'boom' } : {})
  })

describe('ER-01 the notice text', () => {
  it('ER-01 is one <empty-reply> envelope that both shape predicates recognise', () => {
    expect(EMPTY_REPLY_NOTICE_TEXT.startsWith('<empty-reply>')).toBe(true)
    expect(EMPTY_REPLY_NOTICE_TEXT.endsWith('</empty-reply>')).toBe(true)
    expect(isSystemNoticeText(EMPTY_REPLY_NOTICE_TEXT)).toBe(true)
    expect(isEmptyReplyNoticeText(EMPTY_REPLY_NOTICE_TEXT)).toBe(true)
  })
})

describe('ER-02 isEmptyReply', () => {
  it.each<[string, Content, StopReason, boolean]>([
    ['stop, no content', [], 'stop', true],
    ['stop, thinking only', [fauxThinking('I will read it')], 'stop', true],
    ['stop, whitespace text only', [fauxText('  \n\t')], 'stop', true],
    ['stop, thinking + whitespace text', [fauxThinking('t'), fauxText(' ')], 'stop', true],
    ['toolUse with no calls, no content', [], 'toolUse', true],
    ['toolUse with no calls, thinking only', [fauxThinking('t')], 'toolUse', true],
    ['stop, visible text', [fauxText('ok')], 'stop', false],
    ['stop, thinking + visible text', [fauxThinking('t'), fauxText('x')], 'stop', false],
    ['stop, an empty text then a visible one', [fauxText(''), fauxText('x')], 'stop', false],
    ['toolUse with a call', [fauxToolCall('read', {}, { id: 'c1' })], 'toolUse', false],
    [
      'toolUse with thinking + a call',
      [fauxThinking('t'), fauxToolCall('read', {}, { id: 'c1' })],
      'toolUse',
      false
    ],
    ['stop with a call (no text)', [fauxToolCall('read', {}, { id: 'c1' })], 'stop', false],
    ['length, no content', [], 'length', false],
    ['length, thinking only', [fauxThinking('t')], 'length', false],
    ['error, no content', [], 'error', false],
    ['aborted, thinking only', [fauxThinking('t')], 'aborted', false]
  ])('ER-02 %s → %s', (_label, content, stopReason, expected) => {
    expect(isEmptyReply(reply(content, stopReason))).toBe(expected)
  })
})

describe('ER-03 followsToolResult', () => {
  it.each<[string, Message[], boolean]>([
    ['[toolResult]', [toolResult], true],
    ['[toolResult, system]', [toolResult, system], true],
    ['[toolResult, assistant(error)]', [toolResult, assistant('error')], true],
    [
      '[toolResult, assistant(aborted), system, assistant(error)]',
      [toolResult, assistant('aborted'), system, assistant('error')],
      true
    ],
    ['[]', [], false],
    ['[system]', [system], false],
    ['[user]', [user], false],
    ['[toolResult, user]', [toolResult, user], false],
    ['[toolResult, assistant(stop)]', [toolResult, assistant('stop')], false],
    ['[toolResult, assistant(length)]', [toolResult, assistant('length')], false]
  ])('ER-03 %s → %s', (_label, messages, expected) => {
    expect(followsToolResult(messages)).toBe(expected)
  })
})

// ─────────────────────────── hook ───────────────────────────

interface Rig {
  deps: EmptyReplyHookDeps
  conversation: ReturnType<typeof vi.fn>
  context: ReturnType<typeof vi.fn>
  info: string[]
  warn: string[]
  onYield: (
    answer: AssistantMessage,
    api: HookApi,
    context: Context
  ) => Promise<{ continue: unknown } | undefined>
}

/** 假 harness：`conversation()` 交回一个 `context()` 读出 `messages` 的对话（`messages` 为 null → 没有对话） */
function rig(messages: Message[] | null): Rig {
  const info: string[] = []
  const warn: string[] = []
  const context = vi.fn(async () => ({ messages: messages ?? [] }))
  const conversation = vi.fn(async () => (messages === null ? undefined : { context }))
  const deps = {
    harness: { conversation } as unknown as EmptyReplyHookDeps['harness'],
    sessionId: 'sess-er',
    logger: {
      info: (message: string) => info.push(message),
      warn: (message: string) => warn.push(message),
      error: (message: string) => warn.push(message)
    }
  }
  const registration = emptyReplyHook(deps)
  const handlers = registration.handlers as { onYield: Rig['onYield'] }
  return { deps, conversation, context, info, warn, onYield: handlers.onYield }
}

const CONVERSATION = 7 as unknown as ConversationId
const api = { conversationId: CONVERSATION, taskId: 't-1' } as unknown as HookApi
const EMPTY = reply([fauxThinking('I will read it')])

describe('ER-04 the onYield hook', () => {
  it('ER-04a registers on the generation task with onYield only', () => {
    const registration = emptyReplyHook(rig([]).deps)
    expect(registration.task).toBe(GenerationTask.definition.name)
    expect(registration.task).toBe('pi.generation')
    expect(Object.keys(registration.handlers)).toEqual(['onYield'])
  })

  it('ER-04b a non-empty answer → undefined without reading the conversation', async () => {
    const r = rig([toolResult])
    expect(await r.onYield(reply([fauxText('done')]), api, BACKGROUND_CONTEXT)).toBeUndefined()
    expect(r.conversation).not.toHaveBeenCalled()
    expect(r.info).toEqual([])
    expect(r.warn).toEqual([])
  })

  it('ER-04c an empty answer after a tool result → continue with the notice; reads the asking conversation; logs info once', async () => {
    const r = rig([user, assistant('toolUse'), toolResult])
    expect(await r.onYield(EMPTY, api, BACKGROUND_CONTEXT)).toEqual({
      continue: EMPTY_REPLY_NOTICE_TEXT
    })
    expect(r.conversation).toHaveBeenCalledTimes(1)
    expect(r.conversation.mock.calls[0]![0]).toBe(CONVERSATION)
    expect(r.context).toHaveBeenCalledTimes(1)
    expect(r.info).toHaveLength(1)
    expect(r.info[0]).toContain('sess-er')
    expect(r.info[0]).toContain('conversation 7')
    expect(r.warn).toEqual([])
  })

  it('ER-04d an empty answer whose context ends in a user message → undefined', async () => {
    const r = rig([toolResult, user])
    expect(await r.onYield(EMPTY, api, BACKGROUND_CONTEXT)).toBeUndefined()
    expect(r.info).toEqual([])
  })

  it('ER-04e conversation() gives undefined → undefined, no log', async () => {
    const r = rig(null)
    expect(await r.onYield(EMPTY, api, BACKGROUND_CONTEXT)).toBeUndefined()
    expect(r.info).toEqual([])
    expect(r.warn).toEqual([])
  })

  it.each(['conversation', 'context'] as const)(
    'ER-04f %s() rejecting without an abort → undefined and one warn naming the session; nothing thrown',
    async (which) => {
      const r = rig([toolResult])
      const failure = new Error('storage is gone')
      if (which === 'conversation') r.conversation.mockRejectedValueOnce(failure)
      else r.context.mockRejectedValueOnce(failure)
      await expect(r.onYield(EMPTY, api, BACKGROUND_CONTEXT)).resolves.toBeUndefined()
      expect(r.warn).toHaveLength(1)
      expect(r.warn[0]).toContain('sess-er')
      expect(r.warn[0]).toContain('storage is gone')
      expect(r.info).toEqual([])
    }
  )

  it.each(['conversation', 'context'] as const)(
    'ER-04g %s() rejecting while the context is aborted → the same error is rethrown, no warn',
    async (which) => {
      const r = rig([toolResult])
      const controller = new AbortController()
      controller.abort()
      const aborted = withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
      const failure = new Error('aborted read')
      if (which === 'conversation') r.conversation.mockRejectedValueOnce(failure)
      else r.context.mockRejectedValueOnce(failure)
      await expect(r.onYield(EMPTY, api, aborted)).rejects.toBe(failure)
      expect(r.warn).toEqual([])
      expect(r.info).toEqual([])
    }
  )
})

describe('ER-05 builtinExtension', () => {
  const tools: ToolRegistration[] = []

  it('ER-05 without hooks there is no hooks key; with hooks they are carried as given', () => {
    const plain = builtinExtension(tools)
    expect(plain.name).toBe(SHUVIX_BUILTIN_EXTENSION)
    expect('hooks' in plain).toBe(false)
    expect('hooks' in builtinExtension(tools, [])).toBe(false)

    const registration = emptyReplyHook(rig([]).deps)
    const withHook = builtinExtension(tools, [registration])
    expect(withHook.name).toBe(SHUVIX_BUILTIN_EXTENSION)
    expect(withHook.hooks).toEqual([registration])
    expect(withHook.hooks![0]).toBe(registration)
  })
})
