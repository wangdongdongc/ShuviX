/**
 * entry 树 → ChatMessage 投影的端到端验证。
 *
 * 不 mock：真的用 pi 的 `JsonlSessionStorage` 在临时目录里建一个会话文件，
 * 走完整的 append → buildContextEntries → 投影链路。这样同时覆盖了
 * 「JSONL 落盘/回读的保真度」和「投影规则是否符合 chat-ui 的期待」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlSessionStorage, Session } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantTextMessage } from '@shuvix/chat-protocol/types/chatMessage'
import {
  AUTO_COMPACT_CUSTOM_TYPE,
  entriesToChatMessages,
  INSTRUCTION_CUSTOM_TYPE
} from '../projection'

const SESSION_ID = 'sess-1'

let dir: string
let session: Session

/** 造一条 assistant 消息（usage/api 等字段填成最小可用值） */
function assistant(
  content: unknown[],
  stopReason = 'stop',
  usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }
): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason,
    timestamp: Date.now()
  } as unknown as AgentMessage
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-projection-'))
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

async function project(): Promise<ReturnType<typeof entriesToChatMessages>> {
  return entriesToChatMessages(await session.buildContextEntries(), SESSION_ID, 'test-model')
}

describe('entriesToChatMessages', () => {
  it('用户消息投影为 user/text', async () => {
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '你好' }],
      timestamp: Date.now()
    } as AgentMessage)

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'user', type: 'text', content: '你好' })
  })

  it('无 toolCall 的 assistant 消息 = 终答，thinking/usage 收进 metadata', async () => {
    await session.appendMessage(
      assistant([
        { type: 'thinking', thinking: '想一下' },
        { type: 'text', text: '答案是 42' }
      ])
    )

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'assistant', type: 'text', content: '答案是 42' })
    expect(msgs[0].metadata).toMatchObject({
      thinking: '想一下',
      usage: expect.objectContaining({ total: 15 })
    })
  })

  it('终答的 usage 聚合整轮所有 LLM 调用（中间工具轮不丢），跨轮重置', async () => {
    // 第一轮：工具轮(20/10/30，缓存读 100) + 终答(10/5/15)
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '查一下' }],
      timestamp: Date.now()
    } as AgentMessage)
    await session.appendMessage(
      assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 'toolUse', {
        input: 20,
        output: 10,
        cacheRead: 100,
        cacheWrite: 0,
        totalTokens: 30
      })
    )
    await session.appendMessage({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: Date.now()
    } as AgentMessage)
    await session.appendMessage(assistant([{ type: 'text', text: '查到了' }]))

    // 第二轮：单次调用的终答
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '继续' }],
      timestamp: Date.now()
    } as AgentMessage)
    await session.appendMessage(assistant([{ type: 'text', text: '好' }]))

    const msgs = await project()
    const finals = msgs.filter(
      (m): m is AssistantTextMessage => m.role === 'assistant' && m.type === 'text'
    )
    expect(finals).toHaveLength(2)
    // 第一轮终答 = 两次调用之和，details 保留逐次明细
    expect(finals[0].metadata?.usage).toMatchObject({
      input: 30,
      output: 15,
      cacheRead: 100,
      total: 45
    })
    expect(finals[0].metadata?.usage?.details).toHaveLength(2)
    // 第二轮不受第一轮影响
    expect(finals[1].metadata?.usage).toMatchObject({ input: 10, output: 5, total: 15 })
    expect(finals[1].metadata?.usage?.details).toHaveLength(1)
  })

  it('steer 插入的 user 消息不重置本轮 usage 累计', async () => {
    await session.appendMessage(
      assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 'toolUse')
    )
    // steer：轮中插入的用户消息
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '换个方向' }],
      timestamp: Date.now()
    } as AgentMessage)
    await session.appendMessage(assistant([{ type: 'text', text: '收到' }]))

    const msgs = await project()
    const final = msgs.find(
      (m): m is AssistantTextMessage => m.role === 'assistant' && m.type === 'text'
    )
    expect(final?.metadata?.usage).toMatchObject({ input: 20, output: 10, total: 30 })
    expect(final?.metadata?.usage?.details).toHaveLength(2)
  })

  it('带 toolCall 的中间轮拆成 step_thinking / step_text / tool_use', async () => {
    await session.appendMessage(
      assistant(
        [
          { type: 'thinking', thinking: '先查文件' },
          { type: 'text', text: '我来看看' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }
        ],
        'toolUse'
      )
    )

    const msgs = await project()
    expect(msgs.map((m) => m.type)).toEqual(['step_thinking', 'step_text', 'tool_use'])
    // tool_use 的 id 必须是 toolCallId —— 工具事件靠它做 messageId
    expect(msgs[2].id).toBe('call-1')
    expect(msgs[2].metadata).toMatchObject({ toolName: 'read', args: { path: 'a.ts' } })
    // 结果未回填时 content 为空（UI 据此显示「执行中」）
    expect(msgs[2].content).toBe('')
  })

  it('toolResult 回填到同 toolCallId 的 tool_use 上，不产生独立气泡', async () => {
    await session.appendMessage(
      assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 'toolUse')
    )
    await session.appendMessage({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: '文件内容' }],
      isError: false,
      timestamp: Date.now()
    } as AgentMessage)

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ type: 'tool_use', content: '文件内容' })
  })

  it('stopReason=error 塌成 error_event', async () => {
    const msg = assistant([], 'error') as unknown as Record<string, unknown>
    msg.errorMessage = 'prompt is too long'
    await session.appendMessage(msg as unknown as AgentMessage)

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      role: 'system_notify',
      type: 'error_event',
      content: 'prompt is too long'
    })
  })

  it('指令注入的 custom_message 投影为带标记的 user 消息', async () => {
    await session.appendCustomMessageEntry(
      INSTRUCTION_CUSTOM_TYPE,
      'Project instruction file (AGENTS.md):\n\nrules',
      true,
      { filename: 'AGENTS.md' }
    )

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].metadata).toMatchObject({
      isInstructionInjection: true,
      instructionFilename: 'AGENTS.md'
    })
  })

  it('display=false 的 custom_message（hook 上下文）不进 UI', async () => {
    await session.appendCustomMessageEntry('hook', '<system-reminder>x</system-reminder>', false)
    expect(await project()).toHaveLength(0)
  })

  it('id 在重新打开会话后保持稳定', async () => {
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      timestamp: Date.now()
    } as AgentMessage)
    const before = (await project()).map((m) => m.id)

    // 重新从磁盘打开同一个会话文件
    const env = new NodeExecutionEnv({ cwd: dir })
    const reopened = new Session(
      await JsonlSessionStorage.open(env, join(dir, `${SESSION_ID}.jsonl`))
    )
    const after = entriesToChatMessages(
      await reopened.buildContextEntries(),
      SESSION_ID,
      'test-model'
    ).map((m) => m.id)

    expect(after).toEqual(before)
  })

  it('压缩后：摘要进上下文，被压缩的历史从投影中消失', async () => {
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '第一轮' }],
      timestamp: Date.now()
    } as AgentMessage)
    await session.appendMessage(assistant([{ type: 'text', text: '回复一' }]))
    const keepFrom = (await session.getLeafId()) as string
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '第二轮' }],
      timestamp: Date.now()
    } as AgentMessage)

    await session.appendCompaction('这是摘要', keepFrom, 1234)

    const msgs = await project()
    // 摘要 + 保留段（回复一、第二轮）；「第一轮」已被压缩掉
    expect(msgs.map((m) => m.content)).toEqual(['这是摘要', '回复一', '第二轮'])
    expect(msgs[0].metadata).toMatchObject({ isCompactionSummary: true })
    // 手动压缩：无 auto_compact 标记 → 不带 autoCompacted
    expect(msgs[0].metadata).not.toHaveProperty('autoCompacted')
  })

  it('auto_compact 标记 entry 装饰紧邻的压缩摘要卡片（自身不产生消息）', async () => {
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '第一轮' }],
      timestamp: Date.now()
    } as AgentMessage)
    const keepFrom = (await session.getLeafId()) as string
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '第二轮' }],
      timestamp: Date.now()
    } as AgentMessage)
    await session.appendCompaction('这是摘要', keepFrom, 1234)
    await session.appendCustomEntry(AUTO_COMPACT_CUSTOM_TYPE, { tokensBefore: 1234 })

    const msgs = await project()
    // 标记 entry 不出现在消息列表里，只把摘要卡片标成自动压缩
    expect(msgs.map((m) => m.content)).toEqual(['这是摘要', '第一轮', '第二轮'])
    expect(msgs[0].metadata).toMatchObject({ isCompactionSummary: true, autoCompacted: true })
  })
})
