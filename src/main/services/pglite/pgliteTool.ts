/**
 * PGLite 工具 — 使用 PGLite (Postgres WASM) 运行时执行 SQL
 * 支持多语句、扩展加载、COPY FROM 读取项目文件
 */

import { Type, type Static } from '@sinclair/typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import { t } from '../../i18n'
import {
  truncateTail,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES
} from '../../../shared/node/truncate'
import { BaseTool } from '../baseTool'
import { TOOL_ABORTED, type ToolContext } from '../toolContext'
import { createLogger } from '../../logger'
import { pgliteWorkerManager, type SqlStorageMode } from './workerManager'
import { setSqlRuntimeReady, setSqlRuntimeDestroyed } from './runtimeStatus'
import { registerBuiltinTool } from '../toolRegistry'

const log = createLogger('pglite:tool')
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

type SqlParams = Static<typeof SqlParamsSchema>

export class PgliteTool extends BaseTool<typeof SqlParamsSchema> {
  readonly name = 'postgres'
  get label(): string {
    return t('tool.localDbLabel')
  }
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
    // PGLite 初始化在 execute 里懒加载（依赖 sessionId）
  }

  protected async securityCheck(
    _toolCallId: string,
    _params: SqlParams,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    // PGLite WASM 本身即沙箱，无需审批
  }

  protected async executeInternal(
    toolCallId: string,
    params: SqlParams,
    signal?: AbortSignal
  ): Promise<AgentToolResult<unknown>> {
    const sessionId = this.ctx.sessionId
    const timeoutSec = Math.min(params.timeout ?? DEFAULT_TIMEOUT, 300)
    const startTime = Date.now()

    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    // 懒初始化 — 首次调用时创建 worker
    const status = pgliteWorkerManager.getStatus(sessionId)
    await pgliteWorkerManager.ensureReady(sessionId, () => {
      const newStatus = pgliteWorkerManager.getStatus(sessionId)
      const storageMode = newStatus?.storageMode ?? 'memory'
      this.emitReady(sessionId, storageMode)
    })

    // 若 worker 已存在但状态未上报（如 session 切换后状态恢复）
    if (!status) {
      const currentStatus = pgliteWorkerManager.getStatus(sessionId)
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
                pgliteWorkerManager.terminate(sessionId)
                this.emitDestroyed(sessionId)
                reject(new Error(TOOL_ABORTED))
              },
              { once: true }
            )
          })
        : null

      const execPromise = pgliteWorkerManager.execute(
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

      log.info(
        `SQL executed (session ${sessionId}): ${params.sql.slice(0, 50)}... → ${hasError ? 'error' : 'ok'} (${executionTime}ms)`
      )

      return {
        content: [{ type: 'text' as const, text }],
        details: {
          type: 'postgres',
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

  private emitReady(sessionId: string, storageMode: SqlStorageMode): void {
    setSqlRuntimeReady(sessionId, storageMode)
  }

  private emitDestroyed(sessionId: string): void {
    setSqlRuntimeDestroyed(sessionId)
  }
}

registerBuiltinTool({
  name: 'postgres',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.localDbLabel'),
  getHint: () => t('tool.localDbHint'),
  factory: (ctx) => new PgliteTool(ctx),
  presentation: {
    icon: 'Database',
    iconColor: '#3b82f6',
    summaryField: 'sql',
    formItems: [
      { field: 'sql', renderer: { type: 'code', language: 'sql' } },
      { field: 'extensions', label: 'Extensions' },
      { field: 'timeout', label: 'Timeout' }
    ]
  }
})
