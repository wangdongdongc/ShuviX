/**
 * 锁 · 重配的预判（`DurableSession.previewAgentChange` → `AgentLock.preview`，2026-10-26）：照给的配置重配的话，
 * 下一次请求还能不能命中提供商的提示词缓存。不连服务器、不写；没锁 → `locked: false`。
 *
 * faux 的 api 是 `faux`、没有 compat → 任何工具改动都按 `none` 判。要看 native / additive，就只在调 preview 的
 * 那一刻把 `kit.models.getModel` 换成带 compat 的同一模型（请求本身照旧走 faux）。
 */
import type { Model } from '@earendil-works/pi-ai'
import type { Extension } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { SessionClosedError } from '../durableSession'
import type { DurableSession } from '../durableSession'
import type { ReconfigurePreview } from '../lock'
import type { AgentConfig } from '../seams'
import { scenarioConfig, scenarioToolHost } from './support/agentConfig'
import { answer } from './support/faux'
import { registerHostCleanup, type TestHost } from './support/host'
import { recordPublications } from './support/commits'
import { scenarioW } from './support/scenario'
import { stampUsage } from './support/usage'
import { withTimeout } from './support/wait'

registerHostCleanup()

const OVERLAY = ['mcp:ctx']
const NONE: ReconfigurePreview = { locked: false, cache: 'none', reasons: [], promptTokens: 0 }

const NATIVE_COMPAT = { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true }
const ADDITIVE_COMPAT = { supportsAdditionalTools: true }

/** 场景 W 锁住并答完一轮（请求 0）；配置对象可改 */
async function lockedW(overrides: Parameters<typeof scenarioW>[0] = {}): Promise<{
  t: TestHost
  config: AgentConfig
  session: DurableSession
}> {
  const config = overrides.config ?? scenarioConfig()
  const { t } = await scenarioW({ ...overrides, config })
  const session = await t.open()
  t.kit.queue(answer('first'))
  expect(await session.submitUser('u1')).toEqual({})
  return { t, config, session }
}

/** 想改成的样子（基于场景 W 的配置） */
function change(patch: Partial<AgentConfig>): AgentConfig {
  return { ...scenarioConfig(), ...patch }
}

function preview(session: DurableSession, config: AgentConfig): Promise<ReconfigurePreview> {
  return withTimeout(session.previewAgentChange(config), 5000, 'preview')
}

/** 只在预判那一刻把模型目录里的 faux 换成某种 api + compat */
async function previewAs(
  t: TestHost,
  session: DurableSession,
  config: AgentConfig,
  api: string,
  compat: Record<string, unknown>
): Promise<ReconfigurePreview> {
  const models = t.kit.models
  const original = models.getModel.bind(models)
  const spy = vi.spyOn(models, 'getModel').mockImplementation(((provider: string, id: string) => {
    const model = original(provider, id)
    return model === undefined ? undefined : ({ ...model, api, compat } as unknown as Model<never>)
  }) as typeof models.getModel)
  try {
    return await preview(session, config)
  } finally {
    spy.mockRestore()
  }
}

function agentExtension(t: TestHost): Extension | undefined {
  return t.registryOf('s1')!.snapshot().extension('shuvix.agent.1')
}

describe('lock · preview', () => {
  it('PV-1 no lock → locked false, cache none; the host is not asked', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    expect(await preview(session, change({ toolOverlay: [...OVERLAY, 'mcp:new'] }))).toEqual(NONE)
    expect(t.toolHost.reconfigureCalls).toEqual([])
  })

  it('PV-2 locked but no model reply yet → locked, cache none', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    await session.createAgent()
    expect(
      await preview(session, change({ model: { provider: 'faux', modelId: 'faux-2' } }))
    ).toEqual({ ...NONE, locked: true })
  })

  it('PV-3 nothing changed → kept; promptTokens = input + cacheRead + cacheWrite of the last request', async () => {
    const config = scenarioConfig()
    const { t } = await scenarioW({ config })
    const stamp = stampUsage(t.kit)
    stamp.queue({ input: 1000, cacheRead: 200, cacheWrite: 50, output: 7 })
    const session = await t.open()
    t.kit.queue(answer('first'))
    expect(await session.submitUser('u1')).toEqual({})
    expect(await preview(session, scenarioConfig())).toEqual({
      locked: true,
      cache: 'kept',
      reasons: [],
      promptTokens: 1250
    })
  })

  it('PV-4 another model → lost ["model"]', async () => {
    const { session } = await lockedW()
    expect(
      await preview(session, change({ model: { provider: 'faux', modelId: 'faux-2' } }))
    ).toMatchObject({ locked: true, cache: 'lost', reasons: ['model'] })
  })

  it('PV-5 a server not connected yet → lost ["tools"] on faux; the host is asked without connecting, the server stays untouched, it is reported pending; nothing written', async () => {
    const { t, session } = await lockedW()
    const spy = vi.spyOn(t.toolHost, 'reconfigureAgentTools')
    const extension = agentExtension(t)
    const before = session.lock
    const recorder = recordPublications(session.harness)
    const result = await preview(session, change({ toolOverlay: [...OVERLAY, 'mcp:new'] }))
    recorder.stop()
    expect(result).toMatchObject({ locked: true, cache: 'lost', reasons: ['tools'] })
    expect(t.toolHost.reconfigureCalls).toHaveLength(1)
    expect(t.toolHost.reconfigureCalls[0]).toMatchObject({
      connect: false,
      request: { servers: ['new'] }
    })
    expect(t.toolHost.mcp('new').connects).toBe(0)
    expect(await spy.mock.results[0]!.value).toMatchObject({ mcp: [], pending: ['new'] })
    expect(recorder.publications).toEqual([])
    expect(agentExtension(t)).toBe(extension)
    expect(session.lock).toEqual(before)
  })

  it('PV-6 a model that takes mid-conversation tool changes: native keeps an add + remove; additive keeps a pure add and loses a removal', async () => {
    const { t, session } = await lockedW()
    const swap = change({ toolOverlay: ['mcp:ssh'] })
    expect(await previewAs(t, session, swap, 'anthropic-messages', NATIVE_COMPAT)).toMatchObject({
      cache: 'kept',
      reasons: []
    })
    const add = change({ toolOverlay: [...OVERLAY, 'mcp:new'] })
    expect(await previewAs(t, session, add, 'openai-responses', ADDITIVE_COMPAT)).toMatchObject({
      cache: 'kept',
      reasons: []
    })
    const remove = change({ toolOverlay: [] })
    expect(await previewAs(t, session, remove, 'openai-responses', ADDITIVE_COMPAT)).toMatchObject({
      cache: 'lost',
      reasons: ['tools']
    })
  })

  it('PV-7 skills are not part of a reconfigure: a changed shelf on the host and a legacy skill entry in the selection → kept even on faux, neither ["tools"] nor ["prompt"]; the persona vars are not rendered again', async () => {
    let calls = 0
    const promptVars = (): Record<string, string> => {
      calls++
      return { marker: 'M1' }
    }
    const { t, session } = await lockedW({ promptVars })
    expect(calls).toBe(1)
    t.toolHost.options.skills = ['pdf']
    const legacy = change({ toolOverlay: [...OVERLAY, '-skill:builtin:drawing', 'skill:other'] })
    expect(await preview(session, legacy)).toMatchObject({
      locked: true,
      cache: 'kept',
      reasons: []
    })
    expect(calls).toBe(1)
    expect(t.kit.requests[0]!.systemPrompt).toBe('You are M1')
  })

  it('PV-8 a host without reconfigureAgentTools → locked, cache none', async () => {
    const { session } = await lockedW({ toolHost: scenarioToolHost({ reconfigure: false }) })
    expect(
      await preview(session, change({ model: { provider: 'faux', modelId: 'faux-2' } }))
    ).toEqual({ ...NONE, locked: true })
  })

  it('PV-9 a model the agent could not use → locked, cache none (the real change reports the refusal)', async () => {
    const { t, session } = await lockedW()
    expect(
      await preview(session, change({ model: { provider: 'faux', modelId: 'faux-9' } }))
    ).toEqual({ ...NONE, locked: true })
    expect(t.toolHost.reconfigureCalls).toEqual([])
  })

  it('PV-10 a server removed but not sent yet, re-added in the preview (still connected) → kept even on faux', async () => {
    const { t, config, session } = await lockedW()
    config.toolOverlay = []
    expect((await session.reconfigureAgent()).applied).toBe(true)
    const result = await preview(session, change({ toolOverlay: [...OVERLAY] }))
    expect(result).toMatchObject({ locked: true, cache: 'kept', reasons: [] })
    expect(t.toolHost.reconfigureCalls.at(-1)).toMatchObject({
      connect: false,
      request: { servers: ['ctx'] }
    })
  })

  it('PV-11 a server whose removal already reached the model, re-added on an additive model → lost; on a native one → kept', async () => {
    const { t, config, session } = await lockedW()
    config.toolOverlay = []
    expect((await session.reconfigureAgent()).applied).toBe(true)
    t.kit.queue(answer('second'))
    expect(await session.submitUser('u2')).toEqual({})
    const readd = change({ toolOverlay: [...OVERLAY] })
    expect(await previewAs(t, session, readd, 'openai-responses', ADDITIVE_COMPAT)).toMatchObject({
      cache: 'lost',
      reasons: ['tools']
    })
    expect(await previewAs(t, session, readd, 'anthropic-messages', NATIVE_COMPAT)).toMatchObject({
      cache: 'kept',
      reasons: []
    })
  })

  it('PV-12 a closed session → SessionClosedError', async () => {
    const { t, session } = await lockedW()
    await withTimeout(t.host.close('s1'), 5000, 'close')
    await expect(session.previewAgentChange(scenarioConfig())).rejects.toBeInstanceOf(
      SessionClosedError
    )
  })

  it('PV-13 a server that failed to connect earlier is not counted as pending by an unrelated preview (F5)', async () => {
    const { t, config, session } = await lockedW()
    const fresh = t.toolHost.mcp('new')
    fresh.failConnect()
    config.toolOverlay = [...OVERLAY, 'mcp:new']
    expect((await session.reconfigureAgent()).applied).toBe(true)
    expect(session.lock!.mcp).not.toHaveProperty('new')
    expect(await preview(session, change({ toolOverlay: [...OVERLAY, 'mcp:new'] }))).toEqual({
      locked: true,
      cache: 'kept',
      reasons: [],
      promptTokens: expect.any(Number)
    })
    expect(t.toolHost.reconfigureCalls.at(-1)).toMatchObject({
      connect: false,
      request: { servers: [] }
    })
    expect(fresh.connects).toBe(1)
  })
})
