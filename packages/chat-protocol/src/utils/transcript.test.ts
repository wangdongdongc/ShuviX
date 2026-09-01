import { describe, it, expect } from 'vitest'
import type { AssistantBlock, ChatMessage } from '../types/chatMessage'
import { transcribeConversation } from './transcript'

let seq = 0
function base(over: Record<string, unknown>): ChatMessage {
  seq += 1
  return {
    id: `m${seq}`,
    sessionId: 's1',
    content: '',
    model: 'test',
    createdAt: 1_700_000_000_000 + seq * 1000,
    ...over
  } as unknown as ChatMessage
}

function userText(content: string, over: Record<string, unknown> = {}): ChatMessage {
  return base({ role: 'user', type: 'text', content, metadata: null, ...over })
}
/** 一条 assistant 卡：blocks 原序，content = 各 text 块拼接（与投影层一致） */
function assistantCard(blocks: AssistantBlock[], over: Record<string, unknown> = {}): ChatMessage {
  const content = blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return base({ role: 'assistant', type: 'message', blocks, content, metadata: null, ...over })
}
function assistantText(content: string, over: Record<string, unknown> = {}): ChatMessage {
  return assistantCard([{ type: 'text', text: content }], over)
}
function toolUse(toolName: string, result: string, args?: Record<string, unknown>): ChatMessage {
  return assistantCard([{ type: 'tool', toolCallId: 'c1', toolName, args, result }])
}

describe('transcribeConversation', () => {
  it('精简默认：只含 user + assistant final，忽略工具/思考/step', () => {
    const msgs: ChatMessage[] = [
      userText('Hello there'),
      // 过程卡：思考 + 边做边说的正文 + 工具调用同处一条消息
      assistantCard([
        { type: 'thinking', text: 'let me think hard about this' },
        { type: 'text', text: 'intermediate note' },
        {
          type: 'tool',
          toolCallId: 'c1',
          toolName: 'bash',
          args: { command: 'ls' },
          result: 'command output here'
        }
      ]),
      assistantCard([
        { type: 'thinking', text: 'secret reasoning' },
        { type: 'text', text: 'The final answer is 42' }
      ])
    ]
    const md = transcribeConversation(msgs)
    expect(md).toContain('Hello there')
    expect(md).toContain('The final answer is 42')
    expect(md).not.toContain('command output')
    expect(md).not.toContain('secret reasoning')
    expect(md).not.toContain('intermediate note')
    expect(md).not.toContain('let me think hard')
    // 角色标题存在
    expect(md).toContain('### User')
    expect(md).toContain('### Assistant')
  })

  it('includeToolCalls / includeToolResults 生效', () => {
    const msgs = [userText('run it'), toolUse('bash', 'exit 0\ndone', { command: 'make' })]
    const calls = transcribeConversation(msgs, { includeToolCalls: true })
    expect(calls).toContain('Tool call: bash')
    expect(calls).toContain('"command"')
    expect(calls).not.toContain('done')

    const results = transcribeConversation(msgs, { includeToolResults: true })
    expect(results).toContain('Tool result')
    expect(results).toContain('done')
  })

  it('includeThinking 纳入各条消息的 thinking 块', () => {
    const msgs: ChatMessage[] = [
      userText('q'),
      assistantCard([
        { type: 'thinking', text: 'mid thought' },
        { type: 'tool', toolCallId: 'c1', toolName: 'bash', result: 'x' }
      ]),
      assistantCard([
        { type: 'thinking', text: 'final thought' },
        { type: 'text', text: 'answer' }
      ])
    ]
    const md = transcribeConversation(msgs, { includeThinking: true })
    expect(md).toContain('mid thought')
    expect(md).toContain('final thought')
    expect(md).toContain('> ')
  })

  it('inline token：默认人读 displayText，expand 时展开 payload', () => {
    const msg = userText('{{shuvixInlineToken:t0}}', {
      metadata: {
        inlineTokens: {
          t0: {
            type: 'cmd',
            id: 'review',
            displayText: '/review',
            payload: 'Please review the current diff thoroughly.'
          }
        }
      }
    })
    const plain = transcribeConversation([msg])
    expect(plain).toContain('/review')
    expect(plain).not.toContain('review the current diff')

    const expanded = transcribeConversation([msg], { expandInlineTokens: true })
    expect(expanded).toContain('review the current diff')
  })

  it('includeImages 输出占位符，默认省略', () => {
    const msg = userText('look', {
      metadata: { images: [{ mimeType: 'image/png' }, { mimeType: 'image/png' }] }
    })
    expect(transcribeConversation([msg])).not.toContain('[image]')
    expect(transcribeConversation([msg], { includeImages: true })).toContain('[image]')
  })

  it('includeSystemNotices 控制 error_event 与指令注入', () => {
    const msgs: ChatMessage[] = [
      base({ role: 'system_notify', type: 'error_event', content: 'boom', metadata: null }),
      userText('injected instructions', {
        metadata: { isInstructionInjection: true, instructionFilename: 'CLAUDE.md' }
      })
    ]
    expect(transcribeConversation(msgs)).toBe('')
    const withNotices = transcribeConversation(msgs, { includeSystemNotices: true })
    expect(withNotices).toContain('boom')
    expect(withNotices).toContain('injected instructions')
  })

  it('title / headingLevel / timestamps / labels', () => {
    const msgs = [userText('hi'), assistantText('yo')]
    const md = transcribeConversation(msgs, {
      title: 'Session Export',
      headingLevel: 1,
      includeTimestamps: true,
      labels: { user: '用户', assistant: '助手' }
    })
    expect(md).toContain('# Session Export')
    expect(md).toContain('## 用户')
    expect(md).toContain('## 助手')
    expect(md).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('工具结果超长时中间截断', () => {
    const msgs = [toolUse('read', 'a'.repeat(5000))]
    const md = transcribeConversation(msgs, {
      includeToolResults: true,
      maxToolResultChars: 200
    })
    expect(md).toContain('truncated')
    expect(md.length).toBeLessThan(1000)
  })

  it('空对话返回空 markdown', () => {
    expect(transcribeConversation([])).toBe('')
  })
})

/**
 * bot 署名标签（metadata.sender）—— 聊天会话里 bot 说的 assistant 消息，转写标题用
 * 侧车里的 displayName 而不是 labels.assistant：发言人名是数据标注，不走 labels 表也不本地化。
 *
 * 用例清单（先由契约枚举，TB-4 为读实现后的白盒补充）：
 *  - TB-1 bot 署名 → 标题用 displayName 原样（自定义 labels.assistant 对该条无效；文件名 name 不上屏）
 *  - TB-2 无署名 → labels.assistant 照旧（回归）
 *  - TB-3 混排：两个不同 bot + 一条无署名 → 三个互异标题按消息顺序出现
 *  - TB-4（白盒）sender.kind 非 'bot'（未来扩展）→ 回落 labels.assistant
 */
describe('transcribeConversation — bot 署名标签', () => {
  const bot = (name: string, displayName: string): Record<string, unknown> => ({
    metadata: { sender: { kind: 'bot', name, displayName } }
  })

  it('TB-1 bot 署名 → 标题用 displayName 原样，无视自定义 labels.assistant', () => {
    const msgs = [assistantText('结论在此', bot('weaver-bot', '织答'))]
    const md = transcribeConversation(msgs, { labels: { assistant: '助手' } })
    expect(md).toContain('### 织答')
    expect(md).not.toContain('助手')
    // 文件名是稳定标识不是给人读的 —— 上屏的只有当时的显示名
    expect(md).not.toContain('weaver-bot')
  })

  it('TB-2 无署名 → labels.assistant 照旧（回归）', () => {
    const md = transcribeConversation([assistantText('plain answer')])
    expect(md).toContain('### Assistant')
    expect(md).toContain('plain answer')
  })

  it('TB-3 混排：两个不同 bot + 一条无署名 → 三个互异标题按序', () => {
    const msgs = [
      assistantText('甲的结论', bot('bot-a', '甲号机')),
      assistantText('乙的结论', bot('bot-b', '乙号机')),
      assistantText('root answer')
    ]
    const md = transcribeConversation(msgs)
    const at = (h: string): number => {
      const i = md.indexOf(h)
      expect(i, `缺标题 ${h}`).toBeGreaterThanOrEqual(0)
      return i
    }
    expect(at('### 甲号机')).toBeLessThan(at('### 乙号机'))
    expect(at('### 乙号机')).toBeLessThan(at('### Assistant'))
  })

  it("TB-4（白盒）sender.kind 非 'bot'（未来扩展）→ 回落 labels.assistant", () => {
    const msgs = [
      assistantText('spoken', {
        metadata: { sender: { kind: 'user', name: 'x', displayName: '某人' } }
      })
    ]
    const md = transcribeConversation(msgs)
    expect(md).toContain('### Assistant')
    expect(md).not.toContain('某人')
  })
})
