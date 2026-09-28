/**
 * 判定型 hook 全链路 —— 真 runner → 真 SubAgentManager → 真 createAgentFactory → 真 HarnessSession →
 * faux provider（经 createModelsAdapter，与生产同一条模型路径）。假的只有宿主适配面（工具解析透传结果
 * 契约的 `next`、模型构建返回 faux 模型）。
 *
 * 这一层钉的是各层单测拼不出来的东西：模型只调一次 `next` 就出结论（请求恰一次、诱饵留在队列里）、
 * 请求里工具表只有 `next`、任务文本里既有事件围栏也有契约段；以及「没有意见」在真链路上的样子 ——
 * 只写散文（追问一次后放弃）、模型报错（不追问）、中途被外部中止（不等流收尾）。
 *
 *   DR-1  只调 next → 结论、一次请求；
 *   DR-2  只写散文 → null、恰两次请求（原请求 + 一次追问）；
 *   DR-3  模型报错 → null、一次请求、end.error 带 provider 原话；
 *   DR-4  先不合格后合格 → 结论、两次请求；
 *   DR-5  思考档位：会话的档位随派发走，档案声明 off 压过它；
 *   DR-6  next 与普通工具同批 → 结论、不挂住；
 *   DR-7  请求进行中外部 signal 落下 → 很快返回 null。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  Type,
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
  type Context,
  type Model,
  type StreamOptions
} from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import type { PermissionVerdict } from '@shuvix/chat-protocol/types/permissionReview'
import { createHookRunner, type HookRunEvent, type HookRunner } from '../hookRunner'
import { createSubAgentManager } from '../../subagent/manager'
import { createAgentFactory, type AgentHostAdapter } from '../../agentProfile/createAgent'
import type { InProcessAgentType } from '../../subagent/types'
import { permissionPayload } from './harness'

const TRIGGER = 'permission.request'
const MODEL_ID = 'faux-reasoning'
const DECOY = 'SHOULD NOT BE REQUESTED'

const V: PermissionVerdict = {
  decision: 'deny',
  risk: 'high',
  summary: 'Deletes the build directory.',
  reason: 'Outside what the user asked for.'
}

let faux: ReturnType<typeof registerFauxProvider>

beforeEach(() => {
  faux = registerFauxProvider({ models: [{ id: MODEL_ID, reasoning: true }] })
})

afterEach(() => {
  faux.unregister()
})

/** 一次请求里 provider 看到的东西 */
interface SeenRequest {
  tools: string[]
  lastUserText: string
  reasoning: unknown
}

/** 消息内容的纯文本（字符串或文本块数组） */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === 'text' ? (part.text ?? '') : ''
    )
    .join('\n')
}

/** faux 的响应工厂：记下这次请求看到的工具表 / 最后一条 user 消息 / reasoning，再交回给定消息 */
function recording(
  seen: SeenRequest[],
  reply: ReturnType<typeof fauxAssistantMessage>
): (
  context: Context,
  options: StreamOptions | undefined
) => ReturnType<typeof fauxAssistantMessage> {
  return (context, options) => {
    const lastUser = [...context.messages].reverse().find((m) => m.role === 'user')
    seen.push({
      tools: (context.tools ?? []).map((tool) => tool.name),
      lastUserText: textOf(lastUser?.content),
      reasoning: (options as { reasoning?: unknown } | undefined)?.reasoning
    })
    return reply
  }
}

const nextCall = (args: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> =>
  fauxAssistantMessage([fauxToolCall('next', args)], { stopReason: 'toolUse' })

interface Chain {
  runner: HookRunner
  chatEvents: ChatEvent[]
  runEvents: HookRunEvent[]
  logs: string[]
}

function buildChain(
  opts: {
    profile?: Partial<InProcessAgentType>
    /** 宿主按名解析出来的工具（档案工具表为空时它们照样在 —— 模拟同批里的普通工具） */
    hostTools?: AgentTool[]
    sessionThinking?: ThinkingLevel
  } = {}
): Chain {
  const chatEvents: ChatEvent[] = []
  const runEvents: HookRunEvent[] = []
  const logs: string[] = []
  const host: AgentHostAdapter = {
    // 结果契约的 next 经 extraTools 进来；宿主不另挂任何东西
    resolveTools: (req) => [
      ...((opts.hostTools ?? []) as unknown as NonNullable<typeof req.extraTools>),
      ...(req.extraTools ?? [])
    ],
    promptVars: () => ({}),
    buildModel: () => faux.getModel() as unknown as Model<Api>,
    getApiKey: () => 'test-key',
    openSessionTree: async () => {
      throw new Error('root sessions are not expected in this chain')
    },
    eventSink: { broadcast: (event) => chatEvents.push(event), hasUserInputCapability: () => false }
  }
  const manager = createSubAgentManager({
    createAgent: createAgentFactory(host).createAgent,
    broadcast: (event) => chatEvents.push(event)
  })
  const profile: InProcessAgentType = {
    name: 'permission-reviewer',
    displayName: 'Permission Reviewer',
    description: '',
    tools: [],
    systemPrompt: 'Review the operation and answer with next.',
    ...opts.profile
  }
  const runner = createHookRunner({
    manager,
    listHooks: () => [
      {
        source: 'builtin',
        file: {
          name: 'auto-review',
          displayName: 'Automatic Review',
          description: '',
          agent: profile.name,
          bindings: [{ trigger: TRIGGER }],
          prompt: 'Review the operation in the event below and answer with `next`.'
        }
      }
    ],
    resolveAgentProfile: (name) => (name === profile.name ? profile : null),
    resolveRunModel: async () => ({
      provider: 'faux',
      model: MODEL_ID,
      capabilities: {},
      thinkingLevel: opts.sessionThinking ?? 'high'
    }),
    env: { host: 'desktop', platform: 'darwin' },
    onRun: (event) => runEvents.push(event),
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m)
    }
  })
  return { runner, chatEvents, runEvents, logs }
}

const subSessionEnds = (chain: Chain): Array<Extract<ChatEvent, { type: 'sub_session_end' }>> =>
  chain.chatEvents.filter(
    (e): e is Extract<ChatEvent, { type: 'sub_session_end' }> => e.type === 'sub_session_end'
  )
const hookEnds = (chain: Chain): Array<Extract<HookRunEvent, { type: 'end' }>> =>
  chain.runEvents.filter((e): e is Extract<HookRunEvent, { type: 'end' }> => e.type === 'end')

describe('判定型 hook 全链路（真 manager / createAgent / harness + faux provider）', () => {
  it('DR-1 模型只调一次 next → {result, hook}、恰一次请求、诱饵留在队列；请求工具表恰 [next]，任务文本里有事件围栏与契约段', async () => {
    const seen: SeenRequest[] = []
    faux.setResponses([recording(seen, nextCall({ ...V })), fauxAssistantMessage(DECOY)])
    const chain = buildChain()

    const decision = await chain.runner.decide(TRIGGER, permissionPayload())

    expect(decision).toEqual({ result: V, hook: 'auto-review' })
    expect(faux.state.callCount).toBe(1)
    expect(faux.getPendingResponseCount()).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0].tools).toEqual(['next'])
    expect(seen[0].lastUserText).toContain('<hook_event trigger="permission.request">')
    expect(seen[0].lastUserText).toContain('target: rm -rf build')
    expect(seen[0].lastUserText).toContain('<result_contract>')
    expect(seen[0].lastUserText).toContain('("auto-review")')

    expect(subSessionEnds(chain)).toHaveLength(1)
    expect(subSessionEnds(chain)[0].isError).toBe(false)
    expect(hookEnds(chain)).toEqual([expect.objectContaining({ ok: true, result: V })])
    expect(chain.runner.runningCount()).toBe(0)
  })

  it('DR-2 模型只写散文、追问一次后仍不调 next → null；恰两次请求（原请求 + 一次追问）', async () => {
    faux.setResponses([
      fauxAssistantMessage('I think this is fine, allow it.'),
      fauxAssistantMessage('Still just prose.'),
      fauxAssistantMessage(DECOY)
    ])
    const chain = buildChain()

    expect(await chain.runner.decide(TRIGGER, permissionPayload())).toBeNull()
    expect(faux.state.callCount).toBe(2)
    expect(faux.getPendingResponseCount()).toBe(1)
    expect(hookEnds(chain)).toEqual([
      expect.objectContaining({ ok: false, error: 'no valid result' })
    ])
  })

  it('DR-3 模型调用报错 → null、一次请求（出错的一轮不追问）；end.error 带 provider 原话', async () => {
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '500 Internal Server Error' }),
      fauxAssistantMessage(DECOY)
    ])
    const chain = buildChain()

    expect(await chain.runner.decide(TRIGGER, permissionPayload())).toBeNull()
    expect(faux.state.callCount).toBe(1)
    const [end] = hookEnds(chain)
    expect(end.ok).toBe(false)
    expect(end.error).toContain('500 Internal Server Error')
    expect(subSessionEnds(chain)[0].isError).toBe(true)
  })

  it('DR-4 先交不合格的 next、再改正 → 拿到改正后的结论，恰两次请求', async () => {
    const corrected: PermissionVerdict = { ...V, decision: 'ask', risk: 'medium' }
    faux.setResponses([
      nextCall({ ...V, decision: 'maybe' }),
      nextCall({ ...corrected }),
      fauxAssistantMessage(DECOY)
    ])
    const chain = buildChain()

    expect(await chain.runner.decide(TRIGGER, permissionPayload())).toEqual({
      result: corrected,
      hook: 'auto-review'
    })
    expect(faux.state.callCount).toBe(2)
    expect(faux.getPendingResponseCount()).toBe(1)
  })

  it('DR-5 思考档位：会话 high、档案没声明 → 请求带 reasoning high；档案声明 off → 请求不带 reasoning', async () => {
    const inherited: SeenRequest[] = []
    faux.setResponses([recording(inherited, nextCall({ ...V }))])
    await buildChain({ sessionThinking: 'high' }).runner.decide(TRIGGER, permissionPayload())
    expect(inherited.map((r) => r.reasoning)).toEqual(['high'])

    const declared: SeenRequest[] = []
    faux.setResponses([recording(declared, nextCall({ ...V }))])
    await buildChain({ sessionThinking: 'high', profile: { thinkingLevel: 'off' } }).runner.decide(
      TRIGGER,
      permissionPayload()
    )
    expect(declared).toHaveLength(1)
    expect(declared[0].reasoning).toBeUndefined()
  })

  it('DR-6 next 与普通工具同批 → 返回捕获的结论、不挂住、不进追问；请求至多两次', async () => {
    const echo = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'echoed' }],
      details: undefined
    }))
    const echoTool = {
      name: 'echo',
      label: 'echo',
      description: 'Echo back.',
      parameters: Type.Object({}),
      execute: echo
    } as unknown as AgentTool
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('next', { ...V }), fauxToolCall('echo', {})], {
        stopReason: 'toolUse'
      }),
      fauxAssistantMessage('should be cut short'),
      fauxAssistantMessage(DECOY)
    ])
    const chain = buildChain({ hostTools: [echoTool] })

    expect(await chain.runner.decide(TRIGGER, permissionPayload())).toEqual({
      result: V,
      hook: 'auto-review'
    })
    expect(faux.state.callCount).toBeLessThanOrEqual(2)
    // 没进追问：追问文案从未作为 user 消息广播
    expect(chain.chatEvents.some((e) => e.type === 'user_message')).toBe(false)
  })

  it('DR-7 请求进行中外部 signal 落下 → decide 很快返回 null（不等流收尾）；流随后按中止收尾，坑位清空', async () => {
    // 慢速流：每个分片之间检查一次 signal
    faux.unregister()
    faux = registerFauxProvider({
      models: [{ id: MODEL_ID, reasoning: true }],
      tokensPerSecond: 20
    })
    faux.setResponses([nextCall({ ...V, summary: 's'.repeat(400) })])
    const chain = buildChain()
    const controller = new AbortController()

    const pending = chain.runner.decide(TRIGGER, permissionPayload(), { signal: controller.signal })
    await vi.waitFor(() => {
      expect(faux.state.callCount).toBe(1)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const abortedAt = Date.now()
    controller.abort()

    expect(await pending).toBeNull()
    expect(Date.now() - abortedAt).toBeLessThan(500)
    expect(hookEnds(chain)).toEqual([expect.objectContaining({ ok: false, error: 'aborted' })])
    await vi.waitFor(
      () => {
        expect(chain.runner.runningCount()).toBe(0)
      },
      { timeout: 3000 }
    )
    expect(faux.state.callCount).toBe(1)
  })
})
