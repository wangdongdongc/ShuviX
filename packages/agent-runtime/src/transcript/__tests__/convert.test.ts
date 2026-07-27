/**
 * transcript 双向投影单测 —— 存储行 ↔ Agent 上下文的共享桥。
 * 正向：上下文恢复口径（合并连续 tool_use / 中断补错误结果 / 跳过 step 与系统通知）；
 * 反向：toolCall 与 toolResult 按 id 配对回填、thinking 归位 metadata、孤儿结果兜底；
 * 门面：transcribeAgentMessages 直接从 AgentMessage 渲染 Markdown。
 */
import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { chatMessagesToAgentMessages, agentMessagesToChatMessages } from '../convert'
import { transcribeAgentMessages } from '../transcribe'

const row = (m: Record<string, unknown>): ChatMessage =>
  ({ sessionId: 's1', metadata: null, model: '', ...m }) as unknown as ChatMessage

const msg = (m: unknown): AgentMessage => m as AgentMessage

describe('chatMessagesToAgentMessages（上下文恢复）', () => {
  it('文本轮次 + 连续 tool_use 合并 + 中断工具补错误结果；step/系统通知跳过', () => {
    const rows: ChatMessage[] = [
      row({ id: 'm1', role: 'user', type: 'text', content: 'hi', createdAt: 1 }),
      row({ id: 'm2', role: 'system_notify', type: 'error_event', content: 'boom', createdAt: 2 }),
      row({ id: 'm3', role: 'assistant', type: 'step_text', content: '中间步骤', createdAt: 3 }),
      row({
        id: 'm4',
        role: 'assistant',
        type: 'tool_use',
        content: 'result-A',
        metadata: { toolCallId: 'tA', toolName: 'read', args: { path: 'a.ts' } },
        createdAt: 4
      }),
      row({
        id: 'm5',
        role: 'assistant',
        type: 'tool_use',
        content: '',
        metadata: { toolCallId: 'tB', toolName: 'bash', args: { command: 'ls' } },
        createdAt: 5
      }),
      row({
        id: 'm6',
        role: 'assistant',
        type: 'text',
        content: 'done',
        metadata: { thinking: '想一想' },
        createdAt: 6
      })
    ]
    const out = chatMessagesToAgentMessages(rows)
    // user + (toolCall assistant + 2 toolResult) + assistant text = 5
    expect(out).toHaveLength(5)
    expect(out[0].role).toBe('user')
    const toolMsg = out[1] as { role: string; content: Array<{ type: string; name?: string }> }
    expect(toolMsg.role).toBe('assistant')
    expect(toolMsg.content.map((c) => c.name)).toEqual(['read', 'bash'])
    const resA = out[2] as { role: string; isError: boolean; content: Array<{ text: string }> }
    expect(resA.role).toBe('toolResult')
    expect(resA.content[0].text).toBe('result-A')
    expect(resA.isError).toBe(false)
    // 中断未完成 → 错误结果占位
    const resB = out[3] as { isError: boolean; content: Array<{ text: string }> }
    expect(resB.isError).toBe(true)
    expect(resB.content[0].text).toMatch(/interrupted/)
    const finalText = out[4] as { content: Array<{ type: string; thinking?: string }> }
    expect(finalText.content.some((c) => c.type === 'thinking' && c.thinking === '想一想')).toBe(
      true
    )
  })
})

describe('agentMessagesToChatMessages（反向投影）', () => {
  it('toolCall 与 toolResult 按 id 配对回填；thinking 归位 metadata；图片占位', () => {
    const messages: AgentMessage[] = [
      msg({
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', data: 'AAA', mimeType: 'image/png' }
        ],
        timestamp: 1
      }),
      msg({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内心' },
          { type: 'text', text: '我读一下' },
          { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }
        ],
        timestamp: 2
      }),
      msg({
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file body' }],
        isError: false,
        timestamp: 3
      }),
      // 孤儿结果（无对应 toolCall）→ 兜底独立行
      msg({
        role: 'toolResult',
        toolCallId: 't9',
        toolName: 'bash',
        content: [{ type: 'text', text: 'orphan out' }],
        isError: true,
        timestamp: 4
      })
    ]
    const rows = agentMessagesToChatMessages(messages) as unknown as Array<{
      role: string
      type: string
      content: string
      metadata: Record<string, unknown> | null
    }>
    expect(rows).toHaveLength(4)
    expect(rows[0].role).toBe('user')
    expect(rows[0].metadata?.images).toBeTruthy()
    expect(rows[1].type).toBe('text')
    expect(rows[1].content).toBe('我读一下')
    expect(rows[1].metadata?.thinking).toBe('内心')
    expect(rows[2].type).toBe('tool_use')
    expect(rows[2].content).toBe('file body')
    expect((rows[2].metadata as { toolName?: string }).toolName).toBe('read')
    expect(rows[3].type).toBe('tool_use')
    expect(rows[3].content).toBe('orphan out')
    expect((rows[3].metadata as { isError?: boolean }).isError).toBe(true)
  })

  it('存储行 → 上下文 → 存储行 往返后工具轨迹保持配对', () => {
    const rows: ChatMessage[] = [
      row({ id: 'm1', role: 'user', type: 'text', content: 'q', createdAt: 1 }),
      row({
        id: 'm2',
        role: 'assistant',
        type: 'tool_use',
        content: 'grep out',
        metadata: { toolCallId: 't1', toolName: 'grep', args: { pattern: 'x' } },
        createdAt: 2
      }),
      row({ id: 'm3', role: 'assistant', type: 'text', content: 'a', createdAt: 3 })
    ]
    const back = agentMessagesToChatMessages(
      chatMessagesToAgentMessages(rows)
    ) as unknown as Array<{
      type: string
      content: string
      metadata: Record<string, unknown> | null
    }>
    const tool = back.find((r) => r.type === 'tool_use')
    expect(tool?.content).toBe('grep out')
    expect((tool?.metadata as { toolName?: string })?.toolName).toBe('grep')
  })
})

describe('transcribeAgentMessages（门面）', () => {
  it('从 AgentMessage 直接渲染 Markdown 转写（工具轨迹按选项纳入）', () => {
    const messages: AgentMessage[] = [
      msg({ role: 'user', content: '帮我查', timestamp: 1 }),
      msg({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }],
        timestamp: 2
      }),
      msg({
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'read',
        content: [{ type: 'text', text: 'body' }],
        isError: false,
        timestamp: 3
      })
    ]
    const text = transcribeAgentMessages(messages, {
      includeToolCalls: true,
      includeToolResults: true
    })
    expect(text).toContain('### User')
    expect(text).toContain('帮我查')
    expect(text).toContain('Tool call: read')
    expect(text).toContain('body')
  })
})
