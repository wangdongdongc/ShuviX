# Storing records: the widget's database

All widgets share one embedded PostgreSQL (PGlite), and each gets its own schema, so bare table names belong to the widget. Data lives outside the widget's directory and survives restarts.

**Use it only when needed.** Stateless tools (formatters, testers, converters, calculators) never call `db-init`: `useState` is enough. The database is for user records that must survive a restart, and it is also where settings go that a browser would keep in `localStorage`: browser storage is unavailable when the widget is opened from ShuviX's web page.

## The schema file

Keep the widget's **complete** DDL in `<projectDir>/schema.sql`, written idempotently (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), and install it with the full path:

```bash
shuvix widget db-init my-todo --file <projectDir>/schema.sql
```

ShuviX replays `schema.sql` when the widget is registered, but only while it matches what `db-init` last applied: an edited file takes effect only after `db-init` runs again. The next green build commits it with the code.

## Changing tables

The live database is not versioned: reverting code does not revert tables.

- Prefer additive DDL: new nullable columns, new tables. Never add a NOT NULL column without a default, and never drop a column unless asked.
- A widget with tables but no `schema.sql` needs one reconstructed from the live schema and installed.
- To repair a mismatch: inspect the live shape with `db-query` (`information_schema.columns` where `table_schema = current_schema()`), migrate inside an explicit `BEGIN; … COMMIT;` (`db-query` is not transactional), then bring `schema.sql` in line and run `db-init`.

## Calling it from widget code

`/w/<id>/db/<table>`, a PostgREST-style API with no auth. The same path works on the desktop and from a browser.

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

Writes return the affected rows. Errors come back as `{ code, message }` with a 4xx / 5xx status; show them in the UI. Filters are `?column=operator.value`, ANDed together:

| Operator              | Meaning                                           | Example                           |
| --------------------- | ------------------------------------------------- | --------------------------------- |
| `eq` `neq`            | = and <>                                          | `?id=eq.5` `?status=neq.archived` |
| `gt` `gte` `lt` `lte` | numeric and date comparisons                      | `?score=gte.80&score=lt.100`      |
| `like` `ilike`        | LIKE / case-insensitive LIKE, `*` is the wildcard | `?name=ilike.*foo*`               |
| `in`                  | IN (...)                                          | `?status=in.(active,pending)`     |
| `is`                  | IS NULL / TRUE / FALSE / UNKNOWN                  | `?deleted_at=is.null`             |

Control parameters: `?select=col1,col2`, `?order=col.desc.nullslast,col2.asc`, `?limit=20&offset=40`.

Extensions available in DDL and queries: **pg_trgm** (`WHERE text % 'term'`, `USING gin (text gin_trgm_ops)`), **vector** (`vector(1536)` with `<->`, `<#>`, `<=>`), hstore, ltree, citext, tablefunc, cube, earthdistance, intarray, unaccent, fuzzystrmatch.

**Not supported**: embedded resources (`?select=*,fk(*)`: make two requests), `and()` / `or()`, RPC endpoints (use `db-query`), upsert / `on_conflict` / `Prefer` headers (SELECT, then POST or PATCH), and access to another widget's data.
