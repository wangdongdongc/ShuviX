/**
 * Widget DB 隔离工具 —— 把 widget id 映射到 PostgreSQL schema，以及标识符引用。
 *
 * 所有 widget 共享同一个 pglite 实例，但每个 widget 自动获得独占 schema
 * `widget_<sanitized-id>`。REST 层拼 SQL 时强制 schema-qualify 表名，
 * DDL 执行时在事务内 SET search_path，保证 widget 之间表名不会撞、不能跨界。
 */

/** 共享 widgets 数据库的 worker key */
export const WIDGETS_DB_KEY = 'widgets:shared'

/** widget id → schema 名 */
export function widgetIdToSchema(widgetId: string): string {
  return `widget_${widgetId.replace(/-/g, '_')}`
}

/** Postgres 标识符引用（双引号 + 转义内部双引号） */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** 标识符校验：表名、列名必须是简单标识符，不容许任何拼接攻击的可能 */
const IDENT_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function isValidIdent(name: string): boolean {
  return IDENT_REGEX.test(name)
}

export function assertValidIdent(name: string, kind: string): void {
  if (!isValidIdent(name)) {
    throw new Error(`Invalid ${kind} "${name}": must match [a-zA-Z_][a-zA-Z0-9_]*`)
  }
}

/**
 * 检查裸 SQL 里是否引用了别 widget 的 schema。
 * 只拦截显式 `widget_xxx` token，是非严密但能挡住 LLM 99% 的误操作。
 * 注释/字符串字面量内的字符也会被拦下来，宁可误报不可漏放。
 */
export function detectCrossWidgetReferences(
  sql: string,
  ownSchema: string
): { hasViolation: boolean; foreignSchemas: string[] } {
  const found = new Set<string>()
  const re = /\bwidget_[a-z0-9_]+\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    const token = m[0].toLowerCase()
    if (token !== ownSchema.toLowerCase()) {
      found.add(token)
    }
  }
  return { hasViolation: found.size > 0, foreignSchemas: [...found] }
}
