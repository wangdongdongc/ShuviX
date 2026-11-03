/**
 * 自动脱敏的测试夹具（docs/auto-redaction-design.md §16）：钥匙、判定、样例，以及主轴「记录即所发」的断言
 * `recordEqualsRequest`。
 *
 *  - `REDACT` / `SEND` / `DENY2`：第一层适用，第二层一律 redact / send / block；
 *  - `EXEMPT`：第一层不适用，`disclose` 抛错 —— 问到第二层就说明不该问；
 *  - `DENY1`：第一层拒发；
 *  - `byModel`：按模型选判定（faux-1 → …，faux-2 → …）。
 */
import { createHmac } from 'node:crypto'
import type { Message } from '@earendil-works/pi-ai'
import type { Conversation } from '@earendil-works/pi-durable'
import { expect } from 'vitest'
import { makePlaceholder, type PlaceholderSigner } from '../../../redaction/placeholder'
import type { DurableSession } from '../../durableSession'
import type { DiscloseAction, EgressDecision } from '../../redactionEgress'
import type { RedactionPolicy, RedactionPolicyRequest } from '../../redactionModels'
import type { RedactionHost } from '../../sessionRedaction'
import type { FauxKit } from './faux'
import { allEntries } from './transcript'

export const signer: PlaceholderSigner = {
  sign: (data) => createHmac('sha256', 'test-key').update(data).digest()
}

export const redactionHost: RedactionHost = {
  signer,
  vault: {
    seal: (v) => `SEALED:${Buffer.from(v).toString('base64')}`,
    open: (s) => {
      if (!s.startsWith('SEALED:')) throw new Error('cannot open')
      return Buffer.from(s.slice(7), 'base64').toString()
    }
  }
}

/** 规则认得出的 API key（工具结果里打印的那个） */
export const KEY = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2'
/** 同一个值的占位符（签名确定，不必先脱敏一次） */
export const P_KEY = makePlaceholder(signer, 'API_KEY', KEY)
export const EMAIL = 'someone@company-sample.net'
export const PHONE = '13812345678'
export const PLACEHOLDER = /\{\{[A-Z_]+_[a-z2-7]{8}\}\}/

const levelTwoAsked = (): never => {
  throw new Error('level 2 must not be asked')
}

export const REDACT: EgressDecision = { applies: true, disclose: () => 'redact' }
export const SEND: EgressDecision = { applies: true, disclose: () => 'send' }
export const DENY2: EgressDecision = { applies: true, disclose: () => 'block' }
export const EXEMPT: EgressDecision = { applies: false, disclose: levelTwoAsked }
export const DENY1: EgressDecision = { blocked: true, applies: false, disclose: () => 'redact' }

/** 第二层按类别判（没列的 redact） */
export function byCategory(actions: Readonly<Record<string, DiscloseAction>>): EgressDecision {
  return { applies: true, disclose: ({ category }) => actions[category] ?? 'redact' }
}

/** 策略：按模型选判定；`seen` 记每次的入参 */
export function byModel(
  decisions: Readonly<Record<string, EgressDecision>>,
  seen: RedactionPolicyRequest[] = []
): RedactionPolicy {
  return (request) => {
    seen.push(request)
    const decision = decisions[request.model]
    if (decision === undefined) throw new Error(`no decision for ${request.model}`)
    return decision
  }
}

type NormalBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; name: string; arguments: unknown }
  | { type: 'image' }

export interface NormalMessage {
  role: string
  blocks: NormalBlock[]
}

/** 一条消息里要比的那些：角色、文本、thinking、工具调用的名字与参数（不比 usage、时间戳） */
export function normalizeMessage(message: Message): NormalMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', blocks: [] }
    case 'user':
      return {
        role: 'user',
        blocks:
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content.map((part) =>
                part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image' }
              )
      }
    case 'assistant':
      return {
        role: 'assistant',
        blocks: message.content.map((part): NormalBlock => {
          if (part.type === 'text') return { type: 'text', text: part.text }
          if (part.type === 'thinking') return { type: 'thinking', thinking: part.thinking }
          return { type: 'toolCall', name: part.name, arguments: part.arguments }
        })
      }
    case 'toolResult':
      return {
        role: 'toolResult',
        blocks: message.content.map((part) =>
          part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image' }
        )
      }
  }
}

/** 一个对话记录里（跳过 pi.system）的模型消息，最旧在前 */
export async function recordedMessages(conversation: Conversation): Promise<Message[]> {
  return (await allEntries(conversation))
    .filter((entry) => entry.kind !== 'pi.system')
    .flatMap((entry) => (entry.model ?? []) as Message[])
    .filter((message) => message.role !== 'system')
}

/**
 * 主轴：第 n 个请求发出的（system 消息之外的）消息，逐条等于这个对话记录里最前面的那几条 —— 记录里存什么，模型就收到
 * 什么。`conversation` 缺省当前对话；子对话的请求给它自己的对话。
 */
export async function recordEqualsRequest(
  session: DurableSession,
  kit: FauxKit,
  n: number,
  conversation?: Conversation
): Promise<void> {
  const request = kit.requests[n]
  if (request === undefined) throw new Error(`request ${n} was not made (${kit.requests.length})`)
  const sent = request.messages.filter((message) => message.role !== 'system')
  const stored = await recordedMessages(conversation ?? (await session.currentConversation()))
  expect(
    stored.length,
    `request ${n}: the record is shorter than the request`
  ).toBeGreaterThanOrEqual(sent.length)
  expect(
    stored.slice(0, sent.length).map(normalizeMessage),
    `request ${n} differs from the record`
  ).toEqual(sent.map(normalizeMessage))
}
