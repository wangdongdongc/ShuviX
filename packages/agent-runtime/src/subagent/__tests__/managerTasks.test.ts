/**
 * 派生 agent 在后台任务枢纽里的一条命：spawn 即登记、跑完即落定、追问回到运行态、
 * 关掉即销账。
 *
 * 钉的是三条会被日后「顺手优化」掉的性质：
 *   - **taskId 就是 agentId**：它已经是派生期间全部 ChatEvent 的频道，另发明一套就要多一张映射表；
 *   - **任务归属可见会话**（rootSessionId）：嵌套派生不该落在中间那层身上，那层在界面上根本不存在；
 *   - **同步等待不发通知**：runTask 全程挂着等待者，结果由那次调用交回 —— 再补一条通知
 *     等于让父级把刚拿到的东西再读一遍。
 *
 * fake 注入风格对齐 managerResultContract.test.ts。
 */
import { describe, expect, it, vi } from 'vitest'
import { createSubAgentManager, type RunTaskParams } from '../manager'
import { createTaskRegistry, type TaskInfo } from '../../task/registry'
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

function makeHarness(o: { onPrompt?: (text: string) => Promise<{ error?: string }> } = {}): {
  manager: ReturnType<typeof createSubAgentManager>
  tasks: ReturnType<typeof createTaskRegistry>
  broadcasts: TaskInfo[]
  delivered: string[]
  abort: ReturnType<typeof vi.fn>
} {
  const broadcasts: TaskInfo[] = []
  const delivered: string[] = []
  const tasks = createTaskRegistry({
    broadcast: (task) => broadcasts.push(task),
    deliver: (_sessionId, text) => delivered.push(text),
    coalesceMs: 5
  })
  const abort = vi.fn(async () => {})
  const runtime = {
    prompt: async (text: string): Promise<{ error?: string }> =>
      o.onPrompt ? await o.onPrompt(text) : {},
    abort,
    session: {
      appendMessage: vi.fn(async () => {}),
      buildContext: async () => ({ messages: [] })
    }
  }
  const createAgent = vi.fn(async (_params: CreateAgentParams) => {
    return { runtime, dispose: vi.fn() } as unknown as CreatedAgent
  })
  const manager = createSubAgentManager({
    createAgent: createAgent as unknown as AgentFactory['createAgent'],
    broadcast: () => {},
    tasks
  })
  return { manager, tasks, broadcasts, delivered, abort }
}

const params = (over: Partial<RunTaskParams> = {}): RunTaskParams => ({
  parentSessionId: 'root-1',
  agentType: PROFILE,
  prompt: 'Do the thing',
  description: 'task',
  modelConfig: MODEL,
  ...over
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('派生 agent —— 后台任务登记', () => {
  it('spawn 即登记：taskId = agentId，归属可见会话，带上派发它的 tool_call id', async () => {
    const { manager, tasks, broadcasts } = makeHarness()
    await manager.runTask(params({ parentToolCallId: 'tc-1' }))

    const spawned = broadcasts[0]
    expect(spawned.kind).toBe('agent')
    expect(spawned.sessionId).toBe('root-1')
    expect(spawned.title).toBe('Worker')
    expect(spawned.subject).toMatchObject({
      kind: 'agent',
      profileName: 'worker',
      depth: 1,
      parentToolCallId: 'tc-1'
    })
    // taskId 就是事件频道 id —— 面板与转写指的是同一个东西
    expect(tasks.get(spawned.taskId)?.taskId).toBe(spawned.taskId)
  })

  it('跑完落定为 done，且**不通知**（同步等待，结果由那次调用交回）', async () => {
    const { manager, tasks, broadcasts, delivered } = makeHarness()
    await manager.runTask(params())

    const taskId = broadcasts[0].taskId
    expect(tasks.get(taskId)?.status).toBe('done')
    await sleep(20)
    expect(delivered).toHaveLength(0)
  })

  it('这一轮出错 → 落定为 error', async () => {
    const { manager, tasks, broadcasts } = makeHarness({
      onPrompt: async () => ({ error: 'boom' })
    })
    await manager.runTask(params())
    expect(tasks.get(broadcasts[0].taskId)?.status).toBe('error')
  })

  it('用户追问一个跑完的 agent → 那条任务回到运行态（面板行代表的是 agent，不是某一轮）', async () => {
    const { manager, tasks, broadcasts } = makeHarness()
    await manager.runTask(params())
    const taskId = broadcasts[0].taskId
    expect(tasks.get(taskId)?.endedAt).not.toBeNull()

    const pending = manager.continueTask({
      subSessionId: taskId,
      text: 'and now this',
      inlineTokens: undefined
    })
    const seenWhileRunning = tasks.get(taskId)?.status
    await pending

    expect(seenWhileRunning).toBe('running')
    expect(tasks.get(taskId)?.status).toBe('done')
  })

  it('用户从面板关掉 → 条目销账（还在跑的那次等待也一并解开）', async () => {
    const { manager, tasks, broadcasts } = makeHarness()
    await manager.runTask(params())
    const taskId = broadcasts[0].taskId

    manager.destroy(taskId)
    expect(tasks.get(taskId)).toBeUndefined()
  })
})
