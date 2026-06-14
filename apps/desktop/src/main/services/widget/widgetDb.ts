/**
 * Widget DB —— widget 端 REST API 与 CLI db-* 子命令的共享服务层
 *
 * 职责：
 *   1. 懒启动共享 pglite worker（~/.shuvix/widgets-db/data）
 *   2. 把 PostgREST 风格的请求翻译成参数化 SQL，并在 widget 自己的 schema 下跑
 *   3. 暴露 db-init / db-query 两类操作（CLI 调用）
 *
 * 隔离：每个 widget id 自动映射到独占 schema widget_<sanitized-id>。
 *      REST 层强制 schema-qualify，CLI db-query 内部 SET search_path 并对 SQL
 *      做"跨 widget 引用"正则前置校验。
 */

import { randomBytes } from 'crypto'
import { pgliteWorkerManager, PgliteWorkerManager } from '../pglite/workerManager'
import { createLogger } from '../../logger'
import {
  WIDGETS_DB_KEY,
  widgetIdToSchema,
  quoteIdent,
  assertValidIdent,
  detectCrossWidgetReferences
} from './dbScope'
import { parseQuery, PostgrestQueryError, type ParsedQuery } from './postgrestQuery'

const log = createLogger('WidgetDb')

export class WidgetDbError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string = 'WIDGET_DB_ERROR'
  ) {
    super(message)
    this.name = 'WidgetDbError'
  }
}

/** 生成 worker 调用的唯一 id */
function genId(): string {
  return `widgetdb-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/**
 * 共享 worker 启动后，需要把 pglite 注册的扩展真正 `CREATE EXTENSION`
 * 装到 public schema，否则 `uuid_generate_v4()` / `vector` 等函数找不到。
 *
 * 扩展名按 PostgreSQL 标准命名（`uuid-ossp` 用连字符）—— pglite contrib 模块的
 * JS 变量是 `uuid_ossp`（因为标识符不能有 `-`），但注册到 PG 的名字是
 * `uuid-ossp`，SQL 里必须用引号写出真实名字。
 */
const WIDGET_EXTENSIONS = [
  'vector',
  'pg_trgm',
  'fuzzystrmatch',
  'hstore',
  'ltree',
  'uuid-ossp',
  'citext',
  'tablefunc',
  'cube',
  'earthdistance',
  'intarray',
  'unaccent'
]
let extensionsBootstrapped = false

/** 懒启动共享 widget worker（+ 首次 CREATE EXTENSION 全套扩展） */
async function ensureWorker(): Promise<void> {
  await pgliteWorkerManager.ensureWorkerByKey(
    WIDGETS_DB_KEY,
    PgliteWorkerManager.defaultWidgetsDbDir()
  )
  if (extensionsBootstrapped) return

  // 每个扩展独立一条语句，否则 multi-statement 脚本里一条失败会让后面的全跑不到，
  // 这正是 uuid 之前装不上的元凶。
  const failures: string[] = []
  for (const ext of WIDGET_EXTENSIONS) {
    const resp = await pgliteWorkerManager.executeOnWorker(
      WIDGETS_DB_KEY,
      genId(),
      `CREATE EXTENSION IF NOT EXISTS "${ext}"`
    )
    if (resp.type === 'error') {
      failures.push(`${ext}: ${resp.error}`)
    }
  }
  // 不论成功失败都 latch —— 同一进程内重试同一组扩展不会有不同结果，
  // 让用户从「函数找不到」的具体错误里看到是哪个扩展挂了。
  extensionsBootstrapped = true
  if (failures.length > 0) {
    log.warn(`widget DB extension bootstrap partial failures: ${failures.join('; ')}`)
  } else {
    log.info('widget DB extensions bootstrapped')
  }
}

export type RestMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface RestRequest {
  widgetId: string
  table: string
  method: RestMethod
  searchParams: URLSearchParams
  /** POST/PATCH 的 body —— 已 JSON.parse */
  body?: unknown
}

export interface RestResult {
  rows: unknown[]
  affectedRows: number
}

/** 把 SQL 错误转成 HTTP 状态 */
function sqlErrorToStatus(message: string): number {
  // pglite 错误消息没有结构化 code，按文本片段粗粒度分类
  const m = message.toLowerCase()
  if (
    m.includes('does not exist') ||
    m.includes('syntax error') ||
    m.includes('violates') ||
    m.includes('duplicate key') ||
    m.includes('null value') ||
    m.includes('null constraint')
  ) {
    return 400
  }
  return 500
}

/** 在共享 worker 上跑参数化查询（REST 入口） */
async function runQuery(sql: string, params: unknown[]): Promise<RestResult> {
  await ensureWorker()
  const id = genId()
  const resp = await pgliteWorkerManager.queryOnWorker(WIDGETS_DB_KEY, id, sql, params)
  if (resp.type === 'error') {
    throw new WidgetDbError(resp.error ?? 'unknown SQL error', sqlErrorToStatus(resp.error ?? ''))
  }
  return {
    rows: (resp.rows ?? []) as unknown[],
    affectedRows: resp.affectedRows ?? resp.rows?.length ?? 0
  }
}

/** 在共享 worker 上跑 psql 文本 SQL（CLI db-query 入口） */
async function runExecute(sql: string): Promise<{ output: string; error?: string }> {
  await ensureWorker()
  const id = genId()
  const resp = await pgliteWorkerManager.executeOnWorker(WIDGETS_DB_KEY, id, sql)
  if (resp.type === 'error') {
    return { output: '', error: resp.error ?? 'unknown SQL error' }
  }
  return { output: resp.output ?? '' }
}

// ────────────────────────── REST API ──────────────────────────

/** 校验 body：必须是对象或对象数组，且至少一项 */
function normalizeWriteBody(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      throw new WidgetDbError('Request body array is empty', 400, 'EMPTY_BODY')
    }
    for (const row of body) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new WidgetDbError(
          'Request body must be an object or an array of objects',
          400,
          'INVALID_BODY'
        )
      }
    }
    return body as Record<string, unknown>[]
  }
  if (body && typeof body === 'object') {
    return [body as Record<string, unknown>]
  }
  throw new WidgetDbError(
    'Request body must be an object or an array of objects',
    400,
    'INVALID_BODY'
  )
}

/** 校验所有 row 至少有 1 列，且列名合法 + 列集一致 */
function buildInsertSpec(rows: Record<string, unknown>[]): {
  columns: string[]
  values: unknown[][]
} {
  const firstKeys = Object.keys(rows[0])
  if (firstKeys.length === 0) {
    throw new WidgetDbError('Insert row has no columns', 400, 'INVALID_BODY')
  }
  for (const col of firstKeys) {
    assertValidIdent(col, 'column')
  }
  const columns = firstKeys
  const colSet = new Set(columns)
  const values: unknown[][] = []
  for (const row of rows) {
    const rk = Object.keys(row)
    if (rk.length !== columns.length || rk.some((k) => !colSet.has(k))) {
      throw new WidgetDbError(
        'All inserted rows must have the same set of columns',
        400,
        'INVALID_BODY'
      )
    }
    values.push(columns.map((c) => row[c]))
  }
  return { columns, values }
}

export async function handleRestRequest(req: RestRequest): Promise<RestResult> {
  assertValidIdent(req.table, 'table name')

  const schema = widgetIdToSchema(req.widgetId)
  const qSchema = quoteIdent(schema)
  const qTable = quoteIdent(req.table)
  const tableRef = `${qSchema}.${qTable}`

  let parsed: ParsedQuery
  try {
    parsed = parseQuery(req.searchParams)
  } catch (e) {
    if (e instanceof PostgrestQueryError) {
      throw new WidgetDbError(e.message, 400, 'BAD_QUERY')
    }
    throw e
  }

  if (req.method === 'GET') {
    let sql = `SELECT ${parsed.selectClause} FROM ${tableRef}`
    if (parsed.whereClause) sql += ` WHERE ${parsed.whereClause}`
    if (parsed.orderClause) sql += ` ORDER BY ${parsed.orderClause}`
    if (parsed.limit !== null) sql += ` LIMIT ${parsed.limit}`
    if (parsed.offset !== null) sql += ` OFFSET ${parsed.offset}`
    return runQuery(sql, parsed.params)
  }

  if (req.method === 'POST') {
    const rows = normalizeWriteBody(req.body)
    const { columns, values } = buildInsertSpec(rows)
    const colSql = columns.map(quoteIdent).join(', ')
    const valueRows: string[] = []
    const flatParams: unknown[] = []
    let pi = 1
    for (const row of values) {
      const placeholders: string[] = []
      for (const v of row) {
        placeholders.push(`$${pi++}`)
        flatParams.push(v)
      }
      valueRows.push(`(${placeholders.join(', ')})`)
    }
    const sql = `INSERT INTO ${tableRef} (${colSql}) VALUES ${valueRows.join(', ')} RETURNING *`
    return runQuery(sql, flatParams)
  }

  if (req.method === 'PATCH') {
    if (!parsed.whereClause) {
      throw new WidgetDbError(
        'PATCH requires at least one filter (refusing to update all rows)',
        400,
        'NO_FILTER'
      )
    }
    const rows = normalizeWriteBody(req.body)
    if (rows.length !== 1) {
      throw new WidgetDbError('PATCH body must be a single object', 400, 'INVALID_BODY')
    }
    const updates = rows[0]
    const setKeys = Object.keys(updates)
    if (setKeys.length === 0) {
      throw new WidgetDbError('PATCH body has no columns to update', 400, 'INVALID_BODY')
    }
    for (const col of setKeys) assertValidIdent(col, 'column')

    const setParts: string[] = []
    const updateParams: unknown[] = []
    let pi = 1
    for (const col of setKeys) {
      setParts.push(`${quoteIdent(col)} = $${pi++}`)
      updateParams.push(updates[col])
    }
    // WHERE 参数在 UPDATE 参数之后；重写 WHERE 中的 $n 让它们从 setKeys.length+1 开始
    const offsetParams = setKeys.length
    const rebasedWhere = parsed.whereClause.replace(
      /\$(\d+)/g,
      (_m: string, n: string) => `$${Number(n) + offsetParams}`
    )
    const sql = `UPDATE ${tableRef} SET ${setParts.join(', ')} WHERE ${rebasedWhere} RETURNING *`
    return runQuery(sql, [...updateParams, ...parsed.params])
  }

  if (req.method === 'DELETE') {
    if (!parsed.whereClause) {
      throw new WidgetDbError(
        'DELETE requires at least one filter (refusing to delete all rows)',
        400,
        'NO_FILTER'
      )
    }
    const sql = `DELETE FROM ${tableRef} WHERE ${parsed.whereClause} RETURNING *`
    return runQuery(sql, parsed.params)
  }

  throw new WidgetDbError(`Unsupported method: ${req.method}`, 405, 'METHOD_NOT_ALLOWED')
}

// ────────────────────────── DDL（widget db-init） ──────────────────────────

/**
 * 安装/重装 widget 的 schema：
 *   1. CREATE SCHEMA IF NOT EXISTS widget_<id>
 *   2. 在事务里 SET LOCAL search_path 后跑用户的 DDL
 *
 * 成功后调用方负责写入元数据；失败抛出，元数据不更新（LLM 修正后重跑）。
 */
export async function applyWidgetSchema(widgetId: string, ddl: string): Promise<void> {
  const schema = widgetIdToSchema(widgetId)
  const qSchema = quoteIdent(schema)

  // 跨 widget 引用拦截 —— DDL 里也不应出现别的 widget schema
  const cross = detectCrossWidgetReferences(ddl, schema)
  if (cross.hasViolation) {
    throw new WidgetDbError(
      `DDL references other widget schemas: ${cross.foreignSchemas.join(', ')}`,
      400,
      'CROSS_WIDGET_REF'
    )
  }

  // 防御性 ROLLBACK：若上一次 DDL 失败导致连接停在 aborted 态，先清掉
  // —— 同时 sqlWorker 的 catch 路径也会兜一次，这里再做一次保险。
  const wrapped = [
    `ROLLBACK;`,
    `CREATE SCHEMA IF NOT EXISTS ${qSchema};`,
    `BEGIN;`,
    `SET LOCAL search_path TO ${qSchema}, public;`,
    ddl.endsWith(';') ? ddl : ddl + ';',
    `COMMIT;`
  ].join('\n')

  const { error } = await runExecute(wrapped)
  if (error) {
    log.warn(`applyWidgetSchema(${widgetId}) failed: ${error}`)
    throw new WidgetDbError(error, 400, 'DDL_ERROR')
  }
}

// ────────────────────────── 调试 SQL（widget db-query） ──────────────────────────

/**
 * 在 widget schema 下跑裸 SQL（psql 文本输出，复用 execute 路径）。
 * 拦截跨 widget 引用，SET search_path 让裸表名解析到 widget 自己的 schema。
 */
export async function runWidgetDbQuery(
  widgetId: string,
  sql: string
): Promise<{ output: string; error?: string }> {
  const schema = widgetIdToSchema(widgetId)
  const cross = detectCrossWidgetReferences(sql, schema)
  if (cross.hasViolation) {
    return {
      output: '',
      error: `SQL references other widget schemas: ${cross.foreignSchemas.join(', ')}. Cross-widget access is not allowed.`
    }
  }

  const qSchema = quoteIdent(schema)
  // 防御性 ROLLBACK 见 applyWidgetSchema 同样注释
  const wrapped = [
    `ROLLBACK;`,
    `CREATE SCHEMA IF NOT EXISTS ${qSchema};`,
    `SET search_path TO ${qSchema}, public;`,
    sql
  ].join('\n')

  return runExecute(wrapped)
}
