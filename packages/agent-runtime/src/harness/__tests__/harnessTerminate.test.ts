/**
 * `next` 的 `terminate: true` 经真 AgentHarness 的效果 —— 判定型 hook 的审查 agent「一次请求出结论」的前提。
 *
 * pi 的循环在一批工具结果**全部**带 terminate 时直接结束、不再发下一次请求。这里用真 HarnessSession +
 * 内存会话树 + faux provider（经 createModelsAdapter，与生产同一条模型路径），数 provider 被请求了几次，
 * 并在响应队列里多放一条诱饵：诱饵还在队列里 = 循环确实没再发请求。
 *
 *   HT-1  只调合格的 next → 一次请求；
 *   HT-2  只调普通工具 → 两次（对照：普通工具不带 terminate）；
 *   HT-3  同批两次 next → 一次（重复调用也带 terminate，否则整批不满足「全部」）；
 *   HT-4  先不合格再改正 → 恰两次（不合格是 tool error，不带 terminate）；
 *   HT-5  next 与普通工具同批 → 两次（terminate 不成立 —— manager 保留软停止兜底的前提）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemorySessionStorage, Session } from '@earendil-works/pi-agent-core'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import {
  PERMISSION_VERDICT_SCHEMA,
  type PermissionVerdict
} from '@shuvix/chat-protocol/types/permissionReview'
import { HarnessSession } from '../harnessSession'
import { createStubExecutionEnv } from '../stubEnv'
import { createModelsAdapter } from '../modelsAdapter'
import { NextTool } from '../../subagent/nextTool'

const V: PermissionVerdict = {
  decision: 'allow',
  risk: 'low',
  summary: 'Runs the project tests.',
  reason: 'The user asked for the tests.'
}
/** 诱饵：若循环在 next 之后还发了请求，它会被取走 */
const DECOY = 'SHOULD NOT BE REQUESTED'

let faux: ReturnType<typeof registerFauxProvider>

beforeEach(() => {
  faux = registerFauxProvider()
})

afterEach(() => {
  faux.unregister()
})

/** 不带 terminate 的普通工具 */
function echoTool(): { tool: AgentTool; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'echoed' }],
    details: undefined
  }))
  const tool = {
    name: 'echo',
    label: 'echo',
    description: 'Echo back.',
    parameters: Type.Object({}),
    execute
  }
  return { tool: tool as unknown as AgentTool, execute }
}

/** 真 NextTool（审查判决的 schema），捕获进 onCapture */
function nextTool(onCapture: (value: Record<string, unknown>) => void): AgentTool {
  return new NextTool(PERMISSION_VERDICT_SCHEMA, onCapture) as unknown as AgentTool
}

function makeSession(tools: AgentTool[]): { hs: HarnessSession; session: Session } {
  const session = new Session(
    new InMemorySessionStorage({ metadata: { id: 'ht-1', createdAt: new Date().toISOString() } })
  )
  const hs = new HarnessSession({
    sessionId: 'ht-1',
    session,
    env: createStubExecutionEnv(),
    models: createModelsAdapter({ getApiKey: () => 'k' }),
    model: faux.getModel() as unknown as Model<Api>,
    systemPrompt: 'Review the operation.',
    tools,
    eventSink: { broadcast: () => {}, hasUserInputCapability: () => false },
    autoCompact: false
  })
  return { hs, session }
}

/** 会话树上的角色序列（非消息 entry 记它的 type） */
async function branchRoles(session: Session): Promise<string[]> {
  return (await session.getBranch()).map((entry) =>
    entry.type === 'message' ? (entry.message as { role: string }).role : entry.type
  )
}

const callNext = (args: Record<string, unknown>): ReturnType<typeof fauxToolCall> =>
  fauxToolCall('next', args)

describe('next 的 terminate 经真 AgentHarness', () => {
  it('HT-1 只调合格的 next → 恰一次请求、诱饵没被取走；会话树恰 user → assistant → toolResult；捕获一次', async () => {
    const onCapture = vi.fn()
    faux.setResponses([
      fauxAssistantMessage([callNext({ ...V })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(DECOY)
    ])
    const { hs, session } = makeSession([nextTool(onCapture)])

    const { error } = await hs.prompt('Judge this operation.')

    expect(error).toBeUndefined()
    expect(faux.state.callCount).toBe(1)
    expect(faux.getPendingResponseCount()).toBe(1)
    expect(await branchRoles(session)).toEqual(['user', 'assistant', 'toolResult'])
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(onCapture).toHaveBeenCalledWith(V)
  })

  it('HT-2 对照：只调普通工具 → 两次请求（第二次拿到收尾回复）', async () => {
    const echo = echoTool()
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('echo', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('done')
    ])
    const { hs, session } = makeSession([echo.tool])

    await hs.prompt('Echo something.')

    expect(echo.execute).toHaveBeenCalledTimes(1)
    expect(faux.state.callCount).toBe(2)
    expect(faux.getPendingResponseCount()).toBe(0)
    expect(await branchRoles(session)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
  })

  it('HT-3 同批两次 next → 仍只一次请求；捕获一次（第一份）', async () => {
    const onCapture = vi.fn()
    faux.setResponses([
      fauxAssistantMessage([callNext({ ...V }), callNext({ ...V, decision: 'deny' })], {
        stopReason: 'toolUse'
      }),
      fauxAssistantMessage(DECOY)
    ])
    const { hs } = makeSession([nextTool(onCapture)])

    await hs.prompt('Judge this operation.')

    expect(faux.state.callCount).toBe(1)
    expect(faux.getPendingResponseCount()).toBe(1)
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(onCapture).toHaveBeenCalledWith(V)
  })

  it('HT-4 先交不合格的 next、再改正 → 恰两次请求，捕获的是改正后的值', async () => {
    const onCapture = vi.fn()
    const corrected: PermissionVerdict = { ...V, decision: 'ask', risk: 'medium' }
    faux.setResponses([
      fauxAssistantMessage([callNext({ ...V, decision: 'maybe' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([callNext({ ...corrected })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(DECOY)
    ])
    const { hs } = makeSession([nextTool(onCapture)])

    await hs.prompt('Judge this operation.')

    expect(faux.state.callCount).toBe(2)
    expect(faux.getPendingResponseCount()).toBe(1)
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(onCapture).toHaveBeenCalledWith(corrected)
  })

  it('HT-5 next 与普通工具同批 → terminate 不成立，两次请求（manager 的软停止兜底为此存在）', async () => {
    const onCapture = vi.fn()
    const echo = echoTool()
    faux.setResponses([
      fauxAssistantMessage([callNext({ ...V }), fauxToolCall('echo', {})], {
        stopReason: 'toolUse'
      }),
      fauxAssistantMessage('done')
    ])
    const { hs } = makeSession([nextTool(onCapture), echo.tool])

    await hs.prompt('Judge this operation.')

    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(echo.execute).toHaveBeenCalledTimes(1)
    expect(faux.state.callCount).toBe(2)
  })
})
