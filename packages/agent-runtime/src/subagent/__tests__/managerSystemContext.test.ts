/**
 * SubAgentManager 的 systemContext 透传（RunTaskParams.systemContext → CreateAgentParams.systemContext）。
 *
 * manager 不解释内容：它只把调用方给的上下文块**原样**交给统一
 * 创建管线，由 createAgent 追加到系统提示词末尾（契约在 agentProfile/__tests__/createAgent.test.ts）。
 * 这一层要钉的只有「原样、不多不少」：块不进 prompt、不进 contextMessages、不与结果契约的
 * extraTools 互相干扰。fake 注入风格对齐 managerResultContract.test.ts。
 *
 * 同一条透传路径上还有思考档位（MS-5）：`modelConfig.thinkingLevel` 原样成为 createAgent 的
 * thinkingLevel，没给时缺省 off（档案声明压过它是 createAgent 的事，不在这一层）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { createSubAgentManager, type RunTaskParams } from '../manager'
import type { AgentFactory, CreateAgentParams, CreatedAgent } from '../../agentProfile/createAgent'
import type { InProcessAgentType, SubAgentModelConfig } from '../types'

const PROFILE: InProcessAgentType = {
  name: 'worker',
  displayName: 'Worker',
  description: '',
  tools: [],
  systemPrompt: 'S'
}
const MODEL: SubAgentModelConfig = { provider: 'p', model: 'm', capabilities: {} }
const CTX = ['<bot_profile name="scout" file="/b/scout.md">\nP\n</bot_profile>']

function makeHarness(): {
  manager: ReturnType<typeof createSubAgentManager>
  createCalls: CreateAgentParams[]
  promptTexts: string[]
  appendContext: ReturnType<typeof vi.fn>
} {
  const createCalls: CreateAgentParams[] = []
  const promptTexts: string[] = []
  const appendContext = vi.fn(async () => {})
  const runtime = {
    prompt: async (text: string): Promise<{ error?: string }> => {
      promptTexts.push(text)
      return {}
    },
    abort: vi.fn(async () => {}),
    appendContext,
    contextMessages: async () => []
  }
  const createAgent = vi.fn(async (params: CreateAgentParams) => {
    createCalls.push(params)
    return { runtime, dispose: vi.fn() } as unknown as CreatedAgent
  })
  const events: ChatEvent[] = []
  const manager = createSubAgentManager({
    createAgent: createAgent as unknown as AgentFactory['createAgent'],
    broadcast: (e) => events.push(e)
  })
  return { manager, createCalls, promptTexts, appendContext }
}

const task = (over: Partial<RunTaskParams> = {}): RunTaskParams => ({
  parentSessionId: 'root-1',
  agentType: PROFILE,
  prompt: 'Do the thing',
  description: 'task',
  modelConfig: MODEL,
  ...over
})

describe('runTask — systemContext 透传给 createAgent', () => {
  it('MS-1 给了 → createAgent 收到**同一个**数组（原样透传，不拷贝不改写）', async () => {
    const { manager, createCalls } = makeHarness()
    await manager.runTask(task({ systemContext: CTX }))
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0].systemContext).toBe(CTX)
    expect(createCalls[0].kind).toBe('spawned')
  })

  it('MS-2 不给 → createAgent 的 systemContext 为 undefined（manager 不发明缺省）', async () => {
    const { manager, createCalls } = makeHarness()
    await manager.runTask(task())
    expect(createCalls[0].systemContext).toBeUndefined()
  })

  it('MS-3 块不进 prompt、不进内存树：它只走系统提示词那一条路', async () => {
    // 上下文块是系统提示词的一部分（createAgent 追加），不是发给模型的用户消息 ——
    // 走 contextMessages / prompt 会让它进对话历史、随压缩被丢，且面板会把它当「用户说的」
    const { manager, createCalls, promptTexts, appendContext } = makeHarness()
    await manager.runTask(task({ systemContext: CTX }))
    expect(promptTexts).toEqual(['Do the thing'])
    expect(appendContext).not.toHaveBeenCalled()
    expect(createCalls[0].extraTools).toBeUndefined()
  })

  it('MS-4 与结果契约并存：extraTools（next）与 systemContext 各走各的席位', async () => {
    const { manager, createCalls } = makeHarness()
    await manager.runTask(
      task({
        systemContext: CTX,
        resultContract: {
          schema: { type: 'object', required: ['x'] },
          sourceLabel: 'wf',
          nudges: 0
        }
      })
    )
    expect(createCalls[0].systemContext).toBe(CTX)
    expect(createCalls[0].extraTools).toHaveLength(1)
  })
})

describe('runTask — 思考档位随派发方交给 createAgent', () => {
  // hook 派发的 agent 继承会话的思考档位（resolveRunModel 带上 thinkingLevel），档案声明的
  // `shuvix-thinking` 由 createAgent 压过它 —— manager 这一层只管原样交过去、没给时缺省 off
  it.each(['high', 'off'] as const)(
    'MS-5 modelConfig.thinkingLevel %s → createAgent 的 thinkingLevel 原样为 %s',
    async (level) => {
      const { manager, createCalls } = makeHarness()
      await manager.runTask(task({ modelConfig: { ...MODEL, thinkingLevel: level } }))
      expect(createCalls[0].thinkingLevel).toBe(level)
      expect(createCalls[0].model.thinkingLevel).toBe(level)
    }
  )

  it('MS-5 modelConfig 没给 thinkingLevel → createAgent 收到 off', async () => {
    const { manager, createCalls } = makeHarness()
    await manager.runTask(task())
    expect('thinkingLevel' in MODEL).toBe(false)
    expect(createCalls[0].thinkingLevel).toBe('off')
  })
})
