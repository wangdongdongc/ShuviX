/**
 * session 工具共享内核单测 —— 全 stub 依赖（无存储），数据源为 Agent 上下文消息。
 * 验证：压缩转写档位（thinking 剥离 / 工具轨迹纳入 / 图片占位 / 工具结果截断）、
 * 上下文指纹凭据、压缩动作的防护语义（先 transcript 后 compact / 摘要下限 / 并发锁 /
 * 失败不留残留），以及 verifyContextFingerprint 的一致性判定。
 */
import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  createSessionTool,
  buildSummaryContent,
  contextFingerprint,
  verifyContextFingerprint,
  type SessionToolDeps,
  type SessionContextFingerprint
} from '../sessionTool'

const msg = (m: unknown): AgentMessage => m as AgentMessage

const CONVO: AgentMessage[] = [
  msg({ role: 'user', content: '你好，帮我修 bug', timestamp: 1 }),
  msg({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '内心独白很长很长' },
      { type: 'text', text: '好的，我先看看代码。' },
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'src/a.ts' } }
    ],
    timestamp: 2
  }),
  msg({
    role: 'toolResult',
    toolCallId: 't1',
    toolName: 'read',
    content: [{ type: 'text', text: 'x'.repeat(2000) }],
    isError: false,
    timestamp: 3
  }),
  msg({
    role: 'user',
    content: [
      { type: 'text', text: '截图在这' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    ],
    timestamp: 4
  })
]

interface Harness {
  tool: ReturnType<typeof createSessionTool>
  calls: Array<{ summaryContent: string; expectedFingerprint: SessionContextFingerprint }>
}

function makeTool(opts?: {
  messages?: AgentMessage[]
  sessionId?: string
  persist?: SessionToolDeps['persistCompact']
}): Harness {
  const calls: Harness['calls'] = []
  const deps: SessionToolDeps = {
    sessionId: opts?.sessionId ?? `s-${Math.random()}`,
    getAgentMessages: async () => opts?.messages ?? CONVO,
    persistCompact:
      opts?.persist ??
      (async (input) => {
        calls.push(input)
        return { archivedCount: 3 }
      }),
    label: 'Session',
    abortError: 'Aborted'
  }
  return { tool: createSessionTool(deps), calls }
}

const LONG_SUMMARY = 'S'.repeat(300)

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('')
}

describe('SessionTool · transcript（Agent 上下文 → 压缩档位渲染）', () => {
  it('按压缩档位渲染：轮次标题 + 工具轨迹 + 图片占位 + thinking 剥离 + 结果截断', async () => {
    const { tool } = makeTool()
    const text = textOf(await tool.execute('c1', { action: 'transcript' }))
    expect(text).toContain('4 context messages')
    expect(text).toContain('### User')
    expect(text).toContain('你好，帮我修 bug')
    expect(text).toContain('### Assistant')
    expect(text).toContain('好的，我先看看代码。')
    // 工具轨迹纳入（导出精简档位默认不含 —— 这是压缩档位的差异点）
    expect(text).toContain('Tool call: read')
    expect(text).toContain('src/a.ts')
    expect(text).toContain('Tool result')
    // thinking 剥离；图片仅占位；2000 字符结果按 1500 上限中间截断
    expect(text).not.toContain('内心独白')
    expect(text).toContain('[image]')
    expect(text).toContain('[truncated')
    expect(text).not.toContain('x'.repeat(1600))
  })

  it('上下文为空时报错', async () => {
    const { tool } = makeTool({ messages: [] })
    await expect(tool.execute('c1', { action: 'transcript' })).rejects.toThrow(
      /no conversation messages/
    )
  })
})

describe('SessionTool · compact（防护语义）', () => {
  it('未先读 transcript 时 compact 被拒绝', async () => {
    const { tool } = makeTool()
    await expect(tool.execute('c1', { action: 'compact', summary: LONG_SUMMARY })).rejects.toThrow(
      /transcript.*first/i
    )
  })

  it('摘要过短被拒绝', async () => {
    const { tool } = makeTool()
    await tool.execute('c1', { action: 'transcript' })
    await expect(tool.execute('c2', { action: 'compact', summary: 'too short' })).rejects.toThrow(
      /too short/
    )
  })

  it('compact 提交：摘要包上延续框架文案，携带 transcript 时的上下文指纹', async () => {
    const { tool, calls } = makeTool()
    await tool.execute('c1', { action: 'transcript' })
    const r = await tool.execute('c2', { action: 'compact', summary: LONG_SUMMARY })
    expect(calls).toHaveLength(1)
    expect(calls[0].expectedFingerprint).toEqual({ messageCount: 4, lastTimestamp: 4 })
    expect(calls[0].summaryContent).toBe(buildSummaryContent(LONG_SUMMARY))
    expect(calls[0].summaryContent).toContain('continued from a previous conversation')
    expect(textOf(r)).toContain('3 messages archived')
  })

  it('persistCompact 抛错原样透出，且锁释放后可重试', async () => {
    let attempt = 0
    const { tool } = makeTool({
      persist: async () => {
        attempt++
        if (attempt === 1) throw new Error('The conversation changed after the transcript was read')
        return { archivedCount: 5 }
      }
    })
    await tool.execute('c1', { action: 'transcript' })
    await expect(tool.execute('c2', { action: 'compact', summary: LONG_SUMMARY })).rejects.toThrow(
      /conversation changed/
    )
    // 重读转写后重试成功（锁未泄漏）
    await tool.execute('c3', { action: 'transcript' })
    const r = await tool.execute('c4', { action: 'compact', summary: LONG_SUMMARY })
    expect(textOf(r)).toContain('5 messages archived')
  })

  it('同会话并发 compact 被进程内锁拒绝', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { tool } = makeTool({
      persist: async () => {
        await gate
        return { archivedCount: 1 }
      }
    })
    await tool.execute('c1', { action: 'transcript' })
    const first = tool.execute('c2', { action: 'compact', summary: LONG_SUMMARY })
    await expect(tool.execute('c3', { action: 'compact', summary: LONG_SUMMARY })).rejects.toThrow(
      /already in progress/
    )
    release()
    await first
  })
})

describe('verifyContextFingerprint', () => {
  it('一致时静默通过；条数或末条时间戳变化时抛出重读提示', () => {
    const fp = contextFingerprint(CONVO)
    expect(() => verifyContextFingerprint(CONVO, fp)).not.toThrow()
    expect(() => verifyContextFingerprint(CONVO.slice(0, 3), fp)).toThrow(/conversation changed/)
    const grown = [...CONVO, msg({ role: 'user', content: 'more', timestamp: 9 })]
    expect(() => verifyContextFingerprint(grown, fp)).toThrow(/transcript.*again/i)
  })
})
