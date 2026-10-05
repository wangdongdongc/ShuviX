/**
 * P3-01 · SessionView / AgentView / LiveCard 的形状，严格 JSON 守卫，空视图。
 *
 *   P3-01-01 SessionView 的形状（类型层）
 *   P3-01-02 AgentView：同一套 messages / live / toolRuns / run，没有 queue / asks
 *   P3-01-03 LiveCard
 *   P3-01-06 守卫接受合法视图（全字段、空视图、AgentView）
 *   P3-01-07 守卫拒绝非法值（每行一个藏在深处的违规；assert 报出路径）
 *   P3-01-08 守卫与 chord 的 isJsonValue 逐项一致（测试可以引 chord，协议包不行）
 *   P3-01-11 依赖卫生：sessionView.ts / sync.ts 只引协议包自己的东西；子路径可解析
 *   P3-01-12 emptySessionView
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isJsonValue } from '@earendil-works/chord'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { assertJsonOnly, isJsonOnly } from '../utils/jsonOnly'
import type { AssistantMessage, ChatMessage, ToolResultDetails } from './chatMessage'
import type { InputRequest } from './inputRequest'
import {
  emptySessionView,
  type AgentView,
  type LiveCard,
  type SessionView,
  type ToolRunView
} from './sessionView'

const IMAGE = { data: 'iVBORw0KGgo=', mimeType: 'image/png' }

/** 每个可选字段都给上的完整视图 */
function fullView(): SessionView {
  const live: LiveCard = {
    id: 'live:7',
    message: {
      id: 'live:7',
      sessionId: 's',
      role: 'assistant',
      type: 'message',
      blocks: [
        { type: 'thinking', text: 'plan' },
        { type: 'text', text: 'par' },
        { type: 'tool', toolCallId: 'c9', toolName: 'write', args: { path: 'x' } }
      ],
      content: 'par',
      model: 'm',
      provider: 'p',
      createdAt: 5,
      metadata: { retried: { count: 2, lastError: '503' } }
    },
    argsText: { c9: '{"path":"x","con' }
  }
  return {
    v: 1,
    sessionId: 's',
    source: 'durable',
    capabilities: { send: true, rollback: true, continue: true },
    conversationId: 1,
    messages: [
      {
        id: '1',
        sessionId: 's',
        role: 'user',
        type: 'text',
        content: 'run {{shuvixInlineToken:k1}}',
        model: '',
        createdAt: 1000,
        metadata: {
          images: [IMAGE],
          inlineTokens: {
            k1: { type: 'cmd', id: 'deploy', displayText: '/deploy', payload: 'P', name: 'Deploy' }
          }
        }
      },
      {
        id: '2',
        sessionId: 's',
        role: 'assistant',
        type: 'message',
        blocks: [
          { type: 'thinking', text: 't' },
          {
            type: 'tool',
            toolCallId: 'c1',
            toolName: 'bash',
            args: { command: 'ls' },
            result: 'out',
            isError: true,
            details: { type: 'bash', exitCode: 1, truncated: true, persisted: true, cwd: '/w' },
            spill: { path: '/Users/a b/.shuvix/tool_results/c1.txt' }
          },
          {
            type: 'tool',
            toolCallId: 'c2',
            toolName: 'read',
            args: { path: 'img.png' },
            result: 'ok',
            details: {
              type: 'read',
              truncated: false,
              image: { path: '/tmp/i.png', width: 1, height: 1, bytes: 9 }
            }
          },
          { type: 'text', text: 'done' }
        ],
        content: 'done',
        model: 'm',
        provider: 'p',
        createdAt: 2000,
        metadata: {
          images: [IMAGE],
          usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, total: 12 },
          retried: { count: 1, lastError: '429' }
        }
      },
      {
        id: '3',
        sessionId: 's',
        role: 'assistant',
        type: 'message',
        blocks: [{ type: 'text', text: 'S' }],
        content: 'S',
        model: '',
        createdAt: 0,
        metadata: { isCompactionSummary: true }
      },
      {
        id: '4',
        sessionId: 's',
        role: 'system_notify',
        type: 'error_event',
        content: '503',
        model: 'm',
        provider: 'p',
        createdAt: 3000,
        metadata: { retried: { count: 10, lastError: '503' } }
      },
      {
        id: '5',
        sessionId: 's',
        role: 'user',
        type: 'text',
        content: '<background-task id="t">done</background-task>',
        model: '',
        createdAt: 4000,
        metadata: { isSystemNotice: true }
      }
    ],
    live,
    toolRuns: {
      c1: { status: 'running', output: 'l1\n', details: { type: 'bash', exitCode: 0, truncated: false } },
      c2: { status: 'pending' },
      c3: { status: 'done' }
    },
    run: {
      state: 'busy',
      retry: { attempt: 2, at: 9000, error: '503' },
      compacting: { reason: 'threshold', blocking: true, attempt: 1, retryAt: 500 }
    },
    queue: [
      { submissionId: 11, mode: 'steer', text: 'fix it', imageCount: 0 },
      { submissionId: 13, mode: 'followUp', text: 'ab', imageCount: 2 }
    ],
    asks: [
      {
        id: 'c1',
        kind: 'ask',
        toolName: 'write',
        createdAt: 1,
        command: 'write a.ts',
        preview: { kind: 'diff', path: 'a.ts', diff: '@@ -1 +1 @@\n-a\n+b', isNewFile: false },
        policyPrompt: { text: 'careful', policies: ['p1'] },
        review: { risk: 'medium', summary: 'writes a file', reason: 'outside the workspace' }
      },
      {
        id: 'c2',
        kind: 'choice',
        toolName: 'ask',
        createdAt: 2,
        question: 'Which?',
        options: [{ label: 'A', description: 'first' }],
        allowMultiple: false
      }
    ],
    context: { usedTokens: 1250 }
  }
}

function agentView(): AgentView {
  const view = fullView()
  return {
    v: 1,
    agentId: 'a1',
    sessionId: 's',
    conversationId: 4,
    messages: view.messages,
    live: view.live,
    toolRuns: view.toolRuns,
    run: view.run,
    context: view.context
  }
}

class Point {
  constructor(public x = 1) {}
}

/** 每行一个违规，放在 `messages[0].metadata.usage` 这种深处 */
function negatives(): [string, unknown, string][] {
  const deep = (offender: unknown): unknown => {
    const view = fullView() as unknown as {
      messages: { metadata: Record<string, unknown> }[]
    }
    view.messages[1]!.metadata.usage = offender
    return view
  }
  const at = 'messages[1].metadata.usage'
  const sparse: unknown[] = [1, 2]
  sparse.length = 3
  const extra = [1, 2] as unknown[] & { tag?: string }
  extra.tag = 'x'
  const getter = {}
  Object.defineProperty(getter, 'n', { get: () => 1, enumerable: true })
  const cycle: Record<string, unknown> = { a: 1 }
  cycle.self = cycle
  const symbolKey = { [Symbol('k')]: 1 }
  return [
    ['undefined property value', deep({ input: 1, output: undefined }), `${at}.output`],
    ['NaN', deep(NaN), at],
    ['Infinity', deep(Infinity), at],
    ['-Infinity', deep(-Infinity), at],
    ['function', deep(() => 1), at],
    ['bigint', deep(BigInt(1)), at],
    ['symbol key', deep(symbolKey), at],
    ['Date', deep(new Date(0)), at],
    ['Map', deep(new Map()), at],
    ['Set', deep(new Set()), at],
    ['class instance', deep(new Point()), at],
    ['Object.create(proto)', deep(Object.create({ inherited: 1 })), at],
    ['sparse array', deep(sparse), at],
    ['array with an extra named prop', deep(extra), at],
    ['getter property', deep(getter), `${at}.n`],
    ['cycle', deep(cycle), `${at}.self`]
  ]
}

describe('P3-01 · SessionView types and the JSON guard', () => {
  it('P3-01-01 SessionView shape (type level)', () => {
    expectTypeOf<SessionView['v']>().toEqualTypeOf<1>()
    expectTypeOf<SessionView['source']>().toEqualTypeOf<'durable' | 'legacy' | 'none'>()
    expectTypeOf<SessionView['capabilities']>().toEqualTypeOf<{
      send: boolean
      rollback: boolean
      continue: boolean
    }>()
    expectTypeOf<SessionView['conversationId']>().toEqualTypeOf<number | null>()
    expectTypeOf<SessionView['messages']>().toEqualTypeOf<ChatMessage[]>()
    expectTypeOf<SessionView['live']>().toEqualTypeOf<LiveCard | null>()
    expectTypeOf<SessionView['toolRuns']>().toEqualTypeOf<
      Record<
        string,
        { status: 'pending' | 'running' | 'done'; output?: string; details?: ToolResultDetails }
      >
    >()
    expectTypeOf<SessionView['run']['state']>().toEqualTypeOf<'idle' | 'busy' | 'interrupted'>()
    expectTypeOf<SessionView['run']['retry']>().toEqualTypeOf<
      { attempt: number; at: number; error: string } | undefined
    >()
    expectTypeOf<SessionView['run']['compacting']>().toEqualTypeOf<
      { reason: string; blocking: boolean; attempt: number; retryAt?: number } | undefined
    >()
    expectTypeOf<SessionView['queue'][number]['mode']>().toEqualTypeOf<'steer' | 'followUp'>()
    // @ts-expect-error nextTurn is gone end to end (Q-P3-09)
    const nextTurn: SessionView['queue'][number]['mode'] = 'nextTurn'
    expect(nextTurn).toBe('nextTurn')
    expectTypeOf<SessionView['asks']>().toEqualTypeOf<InputRequest[]>()
    expectTypeOf<SessionView['context']['usedTokens']>().toEqualTypeOf<number | null>()
  })

  it('P3-01-02 AgentView: the same messages / live / toolRuns / run, no queue or asks; PIN-24 identity fields', () => {
    expectTypeOf<AgentView['messages']>().toEqualTypeOf<SessionView['messages']>()
    expectTypeOf<AgentView['live']>().toEqualTypeOf<SessionView['live']>()
    expectTypeOf<AgentView['toolRuns']>().toEqualTypeOf<SessionView['toolRuns']>()
    expectTypeOf<AgentView['run']>().toEqualTypeOf<SessionView['run']>()
    expectTypeOf<AgentView['context']>().toEqualTypeOf<SessionView['context']>()
    expectTypeOf<AgentView['v']>().toEqualTypeOf<1>()
    expectTypeOf<AgentView['agentId']>().toEqualTypeOf<string>()
    expectTypeOf<AgentView['sessionId']>().toEqualTypeOf<string>()
    expectTypeOf<AgentView['conversationId']>().toEqualTypeOf<number>()
    const view = agentView()
    // @ts-expect-error an agent view has no queue (it belongs to the root session)
    expect(view.queue).toBeUndefined()
    // @ts-expect-error an agent view has no asks (they belong to the root session)
    expect(view.asks).toBeUndefined()
    expect(Object.keys(view).sort()).toEqual(
      [
        'v',
        'agentId',
        'sessionId',
        'conversationId',
        'messages',
        'live',
        'toolRuns',
        'run',
        'context'
      ].sort()
    )
  })

  it('P3-01-03 LiveCard: string id, the chat-protocol AssistantMessage, optional argsText', () => {
    expectTypeOf<LiveCard['id']>().toEqualTypeOf<string>()
    expectTypeOf<LiveCard['message']>().toEqualTypeOf<AssistantMessage>()
    expectTypeOf<LiveCard['argsText']>().toEqualTypeOf<Record<string, string> | undefined>()
    expectTypeOf<ToolRunView['status']>().toEqualTypeOf<'pending' | 'running' | 'done'>()
  })

  it('P3-01-06 the guard accepts valid views: fully populated, empty, an AgentView', () => {
    for (const value of [fullView(), emptySessionView('s'), agentView()]) {
      expect(isJsonOnly(value)).toBe(true)
      expect(() => assertJsonOnly(value, 'view')).not.toThrow()
    }
    // a null-prototype object is plain JSON too (chord agrees)
    expect(isJsonOnly(Object.assign(Object.create(null), { a: 1 }))).toBe(true)
  })

  it.each(negatives())('P3-01-07 the guard rejects: %s', (_label, value, path) => {
    expect(isJsonOnly(value)).toBe(false)
    expect(() => assertJsonOnly(value, 'view')).toThrow(`view.${path} is not strict JSON`)
  })

  it('P3-01-08 the guard agrees with chord isJsonValue on the whole corpus', () => {
    const corpus: unknown[] = [
      fullView(),
      emptySessionView('s'),
      agentView(),
      null,
      'x',
      0,
      true,
      [],
      {},
      Object.assign(Object.create(null), { a: 1 }),
      undefined,
      [undefined],
      ...negatives().map(([, value]) => value)
    ]
    for (const value of corpus) expect(isJsonOnly(value)).toBe(isJsonValue(value))
    // a shared (DAG) sub-object is not a cycle for either
    const shared = { n: 1 }
    const dag = { a: shared, b: [shared, shared] }
    expect(isJsonOnly(dag)).toBe(true)
    expect(isJsonValue(dag)).toBe(true)
    // a non-enumerable own property fails both
    const hidden = { a: 1 }
    Object.defineProperty(hidden, 'b', { value: 2, enumerable: false })
    expect(isJsonOnly(hidden)).toBe(isJsonValue(hidden))
    expect(isJsonOnly(hidden)).toBe(false)
  })

  it('P3-01-11 dependency hygiene: sessionView.ts and sync.ts import nothing outside the protocol package; the subpaths resolve', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const file of [resolve(here, 'sessionView.ts'), resolve(here, '../sync.ts')]) {
      const source = readFileSync(file, 'utf8')
      const specifiers = [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]!)
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(/^@earendil-works\//)
        expect(specifier).not.toMatch(/^@shuvix\/agent-runtime/)
        expect(specifier).not.toMatch(/^node:/)
        expect(specifier).not.toMatch(/^(fs|path|os|electron)(\/|$)/)
        expect(specifier.startsWith('.')).toBe(true)
      }
    }
    const viewModule = await import('@shuvix/chat-protocol/types/sessionView')
    expect(viewModule.emptySessionView).toBe(emptySessionView)
    const syncModule = await import('@shuvix/chat-protocol/sync')
    expect(syncModule.CHAT_VIEW_SERVICE_ID).toBe('shuvix.chat.view')
  })

  it('P3-01-12 emptySessionView: exact value, passes the guard, a fresh object per call', () => {
    const view = emptySessionView('s9')
    expect(view).toStrictEqual({
      v: 1,
      sessionId: 's9',
      source: 'none',
      capabilities: { send: true, rollback: false, continue: false },
      conversationId: null,
      messages: [],
      live: null,
      toolRuns: {},
      run: { state: 'idle' },
      queue: [],
      asks: [],
      context: { usedTokens: null }
    })
    expect(isJsonOnly(view)).toBe(true)
    const other = emptySessionView('s9')
    expect(other).not.toBe(view)
    view.messages.push({} as ChatMessage)
    view.capabilities.send = false
    view.run.state = 'busy'
    expect(other.messages).toEqual([])
    expect(other.capabilities.send).toBe(true)
    expect(other.run.state).toBe('idle')
  })
})
