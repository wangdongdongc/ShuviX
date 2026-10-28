# 小组件的数据库

每个小组件（widget）把它的记录存在它自己的 SQLite 数据库里：这是小组件文件夹之外的一个文件，重启后仍在，随小组件一起删除。只有小组件自己的操作（`api.md`）读写它；界面和智能体都要经过这些操作。

**只在需要时用它。** 无状态的工具（格式化器、测试器、转换器、计算器）没有表，也没有 `api.ts`：`useState` 就够了。数据库是给必须挺过重启的用户记录用的，浏览器里会放进 `localStorage` 的设置也放在这里：小组件从 ShuviX 的网页打开时，浏览器存储不可用。

## `schema.sql`

把小组件**完整的**表定义放在它文件夹里的 `schema.sql`，用 SQLite 方言，写成再运行一次也不会改变任何东西的样子：

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

把文件的文本传给 `sql` 来安装它。整个脚本在一个事务里运行：任何一条语句失败，就全部不生效。下一次绿色构建会把 `schema.sql` 和代码一起提交。

SQLite 方言：`INTEGER PRIMARY KEY` 是自动编号的 id；类型有 `TEXT`、`INTEGER`、`REAL`、`BLOB`；没有布尔类型（用 `0` / `1`），也没有日期类型（ISO 8601 文本能正确排序）；JSON 放在 `TEXT` 里，用 `json_extract` 读取；upsert 写成 `ON CONFLICT (…) DO UPDATE SET … = excluded.…`。全文搜索（包括中文和日文的子串）：`CREATE VIRTUAL TABLE notes_fts USING fts5(body, tokenize='trigram')`。外键约束会被强制执行。

连接由 ShuviX 自己设置（WAL、外键、缓存），所以 `PRAGMA` 会被拒绝，`ATTACH`、`DETACH`、`VACUUM` 和 `load_extension` 也一样：小组件只能触及它自己的文件。

## 修改表

实际在用的数据库没有版本管理：回退代码不会回退表。

- 优先用增量式的改动：新的可空列（`ALTER TABLE books ADD COLUMN rating INTEGER`）、新表。绝不添加没有缺省值的 NOT NULL 列，没被要求就绝不删列或删表。
- SQLite 不能就地改变列的类型或约束。在一个脚本里重建这张表：建新表，`INSERT INTO new SELECT … FROM old`，删掉旧表，把新表改名，重建它的索引。
- 然后让 `schema.sql` 与实际的表一致，并在同一次构建里改掉用到这些表的操作。

## 查看数据

用 `sql` 运行一条 `SELECT` 会返回一张表：`SELECT * FROM books ORDER BY created_at DESC LIMIT 20`。`SELECT name, sql FROM sqlite_master` 和 `SELECT * FROM pragma_table_info('books')` 显示结构。只有用户要求时，才在 `sql` 里用 `UPDATE` / `DELETE` 修数据；凡是用户会通过界面做的事，都改走一个操作。
