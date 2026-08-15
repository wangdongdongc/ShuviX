/**
 * `shuvix pglite` argv 解析器
 *
 * 把命令行参数翻译成 worker 端可执行的 SqlRequest。
 * 子集，向 psql 看齐：
 *   shuvix pglite -c "SELECT ..."         → mode='-c',     sql=<arg>
 *   shuvix pglite -f path.sql             → mode='file',   filePath=<arg>（CLI 端 readFileSync）
 *   shuvix pglite -                       → mode='stdin',  sql=<已预读 stdin>
 *   shuvix pglite (无参 / 仅 stdin)       → mode='stdin' 若有 stdin，否则 error
 *   shuvix pglite -V | --version          → mode='version'
 *   shuvix pglite -h | --help             → helpText
 *
 *   附加：`--extension <name>` 可多次出现，预加载扩展
 */

export type SqlExecMode = '-c' | 'file' | 'stdin' | 'version'

export interface SqlRequest {
  mode: SqlExecMode
  /** mode='-c' / 'stdin' 时承载 SQL 文本；其他模式为空 */
  sql: string
  /** mode='file' 时为脚本路径，CLI 端负责读取后塞入 sql 字段 */
  filePath?: string
  /** 预加载的扩展列表 */
  extensions: string[]
}

export interface ParseResult {
  request?: SqlRequest
  helpText?: string
  error?: string
}

export const HELP_TEXT = [
  'Usage: shuvix pglite [option] ... [-c sql | -f script.sql | -]',
  '',
  'Options:',
  '  -c sql            execute the given SQL statement(s); semicolon-separated supported',
  '  -f path           read SQL statements from the given file',
  '  -                 read SQL statements from stdin',
  '  --extension name  enable a PG extension before execution; repeat for multiple',
  '  -V, --version     print runtime info and exit',
  '  -h, --help        print this help and exit',
  '',
  'Notes:',
  '  - Runs on the embedded PGLite WebAssembly Postgres — no native server required.',
  '  - Tables/data persist across calls in the same ShuviX project when persistent mode',
  '    is enabled (project setting "Persistent Data Storage").',
  '  - COPY TO/FROM works against the project directory',
  '    follows bash-process permissions, not ShuviX fine-grained sandboxing.',
  '  - Output is psql-style aligned text. Need JSON? Use `SELECT row_to_json(t) FROM ...`.'
].join('\n')

/** 累积消费 `--extension <name>` 形式的成对参数，返回扩展列表 + 剩余 argv */
function collectExtensions(argv: string[]): { extensions: string[]; rest: string[] } {
  const extensions: string[] = []
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--extension') {
      const name = argv[i + 1]
      if (!name) {
        // 缺值——让上游产出 error
        rest.push(tok)
        continue
      }
      extensions.push(name)
      i++ // 跳过 value
    } else {
      rest.push(tok)
    }
  }
  return { extensions, rest }
}

export function parseShuvixPgliteArgv(argv: string[], hasStdin: boolean): ParseResult {
  // --extension 与 mode flag 可任意穿插，先把它们抽出来
  const { extensions, rest } = collectExtensions(argv)

  // 校验 --extension 残留（没接 value）
  if (rest.includes('--extension')) {
    return { error: 'shuvix pglite: argument expected for --extension option' }
  }

  if (rest.length === 0) {
    if (hasStdin) {
      return { request: { mode: 'stdin', sql: '', extensions } }
    }
    return { error: HELP_TEXT }
  }

  const first = rest[0]

  if (first === '-h' || first === '--help') {
    return { helpText: HELP_TEXT }
  }

  if (first === '-V' || first === '--version') {
    return { request: { mode: 'version', sql: '', extensions } }
  }

  if (first === '-c') {
    const sql = rest[1]
    if (sql === undefined) {
      return { error: 'shuvix pglite: argument expected for -c option' }
    }
    if (rest.length > 2) {
      return {
        error: `shuvix pglite: unexpected extra arguments after -c: ${rest.slice(2).join(' ')}`
      }
    }
    return { request: { mode: '-c', sql, extensions } }
  }

  if (first === '-f') {
    const path = rest[1]
    if (!path) {
      return { error: 'shuvix pglite: argument expected for -f option' }
    }
    if (rest.length > 2) {
      return {
        error: `shuvix pglite: unexpected extra arguments after -f: ${rest.slice(2).join(' ')}`
      }
    }
    return { request: { mode: 'file', sql: '', filePath: path, extensions } }
  }

  if (first === '-') {
    if (!hasStdin) {
      return { error: 'shuvix pglite: "-" requires stdin but none was provided' }
    }
    return { request: { mode: 'stdin', sql: '', extensions } }
  }

  if (first.startsWith('-')) {
    return { error: `shuvix pglite: unknown option: ${first}` }
  }

  return { error: `shuvix pglite: unrecognized argument: ${first}` }
}
