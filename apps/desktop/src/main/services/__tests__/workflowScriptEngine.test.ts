/**
 * node:vm 脚本引擎 × 引擎失败归类的**跨 realm** 接线。
 *
 * 引擎（agent-runtime）自己的测试用 AsyncFunction 引擎跑脚本 —— 脚本与引擎同一个 realm，
 * `instanceof Error` 恒真，什么都测不出来。桌面真正落地的是 node:vm：脚本在另一个 realm
 * 里执行，引擎抛进去的错 `instanceof` 那边的 `Error` 为假，脚本抛出来的错在宿主这边同样
 * 为假。失败归类（`errorCode` / `errorStep`）因此**只能**靠 typeof 读属性 —— 这一组钉的
 * 就是：错误对象跨膜之后，code 与 step 两个方向都还在，而且是**同一个对象**（脚本 catch
 * 后 rethrow 不会被更外层的 run 改写）。
 *
 * 夹具与 agent-runtime 的 workflow/__tests__/harness.ts 同形，但脚本引擎换成真件
 * `nodeVmScriptEngine`；不走 workflowService 的扫描夹具 —— 这里测的是膜，不是注册表。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createWorkflowEngine,
  type InProcessAgentType,
  type ParsedWorkflowFile,
  type RunTaskParams,
  type SubAgentManager,
  type WorkflowEngine
} from '@shuvix/agent-runtime'
import { nodeVmScriptEngine } from '../workflowScriptEngine'

const PROFILE: InProcessAgentType = {
  name: 'worker',
  displayName: 'Worker',
  description: '',
  tools: ['read'],
  systemPrompt: 'S'
}

const fileOf = (script: string): ParsedWorkflowFile => ({
  name: 'wf',
  displayName: 'wf',
  description: '',
  bindings: [],
  vars: {},
  limits: {},
  concurrency: 'parallel',
  script,
  prompts: {},
  schemas: {}
})

type RunTaskResult = { result: string; structured?: unknown }

interface Harness {
  engine: WorkflowEngine
  runTask: ReturnType<typeof vi.fn>
  records: Array<Record<string, unknown>>
  /** 脚本 `log()` 落下的消息（run 收尾之后脱手运行的脚本照样能记，见 VM-3） */
  logs: () => string[]
  end: () => Record<string, unknown> | undefined
}

function makeEngine(
  script: string,
  runTaskImpl: (p: RunTaskParams) => Promise<RunTaskResult> = async () => ({ result: 'ok' })
): Harness {
  const records: Array<Record<string, unknown>> = []
  const runTask = vi.fn(runTaskImpl)
  const engine = createWorkflowEngine({
    manager: { runTask } as unknown as SubAgentManager,
    script: nodeVmScriptEngine,
    listWorkflows: () => [{ file: fileOf(script), source: 'builtin' }],
    resolveAgentProfile: (ref) => (ref === 'worker' ? PROFILE : null),
    resolveRunModel: async () => ({ provider: 'p', model: 'm', capabilities: {} }),
    onRecord: (_name, _runId, rec) => {
      records.push(rec)
    },
    env: { host: 'desktop', platform: 'darwin' }
  })
  return {
    engine,
    runTask,
    records,
    logs: () => records.filter((r) => r.type === 'log').map((r) => String(r.message)),
    end: () => records.find((r) => r.type === 'end')
  }
}

/** 挂到 parentAbortSignal 落下为止再交回（真 manager 被中止后也是「回来一个没有 structured 的结果」） */
const hangUntilAborted = (p: RunTaskParams): Promise<RunTaskResult> =>
  new Promise((resolve) => {
    const signal = p.parentAbortSignal
    if (!signal) return
    if (signal.aborted) {
      resolve({ result: '' })
      return
    }
    signal.addEventListener('abort', () => resolve({ result: '' }), { once: true })
  })

/**
 * VM：引擎抛进 vm 的错、vm 抛回引擎的错、以及中止之后的脚本续体 —— 三条跨膜路径。
 *
 * 为什么单独存在：引擎的 `errCode` / `errStep` 刻意写成 typeof 判定而不是 `instanceof`
 * 错误子类，理由就是 node:vm 的 realm 边界；而这条理由在同 realm 的引擎测试里永远
 * 触发不到。这里是它唯一的验收面。
 */
describe('VM —— 失败归类跨 node:vm realm', () => {
  it.each([
    [
      'unknown_agent（第 0 步，ref 名原样挂在 step.agent 上）',
      {
        script: [
          'try {',
          "  await run('ghost', 'p')",
          '} catch (e) {',
          '  log(`caught ${e.code} @${e.step.index}:${e.step.agent} instanceof=${e instanceof Error}`)',
          '  throw e',
          '}'
        ].join('\n'),
        runTask: undefined as ((p: RunTaskParams) => Promise<RunTaskResult>) | undefined,
        code: 'unknown_agent',
        step: { index: 0, agent: 'ghost' },
        logged: 'caught unknown_agent @0:ghost instanceof=false'
      }
    ],
    [
      'next_not_called（第 1 步，档案名挂在 step.agent 上）',
      {
        script: [
          "await run('worker', 'warm-up')",
          'try {',
          "  await run('worker', 'p', { schema: { type: 'object' } })",
          '} catch (e) {',
          '  log(`caught ${e.code} @${e.step.index}:${e.step.agent} instanceof=${e instanceof Error}`)',
          '  throw e',
          '}'
        ].join('\n'),
        runTask: async (): Promise<RunTaskResult> => ({ result: 'just prose' }),
        code: 'next_not_called',
        step: { index: 1, agent: 'worker' },
        logged: 'caught next_not_called @1:worker instanceof=false'
      }
    ]
  ])('VM-1 vm 内 catch 引擎的 %s 并 rethrow → errorCode / errorStep 原样交回', async (_n, c) => {
    const h = makeEngine(c.script, c.runTask)
    const res = await h.engine.invoke({ workflow: 'wf' })

    // 脚本那边读到的就是引擎挂上去的 code 与 step —— 虽然它在 vm 里连 Error 都不算
    expect(h.logs()).toContain(c.logged)
    // rethrow 之后回到宿主：同一个对象，归类没有被更外层改写
    expect(res).toMatchObject({
      started: true,
      ok: false,
      errorCode: c.code,
      errorStep: c.step
    })
    expect(h.end()).toMatchObject({ ok: false, code: c.code, step: c.step })
  })

  it.each([
    [
      'vm realm 的 Error 实例',
      "throw Object.assign(new Error('x'), { code: 'c', step: { index: 2, agent: 'z' } })",
      // 宿主这边它不是 Error（另一个 realm 的构造器）：errText 走 String(err)
      'Error: x'
    ],
    [
      '连 Error 都不是的普通对象',
      "throw { code: 'c', step: { index: 2, agent: 'z' } }",
      '[object Object]'
    ]
  ])(
    'VM-2 脚本在 vm 里抛的错（%s）→ errorCode / errorStep 按 typeof 读出',
    async (_n, script, errorText) => {
      // 归类若靠 instanceof 判定，脚本自己造的带 code 的错就会被读成「无归类」
      const h = makeEngine(script)
      const res = await h.engine.invoke({ workflow: 'wf' })

      expect(res).toMatchObject({
        started: true,
        ok: false,
        error: errorText,
        errorCode: 'c',
        errorStep: { index: 2, agent: 'z' }
      })
      expect(h.end()).toMatchObject({ ok: false, code: 'c', step: { index: 2, agent: 'z' } })
      expect(h.runTask).not.toHaveBeenCalled()
    }
  )

  it('VM-3 vm 内 .catch 吞掉 step_aborted 之后再 run() → 首行即拒绝（run_aborted），runTask 只派发过一次', async () => {
    // 外部 signal 在第 0 步在飞时落下：run 以 run_aborted 收尾，而脚本（node:vm 无法硬中断
    // 异步续体）还在脱手跑 —— 它把被中止的那一步 .catch 吞掉再往下派发，下一次 run() 必须
    // 在第一行就拒绝，不能再派发一个 agent 出去
    const script = [
      "const first = await run('worker', 'one').catch((e) => `swallowed:${e.code}`)",
      'log(first)',
      "const second = await run('worker', 'two').catch((e) => `rejected:${e.code}`)",
      'log(second)',
      "return 'detached-return'"
    ].join('\n')
    const h = makeEngine(script, hangUntilAborted)
    const ac = new AbortController()
    const pending = h.engine.invoke({ workflow: 'wf', signal: ac.signal })
    await vi.waitFor(() => expect(h.runTask).toHaveBeenCalledTimes(1))

    ac.abort()
    const res = await pending
    // race 那一路先落下：结果是 run 级的 run_aborted（带 code、没有 step —— 不是哪一步坏了）
    expect(res).toMatchObject({ started: true, ok: false, errorCode: 'run_aborted' })
    expect(res.errorStep).toBeUndefined()
    expect(h.end()).toMatchObject({ ok: false, code: 'run_aborted' })

    // 脱手的续体：被中止的第 0 步以 step_aborted 抛出并被吞掉，第 1 步在首行以 run_aborted 拒绝
    await vi.waitFor(() => expect(h.logs()).toContain('rejected:run_aborted'))
    expect(h.logs()).toEqual(['swallowed:step_aborted', 'rejected:run_aborted'])
    expect(h.runTask).toHaveBeenCalledTimes(1)
    expect(h.engine.runningCount()).toBe(0)
  })

  it('VM-3b 传入已 aborted 的 signal → 结果仍带 errorCode run_aborted，脚本首行 run() 的拒绝不成为 unhandled rejection', async () => {
    // nodeVmScriptEngine.execute 在同步段之后自查 signal：引擎的 race 分支对已 aborted 的 signal
    // 虽也同步拒绝（带 code），但两者此刻都已 settled，而 exec 在 race 数组里排第一 —— 赢的是
    // execute 抛的那个。它因此必须带同一个 code，否则「有人按了停止」会被宿主读成认不出的失败；
    // 同时脚本的 Promise（首行 run() 以 run_aborted 拒绝）要被接住 —— 没人 await 它
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const script = ["log('entered')", "return await run('worker', 'p')"].join('\n')
      const h = makeEngine(script)
      const ac = new AbortController()
      ac.abort()
      const res = await h.engine.invoke({ workflow: 'wf', signal: ac.signal })
      expect(res).toMatchObject({ started: true, ok: false, errorCode: 'run_aborted' })
      expect(res.errorStep).toBeUndefined()
      expect(h.end()).toMatchObject({ ok: false, code: 'run_aborted' })
      expect(h.runTask).not.toHaveBeenCalled()
      // 同步段确实跑过（log 落下了），异步续体的拒绝被 execute 自己接住
      expect(h.logs()).toEqual(['entered'])
      await new Promise((r) => setImmediate(r))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
