/**
 * SQL Worker — 在 worker_threads 中运行 PGLite (Postgres WASM) 运行时
 * 支持多语句执行、扩展加载、NODEFS 文件系统挂载
 */

import { parentPort } from 'worker_threads'

// ---- 消息协议 ----

interface InitMessage {
  type: 'init'
  mounts: MountConfig[]
}

interface ExecuteMessage {
  type: 'execute'
  id: string
  sql: string
  extensions?: string[]
}

export interface MountConfig {
  hostPath: string
  access: 'readonly' | 'readwrite'
}

export interface WorkerResponse {
  type: 'ready' | 'result' | 'error'
  id?: string
  output?: string
  error?: string
  rowCount?: number
  columnCount?: number
}

// ---- PGLite 运行时 ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null

/** 递归创建目录 */
function mkdirRecursive(fs: { stat(p: string): void; mkdir(p: string): void }, path: string): void {
  const parts = path.split('/').filter(Boolean)
  let current = ''
  for (const part of parts) {
    current += '/' + part
    try {
      fs.stat(current)
    } catch {
      try {
        fs.mkdir(current)
      } catch {
        // 已存在
      }
    }
  }
}

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

async function init(mounts: MountConfig[]): Promise<void> {
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

  // 挂载宿主文件系统（路径与宿主一致）
  if (mounts.length > 0) {
    try {
      const FS = db.Module.FS
      const NODEFS = FS.filesystems.NODEFS
      for (const mount of mounts) {
        mkdirRecursive(FS, mount.hostPath)
        FS.mount(NODEFS, { root: mount.hostPath }, mount.hostPath)
      }
    } catch (err) {
      // 挂载失败不阻塞初始化
      parentPort!.postMessage({
        type: 'error',
        error: `Warning: failed to mount filesystem: ${err instanceof Error ? err.message : String(err)}`
      } satisfies WorkerResponse)
    }
  }

  parentPort!.postMessage({ type: 'ready' } satisfies WorkerResponse)
}

async function execute(id: string, sql: string, extensions?: string[]): Promise<void> {
  if (!db) {
    parentPort!.postMessage({
      type: 'error',
      id,
      error: 'PGLite runtime not initialized'
    } satisfies WorkerResponse)
    return
  }

  // 加载请求的扩展
  if (extensions && extensions.length > 0) {
    try {
      for (const ext of extensions) {
        await db.exec(`CREATE EXTENSION IF NOT EXISTS "${ext}"`)
      }
    } catch (err: unknown) {
      parentPort!.postMessage({
        type: 'error',
        id,
        error: `Failed to load extensions: ${err instanceof Error ? err.message : String(err)}`
      } satisfies WorkerResponse)
      return
    }
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

parentPort!.on('message', (msg: InitMessage | ExecuteMessage) => {
  if (msg.type === 'init') {
    execQueue = execQueue.then(async () => {
      try {
        await init(msg.mounts)
      } catch (err: unknown) {
        parentPort!.postMessage({
          type: 'error',
          error: `Failed to initialize PGLite: ${err instanceof Error ? err.message : (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err))}`
        } satisfies WorkerResponse)
      }
    })
  } else if (msg.type === 'execute') {
    execQueue = execQueue.then(() => execute(msg.id, msg.sql, msg.extensions))
  }
})
