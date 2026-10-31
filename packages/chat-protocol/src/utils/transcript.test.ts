import { describe, it, expect } from 'vitest'
import type { AssistantBlock, ChatMessage } from '../types/chatMessage'
import { transcribeConversation } from './transcript'
import { MID_RUN_NOTE_TEXT, midRunNoteDisplay } from '../midRunNote'
import { makeTokenMarker } from './inlineTokens'

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

  it('系统写的 user 消息（isSystemNotice：后台完成 / 日期 / 空回复追问）从不记在 User 下：缺省丢掉，includeSystemNotices 时以系统通知导出', () => {
    const notice = '<empty-reply>\nYour previous reply had no visible text.\n</empty-reply>'
    const msgs: ChatMessage[] = [
      userText('go'),
      assistantCard([{ type: 'thinking', text: 'I will read it' }]),
      userText(notice, { metadata: { isSystemNotice: true, noticeKind: 'empty-reply' } }),
      userText('<background-task pid="1" status="done">ok</background-task>', {
        metadata: { isSystemNotice: true }
      }),
      assistantText('done')
    ]
    const plain = transcribeConversation(msgs)
    expect(plain).not.toContain('empty-reply')
    expect(plain).not.toContain('background-task')
    expect(plain.match(/### User/g)).toHaveLength(1)
    expect(plain).toContain('go')
    expect(plain).toContain('done')

    const withNotices = transcribeConversation(msgs, { includeSystemNotices: true })
    expect(withNotices.match(/### User/g)).toHaveLength(1)
    expect(withNotices.match(/### System/g)).toHaveLength(2)
    const sections = withNotices.split(/\n(?=### )/)
    const noticeSection = sections.find((section) => section.includes('<empty-reply>'))!
    expect(noticeSection.startsWith('### System')).toBe(true)
    expect(sections.find((section) => section.includes('background-task'))!).toMatch(/^### System/)
    expect(sections.filter((section) => section.startsWith('### User'))).toEqual([
      expect.stringContaining('go')
    ])
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

  it('EX-01 会话导出不带输入的来源（metadata.origin）：各种来源、全开 / 缺省选项，输出与去掉来源的同一串逐字节相同', () => {
    const origins = [
      { kind: 'local' },
      { kind: 'remote', clientId: 'ws:4', address: '192.168.1.20', userAgent: 'SECRET-UA' },
      { kind: 'chrome', installId: 'inst-chrome-9' },
      { kind: 'telegram', botId: 'bot-5', userId: 'tg-777', chatId: 'chat-31' },
      { kind: 'parent-session', sessionId: 'P-parent-1', title: 'Driver-Title' },
      { kind: 'session', sessionId: 'S-other-2', title: 'Driver-Title' }
    ]
    const msgs: ChatMessage[] = [
      ...origins.map((origin, index) =>
        userText(`message ${index} {{shuvixInlineToken:t0}}`, {
          metadata: {
            origin,
            images: [{ mimeType: 'image/png' }],
            inlineTokens: {
              t0: { type: 'at', id: 'f', displayText: '@notes.md', payload: '/tmp/notes.md' }
            }
          }
        })
      ),
      userText('<background-task id="t">done</background-task>', {
        metadata: { isSystemNotice: true, origin: origins[1] }
      }),
      assistantText('reply')
    ]
    const stripped = msgs.map((msg) => {
      const copy = structuredClone(msg) as ChatMessage & {
        metadata: Record<string, unknown> | null
      }
      if (copy.metadata !== null) delete copy.metadata.origin
      return copy as ChatMessage
    })
    expect(stripped.some((msg) => JSON.stringify(msg).includes('origin'))).toBe(false)
    const everything = {
      includeThinking: true,
      includeToolCalls: true,
      includeToolResults: true,
      includeStepText: true,
      includeSystemNotices: true,
      includeImages: true,
      includeTimestamps: true,
      includeUsage: true,
      expandInlineTokens: true,
      title: 'Export'
    }
    const secrets = [
      '192.168.1.20',
      'ws:4',
      'SECRET-UA',
      'inst-chrome-9',
      'bot-5',
      'tg-777',
      'chat-31',
      'P-parent-1',
      'S-other-2',
      'Driver-Title'
    ]
    for (const options of [everything, {}]) {
      const md = transcribeConversation(msgs, options)
      expect(md).toBe(transcribeConversation(stripped, options))
      expect(md).toContain('message 5')
      for (const secret of secrets) expect(md).not.toContain(secret)
    }
  })
})

describe('transcribeConversation — 插话说明不记在 User 名下', () => {
  /** 一条带插话说明的用户消息（投影里的样子） */
  function steered(text: string, extra: Record<string, unknown> = {}): ChatMessage {
    const display = midRunNoteDisplay(text)
    return userText(display.content, {
      metadata: { inlineTokens: { ...display.tokens, ...extra } }
    })
  }

  /** 各个 `### User` 分节的正文（去掉标题行与空行） */
  function userBodies(md: string): string[] {
    return md
      .split(/\n(?=### )/)
      .filter((section) => section.startsWith('### User'))
      .map((section) => section.slice(section.indexOf('\n\n') + 2).trim())
  }

  it('PT-4 普通导出：User 正文恰是原文，没有说明；includeSystemNotices 也一样', () => {
    const msgs = [steered('S'), assistantText('final answer')]
    for (const options of [{}, { includeSystemNotices: true }]) {
      const md = transcribeConversation(msgs, options)
      expect(userBodies(md), JSON.stringify(options)).toEqual(['S'])
      expect(md).not.toContain(MID_RUN_NOTE_TEXT)
      expect(md).not.toContain('shuvixInlineToken')
      expect(md).toContain('final answer')
    }
  })

  it('PT-5 expandInlineTokens：说明同样不出现（S6）；同一条里的别的 Token 照常展开', () => {
    const plain = transcribeConversation([steered('S'), assistantText('final answer')], {
      expandInlineTokens: true
    })
    expect(userBodies(plain)).toEqual(['S'])
    expect(plain).not.toContain(MID_RUN_NOTE_TEXT)

    const paste = {
      type: 'paste',
      id: 'paste-1',
      displayText: '[pasted #1]',
      payload: 'PASTED BODY'
    }
    const display = midRunNoteDisplay(`see ${makeTokenMarker('p1')}`)
    const withPaste = userText(display.content, {
      metadata: { inlineTokens: { ...display.tokens, p1: paste } }
    })
    const expanded = transcribeConversation([withPaste, assistantText('ok')], {
      expandInlineTokens: true
    })
    expect(userBodies(expanded)).toEqual(['see PASTED BODY'])
    expect(expanded).not.toContain(MID_RUN_NOTE_TEXT)
  })
})
