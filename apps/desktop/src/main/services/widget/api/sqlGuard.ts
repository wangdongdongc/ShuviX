/**
 * SQLite 组件的 SQL 防线（设计稿 docs/widget-tool-design.md §8）。
 *
 * 组件宿主进程不在沙箱里，而 SQLite 的 `ATTACH DATABASE '<路径>'` 能打开磁盘上任何 SQLite 文件、
 * `VACUUM INTO '<路径>'` 能往任何位置写文件（2026-10-27 探针，都能执行）—— 一条 SQL 就是对整个磁盘的读写原语。
 * 所以三处来源各自设门：
 *   - handler 的语句：首关键字白名单（`prepare` 只收一条语句，首关键字就决定了语句类型）；
 *   - `schema.sql`（db-init）与 CLI 的 `db-query`：去掉注释和字符串字面量后，见到禁用词就拒绝 —— 宁可误报，
 *     标识符里很少出现这些词；
 *   - 扩展加载由宿主保持关闭（不在这里）。
 *
 * 纯函数，主进程与组件宿主子进程都用。
 */

/** handler 的语句允许的首关键字：查询与增删改（`WITH` 之后只能跟这几种） */
export const HANDLER_STATEMENT_KEYWORDS: readonly string[] = [
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'VALUES'
]

/** 任何来源都不许出现的词：碰得到本文件以外的东西，或改连接级设置 */
export const FORBIDDEN_SQL_WORDS: readonly string[] = [
  'ATTACH',
  'DETACH',
  'VACUUM',
  'PRAGMA',
  'LOAD_EXTENSION'
]

/**
 * 去掉注释与所有引号括起来的东西（字符串 `'…'`、标识符 `"…"` / `` `…` `` / `[…]`），换成一个空格。
 * 关键字不可能藏在引号里，所以去掉它们只会减少误报，不会放过真正的语句
 */
export function stripSqlNoise(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i + 2)
      i = end === -1 ? n : end + 1
      out += ' '
      continue
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      out += ' '
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      // SQL 的转义是把引号写两遍：'it''s'
      let j = i + 1
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      i = j + 1
      out += ' '
      continue
    }
    if (c === '[') {
      const end = sql.indexOf(']', i + 1)
      i = end === -1 ? n : end + 1
      out += ' '
      continue
    }
    out += c
    i++
  }
  return out
}

/** 语句的首个词（大写）；空语句 → '' */
export function firstSqlKeyword(sql: string): string {
  const m = /[A-Za-z_]+/.exec(stripSqlNoise(sql).trimStart())
  if (!m || m.index !== 0) return ''
  return m[0].toUpperCase()
}

/** 第一个出现的禁用词（大写）；没有 → null */
export function findForbiddenSqlWord(sql: string): string | null {
  const words =
    stripSqlNoise(sql)
      .toUpperCase()
      .match(/[A-Z0-9_$]+/g) ?? []
  for (const w of words) {
    if (FORBIDDEN_SQL_WORDS.includes(w)) return w
  }
  return null
}

export class WidgetSqlRefused extends Error {
  readonly code = 'sql_refused'
}

/** handler 的一条语句：首关键字不在白名单 → 抛 */
export function assertHandlerStatement(sql: string): void {
  const kw = firstSqlKeyword(sql)
  if (!HANDLER_STATEMENT_KEYWORDS.includes(kw)) {
    throw new WidgetSqlRefused(
      `Widget operations can only run ${HANDLER_STATEMENT_KEYWORDS.join(' / ')} statements` +
        (kw ? ` (got ${kw}).` : '.') +
        ' Change the database structure in schema.sql with `shuvix widget db-init`.'
    )
  }
  const word = findForbiddenSqlWord(sql)
  if (word) {
    throw new WidgetSqlRefused(`Widget operations cannot use ${word}.`)
  }
  // `pragma_*` 表值函数（pragma_database_list 会给出文件路径）：handler 用不着；db-query 里留着查表结构
  const pragmaFn = (
    stripSqlNoise(sql)
      .toUpperCase()
      .match(/[A-Z0-9_$]+/g) ?? []
  ).find((w) => w.startsWith('PRAGMA_'))
  if (pragmaFn) {
    throw new WidgetSqlRefused(`Widget operations cannot use ${pragmaFn.toLowerCase()}.`)
  }
}

/** schema.sql / db-query 的整段 SQL：含禁用词 → 抛 */
export function assertNoForbiddenSql(sql: string, where: 'schema' | 'query'): void {
  const word = findForbiddenSqlWord(sql)
  if (!word) return
  const hint =
    word === 'PRAGMA'
      ? ' ShuviX sets connection settings (WAL, foreign keys, cache) itself.'
      : ' A widget can only reach its own database file.'
  throw new WidgetSqlRefused(
    `${where === 'schema' ? 'schema.sql' : 'db-query'} cannot use ${word}.${hint}`
  )
}
