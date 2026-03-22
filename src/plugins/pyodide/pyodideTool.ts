/**
 * Pyodide 工具 — 使用 Pyodide WASM 运行时执行 Python 代码
 * REPL 交互模式，多轮共享作用域，无需本机 Python
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
} from '../../main/tools/utils/truncate'
import type { PyodideWorkerManager } from './workerManager'

const TOOL_ABORTED = 'Aborted'
const DEFAULT_TIMEOUT = 30

const PythonParamsSchema = Type.Object({
  code: Type.String({
    description:
      'Python code to execute. Runs in interactive REPL mode — the last expression value is automatically displayed (no need for print). Variables and imports persist across calls within the same session. Do not attempt to install packages in code (no micropip/pip/import micropip) — use the `packages` parameter instead.'
  }),
  packages: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Python packages to install before execution (e.g. ["pandas", "requests"]). This is the ONLY way to install packages — do not use micropip/pip/import in code. Only pure-Python PyPI packages are supported; C-extension packages will fail.'
    })
  ),
  timeout: Type.Optional(
    Type.Number({
      description: `Execution timeout in seconds (default: ${DEFAULT_TIMEOUT}s, max: 300s). Increase for long-running computations.`
    })
  )
})

export class PyodideTool implements PluginTool<typeof PythonParamsSchema> {
  readonly name = 'python'
  readonly label = 'Execute Python'
  readonly description = `Execute Python code in a built-in Pyodide (WebAssembly) runtime. This is an interactive REPL environment:
- The last expression value is automatically displayed (no need for print())
- Variables and imports persist across multiple calls within the same session (use \`_\` to reference the last result)
- The Python environment is Pyodide (WASM), not native Python. Standard library is available, but some C-extension modules (multiprocessing, ctypes, etc.) are not
- Pre-installed packages: pyyaml, beautifulsoup4, regex, python-dateutil, pytz — import them directly (e.g. \`import yaml\`, \`from bs4 import BeautifulSoup\`)
- To install additional packages, use the \`packages\` parameter of this tool (e.g. \`packages: ["pandas"]\`). Do NOT use micropip, pip, or pyodide.loadPackage in code — they will fail. Only pure-Python PyPI packages are supported
- The working directory is set to the project root, so relative paths work (e.g. open('data.csv')). Absolute paths also work
- Use this tool for data processing, calculations, scripting, and any task that benefits from Python`
  readonly parameters = PythonParamsSchema
  readonly presentation: PluginToolPresentation = {
    icon: 'Code',
    iconColor: '#eab308',
    summaryField: 'code',
    formItems: [
      { field: 'code', renderer: { type: 'code', language: 'python' } },
      { field: 'packages', label: 'Packages' },
      { field: 'timeout', label: 'Timeout' }
    ]
  }

  constructor(
    private ctx: PluginContext,
    private workerManager: PyodideWorkerManager
  ) {}

  async preExecute(_toolCallId: string, _params: Record<string, unknown>): Promise<void> {
    // sessionId 无法从 preExecute 获取，延迟到 execute 中处理
  }

  async securityCheck(
    _toolCallId: string,
    _params: { code: string; packages?: string[]; timeout?: number },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    // Pyodide WASM 本身即沙箱，无需审批
  }

  async execute(
    toolCallId: string,
    params: { code: string; packages?: string[]; timeout?: number },
    signal?: AbortSignal,
    _onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
    sessionId?: string
  ): Promise<AgentToolResult<unknown>> {
    if (!sessionId) throw new Error('sessionId is required for Python tool')

    const timeoutSec = Math.min(params.timeout ?? DEFAULT_TIMEOUT, 300)
    const startTime = Date.now()

    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    // 懒初始化 — 首次调用时创建 worker
    await this.workerManager.ensureReady(sessionId, () => {
      this.ctx.emitEvent(sessionId, {
        type: 'plugin:runtime_status',
        runtimeId: 'python',
        status: { label: 'Python WASM', icon: 'Code', color: '#eab308' }
      })
    })

    try {
      // 通过 abort signal 监听取消
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
        params.code,
        params.packages,
        timeoutSec * 1000
      )

      const result = abortPromise
        ? await Promise.race([execPromise, abortPromise])
        : await execPromise

      const executionTime = Date.now() - startTime

      // 组装输出
      const parts: string[] = []
      if (result.stdout) parts.push(result.stdout)
      if (result.stderr) parts.push(result.stderr)

      const hasError = result.type === 'error'
      if (hasError && result.error) {
        parts.push(result.error)
      }

      const combined = parts.join('\n')
      const truncated = truncateTail(combined, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)

      let text = ''
      if (truncated.truncated) {
        text += `[Output truncated: ${truncated.originalLines} lines / ${formatSize(truncated.originalBytes)}]\n\n`
      }
      text += truncated.text

      if (!text) {
        text = '(no output)'
      }

      this.ctx.logger.info(
        `Python executed (session ${sessionId}): ${params.code.slice(0, 50)}... → ${hasError ? 'error' : 'ok'} (${executionTime}ms)`
      )

      return {
        content: [{ type: 'text' as const, text }],
        details: {
          type: 'python',
          hasError,
          truncated: truncated.truncated,
          packages: params.packages,
          executionTime
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg === TOOL_ABORTED) throw err

      // 超时导致 worker 被终止时通知前端
      if (errMsg.includes('timed out')) {
        this.emitDestroyed(sessionId)
      }

      throw new Error(`Python execution failed: ${errMsg}`)
    }
  }

  /** 销毁指定 session 的 worker（供 onEvent 调用） */
  destroySession(sessionId: string): void {
    if (!this.workerManager.isActive(sessionId)) return
    this.workerManager.terminate(sessionId)
    this.emitDestroyed(sessionId)
  }

  private emitDestroyed(sessionId: string): void {
    this.ctx.emitEvent(sessionId, {
      type: 'plugin:runtime_status',
      runtimeId: 'python',
      status: null
    })
  }
}
