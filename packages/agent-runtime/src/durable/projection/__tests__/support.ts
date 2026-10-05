/**
 * 投影用例的小工具：手写条目（`U` / `A` / `E` / `R` / `C` / `N`，对着设计稿的记号）、`P(...)` = 带缺省
 * 输入的 `projectSessionView`，以及「每一份输出都过严格 JSON 守卫」的共享检查（P3-02-49）。
 */
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from '@earendil-works/pi-ai'
import type {
  EntryRecord,
  InboxState,
  JsonObject,
  LiveState,
  ToolDiagnostic
} from '@earendil-works/pi-durable'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { AgentView, RunViewState, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { isJsonOnly } from '@shuvix/chat-protocol/utils/jsonOnly'
import { expect } from 'vitest'
import type { DisplayItem } from '../display'
import {
  projectAgentView,
  projectSessionView,
  type DisplayByEntry,
  type QueueDisplay
} from '../project'

export const SID = 's'
export const META = { sessionId: SID, conversationId: 1 } as const

/** 一张 1×1 的 png（只当内容块用，不解码） */
export const IMAGE: ImageContent = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
export const IMAGE_META = { data: IMAGE.data, mimeType: IMAGE.mimeType }

export const text = (value: string): TextContent => ({ type: 'text', text: value })
export const thinking = (value: string, signature?: string): ThinkingContent => ({
  type: 'thinking',
  thinking: value,
  ...(signature === undefined ? {} : { thinkingSignature: signature })
})
export const call = (name: string, args: JsonObject, id: string): ToolCall => ({
  type: 'toolCall',
  id,
  name,
  arguments: args
})

export interface TestUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export const USAGE = (input: number, output: number, totalTokens = input + output): TestUsage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

const record = (value: object): EntryRecord => value as unknown as EntryRecord

/** `pi.user` */
export function U(
  id: number,
  content: string | (TextContent | ImageContent)[],
  ts?: number,
  conversationId = 1
): EntryRecord {
  return record({
    id,
    conversationId,
    kind: 'pi.user',
    model: [{ role: 'user', content, ...(ts === undefined ? {} : { timestamp: ts }) }]
  })
}

export interface AssistantOptions {
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  errorMessage?: string
  task?: number
  usage?: TestUsage | null
  provider?: string
  model?: string
  images?: unknown
  conversationId?: number
}

/** `pi.assistant`（`task` = byTaskId；usage 缺省 `USAGE(10, 2)`，`null` = 不带） */
export function A(
  id: number,
  content: (TextContent | ThinkingContent | ToolCall)[],
  ts = 0,
  options: AssistantOptions = {}
): EntryRecord {
  const usage = options.usage === undefined ? USAGE(10, 2) : options.usage
  return record({
    id,
    conversationId: options.conversationId ?? 1,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content,
        api: 'faux',
        provider: options.provider ?? 'p',
        model: options.model ?? 'm',
        ...(usage === null ? {} : { usage }),
        stopReason: options.stopReason ?? 'stop',
        ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
        ...(options.images === undefined ? {} : { _images: options.images }),
        timestamp: ts
      }
    ],
    ...(options.task === undefined ? {} : { byTaskId: options.task })
  })
}

/** 一次失败的尝试：stopReason 'error'，没有内容 */
export function E(id: number, errorMessage: string | undefined, task?: number): EntryRecord {
  return A(id, [], 0, {
    stopReason: 'error',
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(task === undefined ? {} : { task })
  })
}

export interface ResultOptions {
  isError?: boolean
  diagnostics?: ToolDiagnostic[]
  details?: unknown
  /** 整份替换 `data`（形状坏的用例）；`null` = 没有 data */
  data?: unknown
}

/** `pi.tool-result` */
export function R(
  id: number,
  callId: string,
  content: (TextContent | ImageContent)[],
  options: ResultOptions = {}
): EntryRecord {
  const data =
    options.data === undefined ? { diagnostics: options.diagnostics ?? [] } : options.data
  return record({
    id,
    conversationId: 1,
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: callId,
        toolName: 't',
        content,
        ...(options.details === undefined ? {} : { details: options.details }),
        isError: options.isError ?? false,
        timestamp: 0
      }
    ],
    ...(data === null ? {} : { data })
  })
}

/** pi 压缩摘要的外壳（与 `projection/entryText` 的常量一致；这里写死，钉住外壳本身） */
export function wrap(summary: string): string {
  return `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`
}

/** `pi.compaction`（`text` = 模型文本，通常 `wrap(...)`） */
export function C(id: number, head: number, summaryText: string, ts = 0): EntryRecord {
  return record({
    id,
    conversationId: 1,
    kind: 'pi.compaction',
    head,
    model: [{ role: 'user', content: [text(summaryText)], timestamp: ts }],
    data: { reason: 'manual' }
  })
}

/** `shuvix.notice` */
export function N(
  id: number,
  content: string | TextContent[],
  kind = 'background',
  ts = 0
): EntryRecord {
  return record({
    id,
    conversationId: 1,
    kind: 'shuvix.notice',
    model: [{ role: 'user', content, timestamp: ts }],
    data: { kind }
  })
}

/** 后台完成通知的正文 */
export const bg = (id: string, body: string): string =>
  `<background-task id="${id}">${body}</background-task>`

export const display = (content: string, tokens: Record<string, unknown>): DisplayItem =>
  ({ content, tokens }) as DisplayItem

export const K1 = {
  k1: { type: 'cmd', id: 'deploy', displayText: '/deploy', payload: 'PAYLOAD-K1' }
}

export interface PInputs {
  meta?: { sessionId: string; conversationId: number }
  live?: unknown
  inbox?: unknown
  display?: DisplayByEntry
  asks?: readonly InputRequest[]
  runState?: RunViewState
  queueDisplay?: QueueDisplay
}

/** 过守卫的输出份数（P3-02-49 断言它不为零） */
export const checked = { views: 0 }

/** P3-02-49 的共享检查：严格 JSON，且 JSON 往返深相等（没有 undefined 的键） */
export function expectJsonView<T>(view: T): T {
  expect(isJsonOnly(view)).toBe(true)
  expect(JSON.parse(JSON.stringify(view))).toStrictEqual(view)
  checked.views += 1
  return view
}

/** `projectSessionView(meta, entries, live, inbox, display, asks, runState)`，缺省见设计稿的约定 */
export function P(entries: readonly EntryRecord[], inputs: PInputs = {}): SessionView {
  return expectJsonView(
    projectSessionView(
      inputs.meta ?? META,
      entries,
      inputs.live as LiveState | undefined,
      (inputs.inbox ?? { items: [] }) as InboxState | undefined,
      inputs.display ?? new Map(),
      inputs.asks ?? [],
      inputs.runState ?? 'idle',
      inputs.queueDisplay
    )
  )
}

export function PA(
  entries: readonly EntryRecord[],
  inputs: Omit<PInputs, 'inbox' | 'asks' | 'queueDisplay'> = {}
): AgentView {
  return expectJsonView(
    projectAgentView(
      { agentId: 'a1', sessionId: SID, conversationId: inputs.meta?.conversationId ?? 1 },
      entries,
      inputs.live as LiveState | undefined,
      inputs.display ?? new Map(),
      inputs.runState ?? 'idle'
    )
  )
}

/** 递归冻结（P3-02-46） */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Reflect.ownKeys(value))
      deepFreeze((value as Record<PropertyKey, unknown>)[key])
  }
  return value
}

/** 视图里所有对象（含数组）的集合 —— 别名检查用 */
export function objectsOf(value: unknown, into = new Set<object>()): Set<object> {
  if (typeof value === 'object' && value !== null && !into.has(value)) {
    into.add(value)
    for (const child of Object.values(value)) objectsOf(child, into)
  }
  return into
}
