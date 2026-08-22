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
import type { AssistantMessage, UserTextMeta } from '@shuvix/chat-protocol/types/chatMessage'
import {
  entriesToChatMessages,
  INLINE_TOKENS_CUSTOM_TYPE,
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

  it('assistant 消息投影成一张卡：thinking/text 按原序成为 blocks，usage 记本次调用', async () => {
    await session.appendMessage(
      assistant([
        { type: 'thinking', thinking: '想一下' },
        { type: 'text', text: '答案是 42' }
      ])
    )

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'assistant', type: 'message', content: '答案是 42' })
    expect((msgs[0] as AssistantMessage).blocks).toEqual([
      { type: 'thinking', text: '想一下' },
      { type: 'text', text: '答案是 42' }
    ])
    expect(msgs[0].metadata).toMatchObject({ usage: expect.objectContaining({ total: 15 }) })
  })

  it('用量各归各：每条 assistant 只带自己那次调用的账，不跨消息累加', async () => {
    // 工具轮(20/10/30，缓存读 100) + 终答(10/5/15)
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

    const cards = (await project()).filter(
      (m): m is AssistantMessage => m.role === 'assistant' && m.type === 'message'
    )
    expect(cards).toHaveLength(2)
    expect(cards[0].metadata?.usage).toMatchObject({
      input: 20,
      output: 10,
      cacheRead: 100,
      total: 30
    })
    expect(cards[1].metadata?.usage).toMatchObject({ input: 10, output: 5, total: 15 })
    // 整轮聚合只存在于 agent_end 事件里，不写进消息元数据
    expect(cards[1].metadata?.usage?.details).toBeUndefined()
  })

  it('轮中 steer 就是一条普通 user 消息，前后各是一张独立的卡', async () => {
    await session.appendMessage(
      assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 'toolUse')
    )
    // steer：轮中插入的用户消息（树里与新 prompt 无从区分，UI 也不再区分）
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '换个方向' }],
      timestamp: Date.now()
    } as AgentMessage)
    await session.appendMessage(assistant([{ type: 'text', text: '收到' }]))

    const msgs = await project()
    expect(msgs.map((m) => [m.role, m.type])).toEqual([
      ['assistant', 'message'],
      ['user', 'text'],
      ['assistant', 'message']
    ])
    expect(msgs[1].content).toBe('换个方向')
  })

  it('一条 entry = 一条消息：thinking/text/toolCall 同处一卡，id 就是 entry id', async () => {
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

    const entryId = (await session.getLeafId()) as string
    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe(entryId)
    const card = msgs[0] as AssistantMessage
    expect(card.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool'])
    expect(card.blocks[2]).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'a.ts' }
    })
    // 结果未回填 = 仍在执行（UI 据此显示「执行中」）
    expect((card.blocks[2] as { result?: string }).result).toBeUndefined()
  })

  it('只有空白的 thinking 不产出思考块', async () => {
    // 实测模型会吐出整块只有一个换行的 thinking，渲染出来是一段空的可点区域
    await session.appendMessage(
      assistant([
        { type: 'thinking', thinking: '\n' },
        { type: 'text', text: '答案是 42' }
      ])
    )

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect((msgs[0] as AssistantMessage).blocks.map((b) => b.type)).toEqual(['text'])
  })

  it('空白 thinking 段被剔除，同消息里的有效思考照常保留', async () => {
    await session.appendMessage(
      assistant(
        [
          { type: 'thinking', thinking: '  \n ' },
          { type: 'thinking', thinking: '先查文件' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }
        ],
        'toolUse'
      )
    )

    const card = (await project())[0] as AssistantMessage
    expect(card.blocks.map((b) => b.type)).toEqual(['thinking', 'tool'])
    expect((card.blocks[0] as { text: string }).text).toBe('先查文件')
  })

  it('什么都没产出的 assistant（首 token 前被中止）不留空卡', async () => {
    await session.appendMessage(assistant([], 'aborted'))
    expect(await project()).toHaveLength(0)
  })

  it('toolResult 回填到同 toolCallId 的工具块上，不产生独立消息', async () => {
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
    expect((msgs[0] as AssistantMessage).blocks).toEqual([
      {
        type: 'tool',
        toolCallId: 'call-1',
        toolName: 'read',
        args: {},
        result: '文件内容',
        isError: undefined,
        details: undefined
      }
    ])
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

  it('display=false 的 custom_message（隐藏上下文）不进 UI', async () => {
    await session.appendCustomMessageEntry('context', '<system-reminder>x</system-reminder>', false)
    expect(await project()).toHaveLength(0)
  })

  it('内联 Token 侧车把紧随的 user 消息还原成标记文本 + inlineTokens', async () => {
    const tokens = {
      t0: { type: 'cmd', id: 'review', displayText: '/review', payload: '展开后的完整模板' }
    }
    await session.appendCustomEntry(INLINE_TOKENS_CUSTOM_TYPE, {
      content: '{{shuvixInlineToken:t0}} 参数',
      tokens
    })
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '展开后的完整模板\n\n参数' }],
      timestamp: Date.now()
    } as AgentMessage)

    const msgs = await project()
    // 侧车自身不产出消息；user 气泡显示标记态原文，tokens 进 metadata
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'user', content: '{{shuvixInlineToken:t0}} 参数' })
    expect(msgs[0].metadata).toMatchObject({ inlineTokens: tokens })
  })

  it('无主侧车（prompt 被 deny）不产出消息，也不污染后续 user 消息', async () => {
    await session.appendCustomEntry(INLINE_TOKENS_CUSTOM_TYPE, {
      content: '{{shuvixInlineToken:t0}}',
      tokens: { t0: { type: 'cmd', id: 'x', displayText: '/x', payload: 'p' } }
    })
    // deny 后 user 消息没来，先来了一条 assistant（如 steer 场景的中间态）
    await session.appendMessage(assistant([{ type: 'text', text: '回复' }]))
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '普通消息' }],
      timestamp: Date.now()
    } as AgentMessage)

    const msgs = await project()
    expect(msgs).toHaveLength(2)
    expect(msgs[1]).toMatchObject({ role: 'user', content: '普通消息' })
    expect((msgs[1].metadata as UserTextMeta | undefined)?.inlineTokens).toBeUndefined()
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
  })
})
