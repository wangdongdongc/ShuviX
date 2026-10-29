# The widget's API

A widget that keeps records defines its operations in `api.ts`. The screen calls them, and so does any agent the user allows, with the same input checks, the same handler and the same database: an action has the same effect whoever takes it.

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

- **`op.read`** never changes data: its statements run on a read-only connection, and one that would write is refused. **`op.write`** changes data; when it commits, every open copy of the widget refetches.
- **Names** are camelCase verb + noun (`addBook`, `listBooks`), at most 48 characters.
- **`description`** is written for the agent that will call it: what it does, when to use it, what happens if it is called twice. Agents see nothing else about the operation.
- **`input`** is a `z.object(...)`; use the user's words (`title`, not `bookId`, when the user thinks in titles), defaults where they are obvious, and put constraints a schema cannot show into `.describe()`. `z.date()`, `z.bigint()` and `z.map()` cannot be described to agents and fail the build: pass dates as ISO strings.
- **`output`** (optional) is checked against what the handler returns and shown to agents; give it for anything an agent will read.
- **`agent: false`** keeps an operation for the screen only (layout, display preferences). Everything the user does with their records stays visible to agents.
- **Idempotent where it can be**: an add that updates instead of duplicating, a set instead of a toggle. Agents retry.

## `ctx`: everything a handler can reach

Handlers run in a sandbox on ShuviX's side, not in the browser. There is no network, no file access, no `require`, no timers: only `ctx`.

| Binding                                    | What it does                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| ``ctx.db.sql`…` ``                         | One statement → its rows (`RETURNING` rows too; `[]` for a statement without rows). Values in `${}` become bound parameters: never build SQL from strings. |
| ``ctx.db.run`…` ``                         | One statement without rows → `{ changes, lastInsertRowid }`.                                                                                       |
| `ctx.db.query(text, params)`               | The same with `?` placeholders written by hand.                                                                                                    |
| `ctx.db.tx(async (tx) => …)`               | Several writes that must happen together: committed when the callback returns, rolled back when it throws. Use `tx` (not `ctx.db`) inside it.       |
| `ctx.fail(code, message)`                  | End the call with an error the screen and the agent both see: `code` is lowercase snake_case (`title_taken`), `message` says what to do instead.   |
| `ctx.caller`                               | `{ kind: 'user' }` or `{ kind: 'agent', sessionId, actor }`, with a `label` to record who did it.                                                  |
| `ctx.now()`, `ctx.uuid()`, `ctx.log(...)`  | The time (ISO 8601), a random UUID, a log line (`call` shows them).                                                                                |

Statements are `SELECT`, `WITH`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE` and `VALUES`, one per call. Tables change through `sql` (`data.md`), never from a handler. Each statement of an `op.write` commits on its own unless it is inside `ctx.db.tx`.

Limits: 64 MB of memory, 20 s of computing and 30 s in all per call; recursion about 1000 levels deep. Module-level variables may survive between calls but are reset by a build or an error: do not rely on them.

## The screen

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

- **`import type`**, always: `api.ts` runs on ShuviX's side, and importing it as a value fails the build.
- **`api.use(op, args)`** loads when the component mounts, when `args` changes (compared as JSON) and after any write is committed, by this screen, another device or an agent. It keeps the previous `data` while it reloads. Pass `null` as `args` to wait until you have them.
- **`api.call(op, args)`** resolves with the operation's result or throws a `WidgetError` with `code` and `message`; show the message inline. There is no need to refetch after a write: every `use` refetches by itself.
- **`api.onData(listener)`** tells you when anything was written (`{ op, source }`), if you keep state of your own.
- `shuvix/widget` also exports `useTheme()` and `themeColor(name)`, for code that needs the theme's colors as values (`design.md`).

## Test it

After a green `build`, `call` each operation you added or changed:

- `dry_run: true` for writes: the call runs for real and everything it wrote is rolled back. Screen-only operations can be called this way too.
- A wrong input comes back as `invalid_args` with the operation's input schema; a `ctx.fail` comes back as `[code] message`; an exception in the handler as `Widget operation failed: …`.

Then check the screen with `preview`.
