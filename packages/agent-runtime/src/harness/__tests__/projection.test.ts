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
import type {
  AssistantMessage,
  ChatMessage,
  UserTextMeta
} from '@shuvix/chat-protocol/types/chatMessage'
import {
  entriesToChatMessages,
  BOT_SENDER_CUSTOM_TYPE,
  INLINE_TOKENS_CUSTOM_TYPE,
  INSTRUCTION_CUSTOM_TYPE,
  SIDECAR_CUSTOM_TYPES
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

// ─── bot 署名侧车 ──────────────────────────────────────────────

/** 一条 bot 说的 assistant 消息：model/provider 留空，靠 model_change / fallback 兜底 */
function botSaid(text: string, stopReason = 'stop'): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: '',
    model: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason,
    timestamp: Date.now()
  } as unknown as AgentMessage
}

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as AgentMessage
}

/** 追加一条署名侧车 */
function sidecar(botName: string, displayName = botName, extra: object = {}): Promise<string> {
  return session.appendCustomEntry(BOT_SENDER_CUSTOM_TYPE, { botName, displayName, ...extra })
}

/** 读一条消息的 sender（不存在时为 undefined，供「无署名」断言） */
function senderOf(msg: ChatMessage | undefined): unknown {
  return (msg?.metadata as { sender?: unknown } | null | undefined)?.sender
}

describe('bot sender sidecar', () => {
  it('署名挂到紧邻的下一条 assistant 上；侧车自身不产消息、不占 id', async () => {
    const sidecarId = await sidecar('scout', 'Scout')
    const assistantId = await session.appendMessage(botSaid('侦察完毕'))

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe(assistantId)
    expect(msgs.map((m) => m.id)).not.toContain(sidecarId)
    expect(senderOf(msgs[0])).toEqual({ kind: 'bot', name: 'scout', displayName: 'Scout' })
  })

  it('中间夹 model_change：降级为无署名，但模型照常生效（署名是在 continue 之前取走的）', async () => {
    await sidecar('scout', 'Scout')
    await session.appendModelChange('anthropic', 'claude-x')
    await session.appendMessage(botSaid('回复'))

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(senderOf(msgs[0])).toBeUndefined()
    // 整条 entry 若被跳过，model_change 也就不会推进 state —— 这里正是要区分这两件事
    expect(msgs[0]).toMatchObject({ model: 'claude-x', provider: 'anthropic' })
  })

  it('中间夹一条未知 customType：降级为无署名（未知 custom 也会消费掉待挂的署名）', async () => {
    await sidecar('scout', 'Scout')
    await session.appendCustomEntry('shuvix:not-a-sidecar', { whatever: 1 })
    await session.appendMessage(botSaid('回复'))

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(senderOf(msgs[0])).toBeUndefined()
  })

  it('中间夹一条 user 消息：user 不带署名，其后的 assistant 也拿不到', async () => {
    await sidecar('scout', 'Scout')
    await session.appendMessage(user('插一句'))
    await session.appendMessage(botSaid('回复'))

    const msgs = await project()
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[0].metadata).not.toHaveProperty('sender')
    expect(senderOf(msgs[1])).toBeUndefined()
  })

  it('中间夹一条 toolResult：它不产消息也不承接署名，后续 assistant 无署名', async () => {
    await session.appendMessage(
      assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 'toolUse')
    )
    await sidecar('scout', 'Scout')
    await session.appendMessage({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: Date.now()
    } as AgentMessage)
    await session.appendMessage(botSaid('回复'))

    const msgs = await project()
    // 工具卡 + bot 回复两条；toolResult 只是回填，不自成一条
    expect(msgs).toHaveLength(2)
    expect(senderOf(msgs[1])).toBeUndefined()
  })

  it('连续两条署名侧车：后一条生效，前一条丢弃（不是两条都丢）', async () => {
    await sidecar('first', 'First')
    await sidecar('second', 'Second')
    await session.appendMessage(botSaid('回复'))

    const msgs = await project()
    expect(senderOf(msgs[0])).toMatchObject({ name: 'second', displayName: 'Second' })
  })

  it('署名后跟 stopReason=error 的 assistant：塌成 error_event 且署名被吃掉、不顺延', async () => {
    await sidecar('scout', 'Scout')
    const errMsg = botSaid('', 'error') as unknown as Record<string, unknown>
    errMsg.errorMessage = 'prompt is too long'
    await session.appendMessage(errMsg as unknown as AgentMessage)
    await session.appendMessage(botSaid('下一条'))

    const msgs = await project()
    expect(msgs.map((m) => m.type)).toEqual(['error_event', 'message'])
    expect(senderOf(msgs[0])).toBeUndefined()
    // 已被 error 那条消费掉 —— 绝不顺延到再后面的消息上
    expect(senderOf(msgs[1])).toBeUndefined()
  })

  it('署名后跟空 assistant（首 token 前中止）：空卡与署名一起消失，不污染下一条', async () => {
    await sidecar('scout', 'Scout')
    await session.appendMessage(assistant([], 'aborted'))
    await session.appendMessage(botSaid('下一条'))

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('下一条')
    expect(senderOf(msgs[0])).toBeUndefined()
  })

  it.each([
    ['缺 botName', { displayName: 'Scout' }],
    ['缺 displayName', { botName: 'scout' }],
    ['botName 为空串', { botName: '', displayName: 'Scout' }],
    ['data 非对象', 'scout']
  ])('侧车 data 非法（%s）：视为无署名，不抛异常，消息条数与无侧车基线一致', async (_n, data) => {
    await session.appendCustomEntry(BOT_SENDER_CUSTOM_TYPE, data)
    await session.appendMessage(botSaid('回复'))

    const msgs = await project()
    expect(msgs).toHaveLength(1)
    expect(senderOf(msgs[0])).toBeUndefined()
  })

  it('侧车 data 带未来键（decision / reply）：原样带过，sender 仍只暴露三个键', async () => {
    await sidecar('scout', 'Scout', { decision: 'reply', reply: { text: 'x' } })
    await session.appendMessage(botSaid('回复'))

    const sender = senderOf((await project())[0]) as Record<string, unknown>
    expect(Object.keys(sender).sort()).toEqual(['displayName', 'kind', 'name'])
    expect(sender).toEqual({ kind: 'bot', name: 'scout', displayName: 'Scout' })
  })

  it('署名侧车与内联 Token 侧车互不干扰（两个 pending 槽相互独立）', async () => {
    const tokens = { t0: { type: 'cmd', id: 'x', displayText: '/x', payload: '展开' } }
    await session.appendCustomEntry(INLINE_TOKENS_CUSTOM_TYPE, {
      content: '{{shuvixInlineToken:t0}}',
      tokens
    })
    await session.appendMessage(user('展开'))
    await sidecar('scout', 'Scout')
    await session.appendMessage(botSaid('回复'))

    const msgs = await project()
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[0].metadata).toMatchObject({ inlineTokens: tokens })
    expect(senderOf(msgs[0])).toBeUndefined()
    expect(senderOf(msgs[1])).toMatchObject({ name: 'scout' })
    expect((msgs[1].metadata as UserTextMeta | undefined)?.inlineTokens).toBeUndefined()
  })

  it('侧车落在压缩切点之前被丢弃：其 assistant 仍在，只是降级为无署名', async () => {
    await sidecar('scout', 'Scout')
    const assistantId = await session.appendMessage(botSaid('切点之后的回复'))
    await session.appendCompaction('这是摘要', assistantId, 1234)

    const msgs = await project()
    expect(msgs.map((m) => m.content)).toEqual(['这是摘要', '切点之后的回复'])
    expect(senderOf(msgs[1])).toBeUndefined()
  })

  it('署名跨「重开会话」保持一致（落盘保真）', async () => {
    await sidecar('scout', 'Scout')
    await session.appendMessage(botSaid('回复'))
    const before = await project()

    const env = new NodeExecutionEnv({ cwd: dir })
    const reopened = new Session(
      await JsonlSessionStorage.open(env, join(dir, `${SESSION_ID}.jsonl`))
    )
    const after = entriesToChatMessages(
      await reopened.buildContextEntries(),
      SESSION_ID,
      'test-model'
    )
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id))
    expect(senderOf(after[0])).toEqual(senderOf(before[0]))
  })
})

describe('未知 customType 对投影是完全透明的', () => {
  /**
   * 造一棵含全部 entry 形态的树（user / assistant / toolCall / toolResult /
   * compaction / instruction / 两种侧车），在若干位置插入未知 custom entry。
   *
   * 插入位置刻意**避开**「侧车 → 它的消息」之间：那里插任何东西都会按设计降级署名，
   * 那是语义而不是透明性。返回插入的未知 entry id 集合。
   */
  async function buildFullTree(): Promise<Set<string>> {
    const unknown = new Set<string>()
    await session.appendMessage(user('第一轮'))
    unknown.add(await session.appendCustomEntry('shuvix:unknown-a', { i: 0 }))
    const keepFrom = await session.appendMessage(assistant([{ type: 'text', text: '回复一' }]))
    await session.appendMessage(user('第二轮'))
    await session.appendCompaction('这是摘要', keepFrom, 1234)
    await session.appendCustomMessageEntry(INSTRUCTION_CUSTOM_TYPE, 'rules', true, {
      filename: 'AGENTS.md'
    })
    unknown.add(await session.appendCustomEntry('shuvix:unknown-b', { i: 1 }))
    await session.appendMessage(
      assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 'toolUse')
    )
    await session.appendMessage({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: Date.now()
    } as AgentMessage)
    unknown.add(await session.appendCustomEntry('shuvix:unknown-c', { i: 2 }))
    await session.appendCustomEntry(INLINE_TOKENS_CUSTOM_TYPE, {
      content: '{{shuvixInlineToken:t0}}',
      tokens: { t0: { type: 'cmd', id: 'x', displayText: '/x', payload: 'p' } }
    })
    await session.appendMessage(user('p'))
    await sidecar('scout', 'Scout')
    await session.appendMessage(botSaid('bot 回复'))
    unknown.add(await session.appendCustomEntry('shuvix:unknown-d', { i: 3 }))
    return unknown
  }

  it('插入未知 custom entry 前后，投影结果逐字段全等', async () => {
    const unknown = await buildFullTree()
    const entries = await session.buildContextEntries()
    // 同一棵树上做对照：id / 时间戳完全一致，差别只有那几条未知 custom
    const after = entriesToChatMessages(entries, SESSION_ID, 'test-model')
    const baseline = entriesToChatMessages(
      entries.filter((e) => !unknown.has(e.id)),
      SESSION_ID,
      'test-model'
    )
    expect(after).toEqual(baseline)
    expect(after.length).toBeGreaterThan(3)
  })

  it('未知 custom entry 的 id 不出现在任何消息 id 上', async () => {
    const unknown = await buildFullTree()
    const ids = (await project()).map((m) => m.id)
    expect(ids.filter((id) => unknown.has(id))).toEqual([])
  })

  it('SIDECAR_CUSTOM_TYPES 恰为两种侧车，且每种都不产出消息', async () => {
    expect([...SIDECAR_CUSTOM_TYPES]).toEqual([INLINE_TOKENS_CUSTOM_TYPE, BOT_SENDER_CUSTOM_TYPE])
    // 新增侧车类型却忘了在投影里 handle 时，这条会红
    for (const type of SIDECAR_CUSTOM_TYPES) {
      await session.appendCustomEntry(type, { botName: 'b', displayName: 'B' })
      expect(await project()).toHaveLength(0)
    }
  })
})

describe('切片投影的 fallback（entriesToChatMessages 的第三/第四参）', () => {
  it('切片里没有 model_change 时，user 消息取 fallbackModel / fallbackProvider', async () => {
    await session.appendMessage(user('hi'))
    const slice = await session.buildContextEntries()

    expect(entriesToChatMessages(slice, SESSION_ID, 'm', 'p')[0]).toMatchObject({
      model: 'm',
      provider: 'p'
    })
    // 不传第四参时 provider 回落空串（旧签名的行为）
    expect(entriesToChatMessages(slice, SESSION_ID, 'm')[0]).toMatchObject({
      model: 'm',
      provider: ''
    })
  })

  it.each([
    ['assistant 自带 model/provider 时优先于 fallback', 'own-model', 'own-provider'],
    ['assistant 的 model/provider 为空时才回落 fallback', '', '']
  ])('%s', async (_n, ownModel, ownProvider) => {
    await session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '回复' }],
      api: 'openai-completions',
      provider: ownProvider,
      model: ownModel,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: 'stop',
      timestamp: Date.now()
    } as unknown as AgentMessage)

    const [msg] = entriesToChatMessages(await session.buildContextEntries(), SESSION_ID, 'fm', 'fp')
    expect(msg).toMatchObject({
      model: ownModel || 'fm',
      provider: ownProvider || 'fp'
    })
  })
})
