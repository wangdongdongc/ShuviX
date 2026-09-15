/**
 * Hook runner（createHookRunner）—— fire → 匹配 → 去重 → prompt + 事件围栏 → runTask。
 *
 * 契约见 .claude/skills/shuvix-hooks（Runner 一节）。分组：
 *   HR-1        埋点目录；
 *   HR-2…11     匹配与派发：一次派发的入参形状、payload 快照、when 的把关与 fail-safe、
 *               注册表现取、未知埋点与无会话上下文；
 *   HR-12…16    宿主规则：去重（同步段占坑）、unknown-agent / no-model 跳过、模型透传；
 *   HR-17…20    超时、中止与监控面；
 *   HR-21…27    兜底与边界：观测回调抛错、无 logger、依赖抛错、身份字段、结果不读、outcome.error 判失败。
 *
 * 夹具见 ./harness.ts（观测面 = onRun 事件 + logger 行）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HOOK_TIMEOUT_MS, type HookRegistryEntry } from '../hookRunner'
import { TRIGGER_POINTS, getTriggerPoint } from '../triggerPoints'
import { renderHookPrompt } from '../hookPrompt'
import type { SubAgentModelConfig } from '../../subagent/types'
import {
  MODEL,
  PROFILE,
  deferred,
  entryOf,
  fileOf,
  gatedRunTask,
  hangUntilAbort,
  makeRunner,
  promptPayload,
  rejectOnAbort,
  settle
} from './harness'

const TRIGGER = 'session.prompt-accepted'

afterEach(() => {
  vi.useRealTimers()
})

describe('埋点目录', () => {
  it('HR-1 恰两条会话域埋点，id 与键一致；未知 id 查不到', () => {
    expect(Object.keys(TRIGGER_POINTS)).toEqual([
      'session.prompt-accepted',
      'session.turn-completed'
    ])
    for (const [key, def] of Object.entries(TRIGGER_POINTS)) {
      expect(def.id).toBe(key)
      expect(def.scope).toBe('session')
      expect(getTriggerPoint(key)).toBe(def)
    }
    expect(getTriggerPoint('nope')).toBeUndefined()
  })
})

describe('匹配与派发', () => {
  it('HR-2 命中 → 一个 run：先 start 后 end；runTask 恰收到派发工具那一组键', async () => {
    const h = makeRunner({ entries: [entryOf(fileOf())] })
    const payload = promptPayload()
    h.runner.fire(TRIGGER, payload)
    await h.waitEnd()

    expect(h.events.map((e) => e.type)).toEqual(['start', 'end'])
    const [start] = h.starts()
    expect(start.run).toEqual({
      runId: expect.stringMatching(/^hkr-/),
      hook: 'hk',
      source: 'builtin',
      trigger: TRIGGER,
      sessionId: 's1',
      agent: 'worker',
      startedAt: expect.any(Number)
    })
    const [end] = h.ends()
    expect(end.run).toEqual(start.run)
    expect(end.ok).toBe(true)
    expect(end.ms).toBeGreaterThanOrEqual(0)
    expect('error' in end).toBe(false)

    expect(h.runTask).toHaveBeenCalledTimes(1)
    const params = h.call()
    // 没有 resultContract / contextMessages / systemContext / parentToolCallId：hook 不读结果、不带旁路上下文
    expect(Object.keys(params).sort()).toEqual([
      'agentType',
      'description',
      'modelConfig',
      'parentAbortSignal',
      'parentSessionId',
      'prompt'
    ])
    expect(params.parentSessionId).toBe('s1')
    expect(params.agentType).toBe(PROFILE)
    expect(params.description).toBe('Hook K')
    expect(params.modelConfig).toBe(MODEL)
    expect(params.parentAbortSignal).toBeInstanceOf(AbortSignal)
    expect(params.parentAbortSignal?.aborted).toBe(false)
    expect(params.prompt).toBe(renderHookPrompt('Body.', TRIGGER, { ...payload }))
  })

  it('HR-3 prompt = 正文 + 围栏；payload 在 fire 时快照（之后的改动不进 prompt）；YAML 里没有 trigger 行', async () => {
    const model = deferred<SubAgentModelConfig | null>()
    const h = makeRunner({ entries: [entryOf(fileOf())], resolveRunModel: () => model.promise })
    const payload = promptPayload({ title: 'First', promptText: 'original' })
    h.runner.fire(TRIGGER, payload)
    // fire 已返回、模型尚未解析：emit 侧改动自己手里的对象
    payload.title = 'Changed later'
    payload.promptText = 'changed later'
    model.resolve(MODEL)
    await h.waitEnd()

    const { prompt } = h.call()
    expect(prompt).toBe(
      renderHookPrompt('Body.', TRIGGER, {
        ...promptPayload({ title: 'First', promptText: 'original' })
      })
    )
    expect(prompt.startsWith('Body.\n\n<hook_event trigger="session.prompt-accepted">\n')).toBe(
      true
    )
    expect(prompt).not.toContain('changed later')
    expect(prompt).not.toContain('Changed later')
    expect(prompt).not.toMatch(/^trigger:/m)
  })

  it('HR-4 该埋点上没有绑定 → 什么都不发生（不解析 agent、不解析模型、不派发）', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf({ bindings: [{ trigger: 'session.turn-completed' }] }))]
    })
    h.runner.fire(TRIGGER, promptPayload())
    await settle()
    expect(h.events).toEqual([])
    expect(h.logs).toEqual([])
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.resolveAgentProfile).not.toHaveBeenCalled()
    expect(h.resolveRunModel).not.toHaveBeenCalled()
  })

  it('HR-5 when 把关，且看得到 event.trigger 与 env', async () => {
    const gated = (name: string, expression: string): HookRegistryEntry =>
      entryOf(
        fileOf({ name, displayName: name, bindings: [{ trigger: TRIGGER, when: expression }] })
      )
    const h = makeRunner({
      entries: [
        gated(
          'sees-context',
          "event.trigger == 'session.prompt-accepted' && env.host == 'desktop' && env.platform == 'darwin'"
        ),
        gated('other-trigger', "event.trigger == 'session.turn-completed'"),
        gated('other-host', "env.host == 'extension'"),
        gated('gated-off', 'event.isDefaultTitle')
      ]
    })
    h.runner.fire(TRIGGER, promptPayload({ isDefaultTitle: false }))
    await h.waitEnd()
    await settle()
    expect(h.starts().map((e) => e.run.hook)).toEqual(['sees-context'])
    expect(h.runTask).toHaveBeenCalledTimes(1)
    expect(h.warns()).toEqual([])
  })

  it('HR-6 求值错误（缺失属性）= 不命中 + 一条 warn；别的 hook 照跑', async () => {
    const h = makeRunner({
      entries: [
        entryOf(fileOf({ bindings: [{ trigger: TRIGGER, when: 'event.nope' }] })),
        entryOf(fileOf({ name: 'ok', displayName: 'OK' }))
      ]
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    await settle()
    expect(h.starts().map((e) => e.run.hook)).toEqual(['ok'])
    expect(h.runTask.mock.calls.map(([p]) => p.description)).toEqual(['OK'])
    expect(h.warns()).toHaveLength(1)
    expect(h.warns()[0]).toContain('hook "hk": when evaluation failed')
    expect(h.warns()[0]).toContain('No such key')
  })

  it('HR-6 非布尔结果 = 不命中 + warn（must evaluate to a boolean）', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf({ bindings: [{ trigger: TRIGGER, when: 'event.title' }] }))]
    })
    h.runner.fire(TRIGGER, promptPayload())
    await settle()
    expect(h.events).toEqual([])
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.warns()).toHaveLength(1)
    expect(h.warns()[0]).toContain('hook "hk": when evaluation failed')
    expect(h.warns()[0]).toContain('must evaluate to a boolean')
  })

  it('HR-7 同一埋点两条绑定都为真 → 第一条命中即起一个 run，不重复起', async () => {
    const h = makeRunner({
      entries: [
        entryOf(fileOf({ bindings: [{ trigger: TRIGGER }, { trigger: TRIGGER, when: 'true' }] }))
      ]
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    await settle()
    expect(h.runTask).toHaveBeenCalledTimes(1)
    expect(h.skips()).toEqual([])
  })

  it('HR-7 第一条求值出错、第二条为真 → 一个 run + 一条 warn', async () => {
    const h = makeRunner({
      entries: [
        entryOf(
          fileOf({
            bindings: [
              { trigger: TRIGGER, when: 'event.nope' },
              { trigger: TRIGGER, when: 'true' }
            ]
          })
        )
      ]
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    await settle()
    expect(h.runTask).toHaveBeenCalledTimes(1)
    expect(h.skips()).toEqual([])
    expect(h.warns()).toHaveLength(1)
    expect(h.warns()[0]).toContain('when evaluation failed')
  })

  it('HR-8 两份 hook 同时命中 → 两个 run、runId 不同、互不 busy', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf()), entryOf(fileOf({ name: 'hk2', displayName: 'Hook 2' }))]
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd(2)
    expect(h.skips()).toEqual([])
    expect(h.runTask).toHaveBeenCalledTimes(2)
    expect(
      h
        .starts()
        .map((e) => e.run.hook)
        .sort()
    ).toEqual(['hk', 'hk2'])
    expect(new Set(h.starts().map((e) => e.run.runId)).size).toBe(2)
  })

  it('HR-9 listHooks 抛错 → fire 照常返回，一条 warn，零 run', async () => {
    const h = makeRunner({
      listHooks: () => {
        throw new Error('disk gone')
      }
    })
    expect(() => h.runner.fire(TRIGGER, promptPayload())).not.toThrow()
    await settle()
    expect(h.warns()).toEqual(['hook registry listing failed: disk gone'])
    expect(h.events).toEqual([])
    expect(h.runTask).not.toHaveBeenCalled()
  })

  it('HR-9 注册表每次 fire 现取：两次 fire 之间改动条目即生效', async () => {
    const entries: HookRegistryEntry[] = []
    const h = makeRunner({ listHooks: () => entries })
    h.runner.fire(TRIGGER, promptPayload())
    await settle()
    expect(h.runTask).not.toHaveBeenCalled()

    entries.push(entryOf(fileOf()))
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.runTask).toHaveBeenCalledTimes(1)
    expect(h.listHooks).toHaveBeenCalledTimes(2)
  })

  it('HR-10 未知埋点 id（绕过类型）→ 静默：不取注册表、不记日志、不派发', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf({ bindings: [{ trigger: 'file.changed' }] }))]
    })
    h.runner.fire('file.changed' as never, { sessionId: 's1' } as never)
    await settle()
    expect(h.listHooks).not.toHaveBeenCalled()
    expect(h.logs).toEqual([])
    expect(h.events).toEqual([])
    expect(h.runTask).not.toHaveBeenCalled()
  })

  const { sessionId: _dropped, ...withoutSession } = promptPayload()
  it.each([
    { label: "''", payload: { ...promptPayload(), sessionId: '' } },
    { label: 'missing', payload: withoutSession },
    { label: '42', payload: { ...promptPayload(), sessionId: 42 } }
  ])('HR-11 没有会话上下文（sessionId: $label）→ warn、不取注册表、不派发', async ({ payload }) => {
    const h = makeRunner({ entries: [entryOf(fileOf())] })
    h.runner.fire(TRIGGER, payload as never)
    await settle()
    expect(h.warns()).toHaveLength(1)
    expect(h.warns()[0]).toContain('no session context — hooks v1 run only under a session')
    expect(h.listHooks).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
    expect(h.runTask).not.toHaveBeenCalled()
  })
})

describe('宿主规则：去重、跳过、模型', () => {
  it('HR-12 同一 hook × 同一会话在跑 → 第二次 fire 同步 skip busy；放行之后再 fire 重新起', async () => {
    const gate = gatedRunTask()
    const h = makeRunner({ entries: [entryOf(fileOf())], runTask: gate.runTask })
    h.runner.fire(TRIGGER, promptPayload())
    await vi.waitFor(() => {
      expect(gate.gates).toHaveLength(1)
    })

    h.runner.fire(TRIGGER, promptPayload())
    // 同步段判定：不需要等
    expect(h.skips()).toEqual([
      {
        type: 'skip',
        hook: 'hk',
        trigger: TRIGGER,
        sessionId: 's1',
        reason: 'busy',
        detail: 'previous run still going'
      }
    ])
    expect(h.infos()).toContain('hook "hk" skipped for session s1: busy (previous run still going)')
    expect(h.starts()).toHaveLength(1)

    gate.gates[0].release()
    await h.waitEnd(1)
    h.runner.fire(TRIGGER, promptPayload())
    await vi.waitFor(() => {
      expect(gate.gates).toHaveLength(2)
    })
    expect(h.starts()).toHaveLength(2)
    expect(h.starts()[1].run.runId).not.toBe(h.starts()[0].run.runId)
    expect(h.skips()).toHaveLength(1)
    gate.gates[1].release()
    await h.waitEnd(2)
  })

  it('HR-12 去重按会话分道：s1 在跑时同一 hook 在 s2 照跑', async () => {
    const gate = gatedRunTask()
    const h = makeRunner({ entries: [entryOf(fileOf())], runTask: gate.runTask })
    h.runner.fire(TRIGGER, promptPayload({ sessionId: 's1' }))
    h.runner.fire(TRIGGER, promptPayload({ sessionId: 's2' }))
    await vi.waitFor(() => {
      expect(gate.gates).toHaveLength(2)
    })
    expect(h.skips()).toEqual([])
    expect(gate.gates.map((g) => g.params.parentSessionId)).toEqual(['s1', 's2'])
    for (const g of gate.gates) g.release()
    await h.waitEnd(2)
  })

  it('HR-13 占坑发生在同步段：模型还没解析（没有 start）时第二次 fire 已判 busy；runningCount / listRuns 立即可见', async () => {
    const model = deferred<SubAgentModelConfig | null>()
    const h = makeRunner({ entries: [entryOf(fileOf())], resolveRunModel: () => model.promise })
    h.runner.fire(TRIGGER, promptPayload())
    expect(h.runner.runningCount()).toBe(1)
    expect(h.runner.listRuns()).toEqual([
      expect.objectContaining({ hook: 'hk', sessionId: 's1', trigger: TRIGGER })
    ])
    expect(h.starts()).toEqual([])

    h.runner.fire(TRIGGER, promptPayload())
    expect(h.skips().map((s) => s.reason)).toEqual(['busy'])
    expect(h.starts()).toEqual([])

    model.resolve(MODEL)
    await h.waitEnd()
    expect(h.events.map((e) => e.type)).toEqual(['skip', 'start', 'end'])
    expect(h.runTask).toHaveBeenCalledTimes(1)
  })

  it('HR-14 未知 agent → skip unknown-agent：不 start、不解析模型、不派发、不占坑', async () => {
    const h = makeRunner({ entries: [entryOf(fileOf({ agent: 'ghost' }))] })
    h.runner.fire(TRIGGER, promptPayload())
    await settle()
    expect(h.events).toEqual([
      {
        type: 'skip',
        hook: 'hk',
        trigger: TRIGGER,
        sessionId: 's1',
        reason: 'unknown-agent',
        detail: 'no agent definition named "ghost"'
      }
    ])
    expect(h.resolveAgentProfile).toHaveBeenCalledWith('ghost')
    expect(h.resolveRunModel).not.toHaveBeenCalled()
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.runner.runningCount()).toBe(0)
    expect(h.infos()).toEqual([
      expect.stringMatching(/: unknown-agent \(no agent definition named "ghost"\)$/)
    ])
  })

  it('HR-15 没有可用模型 → skip no-model：不 start、不派发，坑位释放', async () => {
    const h = makeRunner({ entries: [entryOf(fileOf())], resolveRunModel: async () => null })
    h.runner.fire(TRIGGER, promptPayload())
    await vi.waitFor(() => {
      expect(h.skips()).toHaveLength(1)
    })
    expect(h.events).toEqual([
      {
        type: 'skip',
        hook: 'hk',
        trigger: TRIGGER,
        sessionId: 's1',
        reason: 'no-model',
        detail: 'no model available for this session'
      }
    ])
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.runner.runningCount()).toBe(0)

    // 坑位确实放了：模型恢复后下一次 fire 照常起 run（而不是 busy）
    h.resolveRunModel.mockImplementation(async () => MODEL)
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.skips()).toHaveLength(1)
  })

  it('HR-16 模型以 {sessionId} 解析，解析结果（含 thinkingLevel）原样交给 runTask', async () => {
    const model: SubAgentModelConfig = {
      provider: 'anthropic',
      model: 'm-2',
      capabilities: {},
      thinkingLevel: 'high'
    }
    const h = makeRunner({ entries: [entryOf(fileOf())], resolveRunModel: async () => model })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.resolveRunModel).toHaveBeenCalledTimes(1)
    expect(h.resolveRunModel).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(h.call().modelConfig).toEqual({
      provider: 'anthropic',
      model: 'm-2',
      capabilities: {},
      thinkingLevel: 'high'
    })
  })
})

describe('超时、中止与监控面', () => {
  it('HR-17 到点中止派发：end ok:false「timed out after 20ms」、signal 落下、warn、坑位释放', async () => {
    const h = makeRunner({ entries: [entryOf(fileOf())], timeoutMs: 20, runTask: hangUntilAbort() })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.ends()).toEqual([
      expect.objectContaining({ type: 'end', ok: false, error: 'timed out after 20ms' })
    ])
    expect(h.call().parentAbortSignal?.aborted).toBe(true)
    expect(h.warns()).toEqual([expect.stringContaining('timed out')])
    expect(h.runner.runningCount()).toBe(0)

    // 坑位确实放了：下一次 fire 不是 busy
    h.runner.fire(TRIGGER, promptPayload())
    expect(h.skips()).toEqual([])
    await h.waitEnd(2)
  })

  it('HR-17 manager 收到 abort 时 reject → end 带 reject 的原话', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      timeoutMs: 20,
      runTask: rejectOnAbort('dispatch aborted by parent')
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.ends()).toEqual([
      expect.objectContaining({ ok: false, error: 'dispatch aborted by parent' })
    ])
    expect(h.runner.runningCount()).toBe(0)
  })

  it('HR-17 缺省 5 分钟：差 1ms 不中止、到点中止，文案「timed out after 300s」', async () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(300_000)
    vi.useFakeTimers()
    const h = makeRunner({ entries: [entryOf(fileOf())], runTask: hangUntilAbort() })
    h.runner.fire(TRIGGER, promptPayload())
    // 让模型解析落定 → start → 计时器挂上 → runTask 被调
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runTask).toHaveBeenCalledTimes(1)
    const signal = h.call().parentAbortSignal!

    await vi.advanceTimersByTimeAsync(DEFAULT_HOOK_TIMEOUT_MS - 1)
    expect(signal.aborted).toBe(false)
    expect(h.ends()).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ends()).toEqual([
      expect.objectContaining({ ok: false, error: 'timed out after 300s' })
    ])
  })

  it('HR-17 秒级文案带小数：timeoutMs 1500 → 「timed out after 1.5s」', async () => {
    vi.useFakeTimers()
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      timeoutMs: 1500,
      runTask: hangUntilAbort()
    })
    h.runner.fire(TRIGGER, promptPayload())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.starts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ends()).toEqual([
      expect.objectContaining({ ok: false, error: 'timed out after 1.5s' })
    ])
  })

  it('HR-18 正常收尾会清掉计时器：timeoutMs 过去之后 signal 仍未落下', async () => {
    const h = makeRunner({ entries: [entryOf(fileOf())], timeoutMs: 20 })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.call().parentAbortSignal?.aborted).toBe(false)
    expect(h.events.map((e) => e.type)).toEqual(['start', 'end'])
    expect(h.ends()[0].ok).toBe(true)
  })

  it('HR-18 计时从模型解析之后才开始：慢模型（> timeoutMs）+ 快派发 → ok:true', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      timeoutMs: 20,
      resolveRunModel: () => new Promise((resolve) => setTimeout(() => resolve(MODEL), 60))
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.ends()).toEqual([expect.objectContaining({ ok: true })])
    expect(h.call().parentAbortSignal?.aborted).toBe(false)
  })

  it('HR-19 abortSession 只中止该会话名下的 run 并返回中止数；被中止的 end 为 aborted', async () => {
    const h = makeRunner({
      entries: [
        entryOf(fileOf({ name: 'hkA', displayName: 'A' })),
        entryOf(
          fileOf({
            name: 'hkB',
            displayName: 'B',
            bindings: [{ trigger: TRIGGER, when: "event.sessionId == 's1'" }]
          })
        )
      ],
      runTask: hangUntilAbort()
    })
    h.runner.fire(TRIGGER, promptPayload({ sessionId: 's1' }))
    h.runner.fire(TRIGGER, promptPayload({ sessionId: 's2' }))
    await vi.waitFor(() => {
      expect(h.runTask).toHaveBeenCalledTimes(3)
    })
    const signalOf = (description: string, sessionId: string): AbortSignal | undefined =>
      h.runTask.mock.calls
        .map(([p]) => p)
        .find((p) => p.description === description && p.parentSessionId === sessionId)
        ?.parentAbortSignal

    expect(h.runner.abortSession('s1')).toBe(2)
    expect(signalOf('A', 's1')?.aborted).toBe(true)
    expect(signalOf('B', 's1')?.aborted).toBe(true)
    expect(signalOf('A', 's2')?.aborted).toBe(false)
    await h.waitEnd(2)
    expect(
      h
        .ends()
        .map((e) => [e.run.hook, e.run.sessionId, e.ok, e.error])
        .sort()
    ).toEqual([
      ['hkA', 's1', false, 'aborted'],
      ['hkB', 's1', false, 'aborted']
    ])
    expect(h.runner.abortSession('none')).toBe(0)
    expect(h.runner.runningCount()).toBe(1)

    expect(h.runner.abortSession('s2')).toBe(1)
    await h.waitEnd(3)
    expect(h.runner.abortSession('s1')).toBe(0)
    expect(h.runner.abortSession('s2')).toBe(0)
    expect(h.runner.runningCount()).toBe(0)
  })

  it('HR-20 listRuns / runningCount 生命周期：同步可见、返回副本、busy 不增计数、收尾归零', async () => {
    const gate = gatedRunTask()
    const h = makeRunner({ entries: [entryOf(fileOf())], runTask: gate.runTask })
    expect(h.runner.runningCount()).toBe(0)
    expect(h.runner.listRuns()).toEqual([])

    h.runner.fire(TRIGGER, promptPayload())
    expect(h.runner.runningCount()).toBe(1)
    const runs = h.runner.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual({
      runId: expect.stringMatching(/^hkr-/),
      hook: 'hk',
      source: 'builtin',
      trigger: TRIGGER,
      sessionId: 's1',
      agent: 'worker',
      startedAt: expect.any(Number)
    })
    runs[0].hook = 'mutated'
    expect(h.runner.listRuns()[0].hook).toBe('hk')

    await vi.waitFor(() => {
      expect(gate.gates).toHaveLength(1)
    })
    expect(h.starts()[0].run.hook).toBe('hk')

    h.runner.fire(TRIGGER, promptPayload())
    expect(h.skips()).toHaveLength(1)
    expect(h.runner.runningCount()).toBe(1)

    gate.gates[0].release()
    await h.waitEnd()
    expect(h.runner.runningCount()).toBe(0)
    expect(h.runner.listRuns()).toEqual([])
  })
})

describe('兜底与边界', () => {
  it('HR-21 onRun 在 start 上抛错 → run 照常完成', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      onRun: (event) => {
        if (event.type === 'start') throw new Error('observer broke')
      }
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.runTask).toHaveBeenCalledTimes(1)
    expect(h.ends()).toEqual([expect.objectContaining({ ok: true })])
  })

  it('HR-21 没有 logger 的 runner：命中 / 跳过 / 超时 / 无会话各路径都不抛', async () => {
    const h = makeRunner({
      logger: false,
      timeoutMs: 20,
      entries: [
        entryOf(fileOf({ name: 'fast', displayName: 'Fast' })),
        entryOf(fileOf({ name: 'slow', displayName: 'Slow' })),
        entryOf(fileOf({ name: 'ghost', agent: 'ghost' })),
        entryOf(fileOf({ name: 'bad-when', bindings: [{ trigger: TRIGGER, when: 'event.nope' }] }))
      ],
      runTask: (params) =>
        params.description === 'Slow' ? hangUntilAbort()(params) : Promise.resolve({ result: 'ok' })
    })
    expect(() => h.runner.fire(TRIGGER, promptPayload())).not.toThrow()
    // 紧接着再 fire：fast / slow 还占着坑 → busy
    expect(() => h.runner.fire(TRIGGER, promptPayload())).not.toThrow()
    expect(() => h.runner.fire(TRIGGER, promptPayload({ sessionId: '' }))).not.toThrow()
    await vi.waitFor(() => {
      expect(h.ends()).toHaveLength(2)
    })
    expect(h.ends().find((e) => e.run.hook === 'fast')).toMatchObject({ ok: true })
    expect(h.ends().find((e) => e.run.hook === 'slow')).toMatchObject({
      ok: false,
      error: 'timed out after 20ms'
    })
    expect(
      h
        .skips()
        .map((s) => `${s.hook}:${s.reason}`)
        .sort()
    ).toEqual(['fast:busy', 'ghost:unknown-agent', 'ghost:unknown-agent', 'slow:busy'])
  })

  it('HR-22 resolveAgentProfile 抛错 → 被兜住：fire 照常返回、warn run failed to start、不派发、不占坑', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      resolveAgentProfile: () => {
        throw new Error('registry exploded')
      }
    })
    expect(() => h.runner.fire(TRIGGER, promptPayload())).not.toThrow()
    await vi.waitFor(() => {
      expect(h.warns()).toHaveLength(1)
    })
    expect(h.warns()[0]).toContain('run failed to start')
    expect(h.warns()[0]).toContain('registry exploded')
    expect(h.events).toEqual([])
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.runner.runningCount()).toBe(0)
  })

  it('HR-23 runTask reject → end ok:false 带原话、warn failed: boom、坑位释放', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      runTask: async () => {
        throw new Error('boom')
      }
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.ends()).toEqual([expect.objectContaining({ ok: false, error: 'boom' })])
    expect(h.warns().some((line) => line.includes('failed: boom'))).toBe(true)
    expect(h.runner.runningCount()).toBe(0)
  })

  it('HR-24 模型解析 reject → 记为 skip no-model（配置问题，不是失败的 run）：没有 start / end、不派发、坑位释放', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      resolveRunModel: async () => {
        throw new Error('nope')
      }
    })
    h.runner.fire(TRIGGER, promptPayload())
    await vi.waitFor(() => {
      expect(h.events).toHaveLength(1)
    })
    await settle()
    expect(h.events).toEqual([
      {
        type: 'skip',
        hook: 'hk',
        trigger: TRIGGER,
        sessionId: 's1',
        reason: 'no-model',
        detail: 'model resolution failed: nope'
      }
    ])
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.runner.runningCount()).toBe(0)
  })

  it('HR-25 身份：user 来源进 run.source；description 用 displayName；run.agent 是解析出的档案名', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf({ displayName: 'Shown To Users' }), 'user')],
      resolveAgentProfile: (name) => (name === 'worker' ? { ...PROFILE, name: 'worker-v2' } : null)
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.starts()[0].run).toMatchObject({ hook: 'hk', source: 'user', agent: 'worker-v2' })
    expect(h.ends()[0].run).toMatchObject({ source: 'user', agent: 'worker-v2' })
    expect(h.call().description).toBe('Shown To Users')
    expect(h.call().agentType.name).toBe('worker-v2')
  })

  it('HR-26 结果不读：runTask 交回的 result / structured 不进任何事件、字段或日志', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      runTask: async () => ({ result: 'anything', structured: { x: 1 } })
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.ends()).toEqual([expect.objectContaining({ ok: true })])
    expect(Object.keys(h.ends()[0]).sort()).toEqual(['ms', 'ok', 'run', 'type'])
    const observed = JSON.stringify({ events: h.events, logs: h.logs })
    expect(observed).not.toContain('anything')
    expect(observed).not.toContain('"x":1')
  })

  it('HR-27 runTask 交回 error（派发的 agent 自己失败，如模型调用报错）→ end ok:false 带原话、warn failed:、不记 ok、结果文本仍不进事件', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      runTask: async () => ({ result: 'partial text', error: '500 Internal Server Error' })
    })
    h.runner.fire(TRIGGER, promptPayload())
    await h.waitEnd()
    expect(h.ends()).toEqual([
      expect.objectContaining({ ok: false, error: '500 Internal Server Error' })
    ])
    expect(h.warns().some((line) => line.includes('failed: 500 Internal Server Error'))).toBe(true)
    expect(JSON.stringify(h.logs)).not.toContain(' ok (')
    expect(JSON.stringify(h.events)).not.toContain('partial text')
    expect(h.runner.runningCount()).toBe(0)
  })
})
