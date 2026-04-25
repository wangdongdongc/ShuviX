/**
 * Pyodide 工具 — 使用 Pyodide WASM 运行时执行 Python 代码
 * REPL 交互模式，多轮共享作用域，无需本机 Python
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
import { pyodideWorkerManager } from './workerManager'
import { setPythonRuntimeReady, setPythonRuntimeDestroyed } from './runtimeStatus'
import { registerBuiltinTool } from '../toolRegistry'

const log = createLogger('pyodide:tool')
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
  modulePaths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Absolute host .py file paths to load BEFORE executing `code`. The tool reads each file's source and exec's it in the persistent REPL globals, so all top-level definitions (functions, constants, classes) become directly callable from `code`. Use this to reuse scripts that ship inside a skill (e.g. pass `<skill-dir>/templates/slides.py`, then just call `cover_slide(prs, ...)` from `code`). Do NOT paste the module source into `code`. Loads are idempotent and persist for the rest of the session."
    })
  ),
  timeout: Type.Optional(
    Type.Number({
      description: `Execution timeout in seconds (default: ${DEFAULT_TIMEOUT}s, max: 300s). Increase for long-running computations.`
    })
  )
})

type PythonParams = Static<typeof PythonParamsSchema>

export class PyodideTool extends BaseTool<typeof PythonParamsSchema> {
  readonly name = 'python'
  get label(): string {
    return t('tool.pythonLabel')
  }
  readonly description = `Execute Python code in a built-in Pyodide (WebAssembly) runtime. This is an interactive REPL environment:
- The last expression value is automatically displayed (no need for print())
- Variables and imports persist across multiple calls within the same session (use \`_\` to reference the last result)
- The Python environment is Pyodide (WASM), not native Python. Standard library is available, but some C-extension modules (multiprocessing, ctypes, etc.) are not
- Pre-installed packages: pyyaml, beautifulsoup4, regex, python-dateutil, pytz, lxml, cssselect, pillow, pymupdf, xlrd, python-calamine, openpyxl, python-docx, python-pptx — import them directly
- Office/document processing: use pymupdf for PDF (\`import pymupdf\`), openpyxl for Excel .xlsx read/write (\`from openpyxl import load_workbook\`), xlrd/python-calamine for legacy .xls and fast reading, python-docx for Word .docx (\`from docx import Document\`), python-pptx for PowerPoint (\`from pptx import Presentation\`)
- To install additional packages, use the \`packages\` parameter of this tool (e.g. \`packages: ["pandas"]\`). Do NOT use micropip, pip, or pyodide.loadPackage in code — they will fail. Only pure-Python PyPI packages are supported
- To reuse .py scripts bundled inside a skill, pass their absolute file paths via the \`modulePaths\` parameter. The tool reads each file and exec's it into the REPL before running \`code\`, so all its top-level functions/constants are callable directly — your \`code\` becomes "call foo(...) with my data" instead of pasting the entire script
- The working directory is set to the project root, so relative paths work (e.g. open('data.csv')). Absolute paths also work
- Use this tool for data processing, calculations, scripting, and any task that benefits from Python`
  readonly parameters = PythonParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    // Pyodide 初始化在 execute 里懒加载（依赖 sessionId）
  }

  protected async securityCheck(
    _toolCallId: string,
    _params: PythonParams,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    // Pyodide WASM 本身即沙箱，无需审批
  }

  protected async executeInternal(
    toolCallId: string,
    params: PythonParams,
    signal?: AbortSignal
  ): Promise<AgentToolResult<unknown>> {
    const sessionId = this.ctx.sessionId
    const timeoutSec = Math.min(params.timeout ?? DEFAULT_TIMEOUT, 300)
    const startTime = Date.now()

    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    // 懒初始化 — 首次调用时创建 worker
    await pyodideWorkerManager.ensureReady(sessionId, () => {
      setPythonRuntimeReady(sessionId)
    })

    try {
      // 通过 abort signal 监听取消
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                pyodideWorkerManager.terminate(sessionId)
                setPythonRuntimeDestroyed(sessionId)
                reject(new Error(TOOL_ABORTED))
              },
              { once: true }
            )
          })
        : null

      const execPromise = pyodideWorkerManager.execute(
        sessionId,
        toolCallId,
        params.code,
        params.packages,
        timeoutSec * 1000,
        params.modulePaths
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
        setPythonRuntimeDestroyed(sessionId)
      }

      throw new Error(`Python execution failed: ${errMsg}`)
    }
  }
}

registerBuiltinTool({
  name: 'python',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.pythonLabel'),
  getHint: () => t('tool.pythonHint'),
  factory: (ctx) => new PyodideTool(ctx),
  presentation: {
    icon: 'Code',
    iconColor: '#eab308',
    summaryField: 'code',
    formItems: [
      { field: 'code', renderer: { type: 'code', language: 'python' } },
      { field: 'packages', label: 'Packages' },
      { field: 'modulePaths', label: 'Module Paths' },
      { field: 'timeout', label: 'Timeout' }
    ]
  }
})
