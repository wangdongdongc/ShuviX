# 小组件的 API

存储记录的小组件（widget）在 `api.ts` 里定义它的操作。界面调用它们，用户允许的任何智能体也调用它们，走的是同样的输入校验、同样的处理函数（handler）和同样的数据库：同一件事无论谁来做，效果都相同。

## `api.ts`

```ts
import { defineApi, op, z } from 'shuvix/widget-api'

const Status = z.enum(['want', 'reading', 'done'])
const Book = z.object({ id: z.number(), title: z.string(), author: z.string().nullable(), status: Status })

export default defineApi({
  listBooks: op.read({
    description:
      'List books on the reading list, newest first. Filter by status to see what the user wants to read, is reading or has finished.',
    input: z.object({
      status: Status.optional(),
      limit: z.number().int().min(1).max(200).default(50)
    }),
    output: z.array(Book),
    handler: ({ status, limit }, ctx) => ctx.db.sql`
      SELECT id, title, author, status FROM books
      WHERE ${status ?? null} IS NULL OR status = ${status ?? null}
      ORDER BY created_at DESC LIMIT ${limit}`
  }),

  addBook: op.write({
    description: 'Add a book. A title already on the list is updated instead of duplicated. Returns the book.',
    input: z.object({
      title: z.string().min(1).describe('The title as the user wrote it'),
      author: z.string().optional(),
      status: Status.default('want')
    }),
    output: Book,
    async handler({ title, author, status }, ctx) {
      const [row] = await ctx.db.sql<z.infer<typeof Book>>`
        INSERT INTO books (title, author, status, added_by)
        VALUES (${title}, ${author ?? null}, ${status}, ${ctx.caller.label})
        ON CONFLICT (title) DO UPDATE SET author = COALESCE(excluded.author, books.author), status = excluded.status
        RETURNING id, title, author, status`
      return row
    }
  }),

  saveColumns: op.write({
    agent: false,
    description: 'Remember how many columns the list shows.',
    input: z.object({ columns: z.number().int().min(1).max(4) }),
    handler: ({ columns }, ctx) =>
      ctx.db.run`INSERT INTO settings (key, value) VALUES ('columns', ${columns})
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value`
  })
})
```

- **`op.read`** 从不改动数据：它的语句在只读连接上运行，会写入的语句会被拒绝。**`op.write`** 改动数据；它提交时，小组件每个打开着的副本都会重新获取数据。
- **名称**用 camelCase 的动词 + 名词（`addBook`、`listBooks`），最多 48 个字符。
- **`description`** 是写给将要调用它的智能体看的：它做什么、什么时候用、调用两次会怎样。关于这个操作，智能体看不到别的任何东西。
- **`input`** 是一个 `z.object(...)`；用用户的说法（用户按书名来想时用 `title`，而不是 `bookId`），在显而易见的地方给缺省值，把 schema 表达不了的约束写进 `.describe()`。`z.date()`、`z.bigint()` 和 `z.map()` 无法向智能体描述，会让构建失败：日期用 ISO 字符串传。
- **`output`**（可选）会和处理函数的返回值核对，并展示给智能体；凡是智能体要读的，都给它。
- **`agent: false`** 让一个操作只供界面使用（布局、显示偏好）。用户对自己的记录做的一切，都要让智能体看得见。
- **能幂等就幂等**：添加时已存在就更新而不是重复添加，直接设定值而不是来回切换。智能体会重试。

## `ctx`：处理函数能触及的一切

处理函数运行在 ShuviX 这一侧的沙箱里，不在浏览器里。没有网络，没有文件访问，没有 `require`，没有定时器：只有 `ctx`。

| 绑定                                       | 作用                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| ``ctx.db.sql`…` ``                         | 一条语句 → 它的行（`RETURNING` 的行也算；没有行的语句得到 `[]`）。`${}` 里的值会变成绑定参数：绝不用字符串拼 SQL。         |
| ``ctx.db.run`…` ``                         | 一条没有行的语句 → `{ changes, lastInsertRowid }`。                                                                        |
| `ctx.db.query(text, params)`               | 同上，只是 `?` 占位符由你手写。                                                                                            |
| `ctx.db.tx(async (tx) => …)`               | 必须一起发生的多次写入：回调返回时提交，抛异常时回滚。在里面用 `tx`（而不是 `ctx.db`）。                                   |
| `ctx.fail(code, message)`                  | 以一个界面和智能体都能看到的错误结束这次调用：`code` 是小写 snake_case（`title_taken`），`message` 说明应该改做什么。       |
| `ctx.caller`                               | `{ kind: 'user' }` 或 `{ kind: 'agent', sessionId, actor }`，带一个 `label`，用来记录是谁做的。                            |
| `ctx.now()`、`ctx.uuid()`、`ctx.log(...)`  | 当前时间（ISO 8601）、一个随机 UUID、一行日志（`call` 会显示它们）。                                                       |

语句只能是 `SELECT`、`WITH`、`INSERT`、`UPDATE`、`DELETE`、`REPLACE` 和 `VALUES`，每次调用一条。表通过 `sql` 改动（`data.md`），绝不在处理函数里改。`op.write` 的每条语句各自提交，除非它在 `ctx.db.tx` 里面。

限制：每次调用 64 MB 内存、20 秒计算时间、总共 30 秒；递归深度大约 1000 层。模块级变量可能在两次调用之间保留下来，但构建或出错会重置它们：不要依赖它们。

## 界面

```tsx
import { createClient, WidgetError } from 'shuvix/widget'
import type Api from './api'

const api = createClient<typeof Api>()

function Books() {
  const { data, error, loading, refetch } = api.use('listBooks', { status: 'want' })
  const add = async (title: string) => {
    try {
      await api.call('addBook', { title })
    } catch (e) {
      if (e instanceof WidgetError) setMessage(e.message)
    }
  }
  …
}
```

- **始终用 `import type`**：`api.ts` 运行在 ShuviX 这一侧，把它当作值 import 会让构建失败。
- **`api.use(op, args)`** 在组件挂载时、`args` 变化时（按 JSON 比较）以及任何写入提交之后加载，不管写入来自这个界面、另一台设备还是一个智能体。重新加载时它保留之前的 `data`。还没有参数时把 `args` 传成 `null`，它就会等着。
- **`api.call(op, args)`** 以操作的结果 resolve，或者抛出一个带 `code` 和 `message` 的 `WidgetError`；把消息显示在原处。写入之后不需要重新获取：每个 `use` 都会自己重新获取。
- **`api.onData(listener)`** 在有任何东西被写入时告诉你（`{ op, source }`），供你自己维护状态时使用。
- `shuvix/widget` 还导出 `useTheme()` 和 `themeColor(name)`，给需要把主题颜色当作值来用的代码（`design.md`）。

## 测试

绿色的 `build` 之后，用 `call` 调一遍你加的或改的每个操作：

- 写操作用 `dry_run: true`：调用真的会运行，它写入的一切随后都会回滚。只供界面使用的操作也能这样调用。
- 输入不对时返回 `invalid_args`，附带操作的输入 schema；`ctx.fail` 返回 `[code] message`；处理函数里的异常返回 `Widget operation failed: …`。

然后用 `preview` 检查界面。
