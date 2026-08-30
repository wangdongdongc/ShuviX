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
