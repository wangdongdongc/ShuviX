# The widget's database

Each widget keeps its records in its own SQLite database, a file outside the widget's folder that survives restarts and is deleted with the widget. Only the widget's own operations (`api.md`) read and write it; the screen and agents go through them.

**Use it only when needed.** Stateless tools (formatters, testers, converters, calculators) have no tables and no `api.ts`: `useState` is enough. The database is for user records that must survive a restart, and it is also where settings go that a browser would keep in `localStorage`: browser storage is unavailable when the widget is opened from ShuviX's web page.

## `schema.sql`

Keep the widget's **complete** table definitions in `schema.sql` in its folder, in the SQLite dialect, written so that running them again changes nothing:

```sql
CREATE TABLE IF NOT EXISTS books (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL UNIQUE,
  author     TEXT,
  status     TEXT NOT NULL DEFAULT 'want' CHECK (status IN ('want', 'reading', 'done')),
  added_by   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS books_status ON books (status, created_at);
```

Install it by passing the file's text to `sql`. The whole script runs in one transaction: if any statement fails, none of it applies. The next green build commits `schema.sql` with the code.

The SQLite dialect: `INTEGER PRIMARY KEY` is the auto-numbered id; types are `TEXT`, `INTEGER`, `REAL`, `BLOB`; there is no boolean (`0` / `1`) and no date type (ISO 8601 text sorts correctly); JSON goes in `TEXT` and is read with `json_extract`; upserts are `ON CONFLICT (…) DO UPDATE SET … = excluded.…`. Full-text search, including Chinese and Japanese substrings: `CREATE VIRTUAL TABLE notes_fts USING fts5(body, tokenize='trigram')`. Foreign keys are enforced.

ShuviX sets the connection itself (WAL, foreign keys, cache), so `PRAGMA` is refused, and so are `ATTACH`, `DETACH`, `VACUUM` and `load_extension`: a widget reaches only its own file.

## Changing tables

The live database is not versioned: reverting code does not revert tables.

- Prefer additive changes: new nullable columns (`ALTER TABLE books ADD COLUMN rating INTEGER`), new tables. Never add a NOT NULL column without a default, and never drop a column or a table unless asked.
- SQLite cannot change a column's type or constraints in place. Rebuild the table in one script: create the new table, `INSERT INTO new SELECT … FROM old`, drop the old one, rename the new one, recreate its indexes.
- Then bring `schema.sql` in line with the live tables, and change the operations that use them in the same build.

## Looking at the data

`sql` with a `SELECT` returns a table: `SELECT * FROM books ORDER BY created_at DESC LIMIT 20`. `SELECT name, sql FROM sqlite_master` and `SELECT * FROM pragma_table_info('books')` show the structure. Fix data with `UPDATE` / `DELETE` in `sql` only when the user asked for it; anything the user would do through the screen goes through an operation instead.
