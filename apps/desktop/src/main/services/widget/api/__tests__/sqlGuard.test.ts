/**
 * `services/widget/api/sqlGuard.ts` —— SQLite 组件的 SQL 防线（设计稿 docs/widget-tool-design.md §8）。纯函数，直接调。
 *
 *   G-1 handler 语句的首关键字白名单：SELECT / WITH / INSERT / UPDATE / DELETE / REPLACE / VALUES 放行（前面有 `-- c\n`、
 *       `/* *\/` 也一样）；CREATE DROP ALTER ATTACH DETACH VACUUM PRAGMA BEGIN COMMIT SAVEPOINT RELEASE ROLLBACK ANALYZE
 *       REINDEX EXPLAIN → WidgetSqlRefused（code sql_refused，列出白名单、`(got X)`、db-init 提示）；`(SELECT 1)`、开头是字符串
 *       字面量 → 拒绝；空 / 全空白 → 拒绝且没有 "(got"
 *   G-2 白名单语句里夹着禁用词（load_extension、`; ATTACH`、`; VACUUM INTO`、`; PRAGMA`，大小写混写）→ "Widget operations cannot use X."
 *   G-3 引号 / 注释里的禁用词不误报；但字符串、标识符里的半个引号 / 注释符号不能把后面真的语句藏起来
 *   G-4 含禁用词的标识符（vacuum_log、attached_at、pragmatic、$attach）放行；`:attach` 拒绝（接受的误报）；
 *       没闭合的 `'` / `/*` / `[` 不让 strip 抛
 *   G-5 `"load_extension"('x')` 过得了这道门（运行时由 SQLite 挡，见 H-4）；`pragma_*` 表值函数：handler 拒绝、db-query 放行
 *   G-6 assertNoForbiddenSql：多条 DDL（含 FTS5 trigram）放行；第 5 条里的禁用词拒绝；PRAGMA 的提示是「ShuviX sets connection
 *       settings」，别的是「own database file」；前缀 `schema.sql cannot use …` / `db-query cannot use …`
 */
import { describe, expect, it } from 'vitest'
import {
  assertHandlerStatement,
  assertNoForbiddenSql,
  firstSqlKeyword,
  stripSqlNoise,
  WidgetSqlRefused
} from '../sqlGuard'

/** 抛出的 WidgetSqlRefused（没抛 → 用例失败） */
function refusal(fn: () => void): WidgetSqlRefused {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(WidgetSqlRefused)
    return e as WidgetSqlRefused
  }
  throw new Error('expected WidgetSqlRefused, nothing was thrown')
}

const ALLOWED = [
  'select 1',
  'WITH a AS (SELECT 1 AS x) SELECT x FROM a',
  "insert into t(x) values ('a')",
  "UPDATE t SET x = 'b' WHERE id = 1",
  'DELETE FROM t WHERE id = 1',
  "REPLACE INTO t(id, x) VALUES (1, 'c')",
  'VALUES(1)'
]

const REFUSED_KEYWORDS = [
  'CREATE TABLE x(a)',
  'DROP TABLE t',
  'ALTER TABLE t ADD COLUMN y',
  "ATTACH DATABASE '/x' AS y",
  'DETACH DATABASE y',
  'VACUUM',
  'PRAGMA journal_mode = DELETE',
  'BEGIN',
  'COMMIT',
  'SAVEPOINT s',
  'RELEASE s',
  'ROLLBACK',
  'ANALYZE',
  'REINDEX',
  'EXPLAIN SELECT 1'
]

describe('G-1 handler 语句的首关键字白名单', () => {
  it.each(ALLOWED)('G-1 放行 %j（以及前面有注释时）', (sql) => {
    expect(() => assertHandlerStatement(sql)).not.toThrow()
    expect(() => assertHandlerStatement(`-- c\n${sql}`)).not.toThrow()
    expect(() => assertHandlerStatement(`/* */${sql}`)).not.toThrow()
    expect(() => assertHandlerStatement(`  /* a */ -- b\n  ${sql}`)).not.toThrow()
  })

  it.each(REFUSED_KEYWORDS)(
    'G-1 拒绝 %j：sql_refused、列出白名单、(got X)、db-init 提示',
    (sql) => {
      const kw = sql.split(' ')[0].toUpperCase()
      const e = refusal(() => assertHandlerStatement(sql))
      expect(e.code).toBe('sql_refused')
      expect(e.message).toContain(
        'Widget operations can only run SELECT / WITH / INSERT / UPDATE / DELETE / REPLACE / VALUES statements'
      )
      expect(e.message).toContain(`(got ${kw}).`)
      expect(e.message).toContain('shuvix widget db-init')
      // 注释挡不住：前面加注释照样拒绝
      expect(() => assertHandlerStatement(`-- c\n${sql}`)).toThrow(WidgetSqlRefused)
    }
  )

  it.each(['(SELECT 1)', "'x'; SELECT 1", "'x'"])('G-1 首个东西不是关键字 %j → 拒绝', (sql) => {
    const e = refusal(() => assertHandlerStatement(sql))
    expect(e.code).toBe('sql_refused')
    expect(e.message).toContain('Widget operations can only run')
  })

  it.each(['', '   ', '\n\t', '-- only a comment\n', '/* x */'])(
    'G-1 空语句 %j → 拒绝，没有 "(got"',
    (sql) => {
      const e = refusal(() => assertHandlerStatement(sql))
      expect(e.message).not.toContain('(got')
      expect(e.message).toContain('statements.')
    }
  )

  it('G-1 firstSqlKeyword 大写、跳过注释；空 → ""', () => {
    expect(firstSqlKeyword('  -- x\n select 1')).toBe('SELECT')
    expect(firstSqlKeyword('/* x */with a as (select 1) select 1')).toBe('WITH')
    expect(firstSqlKeyword('')).toBe('')
    expect(firstSqlKeyword('(select 1)')).toBe('')
  })
})

describe('G-2 白名单语句里夹着禁用词', () => {
  it.each([
    ["SELECT load_extension('/x')", 'LOAD_EXTENSION'],
    ["SELECT 1; ATTACH DATABASE '/x' AS y", 'ATTACH'],
    ["WITH a AS(SELECT 1) SELECT 1; VACUUM INTO '/x'", 'VACUUM'],
    ["INSERT INTO t(x) VALUES ('a'); PRAGMA writable_schema=1", 'PRAGMA'],
    ['DELETE FROM t; DETACH DATABASE y', 'DETACH'],
    ["SeLeCt 1; aTtAcH dAtAbAsE '/x' aS y", 'ATTACH'],
    ["select LOAD_extension('/x')", 'LOAD_EXTENSION']
  ])('G-2 %j → cannot use %s', (sql, word) => {
    const e = refusal(() => assertHandlerStatement(sql))
    expect(e.code).toBe('sql_refused')
    expect(e.message).toBe(`Widget operations cannot use ${word}.`)
  })
})

describe('G-3 引号与注释', () => {
  it.each([
    "SELECT 'ATTACH DATABASE x'",
    "SELECT 'it''s VACUUM'",
    'SELECT "pragma" FROM t',
    'SELECT `detach` FROM t',
    'SELECT [attach] FROM t',
    'SELECT 1 -- ATTACH\n',
    'SELECT /* VACUUM INTO */ 1',
    "INSERT INTO t(x) VALUES ('PRAGMA writable_schema=1')"
  ])('G-3 引号 / 注释里的禁用词不误报：%j', (sql) => {
    expect(() => assertHandlerStatement(sql)).not.toThrow()
  })

  it.each([
    "SELECT '[' || x FROM t; ATTACH DATABASE '/x' AS y",
    "SELECT '--', 1; ATTACH DATABASE '/x' AS y",
    "SELECT \"a'b\"; ATTACH DATABASE '/x' AS y",
    "SELECT [x'y]; ATTACH DATABASE '/x' AS y",
    "SELECT '/*'; ATTACH DATABASE '/x' AS y",
    "SELECT 'a''b'; ATTACH DATABASE '/x' AS y"
  ])('G-3 半个引号 / 注释符号藏不住后面的语句：%j', (sql) => {
    const e = refusal(() => assertHandlerStatement(sql))
    expect(e.message).toBe('Widget operations cannot use ATTACH.')
  })
})

describe('G-4 标识符与没闭合的东西', () => {
  it.each([
    'SELECT vacuum_log FROM t',
    'SELECT attached_at FROM t',
    'SELECT pragmatic FROM t',
    'SELECT * FROM t WHERE x = $attach'
  ])('G-4 含禁用词的标识符放行：%j', (sql) => {
    expect(() => assertHandlerStatement(sql)).not.toThrow()
  })

  it('G-4 `:attach` 拒绝（接受的误报：冒号不算标识符的一部分）', () => {
    const e = refusal(() => assertHandlerStatement('SELECT * FROM t WHERE x = :attach'))
    expect(e.message).toBe('Widget operations cannot use ATTACH.')
  })

  it.each(["SELECT 'abc", 'SELECT 1 /* ATTACH', 'SELECT [attach', 'SELECT "x', 'SELECT `x'])(
    'G-4 没闭合 %j：strip 不抛，后面全当噪声',
    (sql) => {
      expect(() => stripSqlNoise(sql)).not.toThrow()
      expect(stripSqlNoise(sql).startsWith('SELECT ')).toBe(true)
      expect(() => assertHandlerStatement(sql)).not.toThrow()
    }
  )

  it('G-4 stripSqlNoise 把引号 / 注释换成一个空格', () => {
    expect(stripSqlNoise("a'x'b")).toBe('a b')
    expect(stripSqlNoise('a/*x*/b')).toBe('a b')
    expect(stripSqlNoise('a-- x\nb')).toBe('a b')
    expect(stripSqlNoise('a[x]b"y"c`z`d')).toBe('a b c d')
    expect(stripSqlNoise("a'it''s'b")).toBe('a b')
  })
})

describe('G-5 只在运行时才挡得住的 / 表值函数', () => {
  it('G-5 `"load_extension"(…)` 过得了这道门（引号里的被当成噪声，运行时由 SQLite 拒绝，见 H-4）', () => {
    expect(() => assertHandlerStatement(`SELECT "load_extension"('x')`)).not.toThrow()
  })

  it('G-5 pragma_* 表值函数：handler 拒绝，db-query / schema 放行', () => {
    const e = refusal(() => assertHandlerStatement('SELECT * FROM pragma_database_list'))
    expect(e.code).toBe('sql_refused')
    expect(e.message).toBe('Widget operations cannot use pragma_database_list.')
    expect(() => assertHandlerStatement("SELECT name FROM PRAGMA_TABLE_INFO('books')")).toThrow(
      'cannot use pragma_table_info.'
    )
    expect(() => assertNoForbiddenSql('SELECT * FROM pragma_database_list', 'query')).not.toThrow()
    expect(() =>
      assertNoForbiddenSql("SELECT * FROM pragma_table_info('books')", 'query')
    ).not.toThrow()
  })
})

describe('G-6 assertNoForbiddenSql（schema.sql / db-query）', () => {
  const DDL = [
    'CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, title TEXT NOT NULL UNIQUE);',
    'CREATE INDEX IF NOT EXISTS books_title ON books(title);',
    'CREATE VIEW IF NOT EXISTS v AS SELECT id FROM books;',
    'CREATE TRIGGER IF NOT EXISTS tr AFTER INSERT ON books BEGIN SELECT 1; END;',
    "CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(title, tokenize='trigram');"
  ].join('\n')

  it('G-6 多条 DDL（表、索引、视图、触发器、FTS5 trigram）放行', () => {
    expect(() => assertNoForbiddenSql(DDL, 'schema')).not.toThrow()
    expect(() => assertNoForbiddenSql(DDL, 'query')).not.toThrow()
  })

  it('G-6 第 5 条里的禁用词也会被找到；前缀与提示', () => {
    const sql = [
      'CREATE TABLE a(x);',
      'CREATE TABLE b(x);',
      'CREATE INDEX i ON a(x);',
      'INSERT INTO a VALUES (1);',
      "ATTACH DATABASE '/tmp/x.sqlite' AS y;"
    ].join('\n')
    const schema = refusal(() => assertNoForbiddenSql(sql, 'schema'))
    expect(schema.code).toBe('sql_refused')
    expect(schema.message).toBe(
      'schema.sql cannot use ATTACH. A widget can only reach its own database file.'
    )
    const query = refusal(() => assertNoForbiddenSql(sql, 'query'))
    expect(query.message).toBe(
      'db-query cannot use ATTACH. A widget can only reach its own database file.'
    )
  })

  it.each(['VACUUM', 'DETACH', 'LOAD_EXTENSION'])('G-6 %s → own database file 提示', (word) => {
    const sql = word === 'LOAD_EXTENSION' ? "SELECT load_extension('/x')" : `${word} x`
    const e = refusal(() => assertNoForbiddenSql(sql, 'query'))
    expect(e.message).toBe(
      `db-query cannot use ${word}. A widget can only reach its own database file.`
    )
  })

  it('G-6 PRAGMA → ShuviX sets connection settings 提示', () => {
    const e = refusal(() => assertNoForbiddenSql('PRAGMA journal_mode = DELETE', 'schema'))
    expect(e.message).toBe(
      'schema.sql cannot use PRAGMA. ShuviX sets connection settings (WAL, foreign keys, cache) itself.'
    )
    expect(e.message).not.toContain('own database file')
  })

  it('G-6 注释 / 字符串里的禁用词不算', () => {
    expect(() =>
      assertNoForbiddenSql("-- PRAGMA x\nCREATE TABLE t(note TEXT DEFAULT 'ATTACH');", 'schema')
    ).not.toThrow()
  })
})
