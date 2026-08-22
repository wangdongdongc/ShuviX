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
 */
import { describe, it, expect, vi } from 'vitest'
import type { AgentHarnessEvent, Session } from '@earendil-works/pi-agent-core'
import { forwardHarnessEvent, createHarnessEventState } from '../eventHandler'
import type { HarnessEventContext } from '../eventHandler'
import { defaultToolResultTransform } from '../../types'
import type { ChatEvent, ToolResultTransform } from '../../types'

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

  it('默认 transform 是 passthrough：文本直取、非文本 JSON 序列化', async () => {
    const { ctx, events } = makeCtx(defaultToolResultTransform)

    await forwardHarnessEvent(ctx, toolEnd([{ type: 'text', text: 'line1' }, IMAGE]))

    // 不注入 transform 的宿主（扩展端）行为与接缝修复前逐字节相同
    expect(events[0]).toMatchObject({
      type: 'tool_end',
      result: `line1\n${JSON.stringify(IMAGE)}`
    })
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
