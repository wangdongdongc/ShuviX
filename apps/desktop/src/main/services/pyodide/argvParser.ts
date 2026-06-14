/**
 * `shuvix python` argv 解析器
 *
 * 把命令行参数翻译成 worker 端可执行的 ExecuteRequest。
 * 模仿 cpython 的 argv 处理子集：
 *   shuvix python script.py [args...]     → mode='script',  pythonArgv=[script, ...args]
 *   shuvix python -c "code" [args...]     → mode='-c',      pythonArgv=['-c', ...args]
 *   shuvix python -m mod [args...]        → mode='-m',      pythonArgv=[mod, ...args]
 *   shuvix python - [args...]             → mode='stdin',   pythonArgv=['-', ...args]
 *   shuvix python (无参 / 仅 stdin)       → mode='stdin' (若有 stdin) / 否则 error
 *   shuvix python -V | --version          → mode='version'
 *   shuvix python -h | --help             → helpText
 *
 * 注：不实现 -i / -O / -B / -E 等 cpython 启动 flag，对当前用法无价值。
 */

export type ExecMode = 'script' | '-c' | '-m' | 'stdin' | 'version'

export interface ExecuteRequest {
  mode: ExecMode
  /** mode='-c' / 'stdin' 时承载源码；其他模式为空 */
  code: string
  /** mode='script' 时是脚本路径；mode='-m' 时是模块名 */
  target?: string
  /** 注入给 Python 端的 sys.argv */
  pythonArgv: string[]
}

export interface ParseResult {
  request?: ExecuteRequest
  helpText?: string
  error?: string
}

export const HELP_TEXT = [
  'Usage: shuvix python [option] ... [-c cmd | -m mod | script | -] [arg] ...',
  '',
  'Options:',
  '  -c cmd       execute the given Python code string',
  '  -m mod       run library module as a script',
  '  -            read program from stdin',
  '  -V, --version  print Pyodide-Python version and exit',
  '  -h, --help     print this help and exit',
  '',
  'Notes:',
  '  - Runs on the embedded Pyodide WebAssembly interpreter — no native Python required.',
  '  - Each invocation gets a fresh globals namespace (no REPL state across calls).',
  '  - PYTHONPATH env var is honoured; directories are mounted readonly on demand.',
  '  - Sandbox: read/write boundaries follow the calling ShuviX session.'
].join('\n')

export function parseShuvixPythonArgv(argv: string[], hasStdin: boolean): ParseResult {
  if (argv.length === 0) {
    if (hasStdin) {
      return { request: { mode: 'stdin', code: '', pythonArgv: [''] } }
    }
    return { error: HELP_TEXT }
  }

  const first = argv[0]

  if (first === '-h' || first === '--help') {
    return { helpText: HELP_TEXT }
  }

  if (first === '-V' || first === '--version') {
    return { request: { mode: 'version', code: '', pythonArgv: ['python'] } }
  }

  if (first === '-c') {
    const code = argv[1]
    if (code === undefined) {
      return { error: 'shuvix python: argument expected for -c option' }
    }
    return { request: { mode: '-c', code, pythonArgv: ['-c', ...argv.slice(2)] } }
  }

  if (first === '-m') {
    const mod = argv[1]
    if (!mod) {
      return { error: 'shuvix python: argument expected for -m option' }
    }
    return {
      request: { mode: '-m', code: '', target: mod, pythonArgv: [mod, ...argv.slice(2)] }
    }
  }

  if (first === '-') {
    if (!hasStdin) {
      return { error: 'shuvix python: "-" requires stdin but none was provided' }
    }
    return { request: { mode: 'stdin', code: '', pythonArgv: ['-', ...argv.slice(1)] } }
  }

  // 未知 flag：与 cpython 行为对齐——以 `-` 开头但不识别则报错
  if (first.startsWith('-') && first.length > 1) {
    return { error: `shuvix python: unknown option: ${first}` }
  }

  // 否则当作脚本路径
  return { request: { mode: 'script', code: '', target: first, pythonArgv: argv } }
}

/**
 * 把 PYTHONPATH 字符串按平台分隔符切开。
 * Windows 用 `;`（路径里 `C:` 不能当分隔符），其他平台用 `:`，与 cpython 一致。
 * 第二参数注入平台标识符以方便测试。
 */
export function splitPythonPath(
  pythonPath: string | undefined,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (!pythonPath) return []
  const sep = platform === 'win32' ? ';' : ':'
  return pythonPath
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean)
}
