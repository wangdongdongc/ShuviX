/**
 * 真值填回命令时按占位符所在的引号环境转义（docs/auto-redaction-design.md §14.2）。模型看不到真值，没法替它加引号：
 * 密码里的 `$` 在 `"{{…}}"` 里会被展开，`'` 在 `'{{…}}'` 里会截断命令。
 *
 * POSIX（bash 工具、`mcp__ssh__exec`）按 tree-sitter-bash 判位置（security/shell/quoting.ts）；PowerShell 用这里手写的
 * 扫描。判不出来（解析器没就绪、命令有语法错误）→ null，调用方退回原样替换（v0.2.34 及以前的行为）。
 * 只按最外层转义：`bash -c '…{{…}}…'` 里那一层由内层 shell 再解析一次，管不到。
 */
import { shellQuoteContexts, type ShellQuoteContext } from '../security/shell/quoting'

/** 命令的方言 */
export type CommandDialect = 'posix' | 'powershell'

/** PowerShell 的引号环境：`here-double` = `@"…"@`（`` ` `` 与 `$` 照样起作用） */
type PowerShellContext = 'bare' | 'single' | 'double' | 'here-double' | 'literal'

export type QuoteContext = ShellQuoteContext | PowerShellContext

interface Span {
  start: number
  end: number
}

/** 命令里几处所在的引号环境；判不出来 → null */
export function commandQuoteContexts(
  command: string,
  spans: readonly Span[],
  dialect: CommandDialect
): QuoteContext[] | null {
  if (spans.length === 0) return []
  return dialect === 'posix'
    ? shellQuoteContexts(command, spans)
    : powershellQuoteContexts(command, spans)
}

/** POSIX 裸词里不必加引号的字符 */
const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/
const SINGLE_QUOTES = /['‘’‚‛]/g
const DOUBLE_QUOTES = /["“”„]/g

/** 真值放进这个环境要写成什么 */
export function quoteValue(value: string, context: QuoteContext, dialect: CommandDialect): string {
  if (dialect === 'posix') {
    switch (context) {
      case 'single':
        return value.replace(/'/g, `'\\''`)
      case 'double':
        return value.replace(/[\\$`"]/g, '\\$&')
      case 'ansi-c':
        return value.replace(/[\\']/g, '\\$&')
      case 'heredoc':
        return value.replace(/[\\$`]/g, '\\$&')
      case 'literal':
        return value
      default:
        return POSIX_SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
    }
  }
  switch (context) {
    case 'single':
      return value.replace(SINGLE_QUOTES, '$&$&')
    case 'double':
      return value.replace(/[`$]/g, '`$&').replace(DOUBLE_QUOTES, '`$&')
    case 'here-double':
      return value.replace(/[`$]/g, '`$&')
    case 'literal':
      return value
    default:
      // 表达式里的裸词会被当成命令名（`$p = abc`）：一律加单引号
      return `'${value.replace(SINGLE_QUOTES, '$&$&')}'`
  }
}

const isSingleQuote = (c: string | undefined): boolean =>
  c === "'" || c === '‘' || c === '’' || c === '‚' || c === '‛'
const isDoubleQuote = (c: string | undefined): boolean =>
  c === '"' || c === '“' || c === '”' || c === '„'

/**
 * PowerShell 的引号环境：单引号（`''` 转义）、双引号（`` ` `` 转义、`""` 也算一个引号）、here-string（`@'`/`@"` 后换行
 * 开始，行首 `'@`/`"@` 结束）、行注释与块注释。双引号里的 `$( )` 仍算双引号 —— 那一层里写占位符的写法少见，
 * 转义多了只是多几个反引号，不会断开字符串。
 */
function powershellQuoteContexts(source: string, spans: readonly Span[]): PowerShellContext[] {
  const at = new Array<PowerShellContext>(source.length).fill('bare')
  let i = 0
  const mark = (from: number, to: number, context: PowerShellContext): void => {
    for (let k = from; k < Math.min(to, source.length); k++) at[k] = context
  }
  while (i < source.length) {
    const c = source[i]
    if (c === '`') {
      i += 2
    } else if (c === '#') {
      const end = source.indexOf('\n', i)
      const to = end === -1 ? source.length : end
      mark(i, to, 'literal')
      i = to
    } else if (c === '<' && source[i + 1] === '#') {
      const end = source.indexOf('#>', i + 2)
      const to = end === -1 ? source.length : end + 2
      mark(i, to, 'literal')
      i = to
    } else if (c === '@' && (isSingleQuote(source[i + 1]) || isDoubleQuote(source[i + 1]))) {
      const double = isDoubleQuote(source[i + 1])
      const close = new RegExp(`\\n[ \\t]*${double ? '["“”„]' : "['‘’‚‛]"}@`, 'g')
      close.lastIndex = i + 2
      const m = close.exec(source)
      const to = m === null ? source.length : m.index + m[0].length
      mark(i, to, double ? 'here-double' : 'literal')
      i = to
    } else if (isSingleQuote(c)) {
      let k = i + 1
      while (k < source.length) {
        if (isSingleQuote(source[k])) {
          if (isSingleQuote(source[k + 1])) {
            k += 2
            continue
          }
          break
        }
        k++
      }
      mark(i, k + 1, 'single')
      i = k + 1
    } else if (isDoubleQuote(c)) {
      let k = i + 1
      while (k < source.length) {
        if (source[k] === '`') {
          k += 2
          continue
        }
        if (isDoubleQuote(source[k])) {
          if (isDoubleQuote(source[k + 1])) {
            k += 2
            continue
          }
          break
        }
        k++
      }
      mark(i, k + 1, 'double')
      i = k + 1
    } else {
      i++
    }
  }
  return spans.map((span) => at[span.start] ?? 'bare')
}
