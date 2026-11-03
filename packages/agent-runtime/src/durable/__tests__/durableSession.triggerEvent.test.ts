/**
 * 触发消息（chat-protocol `triggerEvent.ts`，CLAUDE.md「A trigger message's event is a chip」）在真实脱敏器上的
 * 流程：`botTriggerService` 先按会话的模型 `maskTexts([message, 围栏])`（§16：自动消息是自动脱敏的两个位置之一），再拼模型
 * 文本与显示侧车，然后作为来源 `trigger` 的用户消息提交，提交时不再脱敏。显示侧车与模型文本是同一份内容；重新生成靠展开
 * 侧车逐字重发，所以「展开侧车 === 模型收到的文本」是这里的主轴。
 *
 *   RE-1  值出现一次：展开侧车 === 请求里的模型文本；占位符相同；DisplayDoc 和请求里都没有明文
 *   RE-2  同一个值在 message 里出现两次（第二处光秃）：侧车无明文，展开侧车 === 模型文本
 *   RE-3  值在 message 里被认出、围栏字段里光秃出现；反过来也一样
 *   RE-5  幂等：已经是占位符的各种写法，maskTexts 两遍不变、对照表条数不变
 *   RE-6  往返：文本里的占位符在表里；工具参数写占位符，工具拿到真值；工具输出真值，记录里是同一个占位符
 *   RE-7  重发：回退到那条用户条目 + 展开原侧车 + submitUser：第二次请求逐字相同，说明只有一份；侧车 deepEqual；
 *         对照表条数不变；投影来源是 trigger、Token 还在；重复值的文本也相同
 *   RE-8  默认照发的四类（路径、IP、对象存储地址、user@host）：模型与侧车都是原样，表里没有这四类
 *   RE-9  没配脱敏的宿主：两边原样含明文，全文按 TE-1 的形状
 *   RE-10 投影：content = M + 标记，inlineTokens.trigger 字段齐全（含 name），origin.kind 是 trigger；关闭重开后不变
 *   RE-11 旧会话（这之前的运行）：长文本、无显示侧车：content 就是长文本，没有 inlineTokens，开始新请求
 *   RE-12 真实的围栏（timerPayloadAt + 带 +08:00 的 lastFiredAt）：maskTexts 不变，表为空（时间戳不被误认）
 *   RE-13 按模型判 · 第一层不适用：模型文本、侧车展开、记录、请求都含明文，表 0 项
 *   RE-14 按模型判 · 第二层 send / block：send 明文不记表；block 占位符记一项；四处是同一份
 *   RE-15 按模型判 · 第一层 deny：不发请求，错误回复，用户条目是占位符
 *   RE-16 提交不再二次脱敏：submitUser(text) 之后记录 === text
 */
import { createHmac } from 'node:crypto'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type EntryRecord, type JsonObject } from '@earendil-works/pi-durable'
import { startsTaskListRequest } from '@shuvix/chat-protocol/taskList'
import {
  TRIGGER_EVENT_NOTE_TEXT,
  TRIGGER_EVENT_UID,
  triggerEventMessage,
  type TriggerEventMessage
} from '@shuvix/chat-protocol/triggerEvent'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { TriggerOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import { makeTokenMarker, resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { describe, expect, it } from 'vitest'
import { renderEventPrompt } from '../../hook/hookPrompt'
import { timerPayloadAt } from '../../hook/timerPayload'
import { backgroundContext as BG } from '../context'
import { DisplayDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { freshMount } from '../projection/__tests__/projectorSupport'
import type { EgressDecision } from '../redactionEgress'
import type { MaskOptions, RedactionHost } from '../sessionRedaction'
import { answer, callTool } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { DENY1, DENY2, EXEMPT, recordEqualsRequest, SEND } from './support/redaction'
import { allEntries, messageText, requestTexts } from './support/transcript'

registerHostCleanup()

const TIMEOUT = 15000
const redaction: RedactionHost = {
  signer: { sign: (data) => createHmac('sha256', 'test-key').update(data).digest() },
  vault: {
    seal: (v) => `SEALED:${Buffer.from(v).toString('base64')}`,
    open: (s) => {
      if (!s.startsWith('SEALED:')) throw new Error('cannot open')
      return Buffer.from(s.slice(7), 'base64').toString()
    }
  }
}

const SECRET = 'Tr0ub4dor3xqZZ'
const PLACEHOLDER = /\{\{[A-Z_]+_[a-z2-7]{8}\}\}/
const PLACEHOLDERS = /\{\{[A-Z_]+_[a-z2-7]{8}\}\}/g
const LABEL = '11-02 18:00'
const FENCE =
  '<trigger_event trigger="timer.fired">\nsourceId: timer:builtin:minute\nfiredAt: 2026-11-02T10:00:00.000Z\n</trigger_event>'
const SOURCE: TriggerOrigin = {
  kind: 'trigger',
  trigger: 'timer.fired',
  sourceId: 'timer:builtin:minute',
  bot: 'ticker'
}
const MARKER = makeTokenMarker(TRIGGER_EVENT_UID)

/** botTriggerService 拼消息的那一步：先脱敏（没开脱敏 = 原样），再拼 */
async function build(
  session: DurableSession,
  message: string,
  fence: string,
  options: MaskOptions = {}
): Promise<TriggerEventMessage> {
  const [m, f] =
    session.redaction === undefined
      ? [message, fence]
      : await session.redaction.maskTexts([message, fence], options)
  return triggerEventMessage({
    message: m!,
    fence: f!,
    trigger: 'timer.fired',
    firedLabel: LABEL
  })
}

interface Fired {
  t: TestHost
  session: DurableSession
  built: TriggerEventMessage
  /** 模型收到的那条 user 消息：`user:<文本>` */
  seen: string
  /** 展开显示侧车得到的（同样带 `user:` 前缀） */
  expanded: string
}

/** 显示侧车按 JSON 存（`UserSendOptions.display` 的类型），Token 字典是纯数据 */
const asDisplay = (built: TriggerEventMessage): JsonObject => built.display as unknown as JsonObject

/** 一次触发：拼好、提交、跑完一轮 */
async function fire(message: string, fence = FENCE, withRedaction = true): Promise<Fired> {
  const t = await makeHost(withRedaction ? { redaction } : {})
  const session = await t.open()
  await primeRoot(session)
  const built = await build(session, message, fence)
  t.kit.queue(answer('ok'))
  expect(
    await session.submitUser(built.text, { display: asDisplay(built), source: SOURCE })
  ).toEqual({})
  return {
    t,
    session,
    built,
    seen: requestTexts(t.kit, t.kit.requests.length - 1).at(-1)!,
    expanded: `user:${resolveTokensForAgent(built.display.content, built.display.tokens)}`
  }
}

async function displayItems(session: DurableSession): Promise<Record<string, JsonObject>> {
  const conversation = await session.currentConversation()
  return (await session.harness.snapshot(DisplayDoc, conversation.id, BG))?.items ?? {}
}

async function userEntry(session: DurableSession): Promise<EntryRecord> {
  const entries = await allEntries(await session.currentConversation())
  const found = entries.filter((entry) => entry.kind === 'pi.user')
  expect(found).toHaveLength(1)
  return found[0]!
}

function meta(message: ChatMessage): Record<string, unknown> {
  return (message.metadata ?? {}) as Record<string, unknown>
}

async function lastUser(session: DurableSession): Promise<ChatMessage> {
  const users = (await freshMount(session)).messages.filter((message) => message.role === 'user')
  expect(users.length).toBeGreaterThan(0)
  return users.at(-1)!
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1
}

/** 展开侧车 === 模型文本，两边都没有明文 */
async function expectConsistentNoPlaintext(fired: Fired, plaintext = SECRET): Promise<void> {
  expect(fired.seen).not.toContain(plaintext)
  expect(fired.seen).toMatch(PLACEHOLDER)
  expect(JSON.stringify(fired.built.display)).not.toContain(plaintext)
  expect(JSON.stringify(await displayItems(fired.session))).not.toContain(plaintext)
  expect(fired.expanded).toBe(fired.seen)
}

describe('trigger messages on the real redactor', () => {
  it(
    'RE-1 a value seen once: the expanded sidecar is the model text, the placeholder is the same, no plaintext in DisplayDoc or the request',
    async () => {
      const fired = await fire(`DB_PASSWORD=${SECRET}`)
      await expectConsistentNoPlaintext(fired)
      const inModel = fired.seen.match(PLACEHOLDERS)!
      const inSidecar = fired.built.display.content.match(PLACEHOLDERS)!
      expect(inModel).toHaveLength(1)
      expect(inSidecar).toEqual(inModel)
      const items = Object.values(await displayItems(fired.session))
      expect(items).toHaveLength(1)
      expect((items[0] as { content: string }).content).toBe(`DB_PASSWORD=${inModel[0]}${MARKER}`)
    },
    TIMEOUT
  )

  it(
    'RE-2 the same value twice in the message (the second one bare): no plaintext in the sidecar, the expanded sidecar is the model text',
    async () => {
      const fired = await fire(`DB_PASSWORD=${SECRET} then use ${SECRET} again`)
      await expectConsistentNoPlaintext(fired)
      const found = fired.built.display.content.match(PLACEHOLDERS)!
      expect(found).toHaveLength(2)
      expect(found[0]).toBe(found[1])
      expect((await fired.session.redaction!.table()).size).toBe(1)
    },
    TIMEOUT
  )

  describe('RE-3 the value recognised in one text and bare in the other', () => {
    it(
      '(a) recognised in the message, bare in a fence field',
      async () => {
        const fired = await fire(
          `DB_PASSWORD=${SECRET}`,
          FENCE.replace('sourceId: timer:builtin:minute', `sourceId: ${SECRET}`)
        )
        await expectConsistentNoPlaintext(fired)
        expect(occurrences(fired.seen, fired.seen.match(PLACEHOLDER)![0])).toBe(2)
        const token = fired.built.display.tokens[TRIGGER_EVENT_UID]!
        expect(token.payload).not.toContain(SECRET)
        expect(token.payload).toMatch(PLACEHOLDER)
      },
      TIMEOUT
    )

    it(
      '(b) bare in the message, recognised in a fence field',
      async () => {
        const fired = await fire(
          `please check ${SECRET} first`,
          FENCE.replace('sourceId: timer:builtin:minute', `sourceId: DB_PASSWORD=${SECRET}`)
        )
        await expectConsistentNoPlaintext(fired)
        expect(fired.built.display.content).toMatch(PLACEHOLDER)
        expect(fired.built.display.content.match(PLACEHOLDER)![0]).toBe(
          fired.built.display.tokens[TRIGGER_EVENT_UID]!.payload.match(PLACEHOLDER)![0]
        )
      },
      TIMEOUT
    )
  })

  it(
    'RE-5 already-masked text stays as it is: maskTexts twice, the table size',
    async () => {
      const t = await makeHost({ redaction })
      const session = await t.open()
      await primeRoot(session)
      const redactor = session.redaction!
      const placeholder = (await redactor.maskText(`DB_PASSWORD=${SECRET}`)).match(PLACEHOLDER)![0]
      const table = await redactor.table()
      const size = table.size
      expect(size).toBe(1)
      const forms = [
        `DB_PASSWORD=${placeholder}`,
        `postgres://u:${placeholder}@h`,
        `Bearer ${placeholder}`,
        `"client_secret":"${placeholder}"`,
        `密码：${placeholder}`,
        '{{API_KEY_k3v7x2mq}}'
      ]
      for (const form of forms) {
        const fence = FENCE.replace('sourceId: timer:builtin:minute', `sourceId: ${form}`)
        const once = await redactor.maskTexts([form, fence])
        expect(once, form).toEqual([form, fence])
        expect(await redactor.maskTexts(once), form).toEqual([form, fence])
        expect(table.size, form).toBe(size)
      }
    },
    TIMEOUT
  )

  it(
    'RE-6 round trip: the placeholder in the text is in the table; a tool argument holding it reaches the tool as the real value; the tool printing the value is stored as the same placeholder',
    async () => {
      const seenByTool: unknown[] = []
      const live: { session?: DurableSession } = {}
      const echo = defineTool({
        name: 'echo_secret',
        description: 'prints its argument',
        parameters: Type.Object({ value: Type.String() }),
        // 宿主在工具执行前还原参数（桌面端 wrapToolOutput.restoreArguments 调的就是 restoreJson）
        execute: async (args) => {
          const { value } = await live.session!.redaction!.restoreJson(args)
          seenByTool.push(value)
          return { output: [{ type: 'text', text: `printed ${value.value}` }] }
        }
      })
      const t = await makeHost({ redaction, tools: [echo] })
      const session = await t.open()
      live.session = session
      await primeRoot(session)
      const built = await build(session, `DB_PASSWORD=${SECRET}`, FENCE)
      const placeholder = built.text.match(PLACEHOLDER)![0]
      expect((await session.redaction!.table()).has(placeholder)).toBe(true)

      t.kit.queue(callTool('echo_secret', { value: placeholder }), answer('done'))
      expect(
        await session.submitUser(built.text, { display: asDisplay(built), source: SOURCE })
      ).toEqual({})

      expect(seenByTool).toEqual([{ value: SECRET }])
      const afterTool = requestTexts(t.kit, 1)
      expect(afterTool).toContain(`toolResult:printed ${placeholder}`)
      const stored = JSON.stringify(await allEntries(await session.currentConversation()))
      expect(stored).not.toContain(SECRET)
    },
    TIMEOUT
  )

  describe('RE-7 resending after a rollback', () => {
    /** 回退到那条用户条目，展开原侧车重发一次 */
    async function resend(fired: Fired): Promise<{ second: string; added: JsonObject[] }> {
      const { t, session, built } = fired
      const entry = await userEntry(session)
      const before = new Set(Object.keys(await displayItems(session)))
      expect(await session.rollbackTo(entry.id)).toMatchObject({ ok: true })
      t.kit.queue(answer('ok again'))
      expect(
        await session.submitUser(
          resolveTokensForAgent(built.display.content, built.display.tokens),
          {
            display: asDisplay(built),
            source: SOURCE
          }
        )
      ).toEqual({})
      const items = await displayItems(session)
      return {
        second: requestTexts(t.kit, t.kit.requests.length - 1).at(-1)!,
        added: Object.entries(items)
          .filter(([requestId]) => !before.has(requestId))
          .map(([, item]) => item)
      }
    }

    it(
      'the second request is byte-identical and holds the note once; the new sidecar equals the original; the table does not grow; the projection keeps the origin and the token',
      async () => {
        const fired = await fire(`DB_PASSWORD=${SECRET}`)
        const table = await fired.session.redaction!.table()
        const size = table.size
        const { second, added } = await resend(fired)
        expect(fired.t.kit.requests).toHaveLength(2)
        expect(second).toBe(fired.seen)
        expect(occurrences(second, TRIGGER_EVENT_NOTE_TEXT)).toBe(1)
        expect(occurrences(second, '<trigger_event')).toBe(1)
        expect(added).toHaveLength(1)
        expect(added[0]).toStrictEqual(fired.built.display)
        expect(table.size).toBe(size)
        const user = await lastUser(fired.session)
        expect(user.content).toBe(fired.built.display.content)
        expect(meta(user).inlineTokens).toStrictEqual(fired.built.display.tokens)
        expect(meta(user).origin).toMatchObject({ kind: 'trigger', trigger: 'timer.fired' })
      },
      TIMEOUT
    )

    it(
      'a message with the value repeated bare resends byte-identical too',
      async () => {
        const fired = await fire(`DB_PASSWORD=${SECRET} then use ${SECRET} again`)
        const { second } = await resend(fired)
        expect(second).toBe(fired.seen)
        expect(second).not.toContain(SECRET)
      },
      TIMEOUT
    )
  })

  it(
    'RE-8 the four categories kept as written stay in the model text and the sidecar, with no table entry',
    async () => {
      const message = 'look at /Users/alice and 8.8.8.8 and s3://my-bucket/a and deploy@prod-host'
      const fired = await fire(message)
      expect(fired.seen.startsWith(`user:${message}\n\n`)).toBe(true)
      expect(fired.built.display.content).toBe(`${message}${MARKER}`)
      expect(fired.expanded).toBe(fired.seen)
      const table = await fired.session.redaction!.table()
      expect([...table.entries()].map(([, item]) => item.category)).toEqual([])
    },
    TIMEOUT
  )

  it(
    'RE-9 a host without redaction: both sides hold the plaintext and the full text has the TE-1 shape',
    async () => {
      const message = `DB_PASSWORD=${SECRET}`
      const fired = await fire(message, FENCE, false)
      expect(fired.session.redaction).toBeUndefined()
      expect(fired.seen).toBe(`user:${message}\n\n${FENCE}\n\n${TRIGGER_EVENT_NOTE_TEXT}`)
      expect(fired.built.display.content).toBe(`${message}${MARKER}`)
      expect(fired.expanded).toBe(fired.seen)
    },
    TIMEOUT
  )

  it(
    'RE-10 the projection shows M + the marker with the whole token and a trigger origin, and again after close and reopen',
    async () => {
      const message = 'Tick check-in.'
      const fired = await fire(message)
      const expected = {
        [TRIGGER_EVENT_UID]: {
          type: 'trigger',
          id: 'timer.fired',
          displayText: '',
          name: LABEL,
          payload: `\n\n${FENCE}\n\n${TRIGGER_EVENT_NOTE_TEXT}`
        }
      }
      const check = async (session: DurableSession): Promise<void> => {
        const user = await lastUser(session)
        expect(user.content).toBe(`${message}${MARKER}`)
        expect(meta(user).inlineTokens).toStrictEqual(expected)
        expect((meta(user).origin as { kind: string }).kind).toBe('trigger')
        expect(meta(user).origin).toMatchObject({ trigger: 'timer.fired', bot: 'ticker' })
        expect(startsTaskListRequest(user)).toBe(true)
      }
      await check(fired.session)
      await fired.t.host.close(fired.session.sessionId)
      await check(await fired.t.open(fired.session.sessionId))
    },
    TIMEOUT
  )

  it(
    'RE-11 a run from before this change (long text, no sidecar): the content is the long text, no inlineTokens, it starts a request',
    async () => {
      const t = await makeHost({ redaction })
      const session = await t.open()
      await primeRoot(session)
      const long = `Tick check-in.\n\n${FENCE}`
      t.kit.queue(answer('ok'))
      expect(await session.submitUser(long, { source: SOURCE })).toEqual({})
      const user = await lastUser(session)
      expect(user.content).toBe(long)
      expect(meta(user)).not.toHaveProperty('inlineTokens')
      expect(startsTaskListRequest(user)).toBe(true)
      expect(await displayItems(session)).toStrictEqual({})
    },
    TIMEOUT
  )

  describe('RE-12 a real fence does not look like a secret', () => {
    const moments: Array<[string, Date, string]> = [
      ['an evening', new Date(2026, 10, 2, 18, 0), '2026-11-01T18:00:00+08:00'],
      ['new year', new Date(2027, 0, 1, 0, 0), '2026-12-31T23:59:00+08:00'],
      ['one digit fields', new Date(2026, 0, 5, 9, 7), '2026-01-05T09:06:00+08:00'],
      ['a numeric-looking minute', new Date(2026, 10, 30, 13, 8), '2026-11-30T13:07:00+08:00']
    ]
    for (const [name, at, lastFiredAt] of moments) {
      it(
        name,
        async () => {
          const t = await makeHost({ redaction })
          const session = await t.open()
          await primeRoot(session)
          const fence = renderEventPrompt('trigger_event', '', 'timer.fired', {
            ...timerPayloadAt(at, 'timer:builtin:minute'),
            lastFiredAt
          })
          expect(fence).toContain(`lastFiredAt: ${lastFiredAt}`)
          const message = 'Tick check-in.'
          expect(await session.redaction!.maskTexts([message, fence])).toEqual([message, fence])
          expect((await session.redaction!.table()).size).toBe(0)
        },
        TIMEOUT
      )
    }
  })

  describe('按会话的模型判（§16）', () => {
    const MODEL = { provider: 'faux', modelId: 'faux-1' }

    /** 一次触发：策略判 decision，脱敏按模型现问（botTriggerService 交的就是这个） */
    async function fireUnder(
      decision: EgressDecision,
      message = `DB_PASSWORD=${SECRET}`
    ): Promise<Fired & { result: Awaited<ReturnType<DurableSession['submitUser']>> }> {
      const t = await makeHost({ redaction, redactionPolicy: () => decision })
      const session = await t.open()
      await primeRoot(session)
      const built = await build(session, message, FENCE, { model: MODEL })
      t.kit.queue(answer('ok'))
      const result = await session.submitUser(built.text, {
        display: asDisplay(built),
        source: SOURCE
      })
      return {
        t,
        session,
        built,
        result,
        seen: t.kit.requests.length > 0 ? requestTexts(t.kit, 0).at(-1)! : '',
        expanded: `user:${resolveTokensForAgent(built.display.content, built.display.tokens)}`
      }
    }

    /** 模型文本、侧车展开、记录、请求四处是同一份 */
    async function expectSameEverywhere(fired: Fired): Promise<void> {
      expect(fired.seen).toBe(`user:${fired.built.text}`)
      expect(fired.expanded).toBe(fired.seen)
      expect(messageText((await userEntry(fired.session)).model?.[0])).toBe(fired.built.text)
      await recordEqualsRequest(fired.session, fired.t.kit, 0)
    }

    it(
      'RE-13 第一层不适用：模型文本、侧车展开、记录、请求都含明文，表 0 项',
      async () => {
        const fired = await fireUnder(EXEMPT)
        expect(fired.result).toEqual({})
        expect(fired.built.text).toContain(`DB_PASSWORD=${SECRET}`)
        await expectSameEverywhere(fired)
        expect(JSON.stringify(await displayItems(fired.session))).toContain(SECRET)
        expect((await fired.session.redaction!.table()).size).toBe(0)
      },
      TIMEOUT
    )

    it(
      'RE-14 第二层 send：明文不记表；四处是同一份',
      async () => {
        const fired = await fireUnder(SEND)
        expect(fired.built.text).toContain(`DB_PASSWORD=${SECRET}`)
        await expectSameEverywhere(fired)
        expect((await fired.session.redaction!.table()).size).toBe(0)
      },
      TIMEOUT
    )

    it(
      'RE-14 第二层 block：占位符记一项，请求照发；四处是同一份',
      async () => {
        const fired = await fireUnder(DENY2)
        expect(fired.result).toEqual({})
        expect(fired.built.text).not.toContain(SECRET)
        expect(fired.built.text).toMatch(PLACEHOLDER)
        await expectSameEverywhere(fired)
        expect((await fired.session.redaction!.table()).size).toBe(1)
      },
      TIMEOUT
    )

    it(
      'RE-15 第一层 deny：不发请求，错误回复，用户条目是占位符',
      async () => {
        const fired = await fireUnder(DENY1)
        expect(fired.t.kit.requests).toHaveLength(0)
        expect(fired.result.error).toMatch(/does not allow sending requests/)
        const entry = await userEntry(fired.session)
        const text = messageText(entry.model?.[0])
        expect(text).toBe(fired.built.text)
        expect(text).not.toContain(SECRET)
        expect(text).toMatch(PLACEHOLDER)
        const entries = await allEntries(await fired.session.currentConversation())
        expect(entries.at(-1)!.model?.[0]).toMatchObject({ role: 'assistant', stopReason: 'error' })
        expect(JSON.stringify(await displayItems(fired.session))).not.toContain(SECRET)
      },
      TIMEOUT
    )

    it(
      'RE-16 提交不再二次脱敏：submitUser(text) 之后记录 === text，表不变',
      async () => {
        const t = await makeHost({ redaction })
        const session = await t.open()
        await primeRoot(session)
        const text = `DB_PASSWORD=${SECRET}\n\n${FENCE}`
        t.kit.queue(answer('ok'))
        expect(await session.submitUser(text, { source: SOURCE })).toEqual({})
        expect(messageText((await userEntry(session)).model?.[0])).toBe(text)
        expect(requestTexts(t.kit, 0).at(-1)).toBe(`user:${text}`)
        expect((await session.redaction!.table()).size).toBe(0)
      },
      TIMEOUT
    )
  })
})
