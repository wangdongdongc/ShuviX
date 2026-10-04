/**
 * 锁 · 锁住期间不变（Mapping #6；K9、K14、K21）：MCP 掉线 / 换工具表、会话配置（勾选 / 模型 /
 * provider 启停）、人设变量、注册表里多出来的东西 —— 都不改变提供给模型的工具与人设。唯一活着的是
 * 思考档位。
 *
 * 「不变」= 第 1 个请求的工具与第 0 个逐项相等，且之后没有任何带工具增减的 pi.system 条目。
 */
import { defineExtension } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { AgentStateDoc } from '../docs'
import { backgroundContext as BG } from '../context'
import { builtinExtension } from '../lock'
import { DECL_DOCS, DECL_RESOLVE, scenarioConfig } from './support/agentConfig'
import { answer, callTool, requestTools } from './support/faux'
import { registerHostCleanup } from './support/host'
import { scenarioBuiltins } from './support/toolHost'
import { lockW, scenarioW, type Scenario } from './support/scenario'
import { holdTool } from './support/tools'
import { requestTexts, systemDeltas, toolDeltaCount } from './support/transcript'
import type { DurableSession } from '../durableSession'

registerHostCleanup()

/** 场景 W 锁住并答完一轮（请求 0） */
async function lockedTurn(scenario: Scenario): Promise<DurableSession> {
  const session = await scenario.t.open()
  scenario.t.kit.queue(answer('first'))
  expect(await session.submitUser('u1')).toEqual({})
  return session
}

async function expectUnchanged(scenario: Scenario, session: DurableSession, at = 1): Promise<void> {
  expect(requestTools(scenario.t.kit, at)).toEqual(requestTools(scenario.t.kit, 0))
  expect(await toolDeltaCount(await session.currentConversation())).toBe(1)
}

describe('lock · stable while locked', () => {
  it('LS-01 an MCP server that drops keeps its tools; the next call reconnects on the spot and its result reaches the model', async () => {
    const scenario = await scenarioW()
    const { t } = scenario
    const session = await lockedTurn(scenario)
    const ctx = t.toolHost.mcp('ctx')
    ctx.disconnect()
    t.kit.queue(callTool('mcp__ctx__resolve', { q: 'react' }), answer('done'))
    expect(await session.submitUser('u2')).toEqual({})
    await expectUnchanged(scenario, session)
    expect(ctx.connects).toBe(2)
    expect(requestTexts(t.kit, 2)).toContain('toolResult:ctx.resolve:{"q":"react"}')
    expect(requestTools(t.kit, 2).map((tool) => tool.name)).toContain('mcp__ctx__resolve')
  })

  it('LS-02 list_changed on the server applies only to the next agent: the locked tools stay, a vanished tool answers isError and the run goes on', async () => {
    const scenario = await scenarioW()
    const { t } = scenario
    const session = await lockedTurn(scenario)
    t.toolHost.mcp('ctx').setTools([DECL_RESOLVE])
    t.kit.queue(callTool('mcp__ctx__docs', { q: 'x' }), answer('carried on'))
    expect(await session.submitUser('u2')).toEqual({})
    await expectUnchanged(scenario, session)
    expect(session.lock!.mcp.ctx).toEqual([DECL_RESOLVE, DECL_DOCS])
    expect(t.toolHost.resolveCalls).toHaveLength(1)
    expect(requestTexts(t.kit, 2).find((line) => line.startsWith('toolResult:'))).toContain(
      'unknown tool docs'
    )
    expect(t.kit.requests).toHaveLength(3)
  })

  it('LS-03 editing the selection while locked changes nothing; a newly ticked server is not even connected', async () => {
    const config = scenarioConfig()
    const scenario = await scenarioW({ config })
    const { t } = scenario
    const session = await lockedTurn(scenario)
    config.toolOverlay = ['mcp:new', 'skill:pdf']
    t.kit.queue(answer('second'))
    expect(await session.submitUser('u2')).toEqual({})
    await expectUnchanged(scenario, session)
    expect(t.configCalls).toHaveLength(1)
    expect(t.toolHost.resolveCalls).toHaveLength(1)
    expect(t.toolHost.mcp('new').connects).toBe(0)
  })

  it('LS-04 editing the model while locked: requests stay on the locked model, and so does the compaction window (K14)', async () => {
    const config = scenarioConfig()
    const scenario = await scenarioW({ config })
    const { t } = scenario
    const session = await lockedTurn(scenario)
    config.model = { provider: 'faux', modelId: 'faux-2' }
    t.kit.queue(answer('second'))
    expect(await session.submitUser('u2')).toEqual({})
    expect(t.kit.requests[1]!.modelId).toBe('faux-1')
    expect(session.effectiveSettings.compaction?.reserveTokens).toBe(10000)
    expect(session.lock!.model).toEqual({ provider: 'faux', modelId: 'faux-1' })
  })

  it('LS-05 a provider disabled after the lock does not stop the locked session (Q9)', async () => {
    const scenario = await scenarioW()
    const { t } = scenario
    const session = await lockedTurn(scenario)
    t.port.rows[0]!.isEnabled = false
    t.kit.queue(answer('still here'))
    expect(await session.submitUser('u2')).toEqual({})
    expect(t.toolHost.resolveCalls).toHaveLength(1)
    expect(t.kit.requests[1]!.modelId).toBe('faux-1')
  })

  it('LS-06 the thinking level stays live: the next request reasons at the new level; the lock keeps the creation-time value (K9)', async () => {
    const scenario = await scenarioW()
    const { t } = scenario
    const session = await lockedTurn(scenario)
    expect(t.kit.requests[0]!.options?.reasoning).toBe('low')
    await session.setThinkingLevel('high')
    t.kit.queue(answer('deep'))
    expect(await session.submitUser('u2')).toEqual({})
    expect(t.kit.requests[1]!.options?.reasoning).toBe('high')
    expect(session.lock).toEqual(lockW())
    expect(t.mirror).toEqual([
      ['s1', false],
      ['s1', true]
    ])
    expect(t.broadcastsOf('agent_created')).toHaveLength(1)
    await expectUnchanged(scenario, session)
  })

  it('LS-07 the persona is frozen at creation: a later marker or profile change never reaches the prompt (K21)', async () => {
    const config = scenarioConfig()
    const scenario = await scenarioW({ config })
    const { t, vars } = scenario
    const session = await lockedTurn(scenario)
    expect(t.kit.requests[0]!.systemPrompt).toBe('You are M1')
    vars.state.marker = 'M2'
    config.profile = { ...config.profile, systemPrompt: 'Something else entirely' }
    t.kit.queue(answer('second'))
    expect(await session.submitUser('u2')).toEqual({})
    expect(t.kit.requests[1]!.systemPrompt).toBe('You are M1')
    expect(
      (await session.harness.snapshot(AgentStateDoc, session.lock!.conversationId, BG))?.persona
    ).toBe('You are M1')
    const deltas = await systemDeltas(await session.currentConversation())
    expect(deltas.slice(1).some((delta) => delta.sections.includes('persona'))).toBe(false)
    expect(vars.state.calls).toBe(1)
  })

  it('LS-08 other things in the registry are not offered: an unrelated extension, or a builtin added by reinstalling shuvix.builtin', async () => {
    const scenario = await scenarioW()
    const { t } = scenario
    const session = await lockedTurn(scenario)
    const registry = t.registryOf('s1')!
    registry.install(
      defineExtension({ name: 'unrelated', tools: [holdTool('extra', Promise.resolve())] })
    )
    registry.install(
      builtinExtension([
        ...scenarioBuiltins('darwin', true),
        holdTool('newtool', Promise.resolve())
      ])
    )
    t.kit.queue(answer('second'))
    expect(await session.submitUser('u2')).toEqual({})
    const offered = requestTools(t.kit, 1).map((tool) => tool.name)
    expect(offered).not.toContain('extra')
    expect(offered).not.toContain('newtool')
    await expectUnchanged(scenario, session)
  })
})
