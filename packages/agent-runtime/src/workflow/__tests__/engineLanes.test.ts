/**
 * 分道（lane）、重入策略与中止面 —— M2′ 的核心行为面。
 *
 * 要钉死的那条反转：**互斥的单位从「工作流文件」变成了「分道」**。原先 `running` 以
 * 文件名为键，两个会话同时轮结束时第二个被静默 skip；现在会话域埋点缺省按 sessionId
 * 分道，各跑各的。分道键由**调用方**给（绑定的 CEL `key` / invoke 的 `reentry.key`），
 * 「撞车了怎么办」才是文件的 `shuvix-workflow-concurrency`——两个正交的问题。
 *
 * lane 字符串 = `工作流名 + \u0000 + 键`：工作流名在里面，所以两份不同的 md 永远不互斥。
 * 该组合口径由引擎导出的 `workflowLaneKey(name, key)` 收口 —— abortLane 只收拼好的
 * 字符串，宿主自己抄分隔符迟早与引擎漂移。
 *
 * 夹具见 ./harness.ts。meta 记录在同步段落盘 → 负向断言（「没有起新 run」）无需等待。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TRIGGER_POINTS } from '../triggerPoints'
import type { ParsedWorkflowFile } from '../workflowFile'
import { workflowLaneKey } from '../engine'
import { entryOf, fileOf, gatedRunTask, makeEngine, payload } from './harness'

/** fire 用：派发一次（gate 挂起），prompt 即信封里的 promptText */
const firedGate = (over: Partial<ParsedWorkflowFile> = {}): ParsedWorkflowFile =>
  fileOf({ script: "return await run('worker', event.promptText)", ...over })

/** invoke 用：派发一次（gate 挂起），返回本次调用的 input.tag */
const calledGate = (over: Partial<ParsedWorkflowFile> = {}): ParsedWorkflowFile =>
  fileOf({ script: "await run('worker', String(input.tag))\nreturn input.tag", ...over })

const LANE = (name: string, key: string): string => `${name}\u0000${key}`

describe('缺省分道键（fire 路径）', () => {
  it('会话域埋点缺省按会话分道：lane = 工作流名 + \\0 + sessionId', async () => {
    const eng = makeEngine({ entries: [entryOf(fileOf())] })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    expect(eng.lanes()).toEqual([LANE('wf', 's1')])
  })

  it('两个会话并发互不 skip；同一会话第二次才 skip（M2′ 的行为反转）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(firedGate())] })

    eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's1', promptText: 'A' }))
    eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's2', promptText: 'B' }))
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(eng.lanes()).toEqual([LANE('wf', 's1'), LANE('wf', 's2')])

    // 同一会话的第二次才撞道
    eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's1', promptText: 'A2' }))
    expect(eng.metas()).toHaveLength(2)
    expect(eng.logs.some((l) => l.includes('lane busy — skipped'))).toBe(true)

    gates[0].release()
    gates[1].release()
    await eng.waitEnd(2)
  })

  it('会话域 payload 缺 sessionId → 回落 "*"（fail-safe 的缺省键）', async () => {
    const eng = makeEngine({ entries: [entryOf(fileOf())] })
    eng.engine.fire(
      'session.prompt-accepted',
      payload({ sessionId: undefined as unknown as string })
    )
    await eng.waitEnd()
    expect(eng.lanes()).toEqual([LANE('wf', '*')])
  })

  describe('非会话域埋点', () => {
    // 目前所有埋点都是 session 域，用临时改写构造出「其余 → 全局一条道」那一支
    const def = TRIGGER_POINTS['session.prompt-accepted']
    const original = def.scope
    afterEach(() => {
      def.scope = original
    })

    it('scope 非 session → 全局一条道（= 引入分道之前的行为），不同会话互相 skip', async () => {
      delete (def as { scope?: 'session' }).scope
      const { runTask, gates } = gatedRunTask()
      const eng = makeEngine({ runTask, entries: [entryOf(firedGate())] })

      eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's1', promptText: 'A' }))
      await vi.waitFor(() => expect(gates).toHaveLength(1))
      eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's2', promptText: 'B' }))

      expect(eng.lanes()).toEqual([LANE('wf', '*')])
      expect(eng.metas()).toHaveLength(1)
      gates[0].release()
      await eng.waitEnd()
    })
  })
})

describe('绑定的 CEL key', () => {
  const keyed = (key: string, over: Partial<ParsedWorkflowFile> = {}): ParsedWorkflowFile =>
    firedGate({
      bindings: [{ trigger: 'session.prompt-accepted', when: undefined, key, params: {} }],
      ...over
    })

  it('key: "\'shared\'" 要回「整份文件一条道」（迁移逃生门）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(keyed("'shared'"))] })

    eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's1', promptText: 'A' }))
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's2', promptText: 'B' }))

    expect(eng.lanes()).toEqual([LANE('wf', 'shared')])
    expect(eng.metas()).toHaveLength(1)
    gates[0].release()
    await eng.waitEnd()
  })

  it('key 取 event 字段 → 按该维度分道（什么算同一件事由订阅方决定）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(keyed('event.promptText'))] })

    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'topic-a' }))
    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'topic-b' }))
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(eng.lanes()).toEqual([LANE('wf', 'topic-a'), LANE('wf', 'topic-b')])

    gates[0].release()
    gates[1].release()
    await eng.waitEnd(2)
  })

  it.each([
    ['缺失属性', 'event.nope'],
    ['布尔结果', 'event.isDefaultTitle']
  ])('key 求值失败（%s）→ 回落缺省键 + warn，run 照起', async (_label, key) => {
    const eng = makeEngine({ entries: [entryOf(keyed(key, { script: 'return 1' }))] })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()

    // 键算错时宁可更强的互斥，也不给一个来路不明的触发发一张并发许可
    expect(eng.lanes()).toEqual([LANE('wf', 's1')])
    expect(eng.logs.some((l) => l.includes('lane key evaluation failed'))).toBe(true)
    expect(eng.logs.some((l) => l.includes('using the default lane'))).toBe(true)
  })

  it('同埋点多条绑定：第一条 when 命中的那条的 key 生效（bindings.find 的确定性）', async () => {
    const eng = makeEngine({
      entries: [
        entryOf(
          fileOf({
            bindings: [
              { trigger: 'session.prompt-accepted', when: 'false', key: "'K1'", params: {} },
              { trigger: 'session.prompt-accepted', when: 'true', key: "'K2'", params: {} }
            ]
          })
        )
      ]
    })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    expect(eng.lanes()).toEqual([LANE('wf', 'K2')])
  })
})

describe('分道键的组合口径', () => {
  it('两份不同 md 给同一个键 → 不互斥（laneKey 含工作流名）—— fire 路径', async () => {
    const { runTask, gates } = gatedRunTask()
    const key = "'same'"
    const bindings = [{ trigger: 'session.prompt-accepted', when: undefined, key, params: {} }]
    const eng = makeEngine({
      runTask,
      entries: [
        entryOf(firedGate({ name: 'wf-a', bindings })),
        entryOf(firedGate({ name: 'wf-b', bindings }))
      ]
    })
    eng.engine.fire('session.prompt-accepted', payload())
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(eng.lanes()).toEqual([LANE('wf-a', 'same'), LANE('wf-b', 'same')])

    gates[0].release()
    gates[1].release()
    await eng.waitEnd(2)
  })

  it('两份不同 md 给同一个键 → 不互斥 —— invoke 路径', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({
      runTask,
      entries: [entryOf(calledGate({ name: 'wf-a' })), entryOf(calledGate({ name: 'wf-b' }))]
    })
    const reentry = { key: 'same' }
    const a = eng.engine.invoke({ workflow: 'wf-a', input: { tag: 'a' }, reentry })
    const b = eng.engine.invoke({ workflow: 'wf-b', input: { tag: 'b' }, reentry })
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(
      eng.engine
        .listRuns()
        .map((r) => r.laneKey)
        .sort()
    ).toEqual([LANE('wf-a', 'same'), LANE('wf-b', 'same')])

    gates.forEach((g) => g.release())
    expect((await a).ok).toBe(true)
    expect((await b).ok).toBe(true)
  })

  it('跨路径共道：fire 的缺省会话道与 invoke({reentry:{key: sessionId}}) 落同一条道', async () => {
    // bot 侧选键时必须知道会撞上 auto-title 的道 —— 这条组合口径是宿主的责任
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(firedGate())] })
    eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's1' }))
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const firedLane = eng.engine.listRuns()[0].laneKey

    const res = await eng.engine.invoke({ workflow: 'wf', reentry: { key: 's1' } })
    expect(firedLane).toBe(LANE('wf', 's1'))
    expect(res).toEqual({ started: false, reason: 'skipped' })

    gates[0].release()
    await eng.waitEnd()
  })
})

describe('重入策略的作用域收窄为本分道', () => {
  it('skip：同分道忙 → 没有新 meta（同步断言，无需等待）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(firedGate())] })
    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'A' }))
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    const before = eng.records.length
    eng.engine.fire('session.prompt-accepted', payload({ promptText: 'B' }))
    expect(eng.records).toHaveLength(before)

    gates[0].release()
    await eng.waitEnd()
  })

  it('queue（invoke 版）：槽容量 1、旧的拿 superseded、跑的是最新信封、两 run 不重叠', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const call = (tag: string): Promise<unknown> =>
      eng.engine.invoke({ workflow: 'wf', input: { tag }, reentry: { key: 'k', mode: 'queue' } })

    const a = call('A')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const b = call('B')
    const c = call('C')

    // 槽容量恒为 1：迟到的 C 顶掉 B，B 的调用方立刻拿到 superseded（且没有 runId）
    expect(await b).toEqual({ started: false, reason: 'superseded' })

    gates[0].release()
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(gates[1].prompt).toBe('C')
    gates[1].release()

    expect(await a).toMatchObject({ started: true, ok: true, output: 'A' })
    expect(await c).toMatchObject({ started: true, ok: true, output: 'C' })
    // 不重叠：A 的 end 早于 C 的 meta
    const types = eng.records.map((r) => r.rec.type)
    expect(types.indexOf('end')).toBeLessThan(types.lastIndexOf('meta'))
  })

  it('parallel：同道允许重叠，lane 在最后一个 run 收尾时才清（早删会打断第二个 run 的销号）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const par = (tag: string): Promise<unknown> =>
      eng.engine.invoke({ workflow: 'wf', input: { tag }, reentry: { key: 'k', mode: 'parallel' } })

    const a = par('A')
    const b = par('B')
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(eng.engine.runningCount()).toBe(2)

    gates[0].release()
    await expect(a).resolves.toMatchObject({ ok: true })
    expect(eng.engine.runningCount()).toBe(1)
    // 还有一个在跑 → 这条道仍然是忙的
    expect(
      await eng.engine.invoke({ workflow: 'wf', reentry: { key: 'k', mode: 'skip' } })
    ).toEqual({ started: false, reason: 'skipped' })

    gates[1].release()
    await expect(b).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(eng.engine.runningCount()).toBe(0))
  })

  it('分道跑完即释放：同键再 fire 立刻起（不被幽灵 active 卡住）', async () => {
    const eng = makeEngine({ entries: [entryOf(fileOf())] })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd(2)
    expect(eng.metas()).toHaveLength(2)
  })

  it('大量不同键顺序跑完不泄漏：laneCount 归零，任意旧键能立刻再起', async () => {
    // 「空道即删」的动机是内存增长（bot 路径的键含 sessionId+botName），所以要直接
    // 断言条目数而不只是「还能再起」—— 后者在条目泄漏的实现上同样成立
    const eng = makeEngine({ entries: [entryOf(fileOf({ script: 'return 1' }))] })
    for (let i = 0; i < 50; i++) {
      const res = await eng.engine.invoke({ workflow: 'wf', reentry: { key: `k-${i}` } })
      expect(res.ok).toBe(true)
    }
    expect(eng.engine.runningCount()).toBe(0)
    expect(eng.engine.laneCount()).toBe(0)
    expect(eng.engine.listRuns()).toEqual([])
    expect((await eng.engine.invoke({ workflow: 'wf', reentry: { key: 'k-0' } })).ok).toBe(true)
  })

  it('laneCount：在跑时按分道计数，parallel 同道两个 run 只算一条道', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(firedGate({ concurrency: 'parallel' }))] })
    expect(eng.engine.laneCount()).toBe(0)

    eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's1' }))
    eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's2' }))
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(eng.engine.laneCount()).toBe(2)

    // 同一会话再来一个：parallel 允许重叠，但仍是同一条道
    eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's1' }))
    await vi.waitFor(() => expect(gates).toHaveLength(3))
    expect(eng.engine.runningCount()).toBe(3)
    expect(eng.engine.laneCount()).toBe(2)

    gates.forEach((g) => g.release())
    await vi.waitFor(() => expect(eng.engine.laneCount()).toBe(0))
  })

  it('workflowLaneKey 是宿主拼分道键的唯一口径（abortLane 吃它的产物）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(firedGate())] })
    eng.engine.fire('session.prompt-accepted', payload({ sessionId: 's1' }))
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    // 宿主侧（会话删除、per-bot 停止）只能这样拿键 —— 自己抄分隔符迟早与引擎漂移
    expect(workflowLaneKey('wf', 's1')).toBe(eng.engine.listRuns()[0].laneKey)
    expect(eng.engine.abortLane(workflowLaneKey('wf', 's1'))).toBe(1)
    await vi.waitFor(() => expect(eng.engine.runningCount()).toBe(0))
  })
})

describe('中止面', () => {
  it('listRuns()：字段快照且不含 controller（只读快照的契约）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(firedGate())] })
    eng.engine.fire('session.prompt-accepted', payload())
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    const [snap] = eng.engine.listRuns()
    expect(Object.keys(snap).sort()).toEqual([
      'invocation',
      'laneKey',
      'runId',
      'sessionId',
      'source',
      'startedAt',
      'workflowName'
    ])
    expect(snap.runId).toMatch(/^wfr-/)
    expect(snap.workflowName).toBe('wf')
    expect(snap.source).toBe('builtin')
    expect(snap.invocation).toEqual({ kind: 'trigger', trigger: 'session.prompt-accepted' })
    expect(snap.laneKey).toBe(LANE('wf', 's1'))
    expect(snap.sessionId).toBe('s1')
    expect(typeof snap.startedAt).toBe('number')

    gates[0].release()
    await eng.waitEnd()
  })

  it('listRuns()：invoke 的 label 进 invocation；只报在跑的（排队中的不出现）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const a = eng.engine.invoke({
      workflow: 'wf',
      input: { tag: 'A' },
      label: 'bot:gate',
      reentry: { key: 'k', mode: 'queue' }
    })
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const b = eng.engine.invoke({
      workflow: 'wf',
      input: { tag: 'B' },
      reentry: { key: 'k', mode: 'queue' }
    })

    // 排队不是 run
    expect(eng.engine.listRuns()).toHaveLength(1)
    expect(eng.engine.listRuns()[0].invocation).toEqual({ kind: 'call', label: 'bot:gate' })

    gates[0].release()
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(eng.engine.listRuns()).toHaveLength(1)
    gates[1].release()
    await Promise.all([a, b])
  })

  it('abortRun：未知 id → false；已知 → true，run 失败收尾且在飞步骤的 signal 落下', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(firedGate())] })
    eng.engine.fire('session.prompt-accepted', payload())
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    expect(eng.engine.abortRun('wfr-nope')).toBe(false)
    expect(eng.engine.abortRun(eng.engine.listRuns()[0].runId)).toBe(true)
    await eng.waitEnd()
    expect(eng.ends()[0].ok).toBe(false)
    expect(gates[0].params.parentAbortSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(eng.engine.runningCount()).toBe(0))
  })

  it('中止的失败文案是 aborted 而非超时 —— journal 不该对「用户点了停」撒谎', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(firedGate())] })
    eng.engine.fire('session.prompt-accepted', payload())
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    eng.engine.abortRun(eng.engine.listRuns()[0].runId)
    await eng.waitEnd()
    expect(eng.ends()[0].error).toContain('aborted')
    // 默认限额 1800s 配上几十毫秒的 run 是最误导的一种日志
    expect(eng.ends()[0].error).not.toContain('timed out')
  })

  it('abortLane：返回 active + queued 计数，槽内调用方拿 superseded 且不会被拉起', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const call = (tag: string): Promise<unknown> =>
      eng.engine.invoke({ workflow: 'wf', input: { tag }, reentry: { key: 'k', mode: 'queue' } })

    const a = call('A')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const b = call('B')

    expect(eng.engine.abortLane(LANE('wf', 'k'))).toBe(2)
    expect(await b).toEqual({ started: false, reason: 'superseded' })
    expect(await a).toMatchObject({ started: true, ok: false })
    // 先清槽再中止：被清掉的 plan 不会在 active 收尾时被拉起来
    await new Promise((r) => setTimeout(r, 30))
    expect(gates).toHaveLength(1)
    expect(eng.engine.runningCount()).toBe(0)
  })

  it('abortLane：未知键 / 裸 key（未含工作流名）→ 0，无 run 受影响', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(firedGate())] })
    eng.engine.fire('session.prompt-accepted', payload())
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    expect(eng.engine.abortLane('nope')).toBe(0)
    // 宿主必须用 listRuns().laneKey，不能自己拿裸键去猜
    expect(eng.engine.abortLane('s1')).toBe(0)
    expect(eng.engine.runningCount()).toBe(1)

    gates[0].release()
    await eng.waitEnd()
  })

  it('abortSession：只中止该会话的 run，返回计数', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const a = eng.engine.invoke({ workflow: 'wf', input: { tag: 'A' }, sessionId: 'S1' })
    const b = eng.engine.invoke({ workflow: 'wf', input: { tag: 'B' }, sessionId: 'S2' })
    await vi.waitFor(() => expect(gates).toHaveLength(2))

    expect(eng.engine.abortSession('S1')).toBe(1)
    expect(await a).toMatchObject({ started: true, ok: false })
    expect(eng.engine.runningCount()).toBe(1)
    expect(eng.engine.listRuns()[0].sessionId).toBe('S2')

    gates[1].release()
    expect(await b).toMatchObject({ ok: true })
  })

  it('abortSession：同会话的待跑槽一并作废 —— 中止过的会话不得再被拉起一个新 run', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const call = (tag: string): Promise<unknown> =>
      eng.engine.invoke({
        workflow: 'wf',
        input: { tag },
        sessionId: 'S',
        reentry: { key: 'k', mode: 'queue' }
      })

    const a = call('A')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const b = call('B')

    // 槽 + 在跑的各算一个
    expect(eng.engine.abortSession('S')).toBe(2)
    expect(await b).toEqual({ started: false, reason: 'superseded' })
    expect(await a).toMatchObject({ started: true, ok: false })
    // 会话已经没了，引擎不得拿着它的 sessionId 再派发一次
    await new Promise((r) => setTimeout(r, 30))
    expect(eng.metas()).toHaveLength(1)
    expect(gates).toHaveLength(1)
    expect(eng.engine.runningCount()).toBe(0)
  })

  it('runningCount() === 在跑的 run 数（不再是文件名口径）：同一份 md 三条分道并发 → 3', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(firedGate())] })
    for (const sessionId of ['s1', 's2', 's3']) {
      eng.engine.fire('session.prompt-accepted', payload({ sessionId, promptText: sessionId }))
    }
    await vi.waitFor(() => expect(gates).toHaveLength(3))
    expect(eng.engine.runningCount()).toBe(3)
    expect(eng.engine.listRuns()).toHaveLength(3)

    gates.forEach((g) => g.release())
    await eng.waitEnd(3)
    await vi.waitFor(() => expect(eng.engine.runningCount()).toBe(0))
  })
})
