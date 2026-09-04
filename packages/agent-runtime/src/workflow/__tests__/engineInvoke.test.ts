/**
 * `invoke(req)` —— 定向调用路径（`fire` 是广播）。bot 管线、未来的手动运行 / CLI /
 * mcp.call 共用这一条入口，所以它的契约面比 fire 宽得多：
 *
 *  - **绝不抛出**，五种 `reason` 各自可达（not-found / invalid-input / skipped /
 *    superseded / error）；
 *  - 信封与 fire 同形（`{trigger:'call', chain:[], input}`）—— 脚本读 `event` 不必分路径；
 *  - 入参按 `shuvix-workflow-input` 的 `type:object` + `required` 做**浅**校验；
 *  - **调用方可以随本次调用装配几个自己的函数进脚本 API**（`extraApi`）：与 11 个基础
 *    API 同名、或名字不是合法标识符，即拒绝装配（遮蔽掉 run/log 会让同一份 md 在不同
 *    调用路径下语义不同）。fire 是广播、没有调用方，所以这些名字在 fire 起的 run 里
 *    根本不在作用域内 —— 那是装配面的事实，与安全无关。
 *
 * 夹具见 ./harness.ts；分道/重入/中止面的用例在 engineLanes.test.ts。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ParsedWorkflowFile } from '../workflowFile'
import type { RunTaskParams } from '../../subagent/manager'
import { entryOf, fileOf, gatedRunTask, makeEngine, payload } from './harness'

/** 与 engine.ts 的 BASE_API_NAMES 同表 —— 这份 copy 就是「不许悄悄改」的钉板 */
const BASE_API_NAMES = [
  'event',
  'input',
  'vars',
  'schemas',
  'prompt',
  'run',
  'map',
  'log',
  'sleep',
  'now',
  'fail'
] as const

const calledGate = (over: Partial<ParsedWorkflowFile> = {}): ParsedWorkflowFile =>
  fileOf({ script: "await run('worker', String(input.tag))\nreturn input.tag", ...over })

describe('invoke — 正常路径与信封', () => {
  it('起跑成功的返回形状：{runId, started, ok, output}，output 为 JSON 克隆', async () => {
    const eng = makeEngine({ entries: [entryOf(fileOf({ script: 'return { x: input.x }' }))] })
    const res = await eng.engine.invoke({ workflow: 'wf', input: { x: 1 } })
    expect(res.started).toBe(true)
    expect(res.ok).toBe(true)
    expect(res.runId).toMatch(/^wfr-/)
    expect(res.output).toEqual({ x: 1 })
  })

  it("信封 = {trigger:'call', chain:[], input}；input 与 event.input 同值", async () => {
    const eng = makeEngine({
      entries: [entryOf(fileOf({ script: 'return { event, sameInput: input.tag }' }))]
    })
    const res = await eng.engine.invoke({ workflow: 'wf', input: { tag: 'T' } })
    expect(res.output).toEqual({
      event: { trigger: 'call', chain: [], input: { tag: 'T' } },
      sameInput: 'T'
    })
  })

  it('meta 记录：invocation {kind:call, label} / source / sessionId / lane；不传 label 时只有 kind', async () => {
    const eng = makeEngine({ entries: [entryOf(fileOf({ script: 'return 1' }))] })
    await eng.engine.invoke({
      workflow: 'wf',
      sessionId: 'S9',
      label: 'bot:gate',
      reentry: { key: 'k' }
    })
    expect(eng.metas()[0]).toMatchObject({
      invocation: { kind: 'call', label: 'bot:gate' },
      source: 'builtin',
      sessionId: 'S9',
      lane: 'wf\u0000k'
    })

    await eng.engine.invoke({ workflow: 'wf' })
    expect(eng.metas()[1].invocation).toEqual({ kind: 'call' })
  })

  it('用户覆盖内置同名：invoke 取合并后的那份（与 fire 同一注册表规则）', async () => {
    const eng = makeEngine({
      entries: [
        entryOf(fileOf({ script: "return 'USER'" }), { source: 'user' }),
        entryOf(fileOf({ script: "return 'BUILTIN'" }))
      ]
    })
    const res = await eng.engine.invoke({ workflow: 'wf' })
    expect(res.output).toBe('USER')
    expect(eng.metas()[0].source).toBe('user')
  })

  it('sessionId 透传为 parentSessionId；不传 → runId 自成血缘根', async () => {
    const withSession = makeEngine({
      entries: [entryOf(fileOf({ script: "return await run('worker', 'p')" }))]
    })
    await withSession.engine.invoke({ workflow: 'wf', sessionId: 'sess-7' })
    expect((withSession.runTask.mock.calls[0][0] as RunTaskParams).parentSessionId).toBe('sess-7')

    const bare = makeEngine({
      entries: [entryOf(fileOf({ script: "return await run('worker', 'p')" }))]
    })
    const res = await bare.engine.invoke({ workflow: 'wf' })
    expect((bare.runTask.mock.calls[0][0] as RunTaskParams).parentSessionId).toBe(res.runId)
  })
})

describe('invoke — 四种 reason 各自可达', () => {
  it('not-found：注册表里没有这个名字 → 零 record + warn', async () => {
    const eng = makeEngine({ entries: [entryOf(fileOf())] })
    expect(await eng.engine.invoke({ workflow: 'ghost' })).toEqual({
      started: false,
      reason: 'not-found'
    })
    expect(eng.records).toEqual([])
    expect(eng.logs.some((l) => l.includes('no such workflow'))).toBe(true)
  })

  it('invalid-input：required 缺字段 → 错误列出全部缺失字段名、零 record', async () => {
    const eng = makeEngine({
      entries: [entryOf(fileOf({ inputSchema: { type: 'object', required: ['a', 'b', 'c'] } }))]
    })
    const res = await eng.engine.invoke({ workflow: 'wf', input: { a: 1 } })
    expect(res.reason).toBe('invalid-input')
    expect(res.error).toContain('b, c')
    expect(eng.records).toEqual([])
  })

  it.each([
    ['数组', [1, 2]],
    ['字符串', 'nope'],
    ['显式 null', null]
  ])('invalid-input：入参非对象（%s）→ 消息指向 shuvix-workflow-input', async (_label, input) => {
    const eng = makeEngine({ entries: [entryOf(fileOf({ inputSchema: { type: 'object' } }))] })
    const res = await eng.engine.invoke({ workflow: 'wf', input })
    expect(res.reason).toBe('invalid-input')
    expect(res.error).toContain('declares shuvix-workflow-input')
  })

  it('skipped：同分道忙 + skip → 无新 meta', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const a = eng.engine.invoke({ workflow: 'wf', input: { tag: 'A' }, reentry: { key: 'k' } })
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    expect(await eng.engine.invoke({ workflow: 'wf', reentry: { key: 'k' } })).toEqual({
      started: false,
      reason: 'skipped'
    })
    expect(eng.metas()).toHaveLength(1)

    gates[0].release()
    await a
  })

  it('superseded：槽内被顶掉的调用方拿不到 runId（槽容量恒为 1）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const call = (tag: string): ReturnType<typeof eng.engine.invoke> =>
      eng.engine.invoke({ workflow: 'wf', input: { tag }, reentry: { key: 'k', mode: 'queue' } })

    const a = call('A')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const b = call('B')
    const c = call('C')

    const bRes = await b
    expect(bRes).toEqual({ started: false, reason: 'superseded' })
    expect(bRes.runId).toBeUndefined()

    gates[0].release()
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    gates[1].release()
    await Promise.all([a, c])
  })
})

describe('invoke — 入参归一', () => {
  it('未声明 input schema → 任意 input 放行；不传 input 归一为 {}', async () => {
    const eng = makeEngine({
      entries: [entryOf(fileOf({ script: 'return Object.keys(input).length' }))]
    })
    expect((await eng.engine.invoke({ workflow: 'wf', input: { a: 1, b: 2 } })).output).toBe(2)
    expect((await eng.engine.invoke({ workflow: 'wf' })).output).toBe(0)
  })

  it('声明了 input schema 但 required 为空 + 不传 input → 照起（与信封的归一同一条）', async () => {
    // 校验侧与信封侧各归一各的，会让 invoke({workflow}) 被拒而 invoke({workflow, input:{}}) 通过
    const eng = makeEngine({
      entries: [
        entryOf(fileOf({ inputSchema: { type: 'object' }, script: 'return Object.keys(input)' }))
      ]
    })
    expect(await eng.engine.invoke({ workflow: 'wf' })).toMatchObject({
      started: true,
      ok: true,
      output: []
    })
  })

  it('绝不抛：listWorkflows 抛错 → started:false + reason "error"（不谎称「没这个工作流」）', async () => {
    const eng = makeEngine({
      listWorkflows: () => {
        throw new Error('scan blew up')
      }
    })
    // 兜底 catch 曾经复用 not-found —— 调用方据此提示用户「工作流不存在」会指错方向
    const res = await eng.engine.invoke({ workflow: 'wf' })
    expect(res).toMatchObject({ started: false, reason: 'error' })
    expect(res.error).toContain('scan blew up')
  })
})

describe('invoke — extraApi 装配', () => {
  it('装配进来的函数能被脚本调用到', async () => {
    const eng = makeEngine({
      entries: [entryOf(fileOf({ script: "return await say('x')" }))]
    })
    const res = await eng.engine.invoke({
      workflow: 'wf',
      extraApi: { say: async (t: string) => `said:${t}` }
    })
    expect(res.output).toBe('said:x')
  })

  it('多个函数同时装配，与基础 API 并存', async () => {
    const eng = makeEngine({
      entries: [
        entryOf(
          fileOf({
            script: [
              "log('start')",
              "const a = await say('a')",
              'const b = claim(2)',
              "const c = await run('worker', 'p')",
              'return { a, b, c }'
            ].join('\n')
          })
        )
      ]
    })
    const res = await eng.engine.invoke({
      workflow: 'wf',
      extraApi: { say: async (t: string) => `said:${t}`, claim: (n: number) => n * 10 }
    })
    expect(res.output).toEqual({ a: 'said:a', b: 20, c: 'ok' })
    expect(eng.records.some((r) => r.rec.type === 'log' && r.rec.message === 'start')).toBe(true)
  })

  it.each(BASE_API_NAMES)(
    'extraApi 名与基础 API "%s" 碰撞 → 拒绝装配：ok:false + end 记录，脚本一次都没执行',
    async (fnName) => {
      const eng = makeEngine({ entries: [entryOf(fileOf({ script: "return 'SHOULD NOT RUN'" }))] })
      const res = await eng.engine.invoke({
        workflow: 'wf',
        extraApi: { [fnName]: () => 1 }
      })
      expect(res).toMatchObject({ started: true, ok: false })
      expect(res.runId).toMatch(/^wfr-/)
      expect(res.error).toContain(`extraApi "${fnName}" collides with the base script API`)
      expect(eng.ends()[0]).toMatchObject({ ok: false, ms: 0 })
      expect(eng.execute).not.toHaveBeenCalled()
    }
  )

  it('碰撞后分道被释放（早退路径与正常路径走同一条收尾）', async () => {
    const eng = makeEngine({ entries: [entryOf(fileOf({ script: 'return 1' }))] })
    const bad = await eng.engine.invoke({
      workflow: 'wf',
      extraApi: { log: () => 1 },
      reentry: { key: 'k' }
    })
    expect(bad.ok).toBe(false)
    expect(eng.engine.runningCount()).toBe(0)
    // 同键的下一次调用立刻起跑
    expect((await eng.engine.invoke({ workflow: 'wf', reentry: { key: 'k' } })).ok).toBe(true)
  })

  it('fire 路径没有调用方可传函数：引用 say 的 md 走 fire → say is not defined', async () => {
    // 纯装配面的事实，不是一道安全闸 —— 被派发 agent 能做什么由 security 策略在执行期
    // 判定，与它经 fire 还是 invoke 起跑无关
    const eng = makeEngine({ entries: [entryOf(fileOf({ script: "return await say('x')" }))] })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    expect(eng.ends()[0].ok).toBe(false)
    expect(eng.ends()[0].error).toContain('say is not defined')
  })

  it('排队中的调用其 extraApi 随 plan 保留，起跑时照常装配（bot mailbox 依赖）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({
      runTask,
      entries: [
        entryOf(fileOf({ script: "await run('worker', 'p')\nreturn await say(input.tag)" }))
      ]
    })
    const call = (tag: string): ReturnType<typeof eng.engine.invoke> =>
      eng.engine.invoke({
        workflow: 'wf',
        input: { tag },
        extraApi: { say: async (t: string) => `said:${t}` },
        reentry: { key: 'k', mode: 'queue' }
      })

    const a = call('A')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const b = call('B')

    gates[0].release()
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    gates[1].release()
    expect((await a).output).toBe('said:A')
    expect((await b).output).toBe('said:B')
  })

  it.each(['my-cap', '2fast', 'say it', ''])(
    'extraApi 名不是合法标识符（%s）→ 拒绝装配，与碰撞守卫同形',
    async (fnName) => {
      // 不校验的话失败形态随宿主脚本引擎而异：AsyncFunction 在装配形参时炸出一句
      // 看不懂的语法错，node:vm 下则静默留一个脚本根本写不出来的 global
      const eng = makeEngine({ entries: [entryOf(fileOf({ script: 'return 1' }))] })
      const res = await eng.engine.invoke({
        workflow: 'wf',
        extraApi: { [fnName]: () => 1 }
      })
      expect(res).toMatchObject({ started: true, ok: false })
      expect(res.error).toContain('is not a valid identifier')
      expect(eng.execute).not.toHaveBeenCalled()
    }
  )
})

describe('invoke — signal 与重入参数', () => {
  it('外部 signal 级联：abort 后 run 失败收尾，在飞步骤的 signal 一并落下', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const ac = new AbortController()
    const res = eng.engine.invoke({ workflow: 'wf', input: { tag: 'A' }, signal: ac.signal })
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    ac.abort()
    expect(await res).toMatchObject({ started: true, ok: false })
    expect(gates[0].params.parentAbortSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(eng.engine.runningCount()).toBe(0))
  })

  it('传入已 aborted 的 signal → 立即以失败收尾（不得变成永久泄漏的 run + 占死的分道）', async () => {
    // 已 abort 的 signal 不会再派发事件：少了同步分支，整张墙钟安全网失效
    const eng = makeEngine({
      // input.hang 时永挂 —— 第二次调用不带它，用来证明分道确实被释放了
      entries: [
        entryOf(fileOf({ script: "if (input.hang) await new Promise(() => {})\nreturn 'done'" }))
      ]
    })
    const ac = new AbortController()
    ac.abort()

    const res = await eng.engine.invoke({
      workflow: 'wf',
      input: { hang: true },
      signal: ac.signal,
      reentry: { key: 'k' }
    })
    expect(res).toMatchObject({ started: true, ok: false })
    expect(eng.engine.runningCount()).toBe(0)
    // 分道没被占死：同键的下一次调用照常起跑
    expect(await eng.engine.invoke({ workflow: 'wf', reentry: { key: 'k' } })).toMatchObject({
      started: true,
      ok: true,
      output: 'done'
    })
  })

  it('reentry.key 省略 → 不参与任何互斥（laneKey 为 undefined）', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const a = eng.engine.invoke({ workflow: 'wf', input: { tag: 'A' } })
    const b = eng.engine.invoke({ workflow: 'wf', input: { tag: 'B' } })
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(eng.engine.listRuns().map((r) => r.laneKey)).toEqual([undefined, undefined])

    gates.forEach((g) => g.release())
    await Promise.all([a, b])
  })

  it('【钉现状】reentry.mode 单独给（无 key）静默无效 —— 无键即无道', async () => {
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({
      runTask,
      entries: [entryOf(calledGate({ concurrency: 'skip' }))]
    })
    const a = eng.engine.invoke({ workflow: 'wf', input: { tag: 'A' }, reentry: { mode: 'skip' } })
    const b = eng.engine.invoke({ workflow: 'wf', input: { tag: 'B' }, reentry: { mode: 'skip' } })
    await vi.waitFor(() => expect(gates).toHaveLength(2))

    gates.forEach((g) => g.release())
    expect((await a).ok).toBe(true)
    expect((await b).ok).toBe(true)
  })

  it('reentry.mode 覆盖文件 concurrency（两向）', async () => {
    // 文件 skip + mode parallel → 同键并发
    const loose = gatedRunTask()
    const engLoose = makeEngine({
      runTask: loose.runTask,
      entries: [entryOf(calledGate({ concurrency: 'skip' }))]
    })
    const a = engLoose.engine.invoke({
      workflow: 'wf',
      input: { tag: 'A' },
      reentry: { key: 'k', mode: 'parallel' }
    })
    const b = engLoose.engine.invoke({
      workflow: 'wf',
      input: { tag: 'B' },
      reentry: { key: 'k', mode: 'parallel' }
    })
    await vi.waitFor(() => expect(loose.gates).toHaveLength(2))
    loose.gates.forEach((g) => g.release())
    expect((await a).ok).toBe(true)
    expect((await b).ok).toBe(true)

    // 文件 parallel + mode skip → 第二次被 skip
    const tight = gatedRunTask()
    const engTight = makeEngine({
      runTask: tight.runTask,
      entries: [entryOf(calledGate({ concurrency: 'parallel' }))]
    })
    const first = engTight.engine.invoke({
      workflow: 'wf',
      input: { tag: 'A' },
      reentry: { key: 'k', mode: 'skip' }
    })
    await vi.waitFor(() => expect(tight.gates).toHaveLength(1))
    expect(
      await engTight.engine.invoke({ workflow: 'wf', reentry: { key: 'k', mode: 'skip' } })
    ).toEqual({ started: false, reason: 'skipped' })

    tight.gates[0].release()
    await first
  })
})

/**
 * `run(..., { attach })` —— **附件接缝**。脚本转交的是宿主给的不透明句柄，引擎自己一个
 * 字节都不认识：它只负责在派发之前把句柄交给宿主的 `resolveAttachments`，把换回来的
 * 消息挂进派生 agent 的上下文。
 *
 * 这条接缝的每一格都是「取不到图时会怎样」：宿主没有这个能力、回读抛了、回读回来是空的 ——
 * 三者都必须是「少一张图的回答」，而不是「没有回答」。带图的消息本来就少，一次带图的
 * 失败会被当成偶发，而它其实是这条路径每次都会走的那一条。
 */
describe('invoke — attach 接缝', () => {
  const HANDLE = { sessionId: 'S1', entryId: 'e1', index: 0, mimeType: 'image/png' }
  const IMAGE = {
    role: 'user',
    content: [{ type: 'image', data: 'BYTES', mimeType: 'image/png' }]
  } as never

  const attaching = (opts = '{ attach: [HANDLE] }'): ParsedWorkflowFile =>
    fileOf({
      script: `const HANDLE = ${JSON.stringify(HANDLE)}\nreturn await run('worker', 'p', ${opts})`
    })

  it('EA-1 句柄经 resolveAttachments 换成消息，挂进派生上下文；sessionId 一并交付', async () => {
    const resolveAttachments = vi.fn(async () => [IMAGE])
    const eng = makeEngine({ resolveAttachments, entries: [entryOf(attaching())] })
    await eng.engine.invoke({ workflow: 'wf', sessionId: 'S1' })

    expect(resolveAttachments).toHaveBeenCalledTimes(1)
    expect(resolveAttachments.mock.calls[0]).toEqual([[HANDLE], 'S1'])
    expect((eng.runTask.mock.calls[0][0] as RunTaskParams).contextMessages).toEqual([IMAGE])
  })

  it('EA-2 没有 attach → 回读一次都不调，contextMessages 整个键不铺', async () => {
    const resolveAttachments = vi.fn(async () => [IMAGE])
    const eng = makeEngine({
      resolveAttachments,
      entries: [entryOf(fileOf({ script: "return await run('worker', 'p')" }))]
    })
    await eng.engine.invoke({ workflow: 'wf' })
    expect(resolveAttachments).not.toHaveBeenCalled()
    expect((eng.runTask.mock.calls[0][0] as RunTaskParams).contextMessages).toBeUndefined()
  })

  it.each([
    ['空数组', '{ attach: [] }'],
    ['非数组', "{ attach: 'nope' }"],
    ['显式 null', '{ attach: null }']
  ])('EA-3 attach 是 %s → 当作没有附件，不调回读也不报错', async (_n, opts) => {
    const resolveAttachments = vi.fn(async () => [IMAGE])
    const eng = makeEngine({ resolveAttachments, entries: [entryOf(attaching(opts))] })
    expect(await eng.engine.invoke({ workflow: 'wf' })).toMatchObject({ ok: true })
    expect(resolveAttachments).not.toHaveBeenCalled()
  })

  it('EA-4 宿主没有回读能力 → 留一条 log 并照常派发（附件是宿主能力，不是每个宿主都有）', async () => {
    const eng = makeEngine({ entries: [entryOf(attaching())] })
    const res = await eng.engine.invoke({ workflow: 'wf' })
    expect(res).toMatchObject({ ok: true, output: 'ok' })
    expect(
      eng.records.some(
        (r) =>
          r.rec.type === 'log' &&
          r.rec.message === 'attach ignored: host has no attachment resolver'
      )
    ).toBe(true)
    expect((eng.runTask.mock.calls[0][0] as RunTaskParams).contextMessages).toBeUndefined()
  })

  it('EA-5 回读抛错 → log 记下原因，派发照常（少一张图的回答好过没有回答）', async () => {
    const eng = makeEngine({
      resolveAttachments: async () => {
        throw new Error('tree is gone')
      },
      entries: [entryOf(attaching())]
    })
    const res = await eng.engine.invoke({ workflow: 'wf' })
    expect(res).toMatchObject({ ok: true, output: 'ok' })
    const log = eng.records.find((r) => r.rec.type === 'log')!.rec
    expect(String(log.message)).toContain('attach failed')
    expect(String(log.message)).toContain('tree is gone')
    expect(eng.runTask).toHaveBeenCalledTimes(1)
  })

  it('EA-6 回读回来是空数组 → contextMessages 不铺（不给模型一条空的 user 消息）', async () => {
    const eng = makeEngine({ resolveAttachments: async () => [], entries: [entryOf(attaching())] })
    await eng.engine.invoke({ workflow: 'wf' })
    expect((eng.runTask.mock.calls[0][0] as RunTaskParams).contextMessages).toBeUndefined()
  })

  it('EA-7 【读盘不计入步超时】回读比 timeoutSec 还慢时，这一步照样跑得起来', async () => {
    // 计时器若在回读之前武装，一条带图的消息就会在模型还没被调用之前先被判超时 ——
    // 而读盘的耗时本来就不该记到这一步的模型账上
    vi.useFakeTimers()
    try {
      const eng = makeEngine({
        // 派发那一刻 signal 已经落下 = 计时器武装早了
        runTask: async (p) => ({ result: p.parentAbortSignal?.aborted ? 'ARMED-TOO-EARLY' : 'ok' }),
        resolveAttachments: async () => {
          await new Promise((r) => setTimeout(r, 5_000))
          return [IMAGE]
        },
        entries: [entryOf(attaching('{ attach: [HANDLE], timeoutSec: 1 }'))]
      })
      const p = eng.engine.invoke({ workflow: 'wf' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await p).toMatchObject({ ok: true, output: 'ok' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('EA-8 不传 sessionId → 回读拿到 undefined（宿主据此拒绝跨会话句柄）', async () => {
    const resolveAttachments = vi.fn(async (_refs: unknown[], _sessionId?: string) => [IMAGE])
    const eng = makeEngine({ resolveAttachments, entries: [entryOf(attaching())] })
    await eng.engine.invoke({ workflow: 'wf' })
    expect(resolveAttachments.mock.calls[0][1]).toBeUndefined()
  })
})

/**
 * `systemContext` —— 调用方随本次 invoke 固化的上下文块（已围栏），这次 run 里**每一个**
 * `run()` 派发的 agent 都在系统提示词末尾带上它。与 extraApi 同一种席位：引擎不解释内容，
 * 只透传；fire 没有调用方，所以那条路径恒为空。bot 管线用它把 bot 的人设与记忆带给
 * 门控 / 复核 / 任务每一段（renderBotContext），追加本身在 createAgent（createAgent.test.ts）。
 */
describe('invoke — systemContext 透传', () => {
  const CTX = ['<bot_profile name="scout" file="/b/scout.md">\nP\n</bot_profile>', 'SECOND']
  const paramsOf = (eng: ReturnType<typeof makeEngine>, i = 0): RunTaskParams =>
    eng.runTask.mock.calls[i][0] as RunTaskParams
  /** 两次派发的脚本 —— 「每一次」而不是「第一次」 */
  const twoRuns = (): ParsedWorkflowFile =>
    fileOf({ script: "await run('worker', 'one')\nawait run('worker', 'two')\nreturn 1" })

  it('SC-1 同一 run 里每一次 run() 的派发都带同一份 systemContext', async () => {
    const eng = makeEngine({ entries: [entryOf(twoRuns())] })
    expect(await eng.engine.invoke({ workflow: 'wf', systemContext: CTX })).toMatchObject({
      ok: true
    })
    expect(eng.runTask).toHaveBeenCalledTimes(2)
    expect(paramsOf(eng, 0).systemContext).toEqual(CTX)
    expect(paramsOf(eng, 1).systemContext).toEqual(CTX)
  })

  it('SC-2 不传 → 派发入参里没有这个键（不是 undefined 值，也不是空数组）', async () => {
    const eng = makeEngine({ entries: [entryOf(twoRuns())] })
    await eng.engine.invoke({ workflow: 'wf' })
    expect(paramsOf(eng, 0)).not.toHaveProperty('systemContext')
    expect(paramsOf(eng, 1)).not.toHaveProperty('systemContext')
  })

  it('SC-3 传空数组 → 同样不铺（只在非空时透传）', async () => {
    const eng = makeEngine({ entries: [entryOf(twoRuns())] })
    await eng.engine.invoke({ workflow: 'wf', systemContext: [] })
    expect(paramsOf(eng)).not.toHaveProperty('systemContext')
  })

  it('SC-4 fire 路径恒为空：同一份 md 经埋点起跑，派发入参里没有 systemContext', async () => {
    // fire 是广播、没有调用方 —— 没有谁能替一次埋点触发的 run 装配上下文块
    const eng = makeEngine({ entries: [entryOf(twoRuns())] })
    eng.engine.fire('session.prompt-accepted', payload())
    await eng.waitEnd()
    expect(eng.runTask).toHaveBeenCalledTimes(2)
    expect(paramsOf(eng, 0)).not.toHaveProperty('systemContext')
    expect(paramsOf(eng, 1)).not.toHaveProperty('systemContext')
  })

  it('SC-5 排队中的调用其 systemContext 随 plan 保留，起跑时照常透传（bot mailbox 依赖）', async () => {
    // 与 extraApi 同一条：两个 bot 的 run 排在同一分道上，各自的档案不得串
    const { runTask, gates } = gatedRunTask()
    const eng = makeEngine({ runTask, entries: [entryOf(calledGate())] })
    const call = (tag: string): ReturnType<typeof eng.engine.invoke> =>
      eng.engine.invoke({
        workflow: 'wf',
        input: { tag },
        systemContext: [`ctx-${tag}`],
        reentry: { key: 'k', mode: 'queue' }
      })

    const a = call('A')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const b = call('B')
    expect(gates[0].params.systemContext).toEqual(['ctx-A'])

    gates[0].release()
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(gates[1].params.systemContext).toEqual(['ctx-B'])
    gates[1].release()
    await Promise.all([a, b])
  })
})

/**
 * 入参校验的**嵌套** required：`shuvix-workflow-input` 里每个 `type: object` 的子属性，
 * 若入参给了它，就按它自己的 `required` 再查一层（错误按路径点名，如 `agents.task`）。
 * bot 管线的槽位表靠这条：哪些槽位必填由管线文件说了算，漏填在起跑前就被拦下 ——
 * 让它跑起来只会在脚本深处炸成一句 `Cannot read properties of undefined`。
 */
describe('invoke — 嵌套 required 校验（沿 properties 递归）', () => {
  const nested = (): ParsedWorkflowFile =>
    fileOf({
      inputSchema: {
        type: 'object',
        required: ['agents'],
        properties: {
          agents: {
            type: 'object',
            required: ['intent', 'task'],
            properties: {
              intent: { type: 'string' },
              task: { type: 'string' },
              recheck: { type: 'string' }
            }
          },
          // 可选的子对象：整体省略合法，一旦给了就按它自己的 required 查
          opts: { type: 'object', required: ['mode'] }
        }
      },
      script: 'return input.agents.task'
    })

  it('NR-1 子对象缺必填 → invalid-input，错误按路径点名（agents.task），零 record', async () => {
    const eng = makeEngine({ entries: [entryOf(nested())] })
    const res = await eng.engine.invoke({ workflow: 'wf', input: { agents: { intent: 'i' } } })
    expect(res).toMatchObject({ started: false, reason: 'invalid-input' })
    expect(res.error).toContain('agents.task')
    expect(res.error).not.toContain('agents.intent')
    expect(eng.records).toEqual([])
    expect(eng.execute).not.toHaveBeenCalled()
  })

  it('NR-2 子对象缺多个 → 一次列全（agents.intent, agents.task）', async () => {
    const eng = makeEngine({ entries: [entryOf(nested())] })
    const res = await eng.engine.invoke({ workflow: 'wf', input: { agents: {} } })
    expect(res.reason).toBe('invalid-input')
    expect(res.error).toContain('agents.intent, agents.task')
  })

  it.each([
    ['字符串', 'coding'],
    ['数组', ['a']],
    ['显式 null', null]
  ])('NR-3 子对象不是对象（%s）→ 消息指出 input.agents 必须是对象', async (_label, agents) => {
    const eng = makeEngine({ entries: [entryOf(nested())] })
    const res = await eng.engine.invoke({ workflow: 'wf', input: { agents } })
    expect(res.reason).toBe('invalid-input')
    expect(res.error).toContain('input.agents must be an object')
  })

  it('NR-4 必填齐全 + 可选子对象整体省略 → 照常起跑；可选子对象一旦给了就按它的 required 查', async () => {
    const eng = makeEngine({ entries: [entryOf(nested())] })
    expect(
      await eng.engine.invoke({ workflow: 'wf', input: { agents: { intent: 'i', task: 't' } } })
    ).toMatchObject({ started: true, ok: true, output: 't' })

    const withOpts = await eng.engine.invoke({
      workflow: 'wf',
      input: { agents: { intent: 'i', task: 't' }, opts: {} }
    })
    expect(withOpts.reason).toBe('invalid-input')
    expect(withOpts.error).toContain('opts.mode')
  })

  it('NR-5 顶层缺失先拦、不下钻：错误点名 agents，不是 agents.intent', async () => {
    const eng = makeEngine({ entries: [entryOf(nested())] })
    const res = await eng.engine.invoke({ workflow: 'wf', input: {} })
    expect(res.reason).toBe('invalid-input')
    expect(res.error).toContain('agents')
    expect(res.error).not.toContain('agents.intent')
  })

  it('NR-6 递归只认 type:object 的子 schema：没写 type 的子 required 不查', async () => {
    const eng = makeEngine({
      entries: [
        entryOf(
          fileOf({
            inputSchema: { type: 'object', properties: { agents: { required: ['task'] } } },
            script: 'return 1'
          })
        )
      ]
    })
    expect(await eng.engine.invoke({ workflow: 'wf', input: { agents: {} } })).toMatchObject({
      started: true,
      ok: true
    })
  })

  it('NR-7 多层嵌套按完整路径点名（a.b.c）', async () => {
    const eng = makeEngine({
      entries: [
        entryOf(
          fileOf({
            inputSchema: {
              type: 'object',
              properties: {
                a: {
                  type: 'object',
                  properties: { b: { type: 'object', required: ['c'] } }
                }
              }
            }
          })
        )
      ]
    })
    const res = await eng.engine.invoke({ workflow: 'wf', input: { a: { b: {} } } })
    expect(res.reason).toBe('invalid-input')
    expect(res.error).toContain('input is missing required field(s): a.b.c')
  })
})
