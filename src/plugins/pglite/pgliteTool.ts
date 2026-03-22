/**
 * PGLite 工具 — 使用 PGLite (Postgres WASM) 运行时执行 SQL
 * 支持多语句、扩展加载、COPY FROM 读取项目文件
 */

import { Type } from '@sinclair/typebox'
import type {
  PluginTool,
  PluginContext,
  AgentToolResult,
  PluginToolPresentation
} from '../../plugin-api'
import {
  truncateTail,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES
} from '../../shared/node/truncate'
import type { PgliteWorkerManager, SqlStorageMode } from './workerManager'

const TOOL_ABORTED = 'Aborted'
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

export class PgliteTool implements PluginTool<typeof SqlParamsSchema> {
  readonly name = 'sql'
  readonly label = 'Execute SQL'
  readonly description = `Execute SQL in a built-in PGLite (PostgreSQL 17 WASM) runtime. This is a full PostgreSQL database:
- Multiple statements in one call are supported (separated by semicolons)
- Tables, indexes, views, functions, and data persist across calls within the same session
- Rich extension ecosystem: pgvector for embeddings/similarity search, pg_trgm for fuzzy text matching, tablefunc for pivot tables, and more — enable via the \`extensions\` parameter
- Import CSV/TSV files from the project directory: COPY table FROM '/absolute/path/to/file.csv' WITH (FORMAT csv, HEADER true)
- Full PostgreSQL feature set: window functions, CTEs, JSON operators, array operations, regex, aggregate functions, subqueries
- Best for: structured data analysis, CSV/JSON import & query, data modeling/prototyping, aggregations & pivots, fuzzy/similarity search, vector similarity (RAG)
- Prefer this tool over Python for tabular data analysis — SQL is more concise and less error-prone for aggregation, filtering, joining, and pivoting`
  readonly parameters = SqlParamsSchema
  readonly presentation: PluginToolPresentation = {
    icon: 'Database',
    iconColor: '#3b82f6',
    summaryField: 'sql',
    formItems: [
      { field: 'sql', renderer: { type: 'code', language: 'sql' } },
      { field: 'extensions', label: 'Extensions' },
      { field: 'timeout', label: 'Timeout' }
    ]
  }

  constructor(
    private ctx: PluginContext,
    private workerManager: PgliteWorkerManager
  ) {}

  async preExecute(_toolCallId: string, _params: Record<string, unknown>): Promise<void> {
    // sessionId 无法从 preExecute 获取，延迟到 execute 中处理
  }

  async securityCheck(
    _toolCallId: string,
    _params: { sql: string; extensions?: string[]; timeout?: number },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    // PGLite WASM 本身即沙箱，无需审批
  }

  async execute(
    toolCallId: string,
    params: { sql: string; extensions?: string[]; timeout?: number },
    signal?: AbortSignal,
    _onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
    sessionId?: string
  ): Promise<AgentToolResult<unknown>> {
    if (!sessionId) throw new Error('sessionId is required for SQL tool')

    const timeoutSec = Math.min(params.timeout ?? DEFAULT_TIMEOUT, 300)
    const startTime = Date.now()

    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    // 懒初始化 — 首次调用时创建 worker
    const status = this.workerManager.getStatus(sessionId)
    await this.workerManager.ensureReady(sessionId, () => {
      const newStatus = this.workerManager.getStatus(sessionId)
      const storageMode = newStatus?.storageMode ?? 'memory'
      this.emitReady(sessionId, storageMode)
    })

    // 若 worker 已存在但状态未上报（如 session 切换后状态恢复）
    if (!status) {
      const currentStatus = this.workerManager.getStatus(sessionId)
      if (currentStatus) {
        this.emitReady(sessionId, currentStatus.storageMode)
      }
    }

    try {
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                this.workerManager.terminate(sessionId)
                this.emitDestroyed(sessionId)
                reject(new Error(TOOL_ABORTED))
              },
              { once: true }
            )
          })
        : null

      const execPromise = this.workerManager.execute(
        sessionId,
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

      this.ctx.logger.info(
        `SQL executed (session ${sessionId}): ${params.sql.slice(0, 50)}... → ${hasError ? 'error' : 'ok'} (${executionTime}ms)`
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
        this.emitDestroyed(sessionId)
      }

      throw new Error(`SQL execution failed: ${errMsg}`)
    }
  }

  /** 销毁指定 session 的 worker（供 onEvent 调用） */
  destroySession(sessionId: string): void {
    if (!this.workerManager.isActive(sessionId)) return
    this.workerManager.terminate(sessionId)
    this.emitDestroyed(sessionId)
  }

  private emitReady(sessionId: string, storageMode: SqlStorageMode): void {
    this.ctx.emitEvent(sessionId, {
      type: 'plugin:runtime_status',
      runtimeId: 'sql',
      status: {
        label: 'PGLite',
        icon: 'Database',
        color: '#3b82f6',
        description: storageMode === 'persistent' ? 'persistent' : 'memory'
      }
    })
  }

  private emitDestroyed(sessionId: string): void {
    this.ctx.emitEvent(sessionId, {
      type: 'plugin:runtime_status',
      runtimeId: 'sql',
      status: null
    })
  }
}
