/**
 * `forwardHarnessEvent` 的工具结果广播路径。
 *
 * 钉的是一条曾经断掉的接缝：`transformToolResult` 由宿主注入、`harnessSession` 也确实
 * 传了进来，但 `handleToolEnd` 从没调用过它，而是自己重写了一遍序列化。后果是桌面端
 * 那条「ImageContent → 占位文本」的瘦身管线（stepPersistPipeline）完全没有生效点：
 * `read` 一张图片时整段 base64 会经 IPC 灌进渲染进程再铺到工具卡片上。
 *
 * 注入点没有类型错误、没有报错、行为上只是「图片没被换掉」—— 这种缺陷只能靠
 * 「断言 transform 真的被调用、且广播用的是它的返回值」钉住。
 *
 * 另有 `toolcall_generating` 的 toolCallId（协作编辑的虚影靠它把「正在写的参数」与「随后执行的那次调用」对上）：
 *   E1 toolcall_start 与之后每一片 toolcall_delta 都带块的 id
 *   E2 块没有 id → 事件里根本没有 toolCallId 这个键
 *   E3 一条消息里的第二次调用 → 之后的增量换成第二个 id
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlSessionStorage, Session } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import type { AgentHarnessEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { UserTextMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { forwardHarnessEvent, createHarnessEventState } from '../eventHandler'
import type { HarnessEventContext } from '../eventHandler'
import { INLINE_TOKENS_CUSTOM_TYPE, SYSTEM_NOTICE_CUSTOM_TYPE } from '../projection'
import { defaultToolResultTransform } from '../../types'
import type { ChatEvent, ToolResultTransform } from '../../types'
import { imagePlaceholder } from '../../toolResultText'

const SESSION_ID = 'sess-1'

/** 只装配 handleToolEnd 会用到的东西；session 不参与该分支 */
function makeCtx(transform: ToolResultTransform): {
  ctx: HarnessEventContext
  events: ChatEvent[]
} {
  const events: ChatEvent[] = []
  const ctx: HarnessEventContext = {
    sessionId: SESSION_ID,
    session: {} as Session,
    state: createHarnessEventState(),
    broadcast: (e) => events.push(e),
    deps: {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      getModelId: () => 'test-model',
      transformToolResult: transform
    }
  }
  return { ctx, events }
}

function toolEnd(content: unknown[], extra: Record<string, unknown> = {}): AgentHarnessEvent {
  return {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'read',
    isError: false,
    result: { content, details: { type: 'read', path: '/tmp/a.png' }, ...extra }
  } as unknown as AgentHarnessEvent
}

const IMAGE = { type: 'image', data: 'AAAABBBBCCCC', mimeType: 'image/png' }

describe('工具结果广播', () => {
  it('广播前过宿主注入的 transform，用的是它的返回值而不是原始内容', async () => {
    const transform = vi.fn<ToolResultTransform>(() => ({
      content: '[image omitted]',
      details: { type: 'read', path: '/tmp/a.png' } as never
    }))
    const { ctx, events } = makeCtx(transform)

    await forwardHarnessEvent(ctx, toolEnd([{ type: 'text', text: 'head' }, IMAGE]))

    // 拿到的是原始内容（transform 自己决定怎么瘦身）
    expect(transform).toHaveBeenCalledTimes(1)
    expect(transform.mock.calls[0][0]).toMatchObject({
      toolName: 'read',
      toolCallId: 'call-1',
      sessionId: SESSION_ID,
      isError: false,
      content: [{ type: 'text', text: 'head' }, IMAGE]
    })

    // 广播出去的是 transform 的输出 —— base64 没有外泄
    const [ev] = events
    expect(ev).toMatchObject({ type: 'tool_end', toolCallId: 'call-1', result: '[image omitted]' })
    expect(JSON.stringify(ev)).not.toContain('AAAABBBBCCCC')
  })

  it('默认 transform 与重开会话同一份文字：文本按行拼、图片换占位，base64 不进广播', async () => {
    const { ctx, events } = makeCtx(defaultToolResultTransform)

    await forwardHarnessEvent(ctx, toolEnd([{ type: 'text', text: 'line1' }, IMAGE]))

    // 不注入 transform 的宿主（扩展端）以前把图片块 JSON 序列化 —— 截图的整段 base64 铺进
    // 工具卡片；现在与重开会话的投影同走 toolResultText，跑着时和重开之后一字不差
    expect(events[0]).toMatchObject({
      type: 'tool_end',
      result: `line1\n${imagePlaceholder('image/png')}`
    })
    expect(JSON.stringify(events[0])).not.toContain(IMAGE.data)
  })

  it('details 走 transform 的输出（它可以改写），isError 原样透传', async () => {
    const transform = vi.fn<ToolResultTransform>(() => ({
      content: 'x',
      details: { type: 'read', path: '/rewritten' } as never
    }))
    const { ctx, events } = makeCtx(transform)

    await forwardHarnessEvent(
      ctx,
      toolEnd([{ type: 'text', text: 'boom' }], {}) as AgentHarnessEvent
    )
    expect(events[0]).toMatchObject({ details: { path: '/rewritten' }, isError: false })

    events.length = 0
    const errEvent = {
      type: 'tool_execution_end',
      toolCallId: 'call-2',
      toolName: 'read',
      isError: true,
      result: { content: [{ type: 'text', text: 'ENOENT' }] }
    } as unknown as AgentHarnessEvent
    await forwardHarnessEvent(ctx, errEvent)
    expect(events[0]).toMatchObject({ toolCallId: 'call-2', isError: true })
    expect(transform.mock.calls.at(-1)?.[0].isError).toBe(true)
  })

  it('结果为空时不炸，广播空串', async () => {
    const { ctx, events } = makeCtx(defaultToolResultTransform)
    const bare = {
      type: 'tool_execution_end',
      toolCallId: 'call-3',
      toolName: 'read',
      isError: false
    } as unknown as AgentHarnessEvent
    await forwardHarnessEvent(ctx, bare)
    expect(events[0]).toMatchObject({ type: 'tool_end', result: '' })
  })
})

/**
 * `agent_end.reason` —— 事件流原本只说「结束了」：出错另发一条 error，用户中止连事件
 * 都没有，消费方只能去 usage.details 里翻最后一个 stopReason 反推。通知层要按结局分
 * 文案，判定就收在了产事件的地方；这里钉住那张归一表。
 */
function agentEnd(stopReasons: string[]): AgentHarnessEvent {
  return {
    type: 'agent_end',
    messages: stopReasons.map((stopReason) => ({
      role: 'assistant',
      content: [],
      stopReason,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
    }))
  } as unknown as AgentHarnessEvent
}

/** agent_end 会去读会话树取终答；这条路径与 reason 无关，给个空树即可 */
function makeEndCtx(): { ctx: HarnessEventContext; events: ChatEvent[] } {
  const { ctx, events } = makeCtx(defaultToolResultTransform)
  ctx.session = { getLeafId: async () => undefined } as unknown as Session
  return { ctx, events }
}

describe('agent_end 的结局归一', () => {
  it.each([
    [['stop'], 'ok'],
    [['toolUse', 'stop'], 'ok'],
    [['length'], 'ok'],
    [['stop', 'aborted'], 'aborted'],
    [['toolUse', 'error'], 'error']
  ])('%j → %s', async (stopReasons, expected) => {
    const { ctx, events } = makeEndCtx()
    await forwardHarnessEvent(ctx, agentEnd(stopReasons as string[]))
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: expected })
  })

  it('一条 assistant 消息都没有时按正常结束处理', async () => {
    const { ctx, events } = makeEndCtx()
    await forwardHarnessEvent(ctx, agentEnd([]))
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'ok' })
  })
})

/**
 * `user_message` 广播的侧车配对 —— 实时与重开必须画成同一样。
 *
 * message_end 时 harness 已把 user entry 落盘；广播走的是**切片投影**（只投刚 append 的
 * 那一两条 entry），而侧车（内联 Token / 系统通知）是 user entry 的**父节点**，切片若只带
 * entry 自身，投影就看不见侧车：实时画成用户气泡，重开画成通知行。这里用真实的
 * JsonlSessionStorage + Session 走完整 append → getLeafId → getEntry 链路，不 mock 会话树。
 */
describe('user_message 广播的侧车配对', () => {
  let dir: string
  let session: Session

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'shuvix-eventhandler-'))
    const env = new NodeExecutionEnv({ cwd: dir })
    const storage = await JsonlSessionStorage.create(env, join(dir, `${SESSION_ID}.jsonl`), {
      cwd: dir,
      sessionId: SESSION_ID
    })
    session = new Session(storage)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const userMsg = (text: string): AgentMessage =>
    ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }) as AgentMessage

  /** 落盘一条 user 消息并把它的 message_end 喂给转换器，回广播出的那条 user_message */
  async function broadcastUser(msg: AgentMessage): Promise<UserTextMessage> {
    await session.appendMessage(msg)
    const { ctx, events } = makeCtx(defaultToolResultTransform)
    ctx.session = session
    await forwardHarnessEvent(ctx, { type: 'message_end', message: msg } as AgentHarnessEvent)
    const ev = events.find((e) => e.type === 'user_message')
    expect(ev).toBeDefined()
    return JSON.parse(
      (ev as Extract<ChatEvent, { type: 'user_message' }>).message
    ) as UserTextMessage
  }

  it('系统通知侧车之后的 user 消息：广播出的消息带 isSystemNotice，id 就是 entry id', async () => {
    // 回归（今日修复）：切片只认内联 Token 侧车，自动续跑那一轮的通知实时画成了用户气泡
    await session.appendCustomEntry(SYSTEM_NOTICE_CUSTOM_TYPE, { kind: 'background' })
    const notice =
      '<background-task pid="1" status="exited with code 0" duration="3s">\nsleep 3\n</background-task>'

    const projected = await broadcastUser(userMsg(notice))

    expect(projected).toMatchObject({ role: 'user', type: 'text', content: notice })
    expect(projected.metadata?.isSystemNotice).toBe(true)
    // 实时与重开同一个 id：广播的 id 就是刚落盘的 leaf entry
    expect(projected.id).toBe(await session.getLeafId())
  })

  it('没有侧车的 user 消息：广播出的消息不带 isSystemNotice（侧车不凭空出现）', async () => {
    const projected = await broadcastUser(userMsg('用户真正说的话'))
    expect(projected).toMatchObject({ role: 'user', content: '用户真正说的话' })
    expect(projected.metadata?.isSystemNotice).toBeUndefined()
  })

  it('内联 Token 侧车仍照旧配对：内容还原成标记态原文，tokens 进 metadata', async () => {
    // 加认系统通知侧车不能挤掉原有的那一种
    const tokens = { t0: { type: 'cmd', id: 'review', displayText: '/review', payload: 'REVIEW' } }
    await session.appendCustomEntry(INLINE_TOKENS_CUSTOM_TYPE, {
      content: '{{shuvixInlineToken:t0}} 参数',
      tokens
    })

    const projected = await broadcastUser(userMsg('REVIEW 参数'))

    expect(projected.content).toBe('{{shuvixInlineToken:t0}} 参数')
    expect(projected.metadata?.inlineTokens).toEqual(tokens)
    expect(projected.metadata?.isSystemNotice).toBeUndefined()
  })
})

describe('toolcall_generating 的 toolCallId', () => {
  /** 一条正在生成的助手消息：content 里依次是这些工具调用块 */
  const partialWith = (blocks: Array<{ name: string; id?: string }>): unknown => ({
    role: 'assistant',
    content: blocks.map((b) => ({
      type: 'toolCall',
      name: b.name,
      ...(b.id !== undefined ? { id: b.id } : {}),
      arguments: {}
    }))
  })

  const start = (blocks: Array<{ name: string; id?: string }>, index: number): AgentHarnessEvent =>
    ({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: index,
        partial: partialWith(blocks)
      }
    }) as unknown as AgentHarnessEvent

  const delta = (text: string, index = 0): AgentHarnessEvent =>
    ({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: index, delta: text }
    }) as unknown as AgentHarnessEvent

  const generating = (events: ChatEvent[]): Array<Record<string, unknown>> =>
    events
      .filter((e) => e.type === 'toolcall_generating')
      .map((e) => ({ ...(e as unknown as Record<string, unknown>) }))

  it('E1 开始与之后每一片增量都带块的 id', async () => {
    const { ctx, events } = makeCtx(defaultToolResultTransform)
    const blocks = [{ name: 'doc_edit', id: 'call_A' }]
    await forwardHarnessEvent(ctx, start(blocks, 0))
    await forwardHarnessEvent(ctx, delta('{"find": "a'))
    await forwardHarnessEvent(ctx, delta('bc", "replace": "x"}'))

    expect(generating(events)).toEqual([
      {
        type: 'toolcall_generating',
        sessionId: SESSION_ID,
        toolName: 'doc_edit',
        toolCallId: 'call_A'
      },
      {
        type: 'toolcall_generating',
        sessionId: SESSION_ID,
        toolName: 'doc_edit',
        toolCallId: 'call_A',
        argsDelta: '{"find": "a'
      },
      {
        type: 'toolcall_generating',
        sessionId: SESSION_ID,
        toolName: 'doc_edit',
        toolCallId: 'call_A',
        argsDelta: 'bc", "replace": "x"}'
      }
    ])
  })

  it('E2 块没有 id（或是空串）→ 事件里没有 toolCallId 这个键', async () => {
    for (const id of [undefined, '']) {
      const { ctx, events } = makeCtx(defaultToolResultTransform)
      await forwardHarnessEvent(ctx, start([{ name: 'doc_insert', id }], 0))
      await forwardHarnessEvent(ctx, delta('{"text": "hi"}'))
      const evs = generating(events)
      expect(evs).toHaveLength(2)
      for (const e of evs) {
        expect(e.toolName).toBe('doc_insert')
        expect('toolCallId' in e).toBe(false)
      }
    }
  })

  it('E3 同一条消息里的第二次调用 → 之后的增量换成第二个 id', async () => {
    const { ctx, events } = makeCtx(defaultToolResultTransform)
    const first = [{ name: 'doc_edit', id: 'call_1' }]
    const both = [...first, { name: 'doc_insert', id: 'call_2' }]
    await forwardHarnessEvent(ctx, start(first, 0))
    await forwardHarnessEvent(ctx, delta('{"find": "A", "replace": "B"}'))
    await forwardHarnessEvent(ctx, start(both, 1))
    await forwardHarnessEvent(ctx, delta('{"after": "B"', 1))
    await forwardHarnessEvent(ctx, delta(', "text": "C"}', 1))

    const evs = generating(events)
    expect(evs.map((e) => [e.toolName, e.toolCallId, e.argsDelta ?? null])).toEqual([
      ['doc_edit', 'call_1', null],
      ['doc_edit', 'call_1', '{"find": "A", "replace": "B"}'],
      ['doc_insert', 'call_2', null],
      ['doc_insert', 'call_2', '{"after": "B"'],
      ['doc_insert', 'call_2', ', "text": "C"}']
    ])
  })
})
