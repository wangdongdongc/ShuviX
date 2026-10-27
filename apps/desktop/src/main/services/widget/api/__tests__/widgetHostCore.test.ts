/**
 * `services/widget/api/widgetHostCore.ts` —— 组件宿主的核心，在测试进程里直接 `new WidgetHostCore()`：真的 QuickJS，
 * **没有 SQLite**（这里的 better-sqlite3 是为 Electron 编的，Node 里只能 import、不能建连接；本文件的操作都不碰 ctx.db）。
 * API 包由 widgetApiKit 的 `bundleApi` 打（与 BundlerService.buildApi 同一个入口），`call` 的 bundlePath 是临时目录里的文件。
 * 设计稿 docs/widget-tool-design.md §6、§8。cpuMs 用真的短值，不用假时钟。
 *
 *   K-1  `for(;;){}`、cpuMs 200 → HostFailure timeout，一秒左右；下一次调用照常，模块级计数器从头开始（上下文换新了）
 *   K-2  `for(;;) await null` → timeout
 *   K-3  分配超过 64 MB → out_of_memory；下一次调用在新的上下文上照常
 *   K-4  无限递归 → internal「stack overflow」；测试进程活着；下一次调用照常
 *   K-5  `await new Promise(()=>{})` → internal「never finished」，远早于 cpuMs
 *   K-6  同一个 bundleHash → 计数 1,2,3（热上下文）；换 hash + 文件 → 新代码、计数重来；forget 之后重来；bundlePath 不存在 → no_api
 *   K-7  manifest：合规 → ops；顶层抛错 → internal + 那句话；顶层碰 `__host.db` →「only available inside an operation」；
 *        没装运行时的 JS →「did not install the widget runtime」
 *   K-8  结果超过 8 MB → 结果 too_large（上下文留着）；日志最多 200 条 × 2000 字；caller 原样到 handler；
 *        没有的操作 / 参数不对是结果（wrote:false），不是失败
 *   K-9  [P2] 17 个组件 → 最久没用的那个被淘汰（计数重来），最近用过的接着数
 *   K-10 [P2] handler 自己 `throw new InternalError('interrupted')` → 也报成 timeout（钉住现状）
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HostFailure, MAX_WARM_SANDBOXES, WidgetHostCore } from '../widgetHostCore'
import type { CallResult, HostRequestBody, WidgetCaller } from '../hostProtocol'
import { bundleApi } from './widgetApiKit'

const USER: WidgetCaller = { kind: 'user', label: 'user' }

const HEAD = `import { defineApi, op, z } from 'shuvix/widget-api'\n`

/** 主测试 API：一个模块级计数器 + 各种出事的 handler */
const MAIN_API = `${HEAD}
let n = 0
const none = z.object({})
export default defineApi({
  count: op.read({ description: 'count', input: none, handler: () => ++n }),
  spin: op.read({ description: 'spin', input: none, handler: () => { for (;;) {} } }),
  spinAsync: op.read({ description: 'spin async', input: none, handler: async () => { for (;;) await null } }),
  hog: op.read({
    description: 'hog',
    input: none,
    handler: () => {
      const keep: number[][] = []
      for (;;) keep.push(new Array(100000).fill(1))
    }
  }),
  recurse: op.read({
    description: 'recurse',
    input: none,
    handler: () => {
      const f = (x: number): number => f(x + 1) + 1
      return f(0)
    }
  }),
  hang: op.read({ description: 'hang', input: none, handler: async () => { await new Promise(() => {}); return 1 } }),
  huge: op.read({ description: 'huge', input: none, handler: () => 'x'.repeat(9 * 1024 * 1024) }),
  chatty: op.read({
    description: 'chatty',
    input: none,
    handler: (_a, ctx) => {
      for (let i = 0; i < 250; i++) ctx.log(String(i).padEnd(3000, '.'))
      return 'ok'
    }
  }),
  who: op.read({ description: 'who', input: none, handler: (_a, ctx) => ctx.caller }),
  add: op.write({ description: 'add', input: z.object({ title: z.string() }), handler: (a) => a.title }),
  fakeInterrupt: op.read({
    description: 'throws InternalError("interrupted") itself',
    input: none,
    handler: () => { throw new (globalThis as any).InternalError('interrupted') }
  })
})
`

let dir = ''
let mainBundle = ''
let mainCode = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'whost-core-'))
  mainCode = await bundleApi(MAIN_API)
  mainBundle = join(dir, 'main.js')
  writeFileSync(mainBundle, mainCode)
}, 60_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

interface CallOptions {
  widgetId?: string
  bundlePath?: string
  bundleHash?: string
  cpuMs?: number
  mode?: 'read' | 'write'
  caller?: WidgetCaller
  args?: unknown
}

function callRequest(op: string, o: CallOptions = {}): HostRequestBody {
  const widgetId = o.widgetId ?? 'w-main'
  return {
    type: 'call',
    target: { widgetId, dbPath: join(dir, 'data', widgetId, 'data.sqlite') },
    bundlePath: o.bundlePath ?? mainBundle,
    bundleHash: o.bundleHash ?? 'main',
    op,
    mode: o.mode ?? 'read',
    args: o.args ?? {},
    caller: o.caller ?? USER,
    cpuMs: o.cpuMs ?? 2000
  }
}

async function call(core: WidgetHostCore, op: string, o: CallOptions = {}): Promise<CallResult> {
  return (await core.handle(callRequest(op, o))) as CallResult
}

/** 成功结果的值 */
async function callValue(core: WidgetHostCore, op: string, o: CallOptions = {}): Promise<unknown> {
  const r = await call(core, op, o)
  if (!r.outcome.ok) throw new Error(`expected success, got ${JSON.stringify(r.outcome)}`)
  return r.outcome.value
}

/** 期望 handle 以 HostFailure 失败 → 那个失败 */
async function hostFailure(p: Promise<unknown>): Promise<HostFailure> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(HostFailure)
    return e as HostFailure
  }
  throw new Error('expected a HostFailure, the request succeeded')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('K-1..K-5 VM 层的失败', () => {
  it('K-1 for(;;){}、cpuMs 200 → timeout（一秒左右）；之后照常、计数器从头开始', async () => {
    const core = new WidgetHostCore()
    expect(await callValue(core, 'count')).toBe(1)
    expect(await callValue(core, 'count')).toBe(2)

    const started = Date.now()
    const err = await hostFailure(call(core, 'spin', { cpuMs: 200 }))
    const elapsed = Date.now() - started
    expect(err.code).toBe('timeout')
    expect(err.message).toBe('The operation ran too long and was stopped.')
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(1500)

    expect(await callValue(core, 'count')).toBe(1)
    expect(await callValue(core, 'count')).toBe(2)
    core.closeAll()
  })

  it('K-2 for(;;) await null → timeout', async () => {
    const core = new WidgetHostCore()
    const started = Date.now()
    const err = await hostFailure(call(core, 'spinAsync', { cpuMs: 200 }))
    expect(err.code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1500)
    expect(await callValue(core, 'count')).toBe(1)
    core.closeAll()
  })

  it('K-3 分配超过 64 MB → out_of_memory；下一次调用在新的上下文上照常', async () => {
    const core = new WidgetHostCore()
    expect(await callValue(core, 'count')).toBe(1)
    const err = await hostFailure(call(core, 'hog', { cpuMs: 10_000 }))
    expect(err.code).toBe('out_of_memory')
    expect(err.message).toBe('The operation used too much memory and was stopped.')
    expect(await callValue(core, 'count')).toBe(1)
    core.closeAll()
  }, 30_000)

  it('K-4 无限递归 → internal「stack overflow」；进程活着，下一次照常', async () => {
    const core = new WidgetHostCore()
    expect(await callValue(core, 'count')).toBe(1)
    const err = await hostFailure(call(core, 'recurse', { cpuMs: 5000 }))
    expect(err.code).toBe('internal')
    expect(err.message).toMatch(/stack overflow/i)
    expect(await callValue(core, 'count')).toBe(1)
    core.closeAll()
  })

  it('K-5 await 一个永远不落定的 Promise → internal「never finished」，远早于 cpuMs', async () => {
    const core = new WidgetHostCore()
    const started = Date.now()
    const err = await hostFailure(call(core, 'hang', { cpuMs: 5000 }))
    expect(err.code).toBe('internal')
    expect(err.message).toBe(
      'The operation never finished: it awaited something that never settles.'
    )
    expect(Date.now() - started).toBeLessThan(1000)
    expect(await callValue(core, 'count')).toBe(1)
    core.closeAll()
  })
})

describe('K-6 热上下文与 bundleHash', () => {
  it('K-6 同一个 hash → 1,2,3；换 hash + 文件 → 新代码、重来；forget 之后重来', async () => {
    const core = new WidgetHostCore()
    expect(await callValue(core, 'count')).toBe(1)
    expect(await callValue(core, 'count')).toBe(2)
    expect(await callValue(core, 'count')).toBe(3)

    const v2 = join(dir, 'v2.js')
    writeFileSync(
      v2,
      await bundleApi(`${HEAD}
let n = 0
export default defineApi({ count: op.read({ description: 'v2', input: z.object({}), handler: () => 'v2:' + ++n }) })
`)
    )
    expect(await callValue(core, 'count', { bundlePath: v2, bundleHash: 'v2' })).toBe('v2:1')
    expect(await callValue(core, 'count', { bundlePath: v2, bundleHash: 'v2' })).toBe('v2:2')

    expect(await core.handle({ type: 'forget', widgetId: 'w-main' })).toBeNull()
    expect(await callValue(core, 'count', { bundlePath: v2, bundleHash: 'v2' })).toBe('v2:1')

    // 没见过的组件：forget 什么都不做
    expect(await core.handle({ type: 'forget', widgetId: 'w-never-seen' })).toBeNull()
    core.closeAll()
  }, 30_000)

  it('K-6 bundlePath 不存在 → no_api', async () => {
    const core = new WidgetHostCore()
    const err = await hostFailure(
      call(core, 'count', {
        widgetId: 'w-missing',
        bundlePath: join(dir, 'nope', 'api.js'),
        bundleHash: 'x'
      })
    )
    expect(err.code).toBe('no_api')
    expect(err.message).toMatch(/^The widget's API build is missing \(/)
    core.closeAll()
  })
})

describe('K-7 manifest', () => {
  it('K-7 合规的包 → ops 与 errors', async () => {
    const core = new WidgetHostCore()
    const manifest = (await core.handle({
      type: 'manifest',
      bundleCode: mainCode,
      cpuMs: 5000
    })) as { ops: { name: string; mode: string }[]; errors: string[] }
    expect(manifest.errors).toEqual([])
    expect(manifest.ops.map((o) => o.name)).toEqual([
      'count',
      'spin',
      'spinAsync',
      'hog',
      'recurse',
      'hang',
      'huge',
      'chatty',
      'who',
      'add',
      'fakeInterrupt'
    ])
    expect(manifest.ops.find((o) => o.name === 'add')?.mode).toBe('write')

    // 清单里的错误是结果，不是失败
    const withErrors = (await core.handle({
      type: 'manifest',
      bundleCode: await bundleApi(`${HEAD}
export default defineApi({ Bad: op.read({ description: 'x', input: z.object({}), handler: () => 1 }) })
`),
      cpuMs: 5000
    })) as { ops: unknown[]; errors: string[] }
    expect(withErrors.ops).toEqual([])
    expect(withErrors.errors).toHaveLength(1)
    expect(withErrors.errors[0]).toContain('Operation name "Bad"')
  })

  it('K-7 顶层抛错 → internal + 那句话', async () => {
    const core = new WidgetHostCore()
    const code = await bundleApi(`${HEAD}
if (Math.random() < 2) throw new Error('boom at top level')
export default defineApi({})
`)
    const err = await hostFailure(core.handle({ type: 'manifest', bundleCode: code, cpuMs: 5000 }))
    expect(err.code).toBe('internal')
    expect(err.message).toContain('boom at top level')
  })

  it('K-7 顶层碰 __host.db → only available inside an operation', async () => {
    const core = new WidgetHostCore()
    const code = await bundleApi(`${HEAD}
const rows = (globalThis as any).__host.db('all', 'SELECT 1', '[]')
export default defineApi({ a: op.read({ description: 'x', input: z.object({}), handler: () => rows }) })
`)
    const err = await hostFailure(core.handle({ type: 'manifest', bundleCode: code, cpuMs: 5000 }))
    expect(err.code).toBe('internal')
    expect(err.message).toContain('The database is only available inside an operation.')
  })

  it('K-7 没装运行时的 JS → did not install the widget runtime', async () => {
    const core = new WidgetHostCore()
    const err = await hostFailure(
      core.handle({ type: 'manifest', bundleCode: 'var x = 1', cpuMs: 5000 })
    )
    expect(err.code).toBe('internal')
    expect(err.message).toBe('The API bundle did not install the widget runtime.')
  })
})

describe('K-8 结果的上限与透传', () => {
  it('K-8 结果超过 8 MB → too_large 结果，上下文留着', async () => {
    const core = new WidgetHostCore()
    expect(await callValue(core, 'count')).toBe(1)
    const r = await call(core, 'huge', { cpuMs: 10_000 })
    expect(r.outcome).toEqual({
      ok: false,
      error: { code: 'too_large', message: 'The operation returned more than 8 MB of data.' }
    })
    expect(r.wrote).toBe(false)
    // 上下文没换：计数器接着数
    expect(await callValue(core, 'count')).toBe(2)
    core.closeAll()
  }, 30_000)

  it('K-8 日志最多 200 条、每条最多 2000 字', async () => {
    const core = new WidgetHostCore()
    const r = await call(core, 'chatty')
    expect(r.outcome).toEqual({ ok: true, value: 'ok' })
    expect(r.logs).toHaveLength(200)
    expect(r.logs.every((l) => l.length === 2000)).toBe(true)
    expect(r.logs[0].startsWith('0..')).toBe(true)
    expect(r.logs[199].startsWith('199')).toBe(true)
    core.closeAll()
  })

  it('K-8 caller 原样到 handler', async () => {
    const core = new WidgetHostCore()
    const caller: WidgetCaller = { kind: 'agent', sessionId: 's-1', actor: 'cli', label: 'cli' }
    expect(await callValue(core, 'who', { caller })).toEqual(caller)
    core.closeAll()
  })

  it('K-8 没有的操作 / 参数不对 → 结果（wrote:false），不是失败', async () => {
    const core = new WidgetHostCore()
    const unknown = await call(core, 'nope')
    expect(unknown.wrote).toBe(false)
    expect(unknown.outcome.ok).toBe(false)
    expect(!unknown.outcome.ok && unknown.outcome.error.code).toBe('unknown_op')

    const invalid = await call(core, 'add', { mode: 'write', args: { title: 1 } })
    expect(invalid.wrote).toBe(false)
    expect(!invalid.outcome.ok && invalid.outcome.error.code).toBe('invalid_args')
    expect(!invalid.outcome.ok && invalid.outcome.error.message).toContain('title')

    expect(await callValue(core, 'add', { mode: 'write', args: { title: 'a' } })).toBe('a')
    core.closeAll()
  })
})

describe('K-9 / K-10 [P2]', () => {
  it(`K-9 ${MAX_WARM_SANDBOXES + 1} 个组件 → 最久没用的被淘汰，最近用过的接着数`, async () => {
    const core = new WidgetHostCore()
    const ids = Array.from({ length: MAX_WARM_SANDBOXES + 1 }, (_, i) => `w-${i}`)
    // w-0 … w-15 各数一次
    for (const id of ids.slice(0, MAX_WARM_SANDBOXES)) {
      expect(await callValue(core, 'count', { widgetId: id })).toBe(1)
      await sleep(3)
    }
    // w-0 又用了一次：最久没用的变成 w-1
    expect(await callValue(core, 'count', { widgetId: 'w-0' })).toBe(2)
    await sleep(3)
    // 第 17 个组件建上下文 → 淘汰 w-1
    expect(await callValue(core, 'count', { widgetId: ids[MAX_WARM_SANDBOXES] })).toBe(1)
    await sleep(3)
    expect(await callValue(core, 'count', { widgetId: 'w-0' })).toBe(3)
    expect(await callValue(core, 'count', { widgetId: 'w-2' })).toBe(2)
    expect(await callValue(core, 'count', { widgetId: 'w-1' })).toBe(1)
    core.closeAll()
  }, 60_000)

  it('K-10 handler 自己抛 InternalError("interrupted") → 也报成 timeout（钉住现状）', async () => {
    const core = new WidgetHostCore()
    expect(await callValue(core, 'count')).toBe(1)
    const err = await hostFailure(call(core, 'fakeInterrupt'))
    expect(err.code).toBe('timeout')
    // 上下文被当成不可信换掉了
    expect(await callValue(core, 'count')).toBe(1)
    core.closeAll()
  })
})
