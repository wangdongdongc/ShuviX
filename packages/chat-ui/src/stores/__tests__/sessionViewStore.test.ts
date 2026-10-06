/**
 * 视图 → store 的推导（P3-08-12…25）—— `applySessionView` 是会话切片的唯一写入口：
 *
 *   12 当前会话的 messages 与视图逐项相等（各种消息形状）
 *   13 只有当前会话驱动 messages；切过去那一刻不残留别的会话的消息
 *   14 流式正文 / 思考来自实时卡
 *   15 正在生成的工具调用；进了 toolRuns 就转成执行记录；之前的工具块是「已生成」
 *   16 工具执行：done / error；toolRuns 为空 → EMPTY_TOOLS
 *   17 队列（P3-11-20）：选择器交视图的数组（次序、submissionId 原样）；空视图之间同一个空数组引用
 *   18 询问与草稿：视图里没了的那条，草稿与选中项一并清掉
 *   19 上下文占用来自视图
 *   20 run.state 驱动 isStreaming（busy + live null → 等待点的流式占位卡）
 *   21 结构共享：流式追加 / 落盘一条 / 等值 reset
 *   22 单一写入口（类型层 + 外部写的行熬不过下一次视图）
 *   23 applyAgentView：只改转写与实时态，元信息不动；没登记的不建
 *   P3-14 订阅着视图时 agent_start 照样拨回 running（PIN-14）；detachAgentView；deriveAgentViewFields 的共享
 *   25 legacy 视图：消息照显，能力 send:false，没有流式态
 *
 * 不起 jsdom：纯 store 读写。
 */
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { buildVisibleItems } from '../../components/chat/conversationItems'
import {
  EMPTY_TOOLS,
  applySessionView,
  selectAllPendingCounts,
  selectActivePendingInput,
  selectCompletedStreamingToolCalls,
  selectHasLiveStreamContent,
  selectIsStreaming,
  selectPendingInputs,
  selectPendingPrompt,
  selectSessionCapabilities,
  selectSessionQueueItems,
  selectSessionRun,
  selectSessionSource,
  selectStreamingContent,
  selectStreamingImages,
  selectStreamingThinking,
  selectStreamingToolCall,
  selectToolExecutions,
  useChatStore
} from '../chatStore'
import {
  applyAgentView,
  deriveAgentViewFields,
  detachAgentView,
  useSubSessionStore
} from '../subSessionStore'
import {
  V,
  assistant,
  errorRow,
  liveCard,
  resetStore,
  store,
  text,
  thinking,
  toolBlock,
  user
} from '../../__tests__/support/views'

beforeEach(() => {
  resetStore('s1')
})

const items = (): ReturnType<typeof buildVisibleItems> =>
  buildVisibleItems(store().messages, selectIsStreaming(store()), selectPendingPrompt(store()))

const ask = (id: string): InputRequest => ({
  id,
  kind: 'ask',
  toolName: 'bash',
  command: `cmd-${id}`,
  createdAt: 0
})

describe('P3-08-12 / 13 消息', () => {
  it('P3-08-12 当前会话的 messages 与视图的 messages 逐项相等（各种形状）', () => {
    const view = V('s1', {
      messages: [
        user('1', 'look at {{shuvixInlineToken:t1}}', 's1', {
          inlineTokens: { t1: { type: 'at', id: 'f', displayText: '@f', payload: 'P' } },
          images: [{ data: 'aGk=', mimeType: 'image/png' }]
        }),
        assistant('2', [
          thinking('hmm'),
          toolBlock(
            'c1',
            'read',
            { path: 'a' },
            {
              result: 'ok',
              details: { type: 'edit', diff: '--- a\n+++ b' }
            }
          )
        ]),
        user('3', 'notice', 's1', { isSystemNotice: true }),
        errorRow('4', 'rate limited'),
        assistant('5', [text('summary')], 's1', { isCompactionSummary: true }),
        assistant('6', [text('final')], 's1', { retried: { count: 2, lastError: '429' } })
      ]
    })
    applySessionView('s1', view)
    expect(store().messages).toEqual(view.messages)
  })

  it('P3-08-13 只有当前会话驱动 messages；切到 B 的那一刻不残留 A 的', () => {
    const seen: Array<{ active: string | null; ids: string[] }> = []
    const off = useChatStore.subscribe((s) =>
      seen.push({ active: s.activeSessionId, ids: s.messages.map((m) => m.id) })
    )
    store().setActiveSessionId('A')
    applySessionView('A', V('A', { messages: [user('a1', 'A', 'A')] }))
    applySessionView('B', V('B', { messages: [user('b1', 'B', 'B')] }))
    expect(store().messages.map((m) => m.id)).toEqual(['a1'])
    store().setActiveSessionId('B')
    expect(store().messages.map((m) => m.id)).toEqual(['b1'])
    // 一个没有视图的会话：空，绝不是上一条会话的
    store().setActiveSessionId('C')
    expect(store().messages).toEqual([])
    off()
    expect(seen.some((s) => s.active === 'B' && s.ids.includes('a1'))).toBe(false)
    expect(seen.some((s) => s.active === 'C' && s.ids.length > 0)).toBe(false)
  })
})

describe('P3-08-14…17 流式状态、工具、队列', () => {
  it('P3-08-14 正文 / 思考来自实时卡；图片是稳定的空常量', () => {
    const base = V('s1', { run: { state: 'busy' } })
    applySessionView('s1', { ...base, live: liveCard(1, [thinking('t'), text('Hel')]) })
    expect(selectStreamingThinking(store())).toBe('t')
    expect(selectStreamingContent(store())).toBe('Hel')
    expect(selectHasLiveStreamContent(store())).toBe(true)
    expect(selectIsStreaming(store())).toBe(true)
    const images = selectStreamingImages(store())
    expect(images).toEqual([])
    applySessionView('s1', { ...base, live: liveCard(1, [thinking('t'), text('Hello')]) })
    expect(selectStreamingContent(store())).toBe('Hello')
    expect(selectStreamingImages(store())).toBe(images)
  })

  it('P3-08-15 正在生成的工具调用：argsText 原文；进了 toolRuns → 执行记录；之前的工具块是已生成；没有 argsText → 参数序列化', () => {
    const live = liveCard(1, [text('x'), toolBlock('A', 'read', { pa: '' })], { A: '{"pa' })
    applySessionView('s1', V('s1', { live, run: { state: 'busy' } }))
    expect(selectStreamingToolCall(store())).toEqual({ toolName: 'read', argsText: '{"pa' })

    applySessionView(
      's1',
      V('s1', { live, toolRuns: { A: { status: 'running' } }, run: { state: 'busy' } })
    )
    expect(selectStreamingToolCall(store())).toBeNull()
    expect(selectToolExecutions(store())).toEqual([
      expect.objectContaining({
        toolCallId: 'A',
        toolName: 'read',
        status: 'running',
        args: { pa: '' }
      })
    ])

    const two = liveCard(2, [
      toolBlock('B', 'write', { path: 'p' }),
      toolBlock('C', 'read', { path: 'q' })
    ])
    applySessionView('s1', V('s1', { live: two, run: { state: 'busy' } }))
    expect(selectCompletedStreamingToolCalls(store())).toEqual([
      { toolName: 'write', args: { path: 'p' } }
    ])
    expect(selectStreamingToolCall(store())).toEqual({
      toolName: 'read',
      argsText: JSON.stringify({ path: 'q' })
    })
  })

  it('P3-08-16 执行记录：done 带结果与 details、isError → error；toolRuns 为空 → EMPTY_TOOLS', () => {
    const details = { type: 'edit' as const, diff: 'd' }
    applySessionView(
      's1',
      V('s1', {
        messages: [
          assistant('a1', [
            toolBlock('A', 'edit', { path: 'x' }, { result: 'ok', details }),
            toolBlock('B', 'bash', { command: 'false' }, { result: 'boom', isError: true })
          ])
        ],
        toolRuns: { A: { status: 'done' }, B: { status: 'done' } },
        run: { state: 'busy' }
      })
    )
    const [a, b] = selectToolExecutions(store())
    expect(a).toMatchObject({
      toolCallId: 'A',
      status: 'done',
      result: 'ok',
      details,
      messageId: 'a1'
    })
    expect(b).toMatchObject({ toolCallId: 'B', status: 'error' })
    applySessionView('s1', V('s1', { run: { state: 'idle' } }))
    expect(selectToolExecutions(store())).toBe(EMPTY_TOOLS)
  })

  it('P3-08-17 / P3-11-20 队列选择器交视图的数组；空视图之间同一个空数组引用（不会重渲染循环）', () => {
    const queue = [
      { submissionId: 2, mode: 'followUp' as const, text: 'b', imageCount: 2 },
      { submissionId: 1, mode: 'steer' as const, text: 'a', imageCount: 0 }
    ]
    applySessionView('s1', V('s1', { queue }))
    expect(selectSessionQueueItems(store())).toEqual(queue)
    expect(selectSessionQueueItems(store())).toBe(store().sessionViews.s1!.queue)
    applySessionView('s1', V('s1'))
    const empty = selectSessionQueueItems(store())
    expect(empty).toEqual([])
    applySessionView('s1', V('s1', { run: { state: 'busy' } }))
    expect(selectSessionQueueItems(store())).toBe(empty)
    // 没有视图（别的会话）→ 稳定的空数组
    useChatStore.setState({ activeSessionId: 's2' })
    expect(selectSessionQueueItems(store())).toBe(selectSessionQueueItems(store()))
    expect(selectSessionQueueItems(store())).toEqual([])
    // 旧的派生切片不在了（P3-11-20）
    expect('sessionQueues' in store()).toBe(false)
  })
})

describe('P3-08-18…20 询问、上下文、运行状态', () => {
  it('P3-08-18 视图里没了的询问：草稿与选中项一并清掉，别的草稿留着', () => {
    const r1 = ask('r1')
    const r2 = ask('r2')
    applySessionView('s1', V('s1', { asks: [r1, r2] }))
    store().setInputDraft('s1', 'r1', { text: 'one' })
    store().setInputDraft('s1', 'r2', { text: 'two' })
    store().setActiveInputId('s1', 'r1')
    applySessionView('s1', V('s1', { asks: [r2] }))
    expect(selectPendingInputs(store())).toEqual([r2])
    expect(store().sessionInputDrafts.s1).toEqual({ r2: { text: 'two' } })
    expect(store().sessionActiveInputId.s1).toBeUndefined()
    expect(selectActivePendingInput(store())).toEqual(r2)
  })

  it('P3-08-19 上下文占用来自视图：1234 → 1234；null → null', () => {
    applySessionView('s1', V('s1', { context: { usedTokens: 1234 } }))
    expect(store().usedContextTokens).toBe(1234)
    applySessionView('s1', V('s1', { context: { usedTokens: null } }))
    expect(store().usedContextTokens).toBeNull()
  })

  it('P3-08-20 busy + live null → isStreaming，列表末尾是 streaming-live 占位；idle / interrupted → false', () => {
    applySessionView('s1', V('s1', { messages: [user('1', 'hi')], run: { state: 'busy' } }))
    expect(selectIsStreaming(store())).toBe(true)
    const last = items().at(-1)!
    expect(last.isStreamingPlaceholder).toBe(true)
    expect(last.msg.id).toBe('streaming-live')
    applySessionView('s1', V('s1', { messages: [user('1', 'hi')], run: { state: 'idle' } }))
    expect(selectIsStreaming(store())).toBe(false)
    applySessionView('s1', V('s1', { messages: [user('1', 'hi')], run: { state: 'interrupted' } }))
    expect(selectIsStreaming(store())).toBe(false)
  })
})

describe('P3-08-21 结构共享', () => {
  const base = (): SessionView =>
    V('s1', {
      messages: [user('1', 'hi'), assistant('2', [text('done')])],
      asks: [ask('r1')],
      queue: [{ submissionId: 1, mode: 'steer', text: 'a', imageCount: 0 }],
      toolRuns: { c: { status: 'running' } },
      live: liveCard(5, [text('a')]),
      run: { state: 'busy' }
    })

  it('流式追加：messages 与每条消息、询问 / 队列 / 工具执行 / 全局计数都保持引用', () => {
    applySessionView('s1', base())
    const before = {
      messages: store().messages,
      items: [...store().messages],
      asks: selectPendingInputs(store()),
      queue: selectSessionQueueItems(store()),
      tools: selectToolExecutions(store()),
      counts: selectAllPendingCounts(store())
    }
    for (let i = 0; i < 10; i++) {
      const next = base()
      next.live = liveCard(5, [text(`a${'x'.repeat(i + 1)}`)])
      applySessionView('s1', next)
      expect(selectAllPendingCounts(store())).toBe(before.counts)
    }
    expect(selectStreamingContent(store())).toBe('axxxxxxxxxx')
    expect(store().messages).toBe(before.messages)
    store().messages.forEach((m, i) => expect(m).toBe(before.items[i]))
    expect(selectPendingInputs(store())).toBe(before.asks)
    expect(selectSessionQueueItems(store())).toBe(before.queue)
    expect(selectToolExecutions(store())).toBe(before.tools)
  })

  it('落盘一条：数组换新，旧消息按 id 仍是原对象，只有新的那条是新的', () => {
    applySessionView('s1', base())
    const old = [...store().messages]
    const next = base()
    next.messages = [...next.messages, assistant('3', [text('new')])]
    applySessionView('s1', next)
    expect(store().messages).not.toBe(old)
    expect(store().messages[0]).toBe(old[0])
    expect(store().messages[1]).toBe(old[1])
    expect(store().messages[2].id).toBe('3')
  })

  it('等值 reset（整份新树）：任何会话切片都不换引用', () => {
    applySessionView('s1', base())
    const snapshot = { ...store() }
    applySessionView('s1', JSON.parse(JSON.stringify(base())) as SessionView)
    for (const key of [
      'messages',
      'sessionViews',
      'sessionStreams',
      'sessionToolExecutions',
      'sessionPendingInputs'
    ] as const) {
      expect(store()[key], key).toBe(snapshot[key])
    }
  })
})

describe('P3-08-22 单一写入口', () => {
  it('类型层：旧的流式写入口都不在 ChatState 上', () => {
    type Keys = keyof ReturnType<typeof useChatStore.getState>
    expectTypeOf<'appendStreamingContent'>().not.toMatchTypeOf<Keys>()
    expectTypeOf<'appendStreamingThinking'>().not.toMatchTypeOf<Keys>()
    expectTypeOf<'appendStreamingImage'>().not.toMatchTypeOf<Keys>()
    expectTypeOf<'flushStreamingDeltas'>().not.toMatchTypeOf<Keys>()
    expectTypeOf<'handleAssistantMessage'>().not.toMatchTypeOf<Keys>()
    expectTypeOf<'handleToolStart'>().not.toMatchTypeOf<Keys>()
    expectTypeOf<'handleToolEnd'>().not.toMatchTypeOf<Keys>()
    expectTypeOf<'addPendingInput'>().not.toMatchTypeOf<Keys>()
    expectTypeOf<'removePendingInput'>().not.toMatchTypeOf<Keys>()
    expectTypeOf<'setMessages'>().not.toMatchTypeOf<Keys>()
    const state = store() as unknown as Record<string, unknown>
    for (const key of [
      'appendStreamingContent',
      'flushStreamingDeltas',
      'handleAssistantMessage',
      'handleToolStart',
      'handleToolEnd',
      'addPendingInput',
      'removePendingInput',
      'finishStreaming',
      'addMessage',
      'setMessages'
    ]) {
      expect(key in state, key).toBe(false)
    }
  })

  it('chatStore 不再 import messageOps；StreamingDeltaBuffer 不再导出', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
    const source = readFileSync(join(dir, 'chatStore.ts'), 'utf8')
    expect(source).not.toMatch(/messageOps/)
    expect(source).not.toMatch(/StreamingDeltaBuffer/)
    expect(existsSync(join(dir, 'messageOps.ts'))).toBe(false)
  })
})

describe('P3-08-23 applyAgentView（PIN-07 的范围）', () => {
  beforeEach(() => {
    useSubSessionStore.setState({ subSessions: {} })
  })

  const agentView = (content: string): AgentView => ({
    v: 1,
    agentId: 'a1',
    sessionId: 's1',
    conversationId: 2,
    messages: [user('7', 'go', 'a1'), assistant('8', [text('step')], 'a1')],
    live: liveCard(9, [text(content)], undefined, 'a1'),
    toolRuns: {},
    run: { state: 'busy' },
    context: { usedTokens: null }
  })

  it('登记过的 agent：转写 / 实时态来自视图；展示名、提示词、状态不动', () => {
    useSubSessionStore.getState().register({
      subSessionId: 'a1',
      parentSessionId: 's1',
      subAgentName: 'explore',
      displayName: 'Explore',
      description: 'find',
      systemPrompt: 'SYS',
      prompt: 'PROMPT'
    })
    const before = useSubSessionStore.getState().subSessions.a1
    applyAgentView('a1', agentView('wor'))
    const after = useSubSessionStore.getState().subSessions.a1
    expect(after.messages).toEqual(agentView('wor').messages)
    expect(after.isStreaming).toBe(true)
    expect(after.streamingContent).toBe('wor')
    expect({
      displayName: after.displayName,
      systemPrompt: after.systemPrompt,
      prompt: after.prompt,
      status: after.status
    }).toEqual({
      displayName: before.displayName,
      systemPrompt: before.systemPrompt,
      prompt: before.prompt,
      status: before.status
    })
  })

  it('没登记过的 agent：不建条目', () => {
    applyAgentView('ghost', { ...agentView('x'), agentId: 'ghost' })
    expect(useSubSessionStore.getState().subSessions.ghost).toBeUndefined()
  })

  const registerA1 = (): void =>
    useSubSessionStore.getState().register({
      subSessionId: 'a1',
      parentSessionId: 's1',
      subAgentName: 'explore',
      displayName: 'Explore',
      description: 'find',
      systemPrompt: 'SYS',
      prompt: 'PROMPT'
    })

  it('P3-14 PIN-14 订阅着视图时 agent_start 照样把状态拨回 running（流式标记仍以视图为准）', () => {
    registerA1()
    useSubSessionStore.getState().markEnded({ subSessionId: 'a1', result: 'r' })
    applyAgentView('a1', { ...agentView(''), live: null, run: { state: 'idle' } })
    expect(useSubSessionStore.getState().subSessions.a1.status).toBe('done')
    useSubSessionStore.getState().setRunning('a1', true)
    const entry = useSubSessionStore.getState().subSessions.a1
    expect(entry.status).toBe('running')
    expect(entry.result).toBeUndefined()
    expect(entry.isStreaming).toBe(false)
    // agent_end 不动状态（sub_session_end 才收尾）
    useSubSessionStore.getState().setRunning('a1', false)
    expect(useSubSessionStore.getState().subSessions.a1.status).toBe('running')
  })

  it('P3-14 detachAgentView：实时态收掉、落盘的消息留着、条目不删；之后余项重新维护流式标记', () => {
    registerA1()
    applyAgentView('a1', agentView('wor'))
    detachAgentView('a1')
    const entry = useSubSessionStore.getState().subSessions.a1
    expect(entry.view).toBeUndefined()
    expect(entry.messages.map((m) => m.id)).toEqual(['7', '8'])
    expect(entry.streamingContent).toBe('')
    expect(entry.isStreaming).toBe(false)
    useSubSessionStore.getState().setRunning('a1', true)
    expect(useSubSessionStore.getState().subSessions.a1.isStreaming).toBe(true)
    // 没订阅过的：无事
    const before = useSubSessionStore.getState().subSessions
    detachAgentView('ghost')
    expect(useSubSessionStore.getState().subSessions).toBe(before)
  })

  it('P3-14 deriveAgentViewFields：同一份值交回 prev 本身；消息逐项共享', () => {
    const first = deriveAgentViewFields(undefined, agentView('wor'))
    expect(deriveAgentViewFields(first, agentView('wor'))).toBe(first)
    const next = deriveAgentViewFields(first, agentView('world'))
    expect(next).not.toBe(first)
    expect(next.messages).toBe(first.messages)
    expect(next.streamingContent).toBe('world')
  })
})

describe('P3-08-25 legacy 视图（PIN-16）', () => {
  it('消息照显；能力 send:false；来源 legacy；没有流式态', () => {
    applySessionView(
      's1',
      V('s1', {
        source: 'legacy',
        capabilities: { send: false, rollback: false, continue: false },
        conversationId: null,
        messages: [user('u', 'old'), assistant('a', [text('old answer')])]
      })
    )
    expect(store().messages.map((m) => m.id)).toEqual(['u', 'a'])
    expect(selectSessionCapabilities(store())).toEqual({
      send: false,
      rollback: false,
      continue: false
    })
    expect(selectSessionSource(store())).toBe('legacy')
    expect(selectIsStreaming(store())).toBe(false)
    expect(selectStreamingContent(store())).toBe('')
    expect(selectSessionRun(store())).toEqual({ state: 'idle' })
  })
})
