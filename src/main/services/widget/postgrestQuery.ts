/**
 * PostgREST URL 子集解析器
 *
 * 把 widget REST API 收到的 query string 翻译成参数化 SQL 片段。
 * 目标：让 LLM 用熟悉的 PostgREST 语法写 widget 代码，不需要额外文档。
 *
 * 支持子集（一期）：
 *   - 算子: eq, neq, gt, gte, lt, lte, like, ilike, in, is
 *   - 列投影: ?select=col1,col2
 *   - 排序: ?order=col.asc.nullslast,col2.desc
 *   - 分页: ?limit=&offset=
 *
 * 显式不支持（返回错误）：
 *   - and()/or() 嵌套逻辑
 *   - not.* 前缀
 *   - 全文搜索 (fts/plfts/phfts)
 *   - 数组算子 (cs/cd/ov/sl/sr/nxr/nxl/adj)
 *   - embedded resources ?select=*,fk(*)
 */

import { isValidIdent, quoteIdent } from './dbScope'

/** 由 query string 解析出的可拼到 SQL 里的片段 + 参数 */
export interface ParsedQuery {
  selectClause: string
  whereClause: string
  orderClause: string
  limit: number | null
  offset: number | null
  params: unknown[]
}

const CONTROL_KEYS = new Set(['select', 'order', 'limit', 'offset'])

const OPERATOR_MAP: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE'
}

const REJECTED_OPERATORS = new Set([
  'fts',
  'plfts',
  'phfts',
  'wfts',
  'cs',
  'cd',
  'ov',
  'sl',
  'sr',
  'nxr',
  'nxl',
  'adj',
  'not'
])

export class PostgrestQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PostgrestQueryError'
  }
}

/** 解析 select=a,b,c。一期不支持嵌套外键 (a(b,c))。 */
function parseSelect(value: string): string {
  if (!value || value === '*') return '*'
  // 拒绝 embedded resources / aliasing —— 这些 PostgREST 特性一期不做
  if (value.includes('(') || value.includes(':')) {
    throw new PostgrestQueryError(
      `?select with embedded resources or aliasing is not supported (got "${value}")`
    )
  }
  const cols = value.split(',').map((s) => s.trim())
  const out: string[] = []
  for (const col of cols) {
    if (col === '*') {
      out.push('*')
      continue
    }
    if (!isValidIdent(col)) {
      throw new PostgrestQueryError(`Invalid column in select: "${col}"`)
    }
    out.push(quoteIdent(col))
  }
  return out.join(', ')
}

/** 解析 order=col.asc.nullslast,col2.desc */
function parseOrder(value: string): string {
  if (!value) return ''
  const parts = value.split(',').map((s) => s.trim())
  const out: string[] = []
  for (const p of parts) {
    const segs = p.split('.')
    const col = segs[0]
    if (!col || !isValidIdent(col)) {
      throw new PostgrestQueryError(`Invalid order column: "${col}"`)
    }
    let direction = 'ASC'
    let nulls = ''
    for (const seg of segs.slice(1)) {
      if (seg === 'asc') direction = 'ASC'
      else if (seg === 'desc') direction = 'DESC'
      else if (seg === 'nullsfirst') nulls = ' NULLS FIRST'
      else if (seg === 'nullslast') nulls = ' NULLS LAST'
      else throw new PostgrestQueryError(`Unknown order modifier: "${seg}"`)
    }
    out.push(`${quoteIdent(col)} ${direction}${nulls}`)
  }
  return out.join(', ')
}

/** 解析 in.(a,b,c) 的值部分（已剥离 "in." 前缀） */
function parseInList(raw: string): string[] {
  if (!raw.startsWith('(') || !raw.endsWith(')')) {
    throw new PostgrestQueryError(`Invalid 'in' list: expected (v1,v2,...), got "${raw}"`)
  }
  const inner = raw.slice(1, -1)
  if (inner.length === 0) return []
  // 简单 split —— 不支持引号包裹和转义（PostgREST 真实语法有引号支持，一期省略）
  return inner.split(',').map((s) => s.trim())
}

/** 把 is.<value> 的字面值翻成 SQL IS 比较的右值 */
function parseIsValue(raw: string): string {
  const v = raw.toLowerCase()
  if (v === 'null') return 'NULL'
  if (v === 'true') return 'TRUE'
  if (v === 'false') return 'FALSE'
  if (v === 'unknown') return 'UNKNOWN'
  throw new PostgrestQueryError(`'is' only supports null/true/false/unknown, got "${raw}"`)
}

/** 把 PostgREST 风格的通配 (`*` → `%`) 转为 SQL LIKE 模式 */
function convertLikePattern(raw: string): string {
  return raw.replace(/\*/g, '%')
}

/** 解析一个过滤条件 col=op.value，返回 SQL where 片段 + 它消耗的参数 */
function parseFilter(
  column: string,
  raw: string,
  paramIndex: number
): { fragment: string; params: unknown[]; consumed: number } {
  const dotIdx = raw.indexOf('.')
  if (dotIdx === -1) {
    throw new PostgrestQueryError(
      `Filter for "${column}" must be of form "<operator>.<value>", got "${raw}"`
    )
  }
  const op = raw.slice(0, dotIdx)
  const value = raw.slice(dotIdx + 1)

  if (REJECTED_OPERATORS.has(op)) {
    throw new PostgrestQueryError(`Operator "${op}" is not supported in this widget REST API`)
  }

  const qCol = quoteIdent(column)

  if (op === 'in') {
    const list = parseInList(value)
    if (list.length === 0) {
      // IN () 在 SQL 里非法 —— 用永假
      return { fragment: 'FALSE', params: [], consumed: 0 }
    }
    const placeholders = list.map((_, i) => `$${paramIndex + i}`).join(', ')
    return {
      fragment: `${qCol} IN (${placeholders})`,
      params: list,
      consumed: list.length
    }
  }

  if (op === 'is') {
    return {
      fragment: `${qCol} IS ${parseIsValue(value)}`,
      params: [],
      consumed: 0
    }
  }

  if (op === 'like' || op === 'ilike') {
    const sqlOp = OPERATOR_MAP[op]
    return {
      fragment: `${qCol} ${sqlOp} $${paramIndex}`,
      params: [convertLikePattern(value)],
      consumed: 1
    }
  }

  const sqlOp = OPERATOR_MAP[op]
  if (!sqlOp) {
    throw new PostgrestQueryError(`Unknown operator "${op}" for column "${column}"`)
  }
  return {
    fragment: `${qCol} ${sqlOp} $${paramIndex}`,
    params: [value],
    consumed: 1
  }
}

/**
 * 主入口：把 URLSearchParams 解析成 SQL 片段集合。
 * 同名 query key 多次出现 → 视为多个过滤条件（AND）。
 */
export function parseQuery(params: URLSearchParams): ParsedQuery {
  let selectClause = '*'
  let orderClause = ''
  let limit: number | null = null
  let offset: number | null = null

  const whereFrags: string[] = []
  const sqlParams: unknown[] = []
  let pi = 1

  // 控制参数
  const selectVal = params.get('select')
  if (selectVal !== null) selectClause = parseSelect(selectVal)

  const orderVal = params.get('order')
  if (orderVal !== null) orderClause = parseOrder(orderVal)

  const limitVal = params.get('limit')
  if (limitVal !== null) {
    const n = Number(limitVal)
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new PostgrestQueryError(`Invalid limit: "${limitVal}"`)
    }
    limit = n
  }
  const offsetVal = params.get('offset')
  if (offsetVal !== null) {
    const n = Number(offsetVal)
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new PostgrestQueryError(`Invalid offset: "${offsetVal}"`)
    }
    offset = n
  }

  // 过滤
  for (const [key, value] of params) {
    if (CONTROL_KEYS.has(key)) continue
    if (key === 'and' || key === 'or') {
      throw new PostgrestQueryError(
        `Logical operators ${key}() are not supported in this widget REST API`
      )
    }
    if (!isValidIdent(key)) {
      throw new PostgrestQueryError(`Invalid filter column: "${key}"`)
    }
    const { fragment, params: p, consumed } = parseFilter(key, value, pi)
    whereFrags.push(fragment)
    sqlParams.push(...p)
    pi += consumed
  }

  return {
    selectClause,
    whereClause: whereFrags.length > 0 ? whereFrags.join(' AND ') : '',
    orderClause,
    limit,
    offset,
    params: sqlParams
  }
}
