/**
 * `services/widget/api/sandboxRuntime.ts`（`shuvix/widget-api`）—— 沙箱里的运行时，这里直接在 Node 里跑：
 * `buildManifest` / `callOp` / `__installWidgetRuntime` 拿一个假的宿主（`db` / `tx` / `log` / `uuid` 都是记录调用的 spy）。
 * 设计稿 docs/widget-tool-design.md §3、§6。
 *
 *   R-1  清单：read 操作（`.default(50)` + `.describe()`）、带 output 的 write 操作、`agent:false` 操作 → 按键的顺序、带 mode、
 *        description 去空白、agent 标记；有缺省值的字段不算 required 且留着说明；output 只在声明了时出现；errors []
 *   R-2  每个坏操作一条错误、好的照样列出：名字 AddBook / add_book / 1x / 49 字 / ''；不是操作（普通对象、函数）；
 *        有品牌没 mode 的对象过得了这里（mode undefined，由宿主的 A-5 拒绝）；空白说明；input 是 z.string() / 普通对象 / 没有；
 *        没 handler；agent:'no'
 *   R-3  input 里 z.date() / z.bigint() / z.map() → 带「Use z.string() with a format」提示的错误；output z.date() → output 的错误；
 *        output 不是 zod → 错误；带 transform / refine 的 input 照收
 *   R-4  api 是 undefined / null / 数组 / 数字 → 一条「must `export default defineApi`」；`{}` → 「defines no operations」
 *   R-5  没有的操作（含继承来的 toString / constructor / __proto__ / hasOwnProperty）→ unknown_op，只列自己的键，handler 不调
 *   R-6  参数不对 → invalid_args（prettifyError 的文本，点名字段）；null / undefined 参数当 `{}`；多余的键去掉；缺省值补上；
 *        refine 不过 → invalid_args
 *   R-7  返回值对不上 output → bad_output「returned a value that does not match」；output 的 transform 生效；没 output 原样；
 *        undefined → null
 *   R-8  ctx.fail('not_found', m) → 那个码；不合格的码（Bad、a-b、''、49 字、1x）与宿主保留码（internal … host_*）→ failed；
 *        message 转成字符串；抛 Error → internal + message；抛字符串 / 对象 → internal + String(e)；tx 里 ctx.fail → 回滚、码留着；
 *        name 为 InternalError 的错误 → callOp 直接 reject（不是一个结果）
 *   R-9  模板插值：布尔 / 日期 / 对象 / 数组 / undefined / null / 数字 / 字符串各一个 `?`，参数 JSON 精确；BigInt → 报错、宿主不调；
 *        run → kind run，解析 {changes,lastInsertRowid}；query(text) 的 params 缺省 []
 *   R-10 事务次序（begin 返回保存点名）：正常 begin→commit(name)；抛错 rollback(name) 并重抛；经回调拿到的对象嵌套
 *        begin,begin,commit,commit；里层抛、外层接住 begin,begin,rollback,commit；同步回调也行；同一层第二个并发的 tx
 *        立刻 reject，不碰 host.tx
 *   R-11 __installWidgetRuntime：从全局摘掉 `__host`；manifest() 是 JSON；handler 读 `globalThis.__host` 看到 undefined
 *        （→ internal TypeError）；call 回 JSON 字符串；caller 到得了 ctx.caller；没有宿主 →「The widget runtime has no host.」；
 *        返回 10n / 循环引用 → bad_output「is not JSON」；函数 / symbol → bad_output。每条用例后清掉全局
 *   R-12 ctx.now() 是 ISO；ctx.uuid() → host.uuid；ctx.log('a', {b:1}, 循环对象) → 一次 host.log `'a {"b":1} [object Object]'`
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  __installWidgetRuntime,
  buildManifest,
  callOp,
  defineApi,
  op,
  z,
  type CallOutcome,
  type WidgetCaller,
  type WidgetCtx
} from '../sandboxRuntime'

type SandboxHostArg = Parameters<typeof callOp>[1]

const USER: WidgetCaller = { kind: 'user', label: 'user' }

/**
 * `defineApi` 本身只是原样返回；它的类型约束 `Record<string, Op>` 在 strictFunctionTypes 下收不下具体的操作
 * （handler 的参数比 `Record<string, unknown>` 窄），所以用例经这个包一层再调它
 */
const apiOf = (ops: Record<string, unknown>): Record<string, unknown> =>
  defineApi(ops as Parameters<typeof defineApi>[0])

interface FakeHost {
  /** host.tx 的每次调用：[action] 或 [action, name] */
  txCalls: string[][]
  db: Mock<(kind: 'all' | 'run', text: string, params: string) => string>
  tx: Mock<(action: 'begin' | 'commit' | 'rollback', name?: string) => string>
  log: Mock<(text: string) => void>
  uuid: Mock<() => string>
}

/** 记录调用的假宿主：`db` 回事先定好的行，`tx` 的 begin 回 sp0、sp1 … */
function fakeHost(rows: unknown[] = []): FakeHost {
  let next = 0
  const txCalls: string[][] = []
  const host: FakeHost = {
    txCalls,
    db: vi.fn((kind: 'all' | 'run', _text: string, _params: string): string =>
      kind === 'run' ? JSON.stringify({ changes: 2, lastInsertRowid: 7 }) : JSON.stringify(rows)
    ),
    tx: vi.fn((action: 'begin' | 'commit' | 'rollback', name?: string): string => {
      txCalls.push(name === undefined ? [action] : [action, name])
      return action === 'begin' ? `sp${next++}` : (name ?? '')
    }),
    log: vi.fn((_text: string): void => {}),
    uuid: vi.fn((): string => '11111111-2222-4333-8444-555555555555')
  }
  return host
}

/** 一个操作的 API，跑一次，回结果 */
async function runHandler(
  handler: (input: Record<string, unknown>, ctx: WidgetCtx) => unknown,
  host: FakeHost = fakeHost(),
  options: { args?: unknown; caller?: WidgetCaller } = {}
): Promise<CallOutcome> {
  const api = apiOf({
    x: op.write({ description: 'x', input: z.object({}).passthrough(), handler: handler as never })
  })
  return callOp(api, host as SandboxHostArg, 'x', options.args ?? {}, options.caller ?? USER)
}

function failure(outcome: CallOutcome): { code: string; message: string } {
  if (outcome.ok) throw new Error(`expected a failure, got ${JSON.stringify(outcome)}`)
  return outcome.error
}

function value(outcome: CallOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected success, got ${JSON.stringify(outcome)}`)
  return outcome.value
}

const base = { description: 'd', input: z.object({}), handler: () => 1 }

describe('R-1 清单：好的 API', () => {
  it('R-1 按键的顺序、mode、去空白的说明、agent 标记；缺省值字段不 required 且留说明；output 只在声明时出现', () => {
    const api = apiOf({
      listBooks: op.read({
        description: '  List books, newest first.  \n',
        input: z.object({
          limit: z.number().default(50).describe('How many books'),
          q: z.string()
        }),
        handler: async () => []
      }),
      addBook: op.write({
        description: 'Add a book.',
        input: z.object({ title: z.string() }),
        output: z.object({ id: z.string() }),
        handler: async () => ({ id: 'a' })
      }),
      saveLayout: op.write({
        description: 'Save the layout.',
        input: z.object({}),
        agent: false,
        handler: async () => null
      })
    })
    const manifest = buildManifest(api)
    expect(manifest.errors).toEqual([])
    expect(manifest.ops.map((o) => [o.name, o.mode, o.description, o.agent])).toEqual([
      ['listBooks', 'read', 'List books, newest first.', true],
      ['addBook', 'write', 'Add a book.', true],
      ['saveLayout', 'write', 'Save the layout.', false]
    ])
    const input = manifest.ops[0].input as {
      type: string
      properties: Record<string, { default?: unknown; description?: string; type?: string }>
      required?: string[]
    }
    expect(input.type).toBe('object')
    expect(input.required).toEqual(['q'])
    expect(input.properties.limit).toMatchObject({
      default: 50,
      description: 'How many books',
      type: 'number'
    })
    expect('output' in manifest.ops[0]).toBe(false)
    expect('output' in manifest.ops[2]).toBe(false)
    expect(manifest.ops[1].output).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    })
  })
})

describe('R-2 坏操作各一条错误', () => {
  it('R-2 每个坏操作一条错误，好的照样列出；有品牌没 mode 的对象在这里过（mode undefined）', () => {
    const good = op.read({ description: 'ok', input: z.object({}), handler: () => 1 })
    const api: Record<string, unknown> = {
      AddBook: good,
      add_book: good,
      '1x': good,
      ['a'.repeat(49)]: good,
      '': good,
      plain: { a: 1 },
      fn: () => 1,
      noMode: { __shuvixWidgetOp: true, ...base },
      blank: op.read({ ...base, description: '   ' }),
      strInput: op.read({ ...base, input: z.string() } as never),
      objInput: op.read({ ...base, input: { a: z.string() } } as never),
      noInput: op.read({ description: 'd', handler: () => 1 } as never),
      noHandler: op.read({ description: 'd', input: z.object({}) } as never),
      agentNo: op.read({ ...base, agent: 'no' } as never),
      ['b'.repeat(48)]: good,
      good
    }
    const manifest = buildManifest(api)
    expect(manifest.ops.map((o) => o.name)).toEqual(['noMode', 'b'.repeat(48), 'good'])
    expect(manifest.ops[0].mode).toBeUndefined()
    expect(manifest.errors).toHaveLength(13)

    const nameError = (n: string): string =>
      `Operation name "${n}" must start with a lowercase letter and use only letters and digits (camelCase, at most 48).`
    expect(manifest.errors).toEqual(
      expect.arrayContaining([
        nameError('AddBook'),
        nameError('add_book'),
        nameError('1x'),
        nameError('a'.repeat(49)),
        nameError(''),
        '"plain" is not an operation: define it with op.read({...}) or op.write({...}).',
        '"fn" is not an operation: define it with op.read({...}) or op.write({...}).',
        'Operation "blank" needs a description (written for the agent: what it does and when to use it).',
        'Operation "strInput" needs input: z.object({...}) (use z.object({}) when it takes no arguments).',
        'Operation "objInput" needs input: z.object({...}) (use z.object({}) when it takes no arguments).',
        'Operation "noInput" needs input: z.object({...}) (use z.object({}) when it takes no arguments).',
        'Operation "noHandler" needs a handler function.',
        'Operation "agentNo": agent must be true or false.'
      ])
    )
  })
})

describe('R-3 描述不成 JSON Schema 的类型', () => {
  it.each([
    ['z.date()', z.object({ d: z.date() })],
    ['z.bigint()', z.object({ n: z.bigint() })],
    ['z.map()', z.object({ m: z.map(z.string(), z.number()) })]
  ])('R-3 input 含 %s → 带 z.string() 提示的错误', (_label, input) => {
    const manifest = buildManifest({ bad: op.read({ ...base, input }) })
    expect(manifest.ops).toEqual([])
    expect(manifest.errors).toHaveLength(1)
    expect(manifest.errors[0]).toMatch(
      /^Operation "bad": its input cannot be described as JSON Schema \(/
    )
    expect(manifest.errors[0]).toContain(
      'Use z.string() with a format for dates, numbers instead of bigint, and objects instead of maps.'
    )
  })

  it('R-3 output z.date() → output 的错误；output 不是 zod → 错误', () => {
    const manifest = buildManifest({
      a: op.read({ ...base, output: z.date() } as never),
      b: op.read({ ...base, output: { id: 'string' } } as never)
    })
    expect(manifest.ops).toEqual([])
    expect(manifest.errors[0]).toMatch(
      /^Operation "a": its output cannot be described as JSON Schema \(.+\)\.$/
    )
    expect(manifest.errors[0]).not.toContain('Use z.string()')
    expect(manifest.errors[1]).toBe('Operation "b": output must be a zod schema.')
  })

  it('R-3 带 transform / refine 的 input 照收', () => {
    const manifest = buildManifest({
      t: op.read({
        ...base,
        input: z.object({ s: z.string().transform((s) => s.length) }).refine(() => true, 'never')
      })
    })
    expect(manifest.errors).toEqual([])
    expect(manifest.ops[0].input).toMatchObject({
      type: 'object',
      properties: { s: { type: 'string' } }
    })
  })
})

describe('R-4 不是一个 API', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['数组', [op.read(base)]],
    ['数字', 42]
  ])('R-4 %s → 一条 export default defineApi 错误', (_label, api) => {
    expect(buildManifest(api)).toEqual({
      ops: [],
      errors: ['api.ts must `export default defineApi({ ... })`.']
    })
  })

  it('R-4 {} → defines no operations', () => {
    expect(buildManifest({})).toEqual({ ops: [], errors: ['api.ts defines no operations.'] })
  })
})

describe('R-5 没有的操作', () => {
  it.each(['nope', 'toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'R-5 %s → unknown_op，只列自己的键，handler 不调',
    async (name) => {
      const handler = vi.fn(() => 1)
      const api = apiOf({
        alpha: op.read({ ...base, handler }),
        beta: op.write({ ...base, handler })
      })
      const host = fakeHost()
      const outcome = await callOp(api, host as SandboxHostArg, name, {}, USER)
      expect(failure(outcome)).toEqual({
        code: 'unknown_op',
        message: `This widget has no operation "${name}". Its operations: alpha, beta.`
      })
      expect(handler).not.toHaveBeenCalled()
      expect(host.db).not.toHaveBeenCalled()
    }
  )
})

describe('R-6 参数', () => {
  const input = z.object({ title: z.string(), n: z.number().default(3) })

  it('R-6 参数不对 → invalid_args，文本就是 prettifyError，点名字段；handler 不调', async () => {
    const handler = vi.fn(() => 1)
    const api = apiOf({ add: op.write({ ...base, input, handler }) })
    const outcome = await callOp(api, fakeHost() as SandboxHostArg, 'add', { title: 1 }, USER)
    const err = failure(outcome)
    expect(err.code).toBe('invalid_args')
    expect(err.message).toBe(z.prettifyError(input.safeParse({ title: 1 }).error!))
    expect(err.message).toContain('title')
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['undefined', undefined]
  ])('R-6 参数 %s 当 {}：缺省值补上', async (_label, args) => {
    const seen: unknown[] = []
    const api = apiOf({
      list: op.read({
        ...base,
        input: z.object({ limit: z.number().default(50) }),
        handler: (a) => {
          seen.push(a)
          return 'ok'
        }
      })
    })
    const outcome = await callOp(api, fakeHost() as SandboxHostArg, 'list', args, USER)
    expect(value(outcome)).toBe('ok')
    expect(seen).toEqual([{ limit: 50 }])
  })

  it('R-6 多余的键去掉，缺省值补上', async () => {
    const seen: unknown[] = []
    const api = apiOf({
      add: op.write({
        ...base,
        input,
        handler: (a) => {
          seen.push(a)
          return null
        }
      })
    })
    await callOp(api, fakeHost() as SandboxHostArg, 'add', { title: 'a', extra: 'x' }, USER)
    expect(seen).toEqual([{ title: 'a', n: 3 }])
  })

  it('R-6 refine 不过 → invalid_args，带 refine 的话', async () => {
    const api = apiOf({
      pos: op.read({
        ...base,
        input: z.object({ a: z.number() }).refine((v) => v.a > 0, 'a must be positive')
      })
    })
    const err = failure(await callOp(api, fakeHost() as SandboxHostArg, 'pos', { a: -1 }, USER))
    expect(err.code).toBe('invalid_args')
    expect(err.message).toContain('a must be positive')
  })
})

describe('R-7 返回值', () => {
  it('R-7 对不上 output → bad_output', async () => {
    const api = apiOf({
      get: op.read({
        ...base,
        output: z.object({ id: z.string() }),
        handler: () => ({ id: 1 }) as never
      })
    })
    const err = failure(await callOp(api, fakeHost() as SandboxHostArg, 'get', {}, USER))
    expect(err.code).toBe('bad_output')
    expect(err.message).toMatch(
      /^Operation "get" returned a value that does not match its output schema:\n/
    )
    expect(err.message).toContain('id')
  })

  it('R-7 output 的 transform 生效、多余的键按 zod 去掉', async () => {
    const api = apiOf({
      a: op.read({
        ...base,
        output: z.object({ n: z.number() }).transform((v) => ({ ...v, doubled: v.n * 2 })),
        handler: () => ({ n: 2 })
      }),
      b: op.read({
        ...base,
        output: z.object({ id: z.string() }),
        handler: () => ({ id: 'x', extra: 1 }) as never
      })
    })
    const host = fakeHost() as SandboxHostArg
    expect(value(await callOp(api, host, 'a', {}, USER))).toEqual({ n: 2, doubled: 4 })
    expect(value(await callOp(api, host, 'b', {}, USER))).toEqual({ id: 'x' })
  })

  it('R-7 没有 output → 原样；undefined → null', async () => {
    const obj = { a: [1, { b: 'c' }] }
    expect(value(await runHandler(() => obj))).toBe(obj)
    expect(value(await runHandler(() => undefined))).toBeNull()
    expect(value(await runHandler(async () => undefined))).toBeNull()
    expect(value(await runHandler(() => 0))).toBe(0)
  })
})

describe('R-8 失败', () => {
  it("R-8 ctx.fail('not_found', m) → 那个码", async () => {
    expect(failure(await runHandler((_, ctx) => ctx.fail('not_found', 'No such book.')))).toEqual({
      code: 'not_found',
      message: 'No such book.'
    })
    expect(failure(await runHandler((_, ctx) => ctx.fail('a'.repeat(48), 'm'))).code).toBe(
      'a'.repeat(48)
    )
  })

  it.each([
    'Bad',
    'a-b',
    '',
    'a'.repeat(49),
    '1x',
    'internal',
    'invalid_args',
    'unknown_op',
    'bad_output',
    'too_large',
    'out_of_memory',
    'timeout',
    'interrupted',
    'no_api',
    'sql_refused',
    'host_exited',
    'host_unavailable',
    'host_x'
  ])('R-8 不合格 / 保留的码 %j → failed，message 留着', async (code) => {
    expect(failure(await runHandler((_, ctx) => ctx.fail(code, 'why')))).toEqual({
      code: 'failed',
      message: 'why'
    })
  })

  it('R-8 message 转成字符串', async () => {
    expect(failure(await runHandler((_, ctx) => ctx.fail('x', 42 as never))).message).toBe('42')
  })

  it('R-8 抛 Error → internal + message；抛字符串 / 对象 → internal + String(e)', async () => {
    expect(
      failure(
        await runHandler(() => {
          throw new Error('boom')
        })
      )
    ).toEqual({ code: 'internal', message: 'boom' })
    expect(
      failure(
        await runHandler(async () => {
          throw 'plain string'
        })
      )
    ).toEqual({ code: 'internal', message: 'plain string' })
    expect(
      failure(
        await runHandler(() => {
          throw { a: 1 }
        })
      )
    ).toEqual({ code: 'internal', message: '[object Object]' })
  })

  it('R-8 tx 里 ctx.fail → 回滚记下了，码留着', async () => {
    const host = fakeHost()
    const outcome = await runHandler((_, ctx) => ctx.db.tx(() => ctx.fail('conflict', 'dup')), host)
    expect(failure(outcome)).toEqual({ code: 'conflict', message: 'dup' })
    expect(host.txCalls).toEqual([['begin'], ['rollback', 'sp0']])
  })

  it('R-8 name 为 InternalError 的错误 → callOp reject（交给宿主换掉上下文）', async () => {
    const vmError = new Error('out of memory')
    vmError.name = 'InternalError'
    await expect(
      runHandler(() => {
        throw vmError
      })
    ).rejects.toBe(vmError)
  })
})

describe('R-9 SQL 参数', () => {
  it('R-9 每个插值一个 ?，值按规则转换', async () => {
    const host = fakeHost([{ a: 1 }])
    const outcome = await runHandler(
      (_, ctx) =>
        ctx.db
          .sql`SELECT ${true}, ${false}, ${new Date(0)}, ${{ a: 1 }}, ${[1, 2]}, ${undefined}, ${null}, ${3}, ${'s'}`,
      host
    )
    expect(value(outcome)).toEqual([{ a: 1 }])
    expect(host.db).toHaveBeenCalledTimes(1)
    const [kind, text, params] = host.db.mock.calls[0]
    expect(kind).toBe('all')
    expect(text).toBe('SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?')
    expect(params).toBe('[1,0,"1970-01-01T00:00:00.000Z","{\\"a\\":1}","[1,2]",null,null,3,"s"]')
  })

  it('R-9 BigInt → 报错，宿主不调', async () => {
    const host = fakeHost()
    const err = failure(await runHandler((_, ctx) => ctx.db.sql`SELECT ${BigInt(10)}`, host))
    expect(err.code).toBe('internal')
    expect(err.message).toBe('BigInt values cannot be stored; convert to a number or string first')
    expect(host.db).not.toHaveBeenCalled()
  })

  it('R-9 run → kind run，结果解析成 {changes,lastInsertRowid}', async () => {
    const host = fakeHost()
    const outcome = await runHandler(
      (_, ctx) => ctx.db.run`UPDATE t SET x = ${1} WHERE id = ${'a'}`,
      host
    )
    expect(value(outcome)).toEqual({ changes: 2, lastInsertRowid: 7 })
    expect(host.db.mock.calls).toEqual([['run', 'UPDATE t SET x = ? WHERE id = ?', '[1,"a"]']])
  })

  it('R-9 query(text) 的 params 缺省 []；给了就照规则转换', async () => {
    const host = fakeHost([])
    await runHandler(async (_, ctx) => {
      await ctx.db.query('SELECT 1')
      await ctx.db.query('SELECT ?, ?', [true, { b: 2 }])
      return null
    }, host)
    expect(host.db.mock.calls).toEqual([
      ['all', 'SELECT 1', '[]'],
      ['all', 'SELECT ?, ?', '[1,"{\\"b\\":2}"]']
    ])
  })
})

describe('R-10 事务次序', () => {
  it('R-10 正常结束 → begin、commit(name)；值返回', async () => {
    const host = fakeHost()
    const outcome = await runHandler(
      (_, ctx) =>
        ctx.db.tx(async (t) => {
          await t.run`INSERT INTO t VALUES (1)`
          return 'done'
        }),
      host
    )
    expect(value(outcome)).toBe('done')
    expect(host.txCalls).toEqual([['begin'], ['commit', 'sp0']])
  })

  it('R-10 回调抛错 → rollback(name) 并重抛', async () => {
    const host = fakeHost()
    let caught: unknown
    await runHandler(async (_, ctx) => {
      try {
        await ctx.db.tx(async () => {
          throw new Error('nope')
        })
      } catch (e) {
        caught = e
      }
      return null
    }, host)
    expect((caught as Error).message).toBe('nope')
    expect(host.txCalls).toEqual([['begin'], ['rollback', 'sp0']])
  })

  it('R-10 经回调拿到的对象嵌套 → begin,begin,commit,commit（从里往外）', async () => {
    const host = fakeHost()
    const outcome = await runHandler(
      (_, ctx) => ctx.db.tx(async (t) => (await t.tx(async () => 1)) + 1),
      host
    )
    expect(value(outcome)).toBe(2)
    expect(host.txCalls).toEqual([['begin'], ['begin'], ['commit', 'sp1'], ['commit', 'sp0']])
  })

  it('R-10 里层抛、外层接住 → begin,begin,rollback(里),commit(外)', async () => {
    const host = fakeHost()
    const outcome = await runHandler(
      (_, ctx) =>
        ctx.db.tx(async (t) => {
          try {
            await t.tx(async () => {
              throw new Error('inner')
            })
          } catch {
            // 外层接住里层的失败
          }
          return 'outer ok'
        }),
      host
    )
    expect(value(outcome)).toBe('outer ok')
    expect(host.txCalls).toEqual([['begin'], ['begin'], ['rollback', 'sp1'], ['commit', 'sp0']])
  })

  it('R-10 同步回调也行', async () => {
    const host = fakeHost()
    expect(value(await runHandler((_, ctx) => ctx.db.tx(() => 5), host))).toBe(5)
    expect(host.txCalls).toEqual([['begin'], ['commit', 'sp0']])
  })

  it('R-10 同一层第二个并发的 tx 立刻 reject，不碰 host.tx；第一个照常提交，之后再开一个也行', async () => {
    const host = fakeHost()
    const outcome = await runHandler(async (_, ctx) => {
      const settled = await Promise.allSettled([
        ctx.db.tx(async (t) => {
          await t.run`INSERT INTO t VALUES ('A')`
          return 'a'
        }),
        ctx.db.tx(async (t) => {
          await t.run`INSERT INTO t VALUES ('B')`
          throw new Error('b failed')
        })
      ])
      const after = await ctx.db.tx(() => 'later')
      return [
        ...settled.map((s) => (s.status === 'fulfilled' ? s.value : (s.reason as Error).message)),
        after
      ]
    }, host)
    expect(value(outcome)).toEqual([
      'a',
      'Another ctx.db.tx is still running here; await it first, or nest by calling tx on the object your callback receives.',
      'later'
    ])
    // 第二个 tx 连 begin 都没调；B 的插入从没发给宿主
    expect(host.txCalls).toEqual([['begin'], ['commit', 'sp0'], ['begin'], ['commit', 'sp1']])
    expect(host.db.mock.calls.map((c) => c[1])).toEqual(["INSERT INTO t VALUES ('A')"])
  })

  it('R-10 回调里在外层对象上再开 tx → 同样被拒（嵌套要用回调拿到的对象）', async () => {
    const host = fakeHost()
    const err = failure(
      await runHandler((_, ctx) => ctx.db.tx(async () => ctx.db.tx(async () => 1)), host)
    )
    expect(err.message).toContain('Another ctx.db.tx is still running here')
    expect(host.txCalls).toEqual([['begin'], ['rollback', 'sp0']])
  })
})

describe('R-11 __installWidgetRuntime', () => {
  type Installed = {
    manifest(): string
    call(name: string, argsJson: string, callerJson: string): Promise<string>
  }
  const g = globalThis as unknown as { __host?: unknown; __widget?: Installed }

  afterEach(() => {
    delete g.__host
    delete g.__widget
  })

  function install(api: unknown, host: FakeHost | null = fakeHost()): Installed {
    if (host) g.__host = host
    __installWidgetRuntime(api)
    return g.__widget!
  }

  const callJson = async (
    w: Installed,
    name: string,
    args: unknown = {},
    caller: WidgetCaller = USER
  ): Promise<CallOutcome> => {
    const out = await w.call(name, JSON.stringify(args), JSON.stringify(caller))
    expect(typeof out).toBe('string')
    return JSON.parse(out) as CallOutcome
  }

  it('R-11 __host 从全局摘掉；manifest() 回 JSON 文本', () => {
    const w = install(apiOf({ a: op.read(base), b: op.write(base) }))
    expect('__host' in globalThis).toBe(false)
    const manifest = JSON.parse(w.manifest()) as { ops: { name: string }[]; errors: string[] }
    expect(manifest.ops.map((o) => o.name)).toEqual(['a', 'b'])
    expect(manifest.errors).toEqual([])
  })

  it('R-11 handler 读 globalThis.__host 看到 undefined → internal TypeError；宿主照样从闭包里用得上', async () => {
    const host = fakeHost()
    const w = install(
      apiOf({
        peek: op.read({
          ...base,
          handler: () => (globalThis as unknown as { __host: { uuid(): string } }).__host.uuid()
        }),
        id: op.read({ ...base, handler: (_, ctx) => ctx.uuid() })
      }),
      host
    )
    const err = failure(await callJson(w, 'peek'))
    expect(err.code).toBe('internal')
    expect(err.message).toMatch(/undefined/)
    expect(value(await callJson(w, 'id'))).toBe('11111111-2222-4333-8444-555555555555')
    expect(host.uuid).toHaveBeenCalledTimes(1)
  })

  it('R-11 call 回 JSON 字符串；caller 到得了 ctx.caller；空的 argsJson 当 {}', async () => {
    const w = install(
      apiOf({
        who: op.read({ ...base, handler: (_, ctx) => ctx.caller }),
        dflt: op.read({
          ...base,
          input: z.object({ n: z.number().default(9) }),
          handler: (a) => a.n
        })
      })
    )
    const caller: WidgetCaller = { kind: 'agent', sessionId: 's1', actor: 'cli', label: 'cli' }
    expect(value(await callJson(w, 'who', {}, caller))).toEqual(caller)
    expect(JSON.parse(await w.call('dflt', '', JSON.stringify(USER)))).toEqual({
      ok: true,
      value: 9
    })
  })

  it('R-11 没有宿主 → The widget runtime has no host.', async () => {
    const handler = vi.fn(() => 1)
    const w = install(apiOf({ a: op.read({ ...base, handler }) }), null)
    expect(await callJson(w, 'a')).toEqual({
      ok: false,
      error: { code: 'internal', message: 'The widget runtime has no host.' }
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('R-11 返回 10n / 循环引用 → bad_output「is not JSON」', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const w = install(
      apiOf({
        big: op.read({ ...base, handler: () => BigInt(10) }),
        cyc: op.read({ ...base, handler: () => cyclic })
      })
    )
    for (const name of ['big', 'cyc']) {
      const err = failure(await callJson(w, name))
      expect(err.code).toBe('bad_output')
      expect(err.message).toMatch(
        new RegExp(`^Operation "${name}" returned a value that is not JSON: `)
      )
    }
  })

  it('R-11 返回函数 / symbol → bad_output', async () => {
    const w = install(
      apiOf({
        fn: op.read({ ...base, handler: () => () => 1 }),
        sym: op.read({ ...base, handler: () => Symbol('s') })
      })
    )
    expect(failure(await callJson(w, 'fn'))).toEqual({
      code: 'bad_output',
      message: 'Operation "fn" returned a function; return JSON data instead.'
    })
    expect(failure(await callJson(w, 'sym'))).toEqual({
      code: 'bad_output',
      message: 'Operation "sym" returned a symbol; return JSON data instead.'
    })
  })

  it('R-11 api 是 undefined → 清单一条错误；调用 → unknown_op', async () => {
    const w = install(undefined)
    expect(JSON.parse(w.manifest())).toEqual({
      ops: [],
      errors: ['api.ts must `export default defineApi({ ... })`.']
    })
    expect(failure(await callJson(w, 'a')).code).toBe('unknown_op')
  })
})

describe('R-12 ctx 的小工具', () => {
  it('R-12 now() 是 ISO 时间；uuid() 来自 host.uuid', async () => {
    const host = fakeHost()
    const before = Date.now()
    const out = value(await runHandler((_, ctx) => [ctx.now(), ctx.uuid()], host)) as string[]
    expect(out[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Date.parse(out[0])).toBeGreaterThanOrEqual(before - 1)
    expect(Date.parse(out[0])).toBeLessThanOrEqual(Date.now() + 1)
    expect(out[1]).toBe('11111111-2222-4333-8444-555555555555')
    expect(host.uuid).toHaveBeenCalledTimes(1)
  })

  it("R-12 log('a', {b:1}, 循环对象) → 一次 host.log，空格连起来", async () => {
    const host = fakeHost()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await runHandler((_, ctx) => {
      ctx.log('a', { b: 1 }, cyclic)
      return null
    }, host)
    expect(host.log.mock.calls).toEqual([['a {"b":1} [object Object]']])
  })
})
