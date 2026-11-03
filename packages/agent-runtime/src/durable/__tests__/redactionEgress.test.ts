/**
 * 自动脱敏的出口装饰器（durable/redactionModels.ts + redactionEgress.ts，docs/auto-redaction-design.md §16）：它不改请求，
 * 记录里存什么就发什么。每次请求只问策略、记判定，第一层 deny 时不发。
 *
 *   ME-1 透传：四种判定 × stream / streamSimple，请求逐字等于输入；不记表，不问第二层
 *   ME-2 回复：回复里的真值不压住、不换回，流事件原样转交，存下的也是真值
 *   ME-3 第一层 deny：不发请求，交回一条出错的回复，只问一次、不重试；completeSimple 交回同一条，不 reject
 *   ME-4 问策略出错：记 error，照发，请求逐字
 *   ME-5 第二层 deny 不拦：请求照发、逐字，回合正常结束
 *   ME-6 判定记录：策略的入参与 noteDecision 的次数；认不出对话 / 还没有脱敏对象的两种情况
 *   ME-7 classify / generateImages 原样转交，不问策略
 *   ME-8 问策略出错之后：上一次的判定不再算数，工具结果按内置默认判（KEY 存占位符）
 */
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Models,
  type ToolCall
} from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import {
  DENY1,
  DENY2,
  EXEMPT,
  KEY,
  P_KEY,
  REDACT,
  recordEqualsRequest,
  redactionHost,
  SEND
} from './support/redaction'
import type { EgressDecision } from '../redactionEgress'
import { withRedactionEgress, type RedactionPolicyRequest } from '../redactionModels'
import type { SessionRedaction } from '../sessionRedaction'
import { answer, callTool, fauxKit, type FauxKit } from './support/faux'
import { makeHost, registerHostCleanup, type TestHost } from './support/host'
import { allEntries, requestTexts } from './support/transcript'
import { waitFor } from './support/wait'

registerHostCleanup()

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

const both = `${KEY} and ${P_KEY}`

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 })

/** 系统提示词、用户消息、回复的文本 / thinking / 工具参数、工具结果都同时含真值与占位符 */
function richContext(): Context {
  return {
    systemPrompt: `prompt ${both}`,
    messages: [
      user(`user ${both}`),
      fauxAssistantMessage(
        [
          fauxThinking(`think ${both}`),
          fauxText(`text ${both}`),
          fauxToolCall('bash', { command: `curl ${both}` }, { id: 'c1' })
        ],
        { stopReason: 'toolUse' }
      ),
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: `output ${both}` }],
        isError: false,
        timestamp: 0
      },
      user(`again ${both}`)
    ]
  }
}

const emitKey = (): ToolRegistration =>
  defineTool({
    name: 'emit',
    description: 'prints a key',
    parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: 'text', text: `printed ${KEY}` }] })
  })

async function stored(t: TestHost, id: string): Promise<string> {
  const session = await t.open(id)
  return JSON.stringify(await allEntries(await session.currentConversation()))
}

describe('出口只问策略，不改请求', () => {
  describe('ME-1 透传', () => {
    const decisions: Array<[string, EgressDecision]> = [
      ['REDACT', REDACT],
      ['SEND', SEND],
      ['DENY2', DENY2],
      ['EXEMPT', EXEMPT]
    ]
    const calls = ['stream', 'streamSimple'] as const
    for (const [name, decision] of decisions) {
      for (const call of calls) {
        it(`${name} × ${call}：请求逐字等于输入，不记表，不问第二层`, async () => {
          const t = await makeHost({ ephemeral: ['me1'], redaction: redactionHost })
          const session = await t.open('me1')
          const redaction = session.redaction!
          const disclose = vi.fn(decision.disclose)
          const models = withRedactionEgress(t.kit.models, {
            sessionId: 'me1',
            redaction: () => redaction,
            policy: () => ({ ...decision, disclose }),
            logger: silent
          })
          t.kit.queue(answer('ok'))
          const context = richContext()
          const model = t.kit.models.getModel('faux', 'faux-1')!
          await models[call](model, context, { sessionId: 'p1' }).result()
          const request = t.kit.requests[0]!
          expect(request.systemPrompt).toBe(context.systemPrompt)
          expect(request.messages.filter((m) => m.role !== 'system')).toEqual(context.messages)
          expect((await redaction.table()).size).toBe(0)
          expect(disclose).not.toHaveBeenCalled()
        })
      }
    }
  })

  describe('ME-2 回复', () => {
    const replied = (): AssistantMessage =>
      fauxAssistantMessage(
        [fauxText(`the key is ${KEY}`), fauxToolCall('emit', { value: KEY }, { id: 'call-emit' })],
        { stopReason: 'toolUse' }
      )

    it('真模型套件：每个流事件都不压住，结果里是真值', async () => {
      const t = await makeHost({ ephemeral: ['me2a'], redaction: redactionHost })
      const session = await t.open('me2a')
      const redaction = session.redaction!
      const models = withRedactionEgress(t.kit.models, {
        sessionId: 'me2a',
        redaction: () => redaction,
        policy: () => REDACT,
        logger: silent
      })
      t.kit.queue(replied())
      const stream = models.streamSimple(t.kit.models.getModel('faux', 'faux-1')!, {
        messages: [user('go')]
      })
      const events: AssistantMessageEvent[] = []
      for await (const event of stream) events.push(event)
      const full = `the key is ${KEY}`
      let text = ''
      for (const event of events) {
        if (event.type !== 'text_delta') continue
        text += event.delta
        // 放出的就是模型写的，一个字符都不压、不换
        expect(full.startsWith(text)).toBe(true)
      }
      expect(text).toBe(full)
      const end = events.find((event) => event.type === 'text_end')
      expect(end).toMatchObject({ content: full })
      const toolEnd = events.find((event) => event.type === 'toolcall_end')
      expect((toolEnd as { toolCall: ToolCall }).toolCall.arguments).toEqual({ value: KEY })
      const result = await stream.result()
      expect(result.content[0]).toMatchObject({ text: full })
      expect(result.content[1]).toMatchObject({ arguments: { value: KEY } })
      expect(JSON.stringify(events)).not.toContain(P_KEY)
      expect((await redaction.table()).size).toBe(0)
    })

    it('内层的事件对象原样交出，次序不变', async () => {
      const t = await makeHost({ ephemeral: ['me2b'], redaction: redactionHost })
      const session = await t.open('me2b')
      const message = replied()
      const pushed: AssistantMessageEvent[] = [
        { type: 'start', partial: message },
        { type: 'text_start', contentIndex: 0, partial: message },
        { type: 'text_delta', contentIndex: 0, delta: `the key is ${KEY}`, partial: message },
        { type: 'text_end', contentIndex: 0, content: `the key is ${KEY}`, partial: message },
        { type: 'done', reason: 'toolUse', message }
      ]
      const inner = {
        streamSimple: (): AssistantMessageEventStream => {
          const out = createAssistantMessageEventStream()
          for (const event of pushed) out.push(event)
          out.end(message)
          return out
        }
      } as unknown as Models
      const models = withRedactionEgress(inner, {
        sessionId: 'me2b',
        redaction: () => session.redaction,
        policy: () => REDACT,
        logger: silent
      })
      const stream = models.streamSimple(t.kit.models.getModel('faux', 'faux-1')!, {
        messages: [user('go')]
      })
      const seen: AssistantMessageEvent[] = []
      for await (const event of stream) seen.push(event)
      expect(seen).toHaveLength(pushed.length)
      seen.forEach((event, i) => expect(event).toBe(pushed[i]))
      expect(await stream.result()).toBe(message)
    })

    it('真宿主：存下的回复条目（文本与工具参数）含真值，表为空', async () => {
      const t = await makeHost({
        ephemeral: ['me2c'],
        redaction: redactionHost,
        redactionPolicy: () => REDACT,
        tools: [emitKey()]
      })
      const session = await t.open('me2c')
      t.kit.queue(replied(), answer(`done with ${KEY}`))
      expect(await session.submitUser('go')).toEqual({})
      const entries = await allEntries(await session.currentConversation())
      const assistants = entries.filter((entry) => entry.kind === 'pi.assistant')
      expect(assistants).toHaveLength(2)
      expect(JSON.stringify(assistants[0]!.model)).toContain(`the key is ${KEY}`)
      expect(JSON.stringify(assistants[0]!.model)).toContain(`"value":"${KEY}"`)
      expect(JSON.stringify(assistants[1]!.model)).toContain(`done with ${KEY}`)
      expect(JSON.stringify(assistants.map((entry) => entry.model))).not.toContain(P_KEY)
    })
  })

  describe('ME-3 第一层 deny', () => {
    it('不发请求，存下一条出错的回复；只问一次，开着重试也不重试', async () => {
      const seen: RedactionPolicyRequest[] = []
      const t = await makeHost({
        ephemeral: ['me3'],
        redaction: redactionHost,
        redactionPolicy: (request) => {
          seen.push(request)
          return DENY1
        },
        settingsOverrides: {
          retry: { enabled: true, baseDelayMs: 1, maxRetries: 3 },
          compaction: { enabled: false }
        }
      })
      const session = await t.open('me3')
      t.kit.queue(answer('should not be asked'))
      await session.submitUser(`hello ${KEY}`)
      expect(t.kit.requests).toHaveLength(0)
      expect(t.kit.callCount).toBe(0)
      const entries = await allEntries(await session.currentConversation())
      const reply = entries
        .flatMap((entry) => entry.model ?? [])
        .find((m) => m.role === 'assistant')
      expect(reply).toMatchObject({ stopReason: 'error' })
      expect((reply as AssistantMessage).errorMessage).toMatch(/does not allow sending requests/)
      expect(seen).toHaveLength(1)
    })

    it('completeSimple：交回同一条出错的回复，不 reject', async () => {
      const t = await makeHost({ ephemeral: ['me3b'], redaction: redactionHost })
      const session = await t.open('me3b')
      const models = withRedactionEgress(t.kit.models, {
        sessionId: 'me3b',
        redaction: () => session.redaction,
        policy: () => DENY1,
        logger: silent
      })
      const message = await models.completeSimple(t.kit.models.getModel('faux', 'faux-1')!, {
        messages: [user('go')]
      })
      expect(message).toMatchObject({ role: 'assistant', stopReason: 'error' })
      expect(message.errorMessage).toMatch(/does not allow sending requests/)
      expect(t.kit.requests).toHaveLength(0)
    })
  })

  it('ME-4 问策略出错：请求照发、逐字，记 error，submitUser 不报错', async () => {
    const t = await makeHost({
      ephemeral: ['me4'],
      redaction: redactionHost,
      redactionPolicy: () => {
        throw new Error('policy exploded')
      }
    })
    const session = await t.open('me4')
    t.kit.queue(answer('ok'))
    const text = `the key is ${both}`
    expect(await session.submitUser(text)).toEqual({})
    expect(requestTexts(t.kit, 0).at(-1)).toBe(`user:${text}`)
    await recordEqualsRequest(session, t.kit, 0)
    const logged = t.warnings.filter((line) => line.includes('no redaction decision'))
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('policy exploded')
  })

  it('ME-5 第二层 deny 不拦：请求发出且逐字，回合正常结束', async () => {
    const t = await makeHost({
      ephemeral: ['me5'],
      redaction: redactionHost,
      redactionPolicy: () => DENY2
    })
    const session = await t.open('me5')
    t.kit.queue(answer(`first ${both}`), answer('second'))
    expect(await session.submitUser(`hello ${both}`)).toEqual({})
    expect(await session.submitUser(`again ${both}`)).toEqual({})
    expect(t.kit.requests).toHaveLength(2)
    expect(requestTexts(t.kit, 1)).toEqual([
      `user:hello ${both}`,
      `assistant:first ${both}`,
      `user:again ${both}`
    ])
    await recordEqualsRequest(session, t.kit, 0)
    await recordEqualsRequest(session, t.kit, 1)
    const last = (await allEntries(await session.currentConversation())).at(-1)!
    expect(last.model?.[0]).toMatchObject({ role: 'assistant', stopReason: 'stop' })
  })

  describe('ME-6 判定记录', () => {
    it('策略的入参是会话、对话、provider、模型；每次请求记一次判定', async () => {
      const seen: RedactionPolicyRequest[] = []
      const t = await makeHost({
        ephemeral: ['me6'],
        redaction: redactionHost,
        redactionPolicy: (request) => {
          seen.push(request)
          return REDACT
        },
        tools: [emitKey()]
      })
      const session = await t.open('me6')
      const noteDecision = vi.spyOn(session.redaction!, 'noteDecision')
      t.kit.queue(callTool('emit'), answer('done'))
      expect(await session.submitUser('go')).toEqual({})
      expect(t.kit.requests).toHaveLength(2)
      expect(seen).toHaveLength(2)
      for (const request of seen) {
        expect(request).toEqual({
          sessionId: 'me6',
          conversationId: expect.any(Number),
          provider: 'faux',
          model: 'faux-1'
        })
      }
      expect(noteDecision).toHaveBeenCalledTimes(2)
      expect(noteDecision.mock.calls[0]).toEqual([seen[0]!.conversationId, REDACT])
    })

    it('认不出对话：策略入参没有 conversationId 这个键，不记判定', async () => {
      const kit = fauxKit()
      const noteDecision = vi.fn()
      const redaction = {
        conversationOf: async () => undefined,
        noteDecision,
        forgetDecision: vi.fn()
      } as unknown as SessionRedaction
      const seen: RedactionPolicyRequest[] = []
      const models = withRedactionEgress(kit.models, {
        sessionId: 's1',
        redaction: () => redaction,
        policy: (request) => {
          seen.push(request)
          return REDACT
        },
        logger: silent
      })
      kit.queue(answer('ok'))
      await models
        .streamSimple(kit.models.getModel('faux', 'faux-1')!, {
          messages: [user('go')]
        })
        .result()
      expect(seen).toEqual([{ sessionId: 's1', provider: 'faux', model: 'faux-1' }])
      expect(seen[0]).not.toHaveProperty('conversationId')
      expect(noteDecision).not.toHaveBeenCalled()
      expect(kit.requests).toHaveLength(1)
    })

    it('还没有脱敏对象：不问策略，照发', async () => {
      const kit: FauxKit = fauxKit()
      const policy = vi.fn(() => DENY1)
      const models = withRedactionEgress(kit.models, {
        sessionId: 's1',
        redaction: () => undefined,
        policy,
        logger: silent
      })
      kit.queue(answer('ok'))
      const reply = await models
        .streamSimple(kit.models.getModel('faux', 'faux-1')!, { messages: [user(`go ${both}`)] })
        .result()
      expect(policy).not.toHaveBeenCalled()
      expect(kit.requests).toHaveLength(1)
      expect(kit.requests[0]!.messages.at(-1)).toMatchObject({ content: `go ${both}` })
      expect(reply.stopReason).toBe('stop')
    })
  })

  it('ME-7 classify / generateImages 原样转交，不问策略', async () => {
    const classified = { kind: 'classified' }
    const images = { kind: 'images' }
    const inner = {
      classify: vi.fn(async () => classified),
      generateImages: vi.fn(async () => images)
    } as unknown as Models
    const policy = vi.fn(() => DENY1)
    const models = withRedactionEgress(inner, {
      sessionId: 's1',
      redaction: () => {
        throw new Error('redaction must not be asked')
      },
      policy,
      logger: silent
    })
    const model = { id: 'm' } as never
    const context = { messages: [] } as never
    const options = { signal: new AbortController().signal } as never
    expect(await models.classify(model, context, options)).toBe(classified)
    expect(inner.classify).toHaveBeenCalledWith(model, context, options)
    expect(await models.generateImages(model, context, options)).toBe(images)
    expect(inner.generateImages).toHaveBeenCalledWith(model, context, options)
    expect(policy).not.toHaveBeenCalled()
  })

  it('ME-8 请求 1 不脱敏、请求 2 问策略出错：请求 2 调起的工具结果按默认判，KEY 存占位符', async () => {
    let calls = 0
    const t = await makeHost({
      ephemeral: ['me8'],
      redaction: redactionHost,
      redactionPolicy: () => {
        calls += 1
        if (calls === 1) return EXEMPT
        throw new Error('policy exploded')
      },
      tools: [emitKey()]
    })
    const session = await t.open('me8')
    t.kit.queue(answer('first'), callTool('emit'), answer('done'))
    expect(await session.submitUser('one')).toEqual({})
    expect(await session.submitUser('two')).toEqual({})
    await waitFor(() => t.kit.requests.length >= 3)
    expect(requestTexts(t.kit, 2)).toContain(`toolResult:printed ${P_KEY}`)
    expect(await stored(t, 'me8')).not.toContain(KEY)
    expect([...(await session.redaction!.table()).entries()].map(([p]) => p)).toEqual([P_KEY])
    await recordEqualsRequest(session, t.kit, 2)
  })
})
