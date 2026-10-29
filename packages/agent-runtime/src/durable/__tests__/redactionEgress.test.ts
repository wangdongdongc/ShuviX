/**
 * 自动脱敏的出口（durable/redactionEgress.ts + redactionModels.ts，docs/auto-redaction-design.md §2.4、§15）。
 *
 * 请求的改写（prepareEgress，纯函数）：
 *   EG-1 第一层不适用（信任的目的地）：占位符全部换回真值、不做兜底检测；回复里的真值换回占位符
 *   EG-2 适用 + 保持占位符：占位符原样；请求里现拼的真值（系统提示词）兜底换掉并交回新表项；已知值沿用旧占位符
 *   EG-3 第二层判为照发：只换那一类，工具参数里的也换
 *   EG-4 拒发：第一层（不带类别）与第二层（带类别）都抛 EgressBlockedError
 *   EG-5 thinking 块一字不差
 *   EG-6 同一 (类别, 规则, 值) 在一次请求里只问一次策略
 *   EG-7 记录里照原样存的几类（USERNAME 等）：照发时不记表、回复里不换回（旧版本存下的占位符也是）；策略要它们
 *        保持占位符时只在现拼的内容（系统提示词）里现换、记表，记录里的照存的样子发（§15）
 *   EG-8 用户在输入框里照原样发的值（asWritten）：兜底不换（系统提示词），也不进回复的换回；拒发照旧
 *   EG-9 记录里的内容（用户消息、工具结果、模型回复）不检测：里面的真值照存的样子发，只有系统提示词兜底（§15.1）
 *   EG-10 第一个读者（§15.2）：换成信任的模型后，之前发给别的模型的用户消息、它的回复与工具调用、它调起的工具结果照旧
 *         是占位符；之后的（新模型的回复、它调起的工具结果、还没有回复的新消息）换回真值
 *   EG-11 从信任的模型切回不信任的：之前换回过真值的也保持占位符，回复不必换回
 *   EG-12 第一个读者问不到或判为拒发：按不照发，不拦请求；这次的目的地判为拒发照样拦下（记录里的占位符也算）
 *   EG-13 第二层两边都要照发：第一个读者只照发 API_KEY、这次照发 API_KEY 与 SECRET → 旧消息里只换 API_KEY
 * 回复的换回（Remasker）：
 *   RM-1 流式：真值被切在两个事件之间时先压住，放出的部分从不含真值、只追加；最终与整段换回一致
 *   RM-2 短值只换整词，流式时结尾那个没写完的词先压住
 *   RM-3 工具参数整段换
 * 装饰器（真宿主 + faux 模型）：
 *   ME-1 适用：模型看到占位符；策略收到会话、对话、provider、模型
 *   ME-2 信任的目的地：模型看到真值，它在回复里写出的真值存成占位符
 *   ME-3 第一层拒发：请求不发，回合以出错结束，文案说明原因
 *   ME-4 改写出错（bug）：记 error，按存的样子（占位符）发出
 *   ME-5 记录里的回复来自别的模型：那个模型按同一个对话问一次策略（同一个模型只问一次），它之前的内容保持占位符；
 *        这次的判定记给写入时用（noteDecision）；问不到时记 warn、照样发出
 */
import { createHmac } from 'node:crypto'
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type Message
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { asWrittenKey, makePlaceholder, type PlaceholderSigner } from '../../redaction/placeholder'
import {
  EgressBlockedError,
  prepareEgress,
  Remasker,
  type DiscloseAction,
  type EgressDecision
} from '../redactionEgress'
import type { RedactionPolicyRequest } from '../redactionModels'
import { RedactionTable } from '../redactionTable'
import { withRedactionEgress } from '../redactionModels'
import type { RedactionHost, SessionRedaction } from '../sessionRedaction'
import { fauxKit } from './support/faux'
import { makeHost, registerHostCleanup } from './support/host'
import { allEntries, messageText, requestTexts } from './support/transcript'

registerHostCleanup()

const signer: PlaceholderSigner = {
  sign: (data) => createHmac('sha256', 'test-key').update(data).digest()
}
const host: RedactionHost = {
  signer,
  vault: {
    seal: (v) => `SEALED:${Buffer.from(v).toString('base64')}`,
    open: (s) => Buffer.from(s.slice(7), 'base64').toString()
  }
}

const PASSWORD = 'Tr0ub4dor&3xq'
const KEY = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2'
const PHONE = '13812345678'

const P_PASSWORD = makePlaceholder(signer, 'SECRET', PASSWORD)
const P_KEY = makePlaceholder(signer, 'API_KEY', KEY)

function tableWith(
  ...items: Array<[placeholder: string, category: string, value: string]>
): RedactionTable {
  const table = new RedactionTable()
  for (const [placeholder, category, value] of items) {
    table.put(placeholder, { category, rule: 'test-rule', value })
  }
  return table
}

const decision = (
  applies: boolean,
  disclose: (category: string) => DiscloseAction = () => 'redact'
): EgressDecision => ({ applies, disclose: ({ category }) => disclose(category) })

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 })
const toolResult = (text: string): Message => ({
  role: 'toolResult',
  toolCallId: 'c1',
  toolName: 'bash',
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: 0
})

/** model 产出的一条模型回复 */
const reply = (
  model: string,
  content: Parameters<typeof fauxAssistantMessage>[0],
  provider = 'faux'
): AssistantMessage => ({ ...fauxAssistantMessage(content), provider, model })

function texts(context: Context): string {
  return JSON.stringify(context)
}

describe('出口：请求的改写', () => {
  it('EG-1 不适用：占位符换回真值、不兜底检测；回复里的真值换回占位符', () => {
    const table = tableWith([P_PASSWORD, 'SECRET', PASSWORD])
    const context: Context = {
      systemPrompt: `the phone is ${PHONE}`,
      messages: [user(`DB_PASSWORD=${P_PASSWORD}`), toolResult(`ok ${P_PASSWORD}`)]
    }
    const out = prepareEgress(context, table, signer, decision(false))
    expect(texts(out.context)).not.toContain(P_PASSWORD)
    expect(texts(out.context)).toContain(`DB_PASSWORD=${PASSWORD}`)
    expect(out.context.systemPrompt).toBe(`the phone is ${PHONE}`)
    expect(out.entries).toEqual([])
    expect(out.remasker!.text(`I used ${PASSWORD} to log in`)).toBe(
      `I used ${P_PASSWORD} to log in`
    )
  })

  it('EG-2 适用 + 保持占位符：占位符原样，现拼的真值兜底换掉，已知值沿用旧占位符', () => {
    const table = tableWith([P_KEY, 'API_KEY', KEY])
    const context: Context = {
      systemPrompt: `call ${PHONE}; the key is ${KEY}`,
      messages: [user(`use ${P_KEY}`)]
    }
    const out = prepareEgress(context, table, signer, decision(true))
    const P_PHONE = makePlaceholder(signer, 'PHONE', PHONE)
    expect(out.context.systemPrompt).toBe(`call ${P_PHONE}; the key is ${P_KEY}`)
    expect(texts(out.context)).toContain(`use ${P_KEY}`)
    expect(out.entries).toEqual([
      { placeholder: P_PHONE, category: 'PHONE', rule: 'cn-mobile', value: PHONE }
    ])
    expect(out.remasker).toBeUndefined()
  })

  it('EG-3 第二层判为照发：只换那一类，工具参数里的也换', () => {
    const table = tableWith([P_KEY, 'API_KEY', KEY], [P_PASSWORD, 'SECRET', PASSWORD])
    const assistant = fauxAssistantMessage(
      [
        fauxText(`trying ${P_KEY}`),
        fauxToolCall('bash', { command: `login ${P_KEY} ${P_PASSWORD}` })
      ],
      { stopReason: 'toolUse' }
    )
    const context: Context = { messages: [user('go'), assistant] }
    const out = prepareEgress(
      context,
      table,
      signer,
      decision(true, (category) => (category === 'API_KEY' ? 'send' : 'redact'))
    )
    const sent = out.context.messages[1] as AssistantMessage
    expect(sent.content[0]).toMatchObject({ type: 'text', text: `trying ${KEY}` })
    expect(sent.content[1]).toMatchObject({ arguments: { command: `login ${KEY} ${P_PASSWORD}` } })
    expect(out.remasker!.text(`key=${KEY}`)).toBe(`key=${P_KEY}`)
  })

  it('EG-4 拒发：第一层不带类别、第二层带类别', () => {
    const table = tableWith([P_KEY, 'API_KEY', KEY])
    const context: Context = { messages: [user(`use ${P_KEY}`)] }
    const blocked = (): unknown =>
      prepareEgress(context, table, signer, {
        blocked: true,
        applies: false,
        disclose: () => 'redact'
      })
    expect(blocked).toThrow(EgressBlockedError)
    expect(blocked).toThrow(/requests to this model/)
    const byCategory = (): unknown =>
      prepareEgress(
        context,
        table,
        signer,
        decision(true, () => 'block')
      )
    expect(byCategory).toThrow(/API_KEY/)
    // 现拼的真值同样会被拦
    const raw: Context = { systemPrompt: `phone ${PHONE}`, messages: [user('hi')] }
    expect(() =>
      prepareEgress(
        raw,
        new RedactionTable(),
        signer,
        decision(true, () => 'block')
      )
    ).toThrow(/PHONE/)
  })

  it('EG-5 thinking 块一字不差', () => {
    const table = tableWith([P_KEY, 'API_KEY', KEY])
    const thinking = `the user gave ${P_KEY} and ${PHONE}`
    const assistant = fauxAssistantMessage([fauxThinking(thinking), fauxText(`ok ${P_KEY}`)])
    for (const applies of [false, true]) {
      const out = prepareEgress(
        { messages: [user('go'), assistant] },
        table,
        signer,
        decision(applies)
      )
      const sent = out.context.messages[1] as AssistantMessage
      expect(sent.content[0]).toEqual(assistant.content[0])
    }
  })

  it('EG-7 记录里照原样存的几类：照发时不记表、回复不换回；策略要占位符时兜底现换', () => {
    // v0.2.31 之前存下的旧写法占位符
    const OLD_USER = makePlaceholder(signer, 'USERNAME', 'agent').replace('REDACTED_', '')
    const table = tableWith([OLD_USER, 'USERNAME', 'agent'])
    const context: Context = {
      systemPrompt: 'Working directory: /Users/agent/proj',
      messages: [user(`open /Users/agent/proj/app.ts`), toolResult(`/Users/${OLD_USER}/proj`)]
    }
    const sent = prepareEgress(
      context,
      table,
      signer,
      decision(true, (category) => (category === 'USERNAME' ? 'send' : 'redact'))
    )
    expect(sent.context.systemPrompt).toBe('Working directory: /Users/agent/proj')
    expect(texts(sent.context)).toContain('/Users/agent/proj/app.ts')
    expect(texts(sent.context)).not.toContain(OLD_USER)
    expect(sent.entries).toEqual([])
    // 回复里的 agent 不是用户名：不换
    expect(sent.remasker).toBeUndefined()

    const redacted = prepareEgress(context, new RedactionTable(), signer, decision(true))
    const P_USER = makePlaceholder(signer, 'USERNAME', 'agent')
    expect(P_USER).toMatch(/^\{\{REDACTED_USERNAME_[a-z2-7]{8}\}\}$/)
    expect(redacted.context.systemPrompt).toBe(`Working directory: /Users/${P_USER}/proj`)
    // 记录里的照存的样子发：写入时没换的，出口不再现换（§15）
    expect(texts(redacted.context)).toContain('open /Users/agent/proj/app.ts')
    expect(redacted.entries).toEqual([
      { placeholder: P_USER, category: 'USERNAME', rule: expect.any(String), value: 'agent' }
    ])
  })

  it('EG-8 照原样发的值：哪儿都不兜底换；拒发照旧', () => {
    const table = new RedactionTable()
    table.asWritten.add(asWrittenKey(signer, PASSWORD))
    const context: Context = {
      systemPrompt: `db password: ${PASSWORD}`,
      messages: [
        user(`the db password is DB_PASSWORD=${PASSWORD}`),
        toolResult(`DB_PASSWORD=${PASSWORD}`)
      ]
    }
    const out = prepareEgress(context, table, signer, decision(true))
    const sentUser = out.context.messages[0] as { content: string }
    expect(sentUser.content).toBe(`the db password is DB_PASSWORD=${PASSWORD}`)
    expect(JSON.stringify(out.context.messages[1])).toContain(`DB_PASSWORD=${PASSWORD}`)
    expect(out.context.systemPrompt).toBe(`db password: ${PASSWORD}`)
    expect(out.entries).toEqual([])
    // 照原样发的值不进回复的换回
    expect(out.remasker).toBeUndefined()
    expect(() =>
      prepareEgress(
        { systemPrompt: `DB_PASSWORD=${PASSWORD}`, messages: [user('hi')] },
        table,
        signer,
        decision(true, () => 'block')
      )
    ).toThrow(EgressBlockedError)
  })

  it('EG-9 记录里的内容不检测：真值照存的样子发，只有系统提示词兜底', () => {
    const P_PHONE = makePlaceholder(signer, 'PHONE', PHONE)
    const context: Context = {
      systemPrompt: `call ${PHONE}`,
      messages: [
        user(`my phone is ${PHONE}`),
        reply('faux-1', [fauxToolCall('bash', { command: `sms ${PHONE}` })]),
        toolResult(`sent to ${PHONE}`)
      ]
    }
    const out = prepareEgress(context, new RedactionTable(), signer, decision(true))
    expect(out.context.systemPrompt).toBe(`call ${P_PHONE}`)
    expect(out.context.messages).toEqual(context.messages)
    expect(out.entries).toEqual([
      { placeholder: P_PHONE, category: 'PHONE', rule: 'cn-mobile', value: PHONE }
    ])
  })

  it('EG-10 第一个读者：换成信任的模型后，之前发给别的模型的照旧是占位符', () => {
    const table = tableWith([P_KEY, 'API_KEY', KEY])
    const trusted = decision(false)
    const untrusted = decision(true)
    const readerOf = (provider: string, model: string): EgressDecision | undefined =>
      provider === 'faux' ? { 'faux-0': untrusted, 'faux-1': trusted }[model] : undefined
    const messages: Message[] = [
      user(`first ${P_KEY}`),
      reply('faux-0', [fauxText(`ok ${P_KEY}`), fauxToolCall('bash', { command: `use ${P_KEY}` })]),
      toolResult(`old output ${P_KEY}`),
      user(`switched ${P_KEY}`),
      reply('faux-1', [fauxText(`ok ${P_KEY}`), fauxToolCall('bash', { command: `use ${P_KEY}` })]),
      toolResult(`new output ${P_KEY}`),
      user(`latest ${P_KEY}`)
    ]
    const out = prepareEgress({ messages }, table, signer, trusted, readerOf)
    const sent = out.context.messages.map((m) => JSON.stringify(m))
    for (const i of [0, 1, 2]) {
      expect(sent[i], `message ${i}`).toContain(P_KEY)
      expect(sent[i], `message ${i}`).not.toContain(KEY)
    }
    for (const i of [3, 4, 5, 6]) {
      expect(sent[i], `message ${i}`).toContain(KEY)
      expect(sent[i], `message ${i}`).not.toContain(P_KEY)
    }
    expect(out.remasker!.text(`it is ${KEY}`)).toBe(`it is ${P_KEY}`)
    // 没有 readerOf：都按这次的目的地（整段换回）
    const all = prepareEgress({ messages }, table, signer, trusted)
    expect(texts(all.context)).not.toContain(P_KEY)
  })

  it('EG-11 从信任的模型切回不信任的：之前换回过的也保持占位符', () => {
    const table = tableWith([P_KEY, 'API_KEY', KEY])
    const readerOf = (): EgressDecision => decision(false)
    const messages: Message[] = [
      user(`key ${P_KEY}`),
      reply('faux-0', [fauxText(`using ${P_KEY}`)]),
      toolResult(`out ${P_KEY}`)
    ]
    const out = prepareEgress({ messages }, table, signer, decision(true), readerOf)
    expect(out.context.messages).toEqual(messages)
    expect(out.remasker).toBeUndefined()
  })

  it('EG-12 第一个读者问不到或拒发：不照发、不拦；这次的目的地拒发照样拦下', () => {
    const table = tableWith([P_KEY, 'API_KEY', KEY])
    const messages: Message[] = [user(`key ${P_KEY}`), reply('gone', [fauxText(`ok ${P_KEY}`)])]
    for (const reader of [undefined, { blocked: true, applies: false, disclose: () => 'block' }]) {
      const out = prepareEgress(
        { messages },
        table,
        signer,
        decision(false),
        () => reader as EgressDecision | undefined
      )
      expect(out.context.messages).toEqual(messages)
    }
    expect(() =>
      prepareEgress(
        { messages },
        table,
        signer,
        decision(true, () => 'block'),
        () => decision(false)
      )
    ).toThrow(/API_KEY/)
  })

  it('EG-13 第二层两边都要照发', () => {
    const table = tableWith([P_KEY, 'API_KEY', KEY], [P_PASSWORD, 'SECRET', PASSWORD])
    const both = `${P_KEY} ${P_PASSWORD}`
    const messages: Message[] = [user(both), reply('faux-0', [fauxText('ok')]), user(both)]
    const out = prepareEgress(
      { messages },
      table,
      signer,
      decision(true, () => 'send'),
      (_provider, model) =>
        model === 'faux-0'
          ? decision(true, (category) => (category === 'API_KEY' ? 'send' : 'redact'))
          : undefined
    )
    expect((out.context.messages[0] as { content: string }).content).toBe(`${KEY} ${P_PASSWORD}`)
    expect((out.context.messages[2] as { content: string }).content).toBe(`${KEY} ${PASSWORD}`)
  })

  it('EG-6 同一 (类别, 规则, 值) 一次请求只问一次', () => {
    const table = tableWith([P_KEY, 'API_KEY', KEY])
    let asked = 0
    const counting: EgressDecision = {
      applies: true,
      disclose: () => {
        asked++
        return 'redact'
      }
    }
    prepareEgress(
      { messages: [user(`${P_KEY} ${P_KEY}`), toolResult(P_KEY), user(`again ${P_KEY}`)] },
      table,
      signer,
      counting
    )
    expect(asked).toBe(1)
  })
})

describe('出口：回复的换回', () => {
  const stream = (remasker: Remasker, chunks: string[]): string[] => {
    const outs: string[] = []
    let full = ''
    for (const chunk of chunks) {
      full += chunk
      const partial = remasker.partial(fauxAssistantMessage([fauxText(full)]))
      outs.push((partial.content[0] as { text: string }).text)
    }
    return outs
  }

  it('RM-1 流式：切开的真值先压住，放出的只追加、从不含真值；最终与整段换回一致', () => {
    const remasker = new Remasker(new Map([[KEY, P_KEY]]))
    const text = `here: ${KEY} and again ${KEY}.`
    const chunks = [text.slice(0, 12), text.slice(12, 20), text.slice(20, 45), text.slice(45)]
    const outs = stream(remasker, chunks)
    for (const [i, out] of outs.entries()) {
      expect(out).not.toContain(KEY.slice(0, 10))
      if (i > 0) expect(out.startsWith(outs[i - 1]!)).toBe(true)
    }
    const final = remasker.message(fauxAssistantMessage([fauxText(text)]))
    expect((final.content[0] as { text: string }).text).toBe(`here: ${P_KEY} and again ${P_KEY}.`)
    expect(outs.at(-1)).toBe(`here: ${P_KEY} and again ${P_KEY}.`)
  })

  it('RM-2 短值只换整词；流式时结尾没写完的词先压住', () => {
    const P = '{{SECRET_aaaaaaaa}}'
    const remasker = new Remasker(new Map([['pw1', P]]))
    expect(remasker.text('use pw1 now, not pw12 or xpw1')).toBe(`use ${P} now, not pw12 or xpw1`)
    const streaming = new Remasker(new Map([['pw1', P]]))
    const outs = stream(streaming, ['use pw', '1', ' now'])
    // 结尾的 now 也还压着：最终结果才放出
    expect(outs).toEqual(['use ', 'use ', `use ${P} `])
    const final = streaming.message(fauxAssistantMessage([fauxText('use pw1 now')]))
    expect((final.content[0] as { text: string }).text).toBe(`use ${P} now`)
  })

  it('RM-3 工具参数整段换', () => {
    const remasker = new Remasker(new Map([[KEY, P_KEY]]))
    const message = fauxAssistantMessage([fauxToolCall('bash', { command: `curl -H "x: ${KEY}"` })])
    expect(remasker.partial(message).content[0]).toMatchObject({
      arguments: { command: `curl -H "x: ${P_KEY}"` }
    })
  })
})

describe('出口：装饰器', () => {
  const policyOf =
    (
      make: (request: RedactionPolicyRequest) => EgressDecision,
      seen: RedactionPolicyRequest[] = []
    ) =>
    (request: RedactionPolicyRequest): EgressDecision => {
      seen.push(request)
      return make(request)
    }

  it('ME-1 适用：模型看到占位符；策略收到会话、对话、provider、模型', async () => {
    const seen: RedactionPolicyRequest[] = []
    const t = await makeHost({
      ephemeral: ['me1'],
      redaction: host,
      redactionPolicy: policyOf(() => decision(true), seen)
    })
    const session = await t.open('me1')
    t.kit.queue(fauxAssistantMessage([fauxText('ok')]))
    expect(await session.submitUser(`the key is ${KEY}`)).toEqual({})
    const request = requestTexts(t.kit, 0).join('\n')
    expect(request).not.toContain(KEY)
    expect(request).toContain(P_KEY)
    expect(seen[0]).toMatchObject({ sessionId: 'me1', provider: 'faux', model: 'faux-1' })
    expect(typeof seen[0]!.conversationId).toBe('number')
  })

  it('ME-2 信任的目的地：模型看到真值，回复里写出的真值存成占位符', async () => {
    const t = await makeHost({
      ephemeral: ['me2'],
      redaction: host,
      redactionPolicy: policyOf(() => decision(false))
    })
    const session = await t.open('me2')
    t.kit.queue((context) => {
      const last = context.messages.at(-1)
      const said = messageText(last)
      return fauxAssistantMessage([fauxText(`you said: ${said}`)])
    })
    expect(await session.submitUser(`the key is ${KEY}`)).toEqual({})
    expect(requestTexts(t.kit, 0).join('\n')).toContain(KEY)
    const stored = JSON.stringify(await allEntries(await session.currentConversation()))
    expect(stored).not.toContain(KEY)
    expect(stored).toContain(`you said: the key is ${P_KEY}`)
  })

  it('ME-3 第一层拒发：请求不发，回合以出错结束', async () => {
    const t = await makeHost({
      ephemeral: ['me3'],
      redaction: host,
      redactionPolicy: policyOf(() => ({ blocked: true, applies: false, disclose: () => 'redact' }))
    })
    const session = await t.open('me3')
    t.kit.queue(fauxAssistantMessage([fauxText('should not be asked')]))
    await session.submitUser('hello')
    expect(t.kit.requests).toHaveLength(0)
    const stored = await allEntries(await session.currentConversation())
    const reply = stored.flatMap((entry) => entry.model ?? []).find((m) => m.role === 'assistant')
    expect(reply).toMatchObject({ stopReason: 'error' })
    expect((reply as AssistantMessage).errorMessage).toMatch(/does not allow sending requests/)
  })

  it('ME-5 记录里的回复来自别的模型：按同一个对话各问一次策略，它之前的内容保持占位符', async () => {
    const kit = fauxKit({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
    const table = tableWith([P_KEY, 'API_KEY', KEY])
    const noted: Array<[number, EgressDecision]> = []
    const redaction = {
      conversationOf: async () => 7,
      table: async () => table,
      signer,
      record: async () => undefined,
      noteDecision: (conversationId: number, d: EgressDecision) => noted.push([conversationId, d])
    } as unknown as SessionRedaction
    const seen: RedactionPolicyRequest[] = []
    const warnings: string[] = []
    const models = withRedactionEgress(kit.models, {
      sessionId: 's1',
      redaction: () => redaction,
      // faux-2 是信任的；faux-1 保持占位符；gone 的服务商已经删了
      policy: (request) => {
        seen.push(request)
        if (request.provider === 'gone') throw new Error('no such provider')
        return decision(request.model !== 'faux-2')
      },
      logger: { info: () => undefined, warn: (m) => warnings.push(m), error: () => undefined }
    })
    kit.queue(fauxAssistantMessage([fauxText('done')]))
    const context: Context = {
      messages: [
        user(`first ${P_KEY}`),
        reply('faux-1', [fauxText('ok')]),
        user(`again ${P_KEY}`),
        reply('faux-1', [fauxText('ok')]),
        reply('old', [fauxText(`gone ${P_KEY}`)], 'gone'),
        user(`now ${P_KEY}`)
      ]
    }
    const model = kit.models.getModel('faux', 'faux-2')!
    await models.streamSimple(model, context, { sessionId: 'p1' }).result()
    const request = kit.requests[0]!.messages.map((m) => JSON.stringify(m))
    expect(request[0]).toContain(P_KEY)
    expect(request[2]).toContain(P_KEY)
    expect(request[4]).toContain(P_KEY)
    expect(request[5]).toContain(KEY)
    expect(request[5]).not.toContain(P_KEY)
    expect(seen.map((r) => [r.conversationId, r.provider, r.model])).toEqual([
      [7, 'faux', 'faux-2'],
      [7, 'faux', 'faux-1'],
      [7, 'gone', 'old']
    ])
    expect(noted).toHaveLength(1)
    expect(noted[0]![0]).toBe(7)
    expect(noted[0]![1].applies).toBe(false)
    expect(warnings.some((w) => w.includes('gone/old'))).toBe(true)
  })

  it('ME-4 改写出错：记 error，按存的样子发出', async () => {
    const t = await makeHost({
      ephemeral: ['me4'],
      redaction: host,
      redactionPolicy: () => {
        throw new Error('policy exploded')
      }
    })
    const session = await t.open('me4')
    t.kit.queue(fauxAssistantMessage([fauxText('ok')]))
    expect(await session.submitUser(`the key is ${KEY}`)).toEqual({})
    expect(requestTexts(t.kit, 0).join('\n')).toContain(P_KEY)
    expect(t.warnings.some((w) => w.includes('policy exploded'))).toBe(true)
  })
})
