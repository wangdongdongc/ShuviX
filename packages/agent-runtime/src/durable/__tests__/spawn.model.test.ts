/**
 * SpawnCoordinator · 模型与思考档位（P2-03，C 段 17–23）：档案的 `shuvix-model` 经 `resolveProfileModel`
 * + `resolveLockModel`；被拒 / 抛错 / 解析不了都回落调用方的现取模型（seam 在才警告）；思考档位 =
 * 档案的 ?? 调用方的现取档位；调用方没有模型 → 拒绝、什么都不建。
 */
import type { Context } from '@earendil-works/chord'
import {
  AgentDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type TaskId,
  type ToolExecutionApi
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { spawnedAgentRecordOf } from '../agentRecord'
import { NO_CALLER_MODEL_TEXT } from '../spawn'
import type { InProcessAgentType } from '../../subagent/types'
import { testProfile } from './support/agentConfig'
import { answer } from './support/faux'
import { registerHostCleanup } from './support/host'
import { callAgent, conversationIds, hostD, PROFILES, type HostD } from './support/spawn'

registerHostCleanup()

const explore = (overrides: Partial<InProcessAgentType>): InProcessAgentType =>
  testProfile({ ...PROFILES.explore, ...overrides })

async function spawnOnce(d: HostD, name = 'explore'): Promise<ConversationId> {
  d.t.kit.queue(callAgent(name, 'find X'), answer('found'), answer('done'))
  expect(await d.session.submitUser('go')).toEqual({})
  expect(d.outcomes.at(-1)!.error).toBeUndefined()
  return d.outcomes.at(-1)!.conversationId!
}

const modelWarnings = (d: HostD): string[] =>
  d.t.warnings.filter((warning) => warning.includes('declares model'))

describe('SpawnCoordinator · model and thinking', () => {
  it('P2-03-17 no shuvix-model: the caller live model; the seam is never called', async () => {
    const d = await hostD()
    const C = await spawnOnce(d)
    expect((await spawnedAgentRecordOf(d.session.harness, C, BG))!.model).toEqual({
      provider: 'faux',
      modelId: 'faux-1'
    })
    expect(d.t.kit.requests[1]!.modelId).toBe('faux-1')
    expect(d.rpm.calls).toEqual([])
  })

  it('P2-03-18 shuvix-model resolves: faux-2 in the record, the request and the identity', async () => {
    const d = await hostD()
    const C = await spawnOnce(d, 'modeled')
    expect((await spawnedAgentRecordOf(d.session.harness, C, BG))!.model).toEqual({
      provider: 'faux',
      modelId: 'faux-2'
    })
    expect(d.t.kit.requests[1]!.modelId).toBe('faux-2')
    expect(d.session.agentIdentity(C)!.getModelConfig!()).toEqual({
      provider: 'faux',
      model: 'faux-2',
      capabilities: {}
    })
    expect(d.rpm.calls).toEqual(['spec:faux-2'])
  })

  it.each([
    ['refused (null)', 'spec:other'],
    ['model_unknown', 'spec:nope'],
    ['provider_disabled', 'spec:faux-2'],
    ['the seam throws', 'spec:faux-2']
  ])(
    'P2-03-19 a refusal falls back to the caller model with one warning: %s',
    async (row, spec) => {
      const d = await hostD({ dispatch: { profiles: { explore: explore({ model: spec }) } } })
      if (row === 'provider_disabled') d.t.port.rows.find((r) => r.id === 'faux')!.isEnabled = false
      if (row === 'the seam throws') d.rpm.fail = new Error('rpm broke')
      const C = await spawnOnce(d)
      expect((await spawnedAgentRecordOf(d.session.harness, C, BG))!.model).toEqual({
        provider: 'faux',
        modelId: 'faux-1'
      })
      expect(d.t.kit.requests[1]!.modelId).toBe('faux-1')
      const warnings = modelWarnings(d)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('explore')
      expect(warnings[0]).toContain(spec)
    }
  )

  it('P2-03-19 without a resolveProfileModel seam the fallback is silent', async () => {
    const d = await hostD({
      host: { resolveProfileModel: undefined },
      dispatch: { profiles: { explore: explore({ model: 'spec:faux-2' }) } }
    })
    const C = await spawnOnce(d)
    expect((await spawnedAgentRecordOf(d.session.harness, C, BG))!.model.modelId).toBe('faux-1')
    expect(modelWarnings(d)).toEqual([])
  })

  it('P2-03-20 thinking: the profile wins; else the caller live level (not the lock)', async () => {
    const d = await hostD({
      dispatch: {
        profiles: {
          thinker: PROFILES.thinker,
          off: explore({ name: 'off', thinkingLevel: 'off' }),
          explore: PROFILES.explore
        }
      }
    })
    const level = async (C: ConversationId): Promise<unknown> => [
      ((await d.session.harness.snapshot(AgentDoc, C, BG)) as { thinkingLevel?: string })
        .thinkingLevel,
      (await spawnedAgentRecordOf(d.session.harness, C, BG))!.thinkingLevel
    ]
    expect(await level(await spawnOnce(d, 'thinker'))).toEqual(['high', 'high'])
    expect(await level(await spawnOnce(d, 'off'))).toEqual(['off', 'off'])
    await d.session.setThinkingLevel('high')
    expect(d.session.lock!.thinkingLevel).toBe('low')
    expect(await level(await spawnOnce(d, 'explore'))).toEqual(['high', 'high'])
  })

  it('P2-03-21 model and thinking are independent rows', async () => {
    const d = await hostD({
      dispatch: {
        profiles: { explore: explore({ model: 'spec:nope', thinkingLevel: 'high' }) }
      }
    })
    const C = await spawnOnce(d)
    const record = (await spawnedAgentRecordOf(d.session.harness, C, BG))!
    expect(record.model.modelId).toBe('faux-1')
    expect(record.thinkingLevel).toBe('high')
    expect(modelWarnings(d)).toHaveLength(1)
  })

  it('P2-03-22 a caller without a model: refused, nothing created, nothing resolved', async () => {
    const d = await hostD()
    const side = await d.session.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      BG
    )
    const resolves = d.t.toolHost.resolveCalls.length
    // 一个没有模型的对话发不出请求：直接以一个桩 API 调协调器
    const api = {
      taskId: 999 as TaskId,
      conversationId: side.id,
      callId: 'stub',
      agent: async () => ({ thinkingLevel: 'off', extensions: [], tools: [], sections: [] }),
      snapshot: (doc: never, id: never, context: Context) =>
        d.session.harness.snapshot(doc, id, context),
      memo: async () => {
        throw new Error('memo must not be reached')
      },
      // 重跑发现（只读）走这里；之后的创建提交不该到达
      commit: (change: never, context: Context) => d.session.harness.commit(change, context)
    } as unknown as ToolExecutionApi
    const outcome = await d.session.agents.spawn(
      { owner: { tool: api }, profile: PROFILES.explore, prompt: 'x', description: 'd' },
      BG
    )
    expect(outcome).toEqual({ result: NO_CALLER_MODEL_TEXT, error: NO_CALLER_MODEL_TEXT })
    expect(await conversationIds(d.session)).toEqual([ROOT_CONVERSATION_ID, side.id])
    expect(d.t.toolHost.resolveCalls).toHaveLength(resolves)
  })

  it('P2-03-23 the grandchild inherits the child live model (faux-2)', async () => {
    const d = await hostD()
    d.t.kit.queue(
      callAgent('modeled', 'mid'),
      callAgent('explore', 'leaf', { id: 'call-g' }),
      answer('leaf done'),
      answer('mid done'),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    const G = d.outcomes[0]!.conversationId!
    expect((await spawnedAgentRecordOf(d.session.harness, G, BG))!.model.modelId).toBe('faux-2')
    expect(d.t.kit.requests[2]!.modelId).toBe('faux-2')
  })
})
