/**
 * Python 工具 — 使用 Pyodide WASM 运行时执行 Python 代码
 * REPL 交互模式，多轮共享作用域，无需本机 Python
 */

import { Type } from '@sinclair/typebox'
import { truncateTail, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { BaseTool, resolveProjectConfig, TOOL_ABORTED, type ToolContext } from './types'
import { pythonWorkerManager } from '../services/pythonWorkerManager'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { PythonToolDetails } from '../../shared/types/chatMessage'
import { t } from '../i18n'
import { createLogger } from '../logger'

const log = createLogger('Tool:python')

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

export class PythonTool extends BaseTool<typeof PythonParamsSchema> {
  readonly name = 'python'
  readonly label = t('tool.pythonLabel')
  readonly description = `Execute Python code in a built-in Pyodide (WebAssembly) runtime. This is an interactive REPL environment:
- The last expression value is automatically displayed (no need for print())
- Variables and imports persist across multiple calls within the same session (use \`_\` to reference the last result)
- The Python environment is Pyodide (WASM), not native Python. Standard library is available, but some C-extension modules (multiprocessing, ctypes, etc.) are not
- Pre-installed packages: pyyaml, beautifulsoup4, regex, python-dateutil, pytz — import them directly (e.g. \`import yaml\`, \`from bs4 import BeautifulSoup\`)
- To install additional packages, use the \`packages\` parameter of this tool (e.g. \`packages: ["pandas"]\`). Do NOT use micropip, pip, or pyodide.loadPackage in code — they will fail. Only pure-Python PyPI packages are supported
- The working directory is set to the project root, so relative paths work (e.g. open('data.csv')). Absolute paths also work
- Use this tool for data processing, calculations, scripting, and any task that benefits from Python`
  readonly parameters = PythonParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    // 懒初始化 — 首次调用时创建 worker
    const config = resolveProjectConfig(this.ctx.sessionId)
    await pythonWorkerManager.ensureReady(
      this.ctx.sessionId,
      config,
      () => this.ctx.onPythonReady?.()
    )
  }

  protected async securityCheck(
    _toolCallId: string,
    _params: { code: string; packages?: string[]; timeout?: number },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    // Pyodide WASM 本身即沙箱，无需审批
  }

  protected async executeInternal(
    toolCallId: string,
    params: { code: string; packages?: string[]; timeout?: number },
    signal?: AbortSignal
  ): Promise<AgentToolResult<PythonToolDetails>> {
    const timeoutSec = Math.min(params.timeout ?? DEFAULT_TIMEOUT, 300)
    const startTime = Date.now()

    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    try {
      // 通过 abort signal 监听取消
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                pythonWorkerManager.terminate(this.ctx.sessionId)
                this.ctx.onPythonDestroyed?.()
                reject(new Error(TOOL_ABORTED))
              },
              { once: true }
            )
          })
        : null

      const execPromise = pythonWorkerManager.execute(
        this.ctx.sessionId,
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

      log.info(
        `Python executed (session ${this.ctx.sessionId}): ${params.code.slice(0, 50)}... → ${hasError ? 'error' : 'ok'} (${executionTime}ms)`
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
        this.ctx.onPythonDestroyed?.()
      }

      throw new Error(`Python execution failed: ${errMsg}`)
    }
  }
}
