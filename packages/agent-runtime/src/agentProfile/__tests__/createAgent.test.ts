/**
 * createAgentFactory —— 切换期（pi-durable P1-01）的创建入口。
 *
 * 决策表、档案模型 / 思考档位、注入次序、工具名单归一这些纯派生的用例已搬到
 * `durable/__tests__/agentSpec.test.ts`（断言落在 `deriveAgentSpec` 的规格上）。这里只剩入口本身：
 * 会话的根 agent 由 durable 会话自己创建（锁），本工厂收到 root 直接拒绝；派生 agent 的 durable 版在
 * phase 2，所以 spawned 以 `PhasePendingError` 收尾，入参校验照旧先行。依赖运行时本身的旧用例列在下面作 it.todo。
 */
import { describe, it, expect, vi } from 'vitest'
import { createAgentFactory, type AgentHostAdapter, type SpawnContext } from '../createAgent'
import { PhasePendingError } from '../../errors/phasePending'
import type { InProcessAgentType, SubAgentModelConfig } from '../../subagent/types'

const PROFILE: InProcessAgentType = {
  name: 'default',
  displayName: 'Default',
  description: '',
  tools: ['read', 'grep', 'agent'],
  systemPrompt: 'BASE {{shuvix:persona}}',
  instructionFiles: ['AGENTS.md', 'CLAUDE.md']
}
const MODEL_CFG: SubAgentModelConfig = { provider: 'p1', model: 'm1', capabilities: {} }
const SPAWN: SpawnContext = {
  agentId: 'sub-1',
  depth: 1,
  parentAgentId: 'root-s',
  rootSessionId: 'root-s',
  modelConfig: MODEL_CFG,
  canSpawn: true
}

function makeHost(): AgentHostAdapter & { resolveTools: ReturnType<typeof vi.fn> } {
  return {
    resolveTools: vi.fn().mockResolvedValue([]),
    promptVars: () => ({ persona: 'PERSONA' }),
    eventSink: { broadcast: vi.fn(), hasUserInputCapability: () => true }
  }
}

describe('createAgentFactory —— 切换期入口', () => {
  it('root → 拒绝（根 agent 由 durable 会话的锁创建，不经本工厂）；不是「未实现」，不解析工具', async () => {
    const host = makeHost()
    const err = await createAgentFactory(host)
      .createAgent({ kind: 'root', sessionId: 's1', profile: PROFILE, model: MODEL_CFG, cwd: '/w' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PhasePendingError)
    expect((err as Error).message).toMatch(/DurableSession\.createAgent/)
    expect(host.resolveTools).not.toHaveBeenCalled()
  })

  it('spawned → PhasePendingError（phase 2）', async () => {
    const err = await createAgentFactory(makeHost())
      .createAgent({
        kind: 'spawned',
        sessionId: 'sub-1',
        profile: PROFILE,
        model: MODEL_CFG,
        thinkingLevel: 'off',
        cwd: '',
        spawn: SPAWN
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PhasePendingError)
    expect((err as PhasePendingError).phase).toBe(2)
  })

  it('缺 spawn 上下文即抛错（入参校验先于「未实现」）', async () => {
    await expect(
      createAgentFactory(makeHost()).createAgent({
        kind: 'spawned',
        sessionId: 'sub-1',
        profile: PROFILE,
        model: MODEL_CFG,
        cwd: ''
      })
    ).rejects.toThrow('requires spawn context')
  })

  // 以下依赖运行时本身：旧运行时已删，派生 agent 的 durable 版在 phase 2、监控在 phase 3
  it.todo(
    'getModelConfig 惰性：thinkingLevel 读运行时当前档位；模型是创建时那份，运行期没有换模型的入口（派发工具读它） (pi-durable p2)'
  )
  it.todo(
    'ML-U-10 监控里的 displayName：档案写了显示名 → 原样；显示名为空串 → 回落档案名 (pi-durable p3)'
  )
})
