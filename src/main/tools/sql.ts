/**
 * SQL 工具 — 使用 PGLite (Postgres WASM) 运行时执行 SQL
 * 支持多语句、扩展加载、COPY FROM 读取项目文件
 */

import { Type } from '@sinclair/typebox'
import { truncateTail, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { BaseTool, resolveProjectConfig, TOOL_ABORTED, type ToolContext } from './types'
import { sqlWorkerManager } from '../services/sqlWorkerManager'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { SqlToolDetails } from '../../shared/types/chatMessage'
import { t } from '../i18n'
import { createLogger } from '../logger'

const log = createLogger('Tool:sql')

const DEFAULT_TIMEOUT = 30

const SqlParamsSchema = Type.Object({
  sql: Type.String({
    description:
      'SQL statement(s) to execute. Multiple statements separated by semicolons are supported and executed sequentially. Tables, views, and data persist across calls within the same session. Use standard PostgreSQL syntax.'
  }),
  extensions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'PostgreSQL extensions to enable before execution (runs CREATE EXTENSION IF NOT EXISTS for each). Available: vector (pgvector similarity search), pg_trgm (trigram fuzzy text matching), fuzzystrmatch (phonetic matching: soundex, levenshtein, metaphone), hstore (key-value pairs), ltree (hierarchical labels), tablefunc (crosstab/pivot tables), cube (multi-dimensional points), earthdistance (geographic distance), citext (case-insensitive text), intarray (integer array operations), unaccent (accent removal), uuid-ossp (UUID generation), pg_uuidv7 (time-sortable UUIDs), pg_hashids (short hash IDs).'
    })
  ),
  timeout: Type.Optional(
    Type.Number({
      description: `Execution timeout in seconds (default: ${DEFAULT_TIMEOUT}s, max: 300s). Increase for large data imports or complex queries.`
    })
  )
})

export class SqlTool extends BaseTool<typeof SqlParamsSchema> {
  readonly name = 'sql'
  readonly label = t('tool.sqlLabel')
  readonly description = `Execute SQL in a built-in PGLite (PostgreSQL 17 WASM) runtime. This is a full PostgreSQL database:
- Multiple statements in one call are supported (separated by semicolons)
- Tables, indexes, views, functions, and data persist across calls within the same session
- Rich extension ecosystem: pgvector for embeddings/similarity search, pg_trgm for fuzzy text matching, tablefunc for pivot tables, and more — enable via the \`extensions\` parameter
- Import CSV/TSV files from the project directory: COPY table FROM '/absolute/path/to/file.csv' WITH (FORMAT csv, HEADER true)
- Full PostgreSQL feature set: window functions, CTEs, JSON operators, array operations, regex, aggregate functions, subqueries
- Best for: structured data analysis, CSV/JSON import & query, data modeling/prototyping, aggregations & pivots, fuzzy/similarity search, vector similarity (RAG)
- Prefer this tool over Python for tabular data analysis — SQL is more concise and less error-prone for aggregation, filtering, joining, and pivoting`
  readonly parameters = SqlParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    const config = resolveProjectConfig(this.ctx.sessionId)
    await sqlWorkerManager.ensureReady(this.ctx.sessionId, config, () => this.ctx.onSqlReady?.())
  }

  protected async securityCheck(
    _toolCallId: string,
    _params: { sql: string; extensions?: string[]; timeout?: number },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    // PGLite WASM 本身即沙箱，无需审批
  }

  protected async executeInternal(
    toolCallId: string,
    params: { sql: string; extensions?: string[]; timeout?: number },
    signal?: AbortSignal
  ): Promise<AgentToolResult<SqlToolDetails>> {
    const timeoutSec = Math.min(params.timeout ?? DEFAULT_TIMEOUT, 300)
    const startTime = Date.now()

    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    // 记录当前存储模式，用于 timeout/abort 后的 destroy 通知
    const currentStorageMode = sqlWorkerManager.getStatus(this.ctx.sessionId)?.storageMode ?? 'memory'

    try {
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                sqlWorkerManager.terminate(this.ctx.sessionId)
                this.ctx.onSqlDestroyed?.(currentStorageMode)
                reject(new Error(TOOL_ABORTED))
              },
              { once: true }
            )
          })
        : null

      const execPromise = sqlWorkerManager.execute(
        this.ctx.sessionId,
        toolCallId,
        params.sql,
        params.extensions,
        timeoutSec * 1000
      )

      const result = abortPromise
        ? await Promise.race([execPromise, abortPromise])
        : await execPromise

      const executionTime = Date.now() - startTime

      const hasError = result.type === 'error'
      const raw = hasError ? result.error || 'Unknown error' : result.output || '(no output)'

      const truncated = truncateTail(raw, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)

      let text = ''
      if (truncated.truncated) {
        text += `[Output truncated: ${truncated.originalLines} lines / ${formatSize(truncated.originalBytes)}]\n\n`
      }
      text += truncated.text

      log.info(
        `SQL executed (session ${this.ctx.sessionId}): ${params.sql.slice(0, 50)}... → ${hasError ? 'error' : 'ok'} (${executionTime}ms)`
      )

      return {
        content: [{ type: 'text' as const, text }],
        details: {
          type: 'sql',
          hasError,
          truncated: truncated.truncated,
          rowCount: result.rowCount,
          columnCount: result.columnCount,
          extensions: params.extensions,
          executionTime
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg === TOOL_ABORTED) throw err

      if (errMsg.includes('timed out')) {
        this.ctx.onSqlDestroyed?.(currentStorageMode)
      }

      throw new Error(`SQL execution failed: ${errMsg}`)
    }
  }
}
