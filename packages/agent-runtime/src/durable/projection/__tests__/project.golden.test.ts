/**
 * P3-02 · 与冻结的旧投影（`legacy/harnessV3/projection.ts`）对照 —— 只读它的 fixture，不碰它。
 *
 *   P3-01-09 旧投影的原始输出不是严格 JSON（`images: undefined` 之类）；剥掉 undefined 之后是（PIN-23）
 *   P3-02-44 fixture 对照：每份旧 fixture 的上下文经测试专用转换器变成 durable 条目，投影结果与期望一致
 *   P3-02-45 逐条规则的等价，以及刻意的差异（同任务错误链、指令注入、undefined 键）
 *
 * 转换器（测试专用）：message/user → pi.user；assistant → pi.assistant（每个用户回合一个新 byTaskId）；
 * toolResult → pi.tool-result（诊断为空）；compaction → pi.compaction（外壳包好的摘要，头标记）；
 * 内联侧车 + 紧随的 user → 显示侧车；系统通知侧车 + 紧随的 user → shuvix.notice；model_change /
 * thinking_level_change → 丢掉；其余 custom 与元条目 → 未知种类；指令 custom_message → 两边都去掉。
 * 归一化：两边都过 JSON；id 按位置对应；去掉 createdAt；user 与压缩摘要去掉 model / provider（PIN-21）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyJson } from '@earendil-works/chord'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { isJsonOnly } from '@shuvix/chat-protocol/utils/jsonOnly'
import { describe, expect, it } from 'vitest'
import {
  INLINE_TOKENS_CUSTOM_TYPE,
  INSTRUCTION_CUSTOM_TYPE,
  SYSTEM_NOTICE_CUSTOM_TYPE,
  entriesToChatMessages,
  readHarnessV3Transcript,
  type HarnessV3Entry
} from '../../../legacy/harnessV3'
import type { DisplayItem } from '../display'
import { P, wrap } from './support'

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../legacy/harnessV3/__tests__/fixtures'
)

const FIXTURES = [
  'G01-linear-basic',
  'G02-sidecars',
  'G03-rollback-continue',
  'G03b-rollback-tail',
  'G04a-rollback-to-root-tail',
  'G04b-rollback-to-root-continue',
  'G05-compaction-single',
  'G06a-compaction-multiple-later-cut',
  'G06b-compaction-multiple-earlier-cut',
  'G07-compaction-rolled-back',
  'G08-compaction-firstkept-missing',
  'G09-meta-entries',
  'G10-errors-images',
  'G11-model-switch-midway'
] as const

interface Fixture {
  sessionId: string
  contextEntries: HarnessV3Entry[]
  messages: ChatMessage[]
}

function fixture(name: string): Fixture {
  const text = readFileSync(join(FIXTURE_DIR, `${name}.jsonl`), 'utf8')
  const expected = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.expected.json`), 'utf8')) as {
    sessionId: string
    contextEntryIds: string[]
    messages: ChatMessage[]
  }
  const contextEntries = readHarnessV3Transcript(text).contextEntries
  expect(contextEntries.map((entry) => entry.id)).toEqual(expected.contextEntryIds)
  return { sessionId: expected.sessionId, contextEntries, messages: expected.messages }
}

interface Converted {
  entries: EntryRecord[]
  display: Map<number, DisplayItem>
  /** 两边都去掉的旧条目 id（指令注入） */
  removed: Set<string>
}

/** 测试专用：旧上下文条目 → durable 条目 + 显示侧车 */
function convert(context: readonly HarnessV3Entry[]): Converted {
  const entries: EntryRecord[] = []
  const display = new Map<number, DisplayItem>()
  const removed = new Set<string>()
  let nextId = 1
  let task = 0
  let pendingInline: DisplayItem | null = null
  let pendingNotice = false
  const push = (draft: Record<string, unknown>): number => {
    const id = nextId++
    entries.push({ id, conversationId: 1, ...draft } as unknown as EntryRecord)
    return id
  }
  for (const entry of context) {
    const ts = Date.parse(entry.timestamp) || 0
    switch (entry.type) {
      case 'model_change':
      case 'thinking_level_change':
        continue
      case 'custom': {
        if (entry.customType === INLINE_TOKENS_CUSTOM_TYPE) {
          const data = entry.data as { content?: unknown; tokens?: unknown }
          pendingInline =
            typeof data?.content === 'string' && typeof data.tokens === 'object' && data.tokens !== null
              ? ({ content: data.content, tokens: data.tokens } as DisplayItem)
              : null
          continue
        }
        if (entry.customType === SYSTEM_NOTICE_CUSTOM_TYPE) {
          pendingNotice = true
          continue
        }
        push({ kind: 'x.legacy-custom', data: { customType: entry.customType } })
        continue
      }
      case 'custom_message':
        if (entry.customType === INSTRUCTION_CUSTOM_TYPE) {
          removed.add(entry.id)
          continue
        }
        push({ kind: 'x.legacy-custom-message' })
        continue
      case 'compaction':
        push({
          kind: 'pi.compaction',
          head: nextId + 1,
          model: [{ role: 'user', content: [{ type: 'text', text: wrap(entry.summary) }], timestamp: ts }],
          data: { reason: 'threshold' }
        })
        continue
      case 'message': {
        const message = entry.message as { role: string; timestamp?: number }
        const timestamp = typeof message.timestamp === 'number' ? message.timestamp : ts
        if (message.role === 'user') {
          const id = push({
            kind: pendingNotice ? 'shuvix.notice' : 'pi.user',
            model: [{ ...message, timestamp }],
            ...(pendingNotice ? { data: { kind: 'background' } } : {})
          })
          if (pendingInline !== null) display.set(id, pendingInline)
          pendingInline = null
          pendingNotice = false
          task += 1
          continue
        }
        pendingInline = null
        pendingNotice = false
        if (message.role === 'assistant') {
          push({ kind: 'pi.assistant', model: [message], byTaskId: task })
        } else if (message.role === 'toolResult') {
          push({ kind: 'pi.tool-result', model: [message], data: { diagnostics: [] } })
        } else {
          push({ kind: `x.legacy-role-${message.role}` })
        }
        continue
      }
      default:
        push({ kind: `x.legacy-${entry.type}` })
    }
  }
  return { entries, display, removed }
}

/** 归一化：过 JSON，id 换成位置，去掉 createdAt，user / 压缩摘要去掉 model / provider */
function normalize(messages: readonly ChatMessage[]): unknown[] {
  return (JSON.parse(JSON.stringify(messages)) as Record<string, unknown>[]).map((message, index) => {
    const { createdAt: _createdAt, id: _id, ...rest } = message
    const metadata = rest.metadata as { isCompactionSummary?: boolean } | null
    if (rest.role === 'user' || metadata?.isCompactionSummary === true) {
      delete rest.model
      delete rest.provider
    }
    return { at: index, ...rest }
  })
}

function legacyOf(context: readonly HarnessV3Entry[], sessionId: string): ChatMessage[] {
  return entriesToChatMessages(context, sessionId)
}

function durableOf(context: readonly HarnessV3Entry[], sessionId: string): ChatMessage[] {
  const { entries, display } = convert(context)
  return P(entries, { meta: { sessionId, conversationId: 1 }, display }).messages
}

// ─── 手写的旧条目（P3-02-45） ───

let serial = 0
const TS = '2026-10-05T00:00:00.000Z'
const base = () => ({ id: `e${++serial}`, parentId: null, timestamp: TS })
const lUser = (content: unknown): HarnessV3Entry =>
  ({ ...base(), type: 'message', message: { role: 'user', content, timestamp: 1 } }) as HarnessV3Entry
const lAssistant = (content: unknown[], extra: Record<string, unknown> = {}): HarnessV3Entry =>
  ({
    ...base(),
    type: 'message',
    message: {
      role: 'assistant',
      content,
      api: 'faux',
      provider: 'p',
      model: 'm',
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: {} },
      stopReason: 'stop',
      timestamp: 2,
      ...extra
    }
  }) as HarnessV3Entry
const lResult = (toolCallId: string, text: string, isError = false): HarnessV3Entry =>
  ({
    ...base(),
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 't',
      content: [{ type: 'text', text }],
      isError,
      timestamp: 3
    }
  }) as HarnessV3Entry
const lCustom = (customType: string, data: unknown): HarnessV3Entry =>
  ({ ...base(), type: 'custom', customType, data }) as HarnessV3Entry
const lCall = (id: string) => ({ type: 'toolCall', id, name: 'ls', arguments: { path: '.' } })
const IMG = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }

function expectEquivalent(context: HarnessV3Entry[]): void {
  const legacy = legacyOf(context, 's')
  const durable = durableOf(context, 's')
  expect(normalize(durable)).toEqual(normalize(legacy))
}

describe('P3-01-09 · the raw legacy view is not strict JSON (hazard for P3-04)', () => {
  it('G10-errors-images: the guard rejects the raw output and accepts it after stripping undefined (PIN-23)', () => {
    const { contextEntries, sessionId } = fixture('G10-errors-images')
    const raw = entriesToChatMessages(contextEntries, sessionId)
    expect(isJsonOnly(raw)).toBe(false)
    expect(isJsonOnly(copyJson(raw, { omitUndefinedProperties: true }))).toBe(true)
  })
})

describe('P3-02-44 · golden parity with the legacy fixtures', () => {
  it.each(FIXTURES)('%s', (name) => {
    const { contextEntries, sessionId, messages } = fixture(name)
    const { removed } = convert(contextEntries)
    const expected = messages.filter((message) => !removed.has(message.id))
    const durable = durableOf(contextEntries, sessionId)
    expect(durable.length).toBe(expected.length)
    expect(normalize(durable)).toEqual(normalize(expected))
  })

  it('the corpus exercises the interesting rules (instruction removal, sidecars, compaction, errors, images)', () => {
    const all = FIXTURES.map((name) => fixture(name))
    const removedCount = all.reduce((n, f) => n + convert(f.contextEntries).removed.size, 0)
    expect(removedCount).toBeGreaterThan(0)
    const messages = all.flatMap((f) => f.messages)
    const meta = (m: ChatMessage) => (m.metadata ?? {}) as Record<string, unknown>
    expect(messages.some((m) => 'inlineTokens' in meta(m))).toBe(true)
    expect(messages.some((m) => meta(m).isSystemNotice === true)).toBe(true)
    expect(messages.some((m) => meta(m).isCompactionSummary === true)).toBe(true)
    expect(messages.some((m) => m.type === 'error_event')).toBe(true)
    expect(messages.some((m) => Array.isArray(meta(m).images))).toBe(true)
  })
})

describe('P3-02-45 · per-rule equivalence and intended differences', () => {
  it('inline sidecar ↔ display', () => {
    expectEquivalent([
      lCustom(INLINE_TOKENS_CUSTOM_TYPE, {
        content: 'run {{shuvixInlineToken:k}}',
        tokens: { k: { type: 'cmd', id: 'x', displayText: '/x', payload: 'PAYLOAD' } }
      }),
      lUser([{ type: 'text', text: 'run PAYLOAD' }]),
      lAssistant([{ type: 'text', text: 'ok' }])
    ])
  })

  it('notice sidecar ↔ notice entry; text-shape notice', () => {
    expectEquivalent([
      lCustom(SYSTEM_NOTICE_CUSTOM_TYPE, {}),
      lUser('Background task finished: npm test exited 0'),
      lAssistant([{ type: 'text', text: 'noted' }]),
      lUser('<background-task id="t1">done</background-task>'),
      lAssistant([{ type: 'text', text: 'ok' }])
    ])
  })

  it('whitespace-thinking drop and empty-card drop', () => {
    expectEquivalent([
      lUser('hi'),
      lAssistant([{ type: 'thinking', thinking: '\n' }, { type: 'text', text: 'a' }]),
      lUser('again'),
      lAssistant([{ type: 'thinking', thinking: '  ' }], { stopReason: 'aborted' }),
      lUser('third'),
      lAssistant([], { stopReason: 'aborted' })
    ])
  })

  it('an error with and without a message (one per user turn, so nothing folds)', () => {
    expectEquivalent([
      lUser('hi'),
      lAssistant([], { stopReason: 'error', errorMessage: 'Connection error.' }),
      lUser('again'),
      lAssistant([{ type: 'text', text: 'partial' }], { stopReason: 'error' }),
      lUser('third'),
      lAssistant([{ type: 'text', text: 'partial' }], { stopReason: 'error', errorMessage: '' })
    ])
  })

  it('orphan results and a reused tool-call id', () => {
    expectEquivalent([
      lUser('hi'),
      lResult('nope', 'orphan'),
      lAssistant([lCall('dup')], { stopReason: 'toolUse' }),
      lAssistant([lCall('dup')], { stopReason: 'toolUse' }),
      lResult('dup', 'first'),
      lResult('dup', 'second'),
      lAssistant([{ type: 'text', text: 'done' }])
    ])
  })

  it('images on user messages and _images on assistant messages; error tool results', () => {
    expectEquivalent([
      lUser([{ type: 'text', text: 'look' }, IMG]),
      lAssistant([lCall('c1')], { stopReason: 'toolUse' }),
      lResult('c1', 'bad', true),
      lAssistant([], { _images: [{ data: 'AAAA', mimeType: 'image/png' }] })
    ])
  })

  it('intended difference: a same-task error chain is N rows in legacy, folded into the hinted card in durable', () => {
    const context = [
      lUser('hi'),
      lAssistant([], { stopReason: 'error', errorMessage: '503 a' }),
      lAssistant([], { stopReason: 'error', errorMessage: '503 b' }),
      lAssistant([{ type: 'text', text: 'ok' }])
    ]
    const legacy = legacyOf(context, 's')
    const durable = durableOf(context, 's')
    expect(legacy.map((m) => m.type)).toEqual(['text', 'error_event', 'error_event', 'message'])
    expect(durable.map((m) => m.type)).toEqual(['text', 'message'])
    expect(durable[1]!.metadata).toMatchObject({ retried: { count: 2, lastError: '503 b' } })
    // the final failure of a chain: one row with the count
    const failed = durableOf(context.slice(0, 3), 's')
    expect(failed.map((m) => [m.type, m.content, m.metadata])).toEqual([
      ['text', 'hi', {}],
      ['error_event', '503 b', { retried: { count: 1, lastError: '503 a' } }]
    ])
    expect(legacyOf(context.slice(0, 3), 's').filter((m) => m.type === 'error_event')).toHaveLength(2)
  })

  it('intended difference: instruction injection has no durable counterpart', () => {
    const injection = {
      ...base(),
      type: 'custom_message',
      customType: INSTRUCTION_CUSTOM_TYPE,
      content: 'Follow AGENTS.md',
      details: { filename: 'AGENTS.md' },
      display: true
    } as HarnessV3Entry
    const context = [injection, lUser('hi')]
    const legacy = legacyOf(context, 's')
    expect(legacy[0]!.metadata).toMatchObject({ isInstructionInjection: true })
    const durable = durableOf(context, 's')
    expect(durable.map((m) => m.content)).toEqual(['hi'])
    expect(JSON.stringify(durable)).not.toContain('isInstructionInjection')
  })

  it('intended difference: legacy carries undefined keys, durable output has none', () => {
    const context = [
      lUser('hi'),
      lAssistant([lCall('c1')], { stopReason: 'toolUse', usage: undefined }),
      lResult('c1', 'ok')
    ]
    const legacy = legacyOf(context, 's')
    const durable = durableOf(context, 's')
    expect('images' in (legacy[0]!.metadata as object)).toBe(true)
    expect((legacy[0]!.metadata as { images?: unknown }).images).toBeUndefined()
    expect(isJsonOnly(legacy)).toBe(false)
    expect('images' in (durable[0]!.metadata as object)).toBe(false)
    expect(isJsonOnly(durable)).toBe(true)
    expect(normalize(durable)).toEqual(normalize(legacy))
  })
})
