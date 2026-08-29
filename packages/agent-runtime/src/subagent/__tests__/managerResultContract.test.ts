/**
 * SubAgentManager 的结果契约链路（RunTaskParams.resultContract）——
 * next 工具注入 / prompt 契约段 / 捕获即软停止 / 未捕获 nudge 补救 / structured 返回。
 *
 * 「模型调 next」在测试里 = 编排的 fakeRuntime.prompt 内取 createAgent 捕到的
 * extraTools[0] 直接 execute —— 与 harness 派发工具调用同一条代码路径（BaseTool.execute），
 * 只是不经 LLM。fake 注入风格对齐 dispatchTool.test.ts。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { createSubAgentManager, type RunTaskParams } from '../manager'
import type { AgentFactory, CreateAgentParams, CreatedAgent } from '../../agentProfile/createAgent'
import type { InProcessAgentType, SubAgentModelConfig } from '../types'
import { NEXT_NUDGE_TEXT, buildResultContractNote, type ResultContract } from '../nextTool'

const TITLE_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string' } }
}
const PROFILE: InProcessAgentType = {
  name: 'worker',
  displayName: 'Worker',
  description: '',
  tools: [],
  systemPrompt: 'S'
}
const MODEL: SubAgentModelConfig = { provider: 'p', model: 'm', capabilities: {} }

interface Harness {
  events: ChatEvent[]
  createCalls: CreateAgentParams[]
  promptTexts: string[]
  abort: ReturnType<typeof vi.fn>
  /** 「模型调 next」：取捕到的 extraTools[0] 走 BaseTool.execute */
  next: (value: Record<string, unknown>) => Promise<unknown>
}

function makeHarness(
  o: {
    /** 每轮 prompt 的编排（round 从 1 起）；缺省自然结束（{}，不捕获） */
    onPrompt?: (text: string, round: number, h: Harness) => Promise<{ error?: string }>
    /** buildContext 返回的内存树消息（无捕获时 extractResult 的输入） */
    messages?: unknown[]
  } = {}
): {
  manager: ReturnType<typeof createSubAgentManager>
  h: Harness
  createAgent: ReturnType<typeof vi.fn>
} {
  const h: Harness = {
    events: [],
    createCalls: [],
    promptTexts: [],
    abort: vi.fn(async () => {}),
    next: async (value) => {
      const tool = h.createCalls[0]?.extraTools?.[0] as unknown as {
        execute: (id: string, p: Record<string, unknown>) => Promise<unknown>
      }
      return tool.execute(`tc-${h.promptTexts.length}`, value)
    }
  }
  const runtime = {
    prompt: async (text: string): Promise<{ error?: string }> => {
      h.promptTexts.push(text)
      return o.onPrompt ? await o.onPrompt(text, h.promptTexts.length, h) : {}
    },
    abort: h.abort,
    session: {
      appendMessage: vi.fn(async () => {}),
      buildContext: async () => ({ messages: o.messages ?? [] })
    }
  }
  const createAgent = vi.fn(async (params: CreateAgentParams) => {
    h.createCalls.push(params)
    return { runtime, dispose: vi.fn() } as unknown as CreatedAgent
  })
  const manager = createSubAgentManager({
    createAgent: createAgent as unknown as AgentFactory['createAgent'],
    broadcast: (e) => h.events.push(e)
  })
  return { manager, h, createAgent }
}

const task = (over: Partial<RunTaskParams> = {}): RunTaskParams => ({
  parentSessionId: 'root-1',
  agentType: PROFILE,
  prompt: 'Do the thing',
  description: 'task',
  modelConfig: MODEL,
  ...over
})
const CONTRACT: ResultContract = { schema: TITLE_SCHEMA, sourceLabel: 'wf-x' }

const endEvent = (h: Harness): Extract<ChatEvent, { type: 'sub_session_end' }> =>
  h.events.find((e) => e.type === 'sub_session_end') as Extract<
    ChatEvent,
    { type: 'sub_session_end' }
  >

describe('结果契约 — next 工具注入与 prompt 契约段', () => {
  it('带契约 → createAgent 收到 extraTools 恰一件：name next、parameters 即契约 schema', async () => {
    const { manager, h } = makeHarness({
      onPrompt: async (_t, _r, hh) => {
        await hh.next({ title: 'X' })
        return {}
      }
    })
    await manager.runTask(task({ resultContract: CONTRACT }))
    expect(h.createCalls).toHaveLength(1)
    const extra = h.createCalls[0].extraTools
    expect(extra).toHaveLength(1)
    const tool = extra![0] as unknown as { name: string; parameters: Record<string, unknown> }
    expect(tool.name).toBe('next')
    expect(tool.parameters.type).toBe('object')
    expect(tool.parameters.required).toEqual(['title'])
    expect(tool.parameters.properties).toEqual(TITLE_SCHEMA.properties)
  })

  it('发给 runtime 的首个 prompt 以契约段结尾（原 prompt 在前）', async () => {
    const { manager, h } = makeHarness({
      onPrompt: async (_t, _r, hh) => {
        await hh.next({ title: 'X' })
        return {}
      }
    })
    await manager.runTask(task({ resultContract: CONTRACT }))
    expect(h.promptTexts[0]).toBe(`Do the thing\n\n${buildResultContractNote(CONTRACT)}`)
  })

  it('无契约 → extraTools 为 undefined、prompt 无契约段', async () => {
    const { manager, h } = makeHarness()
    await manager.runTask(task())
    expect(h.createCalls[0].extraTools).toBeUndefined()
    expect(h.promptTexts[0]).toBe('Do the thing')
    expect(h.promptTexts[0]).not.toContain('<workflow_result_contract>')
  })

  it('契约 schema 非法 → runTask 直接 reject invalid result contract，createAgent 未被调用', async () => {
    const { manager, h, createAgent } = makeHarness()
    await expect(
      manager.runTask(task({ resultContract: { schema: { type: 'array' } } }))
    ).rejects.toThrow(/invalid result contract/)
    expect(createAgent).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
  })
})

describe('结果契约 — 捕获路径', () => {
  it('首轮捕获 → {structured, result: JSON 文本}；sub_session_end isError:false 且 result 同文', async () => {
    const { manager, h } = makeHarness({
      onPrompt: async (_t, _r, hh) => {
        await hh.next({ title: 'X' })
        return {}
      }
    })
    const res = await manager.runTask(task({ resultContract: CONTRACT }))
    expect(res.structured).toEqual({ title: 'X' })
    expect(res.result).toBe(JSON.stringify({ title: 'X' }, null, 2))

    const end = endEvent(h)
    expect(end.isError).toBe(false)
    expect(end.result).toBe(res.result)
  })

  it('捕获即软停止：microtask 冲刷后 runtime.abort 被调恰一次', async () => {
    const { manager, h } = makeHarness({
      onPrompt: async (_t, _r, hh) => {
        await hh.next({ title: 'X' })
        return {}
      }
    })
    await manager.runTask(task({ resultContract: CONTRACT }))
    await Promise.resolve()
    expect(h.abort).toHaveBeenCalledTimes(1)
  })

  it('首轮已捕获 → 不进 nudge 循环（prompt 恰 1 次）', async () => {
    const { manager, h } = makeHarness({
      onPrompt: async (_t, _r, hh) => {
        await hh.next({ title: 'X' })
        return {}
      }
    })
    await manager.runTask(task({ resultContract: CONTRACT }))
    expect(h.promptTexts).toHaveLength(1)
  })
})

describe('结果契约 — 未调用 next 的 nudge 补救', () => {
  it('自然结束未捕获 → 广播 NEXT_NUDGE_TEXT 的 user_message，第二轮 prompt 入参即 nudge 文本；nudge 轮捕获生效', async () => {
    const { manager, h } = makeHarness({
      onPrompt: async (_t, round, hh) => {
        if (round === 2) await hh.next({ title: 'from nudge' })
        return {}
      }
    })
    const res = await manager.runTask(task({ resultContract: CONTRACT }))
    expect(res.structured).toEqual({ title: 'from nudge' })

    const userMsg = h.events.find((e) => e.type === 'user_message') as Extract<
      ChatEvent,
      { type: 'user_message' }
    >
    expect(userMsg).toBeDefined()
    expect(JSON.parse(userMsg.message).content).toBe(NEXT_NUDGE_TEXT)
    expect(h.promptTexts[1]).toBe(NEXT_NUDGE_TEXT)
  })

  it('nudges 缺省 = 1：始终不捕获 → prompt 恰 2 次', async () => {
    const { manager, h } = makeHarness()
    await manager.runTask(task({ resultContract: CONTRACT }))
    expect(h.promptTexts).toHaveLength(2)
  })

  it('nudges: 0 → 不追问、structured undefined、result 走 extractResult', async () => {
    const { manager, h } = makeHarness({
      messages: [{ role: 'assistant', content: 'FINAL PROSE', stopReason: 'stop' }]
    })
    const res = await manager.runTask(task({ resultContract: { ...CONTRACT, nudges: 0 } }))
    expect(h.promptTexts).toHaveLength(1)
    expect(res.structured).toBeUndefined()
    expect(res.result).toBe('FINAL PROSE')
  })

  it('nudges: 2 且始终不捕获 → prompt 恰 3 次', async () => {
    const { manager, h } = makeHarness()
    await manager.runTask(task({ resultContract: { ...CONTRACT, nudges: 2 } }))
    expect(h.promptTexts).toHaveLength(3)
  })

  it('首轮 execError → 不追问、structured undefined、sub_session_end isError:true', async () => {
    const { manager, h } = makeHarness({ onPrompt: async () => ({ error: 'boom' }) })
    const res = await manager.runTask(task({ resultContract: CONTRACT }))
    expect(h.promptTexts).toHaveLength(1)
    expect(res.structured).toBeUndefined()
    expect(endEvent(h).isError).toBe(true)
  })
})

describe('结果契约 — spawn 血缘与中止', () => {
  it('workflow 式未知 parent（wfr-x 未登记）→ spawn.depth=1、rootSessionId=wfr-x', async () => {
    const { manager, h } = makeHarness()
    await manager.runTask(task({ parentSessionId: 'wfr-x' }))
    expect(h.createCalls[0].spawn?.depth).toBe(1)
    expect(h.createCalls[0].spawn?.rootSessionId).toBe('wfr-x')
  })

  it('parentAbortSignal 预先 aborted → 结果为 abortedNote、isError:true、契约下也不追问', async () => {
    const controller = new AbortController()
    controller.abort()
    const { manager, h } = makeHarness()
    const res = await manager.runTask(
      task({ resultContract: CONTRACT, parentAbortSignal: controller.signal })
    )
    expect(res.result).toBe('Aborted by user.')
    expect(res.structured).toBeUndefined()
    expect(endEvent(h).isError).toBe(true)
    expect(h.promptTexts).toHaveLength(1)
  })
})
