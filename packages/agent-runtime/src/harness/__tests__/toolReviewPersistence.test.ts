/**
 * 「已审查」标记的载体 —— 工具结果 details 上的保留键 `shuvixReview` —— 走完落盘与广播两条路之后
 * 还在，而且两边一样。
 *
 * 宿主把标记写进 toolResult 的 details（wrapToolOutput）：实时那一路经 forwardHarnessEvent 广播成
 * tool_end，重开那一路经 JSONL 回读、entriesToChatMessages 投影回填到工具块。标记只有一份，
 * 所以两边读到的 details 必须深等 —— 否则工具卡上的盾牌跑着时有、重开就没了（或反过来）。
 *
 * 不 mock：真的 JsonlSessionStorage（临时目录，落盘后从磁盘重开）+ 真的 forwardHarnessEvent。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlSessionStorage, Session } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import type { AgentHarnessEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, AssistantToolBlock } from '@shuvix/chat-protocol/types/chatMessage'
import { toolReviewOf, withToolReview } from '@shuvix/chat-protocol/types/toolReview'
import { entriesToChatMessages } from '../projection'
import { createHarnessEventState, forwardHarnessEvent } from '../eventHandler'
import type { HarnessEventContext } from '../eventHandler'
import { defaultToolResultTransform } from '../../types'
import type { ChatEvent } from '../../types'

const SESSION_ID = 'sess-review'

const NOTE = { risk: 'medium' as const, summary: 'Removes the build folder' }
const DETAILS = withToolReview(
  { type: 'bash', exitCode: 0, truncated: false, cwd: '/w' },
  NOTE
) as Record<string, unknown>

let dir: string
let session: Session

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-tool-review-'))
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

function assistantWithCall(): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'rm -rf build' } }
    ],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    stopReason: 'toolUse',
    timestamp: Date.now()
  } as unknown as AgentMessage
}

function toolResult(details: unknown): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'removed' }],
    details,
    isError: false,
    timestamp: Date.now()
  } as unknown as AgentMessage
}

/** 重开会话文件（从磁盘读回来）之后投影出的那个工具块 */
async function reopenedBlock(): Promise<AssistantToolBlock> {
  const env = new NodeExecutionEnv({ cwd: dir })
  const reopened = new Session(
    await JsonlSessionStorage.open(env, join(dir, `${SESSION_ID}.jsonl`))
  )
  const msgs = entriesToChatMessages(await reopened.buildContextEntries(), SESSION_ID, 'test-model')
  const card = msgs.find((m): m is AssistantMessage => m.role === 'assistant')
  const block = card?.blocks.find((b): b is AssistantToolBlock => b.type === 'tool')
  if (!block) throw new Error('tool block not projected')
  return block
}

/** 同一个 toolResult 经实时那一路（forwardHarnessEvent）广播出的 tool_end */
async function broadcastToolEnd(
  details: unknown
): Promise<Extract<ChatEvent, { type: 'tool_end' }>> {
  const events: ChatEvent[] = []
  const ctx: HarnessEventContext = {
    sessionId: SESSION_ID,
    session: {} as Session,
    state: createHarnessEventState(),
    broadcast: (e) => events.push(e),
    deps: {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      getModelId: () => 'test-model',
      transformToolResult: defaultToolResultTransform
    }
  }
  await forwardHarnessEvent(ctx, {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'bash',
    isError: false,
    result: { content: [{ type: 'text', text: 'removed' }], details }
  } as unknown as AgentHarnessEvent)
  const end = events.find((e) => e.type === 'tool_end')
  if (!end || end.type !== 'tool_end') throw new Error('tool_end not broadcast')
  return end
}

describe('「已审查」标记随 toolResult 落盘与广播', () => {
  it('TP-1 append 之后从磁盘重开再投影：工具块的 details 与写入的深等，标记读得出', async () => {
    await session.appendMessage(assistantWithCall())
    await session.appendMessage(toolResult(DETAILS))

    const block = await reopenedBlock()
    expect(block.toolCallId).toBe('call-1')
    expect(block.details).toStrictEqual(DETAILS)
    expect(toolReviewOf(block.details)).toStrictEqual(NOTE)
  })

  it('TP-2 同一个 toolResult 经实时广播出的 tool_end.details 与重开投影出的深等', async () => {
    await session.appendMessage(assistantWithCall())
    await session.appendMessage(toolResult(DETAILS))
    const projected = (await reopenedBlock()).details

    const live = await broadcastToolEnd(DETAILS)
    expect(live.details).toStrictEqual(projected)
    expect(toolReviewOf(live.details)).toStrictEqual(NOTE)
  })

  it('TP-3 details 缺省 → 块 details undefined，toolReviewOf undefined（两路都是）', async () => {
    await session.appendMessage(assistantWithCall())
    await session.appendMessage(toolResult(undefined))

    const block = await reopenedBlock()
    expect(block.details).toBeUndefined()
    expect(toolReviewOf(block.details)).toBeUndefined()

    const live = await broadcastToolEnd(undefined)
    expect(live.details).toBeUndefined()
    expect(toolReviewOf(live.details)).toBeUndefined()
  })
})
