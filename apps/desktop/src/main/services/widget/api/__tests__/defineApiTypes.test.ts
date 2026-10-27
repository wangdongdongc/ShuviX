/**
 * `defineApi` / `op` 的类型（编译期断言，经 `npm run typecheck:node` 生效 —— 本目录的测试文件在主进程的类型检查范围里）。
 *
 * 组件作者在编辑器里写 `api.ts` 时看的就是这些类型：带类型的操作必须放得进 `defineApi`
 * （曾经在严格函数类型下每个 handler 都报 TS2322），返回值与 `output` 不符时要报错。
 */
import { describe, expect, it } from 'vitest'
import { defineApi, op, z } from '../sandboxRuntime'

const Book = z.object({ id: z.number(), title: z.string(), status: z.enum(['want', 'done']) })

const api = defineApi({
  listBooks: op.read({
    description: 'List books.',
    input: z.object({ status: z.enum(['want', 'done']).optional(), limit: z.number().default(50) }),
    output: z.array(Book),
    handler: async ({ status, limit }, ctx) => {
      // 参数按 input 推断：limit 有缺省值，handler 里是 number
      const n: number = limit
      void n
      return ctx.db.sql<
        z.infer<typeof Book>
      >`SELECT * FROM books WHERE ${status ?? null} IS NULL LIMIT ${limit}`
    }
  }),
  addBook: op.write({
    description: 'Add a book.',
    input: z.object({ title: z.string().min(1) }),
    output: Book,
    async handler({ title }, ctx) {
      const [row] = await ctx.db.sql<
        z.infer<typeof Book>
      >`INSERT INTO books (title) VALUES (${title}) RETURNING *`
      return row
    }
  }),
  // 没有 output：返回什么都行
  touch: op.write({
    description: 'Touch.',
    input: z.object({}),
    handler: (_input, ctx) => ctx.db.run`UPDATE books SET status = status`
  }),
  saveLayout: op.write({
    description: 'UI only.',
    agent: false,
    input: z.object({ columns: z.number() }),
    handler: () => null
  })
})

// 返回值与 output 不符 → 类型错误
op.read({
  description: 'x',
  input: z.object({}),
  output: z.number(),
  // @ts-expect-error 返回字符串，output 是 number
  handler: () => 'not a number'
})

// 参数类型来自 input：读不存在的字段 → 类型错误
op.read({
  description: 'x',
  input: z.object({ a: z.string() }),
  // @ts-expect-error input 里没有 b
  handler: ({ b }) => b
})

// 不是操作的值放不进 defineApi
// @ts-expect-error 普通对象不是操作
defineApi({ nope: { description: 'x', input: z.object({}), handler: () => 1 } })

describe('defineApi 的类型', () => {
  it('带类型的操作放得进 defineApi，模式与名字保留', () => {
    expect(Object.keys(api)).toEqual(['listBooks', 'addBook', 'touch', 'saveLayout'])
    expect(api.listBooks.mode).toBe('read')
    expect(api.addBook.mode).toBe('write')
    expect(api.saveLayout.agent).toBe(false)
  })
})
