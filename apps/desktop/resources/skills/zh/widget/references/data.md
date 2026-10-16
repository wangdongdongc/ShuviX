# 存储记录：小组件的数据库

所有小组件（widget）共用一个内嵌的 PostgreSQL（PGlite），每个小组件有自己的 schema，所以裸表名属于该小组件。数据存在小组件目录之外，重启后仍在。

**只在需要时用它。** 无状态的工具（格式化器、测试器、转换器、计算器）从不调用 `db-init`：`useState` 就够了。数据库是给必须挺过重启的用户记录用的，浏览器里会放进 `localStorage` 的设置也放在这里：小组件从 ShuviX 的网页打开时，浏览器存储不可用。

## schema 文件

把小组件**完整的** DDL 放在 `<projectDir>/schema.sql`，写成幂等的（`CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`），并用完整路径安装：

```bash
shuvix widget db-init my-todo --file <projectDir>/schema.sql
```

ShuviX 在小组件注册时会重放 `schema.sql`，但只在它与 `db-init` 上次应用的内容一致时才重放：改过的文件只有在再跑一次 `db-init` 之后才生效。下一次绿色构建会把它和代码一起提交。

## 修改表

实际在用的数据库没有版本管理：回退代码不会回退表。

- 优先用增量式 DDL：新的可空列、新表。绝不添加没有缺省值的 NOT NULL 列，没被要求就绝不删列。
- 有表却没有 `schema.sql` 的小组件，需要从实际的 schema 重建出一份并安装。
- 修复不一致：用 `db-query` 查看实际的结构（`information_schema.columns`，条件 `table_schema = current_schema()`），在显式的 `BEGIN; … COMMIT;` 里迁移（`db-query` 不带事务），然后让 `schema.sql` 与之一致并运行 `db-init`。

## 在小组件代码里调用

`/w/<id>/db/<table>`，一个 PostgREST 风格、没有鉴权的 API。同一个路径在桌面端和浏览器里都能用。

```ts
// Read with filters / ordering / pagination
const res = await fetch('/w/my-todo/db/todos?done=is.false&order=created_at.desc&limit=20')
const rows = await res.json() // → array of row objects

// Insert one row or many
await fetch('/w/my-todo/db/todos', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'buy milk' }) // or [{ text: 'a' }, { text: 'b' }]
})

// Update and delete — a WHERE filter is REQUIRED (no "change everything" footgun)
await fetch('/w/my-todo/db/todos?id=eq.7', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ done: true })
})
await fetch('/w/my-todo/db/todos?id=eq.7', { method: 'DELETE' })
```

写操作返回受影响的行。错误以 `{ code, message }` 返回，状态码为 4xx / 5xx；把它们显示在 UI 里。过滤条件是 `?column=operator.value`，彼此之间取 AND：

| 运算符                | 含义                                        | 示例                              |
| --------------------- | ------------------------------------------- | --------------------------------- |
| `eq` `neq`            | = 和 <>                                     | `?id=eq.5` `?status=neq.archived` |
| `gt` `gte` `lt` `lte` | 数值与日期比较                              | `?score=gte.80&score=lt.100`      |
| `like` `ilike`        | LIKE / 不区分大小写的 LIKE，`*` 是通配符    | `?name=ilike.*foo*`               |
| `in`                  | IN (...)                                    | `?status=in.(active,pending)`     |
| `is`                  | IS NULL / TRUE / FALSE / UNKNOWN            | `?deleted_at=is.null`             |

控制参数：`?select=col1,col2`、`?order=col.desc.nullslast,col2.asc`、`?limit=20&offset=40`。

DDL 和查询里可用的扩展：**pg_trgm**（`WHERE text % 'term'`、`USING gin (text gin_trgm_ops)`）、**vector**（`vector(1536)` 配 `<->`、`<#>`、`<=>`）、hstore、ltree、citext、tablefunc、cube、earthdistance、intarray、unaccent、fuzzystrmatch。

**不支持**：嵌入资源（`?select=*,fk(*)`：改成两次请求）、`and()` / `or()`、RPC 端点（用 `db-query`）、upsert / `on_conflict` / `Prefer` 头（先 SELECT，再 POST 或 PATCH），以及访问别的小组件的数据。
