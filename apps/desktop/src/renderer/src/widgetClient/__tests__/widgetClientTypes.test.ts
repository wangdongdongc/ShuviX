/**
 * `shuvix/widget` 的类型（编译期断言，经 `npm run typecheck:web` 生效 —— 渲染层的测试文件在 web 的类型检查范围里；
 * vitest 跑的只是最后那一条运行时用例）。
 *
 * 组件作者写 `createClient<typeof Api>()` 时看到的就是这些类型。渲染层不能 import 主进程的 sandboxRuntime，所以这里
 * 用真的 zod 照抄一份 `OpDef` / `op`（形状与 sandboxRuntime.ts 一致：`output` 可选、handler 的返回在没有 output 时是
 * unknown）—— 改了那边的 OpDef，这里要跟着改。
 *
 *   WC-60 不认识的操作名、参数类型不对 → 类型错误
 *   WC-61 参数取 input 的**输入**侧：有缺省值的字段可以不给；全是可选的操作可以不给参数
 *   WC-62 结果：`call` 是 output 的形状；`use(...).data` 是它 | undefined；`.error` 是 WidgetError | undefined
 *   WC-63 不给类型参数：任何操作名、任何参数，结果 unknown
 *   WC-64 原来的类型缺口：T-1（output 有缺省值的字段，界面拿到的是**输出**侧 → 必有）、T-3（有必填参数的操作
 *         不能省略参数，call 与 use 都是）已修；T-2（没有 output 的操作结果是 unknown —— OpDef 把这种 handler 的返回
 *         声明成 unknown）钉住
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { createClient, WidgetError, type UseResult } from '../widgetClient'

// ─── sandboxRuntime.ts 的 OpDef / op 的照抄（只取类型上有用的部分） ───────────────────────

type AnyObjectSchema = z.ZodObject<z.ZodRawShape>

interface OpDef<I extends AnyObjectSchema, O extends z.ZodType | undefined> {
  description: string
  input: I
  output?: O
  agent?: boolean
  handler: (
    input: z.output<I>,
    ctx: unknown
  ) => O extends z.ZodType ? z.input<O> | Promise<z.input<O>> : unknown
}

type Op<I extends AnyObjectSchema, O extends z.ZodType | undefined> = OpDef<I, O> & {
  readonly mode: 'read' | 'write'
}

function makeOp(mode: 'read' | 'write') {
  return <I extends AnyObjectSchema, O extends z.ZodType | undefined = undefined>(
    def: OpDef<I, O>
  ): Op<I, O> => ({ ...def, mode })
}

const op = { read: makeOp('read'), write: makeOp('write') }

// ─── 一套 API ───────────────────────────────────────────────────────────────

const Book = z.object({ id: z.number(), title: z.string(), status: z.enum(['want', 'done']) })
type Book = z.output<typeof Book>

const Api = {
  listBooks: op.read({
    description: 'List books.',
    input: z.object({ status: z.enum(['want', 'done']).optional(), limit: z.number().default(50) }),
    output: z.array(Book),
    handler: () => []
  }),
  addBook: op.write({
    description: 'Add a book.',
    input: z.object({ title: z.string() }),
    output: Book,
    handler: ({ title }) => ({ id: 1, title, status: 'want' as const })
  }),
  // T-1：output 里有缺省值的字段
  counter: op.read({
    description: 'A counter.',
    input: z.object({}),
    output: z.object({ n: z.number().default(0) }),
    handler: () => ({})
  }),
  // T-2：没有 output
  touch: op.write({
    description: 'Touch.',
    input: z.object({}),
    handler: () => 1
  })
}

/** 只给类型检查看，从不调用（里面的 call 会真的发请求） */
function typeOnly(): void {
  const api = createClient<typeof Api>()

  // WC-60
  // @ts-expect-error 没有这个操作
  void api.call('nope')
  // @ts-expect-error title 是字符串
  void api.call('addBook', { title: 1 })
  // @ts-expect-error input 里没有 extra
  void api.call('addBook', { title: 'x', extra: true })
  // @ts-expect-error use 也一样：没有这个操作
  api.use('nope', null)

  // WC-61：limit 有缺省值（输入侧可选），status 可选 → `{}` 与不给参数都行
  void api.call('listBooks', {})
  void api.call('listBooks', { status: 'done' })
  void api.call('listBooks')
  api.use('listBooks')
  api.use('listBooks', null)
  void api.call('touch')

  // WC-62
  expectTypeOf(api.call('addBook', { title: 'Dune' })).resolves.toEqualTypeOf<Book>()
  expectTypeOf(api.call('listBooks', {})).resolves.toEqualTypeOf<Book[]>()
  expectTypeOf(api.use('listBooks', null).data).toEqualTypeOf<Book[] | undefined>()
  expectTypeOf(api.use('listBooks', null).error).toEqualTypeOf<WidgetError | undefined>()
  expectTypeOf(api.use('listBooks', null).loading).toEqualTypeOf<boolean>()
  expectTypeOf(api.use('listBooks', null).refetch).toEqualTypeOf<() => void>()

  // WC-63
  const loose = createClient()
  void loose.call('anything')
  void loose.call('anything', { a: 1 })
  void loose.call('anything', 5)
  expectTypeOf(loose.call('x')).resolves.toBeUnknown()
  expectTypeOf(loose.use('x', null)).toEqualTypeOf<UseResult<unknown>>()

  // WC-64 T-1（已修）：结果是 output 的输出侧，有缺省值的字段必有
  expectTypeOf(api.call('counter')).resolves.toEqualTypeOf<{ n: number }>()
  // WC-64 T-3（已修）：有必填参数的操作不能省略参数
  // @ts-expect-error addBook 的 title 必填
  void api.call('addBook')
  // @ts-expect-error use 也不能省略
  api.use('addBook')
  api.use('addBook', null)
  api.use('addBook', { title: 'x' })
  // WC-64 T-2（钉住）：没有 output 的操作结果是 unknown
  expectTypeOf(api.call('touch')).resolves.toBeUnknown()
}

describe('shuvix/widget 的类型', () => {
  it('类型断言在 typecheck:web 里生效；运行时客户端交回 call / use / onData', () => {
    expect(typeof typeOnly).toBe('function')
    // 照抄的 op 与真的一样：操作带上 mode
    expect(Object.keys(Api)).toEqual(['listBooks', 'addBook', 'counter', 'touch'])
    expect(Api.addBook.mode).toBe('write')
    const api = createClient<typeof Api>()
    expect(Object.keys(api).sort()).toEqual(['call', 'onData', 'use'])
    expect(new WidgetError('c', 'm')).toBeInstanceOf(Error)
  })
})
