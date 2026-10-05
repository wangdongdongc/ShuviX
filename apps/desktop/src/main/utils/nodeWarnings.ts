/**
 * Node 进程警告的过滤（裁决 Q20）。
 *
 * 会话存储用 Node 自带的 `node:sqlite`（pi-durable 的 SQLite 适配器）。它在 Electron 39 / Node 22 上
 * 能用，但第一次加载时会打一条 `ExperimentalWarning: SQLite is an experimental feature…` —— 每次启动
 * 都在终端 / 日志里出现一次，读起来像出了问题。这里**只吞这一条**：别的 ExperimentalWarning、
 * 别的任何警告照常打印。
 *
 * 必须在第一次加载 `node:sqlite` 之前装上（会话存储的打开器是动态 import，装在它前面即可）；
 * 幂等，装多少次都只包一层。
 */

let original: typeof process.emitWarning | undefined

/** 这是不是 node:sqlite 的那条实验特性警告（只认 ExperimentalWarning + 正文提到 SQLite） */
export function isSqliteExperimentalWarning(warning: unknown, typeOrOptions?: unknown): boolean {
  const message =
    typeof warning === 'string'
      ? warning
      : warning instanceof Error
        ? warning.message
        : typeof (warning as { message?: unknown } | null)?.message === 'string'
          ? (warning as { message: string }).message
          : ''
  let type: unknown = warning instanceof Error ? warning.name : undefined
  if (typeof typeOrOptions === 'string') type = typeOrOptions
  else if (typeOrOptions !== null && typeof typeOrOptions === 'object') {
    type = (typeOrOptions as { type?: unknown }).type ?? type
  }
  return type === 'ExperimentalWarning' && /\bSQLite\b/.test(message)
}

/** 装上过滤（幂等）：包一层 `process.emitWarning`，只拦 SQLite 的实验特性警告 */
export function installSqliteWarningFilter(): void {
  if (original !== undefined) return
  const emit = process.emitWarning
  original = emit
  const filtered = function (this: unknown, warning: unknown, ...rest: unknown[]): void {
    if (isSqliteExperimentalWarning(warning, rest[0])) return
    Reflect.apply(emit, process, [warning, ...rest])
  }
  process.emitWarning = filtered as typeof process.emitWarning
}

/** 过滤器装上了没有 */
export function sqliteWarningFilterInstalled(): boolean {
  return original !== undefined
}

/** 拆掉过滤器、还原 `process.emitWarning` —— 仅供单测隔离 */
export function uninstallSqliteWarningFilterForTests(): void {
  if (original === undefined) return
  process.emitWarning = original
  original = undefined
}
