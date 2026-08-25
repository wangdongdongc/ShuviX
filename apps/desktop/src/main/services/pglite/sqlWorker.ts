/**
 * SQL Worker — 在 worker_threads 中运行 PGLite (Postgres WASM) 运行时
 *
 * 恒持久化（dataDir 必传），不挂载宿主文件系统 —— 唯一消费者是 widget 共享库。
 */

import { parentPort } from 'worker_threads'

// ---- 消息协议 ----

interface InitMessage {
  type: 'init'
  /** 持久化存储目录 */
  dataDir: string
}

interface ExecuteMessage {
  type: 'execute'
  id: string
  sql: string
}

/** 参数化结构化查询 —— 返回行数组而非 psql 文本 */
interface QueryMessage {
  type: 'query'
  id: string
  sql: string
  params?: unknown[]
}

export interface QueryField {
  name: string
  dataTypeID: number
}

export interface WorkerResponse {
  type: 'ready' | 'result' | 'error'
  id?: string
  output?: string
  error?: string
  rowCount?: number
  columnCount?: number
  /** 结构化查询返回的行（仅 query 消息使用） */
  rows?: unknown[]
  fields?: QueryField[]
  affectedRows?: number
}

// ---- PGLite 运行时 ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null

/** 格式化单个结果集为类 psql 文本表格 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatResultSet(result: any): string {
  const rows = result.rows
  const fields = result.fields

  // 无结果集（DDL / 空 SELECT）
  if (!fields || fields.length === 0) {
    if (result.affectedRows != null && result.affectedRows > 0) {
      // DML 操作
      const cmd = (result.command || '').toUpperCase()
      if (cmd === 'INSERT') return `INSERT 0 ${result.affectedRows}`
      if (cmd === 'UPDATE') return `UPDATE ${result.affectedRows}`
      if (cmd === 'DELETE') return `DELETE ${result.affectedRows}`
      return `${cmd || 'OK'} ${result.affectedRows}`
    }
    return 'OK'
  }

  // 有结果集 — 格式化为表格
  const colNames: string[] = fields.map((f: { name: string }) => f.name)

  // 计算每列宽度（至少等于列名长度）
  const widths = colNames.map((name) => name.length)
  for (const row of rows) {
    for (let i = 0; i < colNames.length; i++) {
      const val = row[colNames[i]]
      const str = val === null || val === undefined ? '' : String(val)
      if (str.length > widths[i]) widths[i] = str.length
    }
  }

  // 表头
  const header = colNames.map((name, i) => ` ${name.padEnd(widths[i])} `).join('|')
  const separator = widths.map((w) => '-'.repeat(w + 2)).join('+')

  // 行数据
  const dataLines = rows.map((row: Record<string, unknown>) =>
    colNames
      .map((name, i) => {
        const val = row[name]
        const str = val === null || val === undefined ? '' : String(val)
        return ` ${str.padEnd(widths[i])} `
      })
      .join('|')
  )

  const parts = [header, separator, ...dataLines, `(${rows.length} rows)`]
  return parts.join('\n')
}

async function init(dataDir: string): Promise<void> {
  // 动态导入 PGLite 及扩展
  const { PGlite } = await import('@electric-sql/pglite')
  const { vector } = await import('@electric-sql/pglite/vector')
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm')
  const { fuzzystrmatch } = await import('@electric-sql/pglite/contrib/fuzzystrmatch')
  const { hstore } = await import('@electric-sql/pglite/contrib/hstore')
  const { ltree } = await import('@electric-sql/pglite/contrib/ltree')
  const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp')
  const { citext } = await import('@electric-sql/pglite/contrib/citext')
  const { tablefunc } = await import('@electric-sql/pglite/contrib/tablefunc')
  const { cube } = await import('@electric-sql/pglite/contrib/cube')
  const { earthdistance } = await import('@electric-sql/pglite/contrib/earthdistance')
  const { intarray } = await import('@electric-sql/pglite/contrib/intarray')
  const { unaccent } = await import('@electric-sql/pglite/contrib/unaccent')

  db = new PGlite({
    dataDir,
    extensions: {
      vector,
      pg_trgm,
      fuzzystrmatch,
      hstore,
      ltree,
      uuid_ossp,
      citext,
      tablefunc,
      cube,
      earthdistance,
      intarray,
      unaccent
    }
  })

  await db.waitReady

  parentPort!.postMessage({ type: 'ready' } satisfies WorkerResponse)
}

/** pglite 是单连接：任何错误都可能让事务停在 aborted 态，后续所有查询全挂。
 *  在 catch 里盲发一次 ROLLBACK 兜底，让 worker 自愈。 */
async function rollbackQuietly(): Promise<void> {
  if (!db) return
  try {
    await db.exec('ROLLBACK')
  } catch {
    // 无事务时 ROLLBACK 只产生 NOTICE，不会抛；这里捕获是给其它意外兜底
  }
}

async function query(id: string, sql: string, params?: unknown[]): Promise<void> {
  if (!db) {
    parentPort!.postMessage({
      type: 'error',
      id,
      error: 'PGLite runtime not initialized'
    } satisfies WorkerResponse)
    return
  }

  try {
    // 多语句 query：pglite 的 `query()` 只跑单语句 + 参数；多语句拆开执行，
    // 取最后一个产生结果集的语句作为返回（与 PostgREST 行为对齐）。
    // 用 `pg.query` 走的是 extended protocol，参数化、类型安全。
    const result = await db.query(sql, params ?? [])
    const fields: QueryField[] = (result.fields ?? []).map(
      (f: { name: string; dataTypeID: number }) => ({
        name: f.name,
        dataTypeID: f.dataTypeID
      })
    )
    parentPort!.postMessage({
      type: 'result',
      id,
      rows: result.rows ?? [],
      fields,
      affectedRows: result.affectedRows ?? 0,
      rowCount: (result.rows ?? []).length,
      columnCount: fields.length
    } satisfies WorkerResponse)
  } catch (err: unknown) {
    await rollbackQuietly()
    parentPort!.postMessage({
      type: 'error',
      id,
      error: err instanceof Error ? err.message : String(err)
    } satisfies WorkerResponse)
  }
}

async function execute(id: string, sql: string): Promise<void> {
  if (!db) {
    parentPort!.postMessage({
      type: 'error',
      id,
      error: 'PGLite runtime not initialized'
    } satisfies WorkerResponse)
    return
  }

  try {
    const results = await db.exec(sql)

    // 格式化所有结果
    const outputParts: string[] = []
    let totalRowCount = 0
    let lastColumnCount = 0

    for (const result of results) {
      const formatted = formatResultSet(result)
      if (formatted) outputParts.push(formatted)
      if (result.rows) totalRowCount += result.rows.length
      if (result.fields) lastColumnCount = result.fields.length
    }

    const output = outputParts.join('\n\n') || 'OK'

    parentPort!.postMessage({
      type: 'result',
      id,
      output,
      rowCount: totalRowCount,
      columnCount: lastColumnCount
    } satisfies WorkerResponse)
  } catch (err: unknown) {
    await rollbackQuietly()
    parentPort!.postMessage({
      type: 'error',
      id,
      error: err instanceof Error ? err.message : String(err)
    } satisfies WorkerResponse)
  }
}

// ---- 执行队列（确保同一 worker 内串行执行） ----

let execQueue: Promise<void> = Promise.resolve()

// ---- 消息处理 ----

parentPort!.on('message', (msg: InitMessage | ExecuteMessage | QueryMessage) => {
  if (msg.type === 'init') {
    execQueue = execQueue.then(async () => {
      try {
        await init(msg.dataDir)
      } catch (err: unknown) {
        parentPort!.postMessage({
          type: 'error',
          error: `Failed to initialize PGLite: ${err instanceof Error ? err.message : typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err)}`
        } satisfies WorkerResponse)
      }
    })
  } else if (msg.type === 'execute') {
    execQueue = execQueue.then(() => execute(msg.id, msg.sql))
  } else if (msg.type === 'query') {
    execQueue = execQueue.then(() => query(msg.id, msg.sql, msg.params))
  }
})
