/**
 * cmd.exe 命令行的最小切分 —— 只为读 PowerShell 里嵌着的 `cmd /c "…"` 载荷。
 *
 * cmd 本身几乎没有「解析」：它把整行交给程序，由程序自己切参数。这里做的只是
 * 规则关心的那一点 —— 按 `&` / `&&` / `||` / `|` 与括号块切成几条命令，每条按空白切词，
 * 去掉引号与 `^` 转义，认出重定向。`%VAR%` 在执行前才展开，含它的词记为动态（null）。
 *
 * 括号只在命令开头、或 `if` / `else` / `for … do` 之后才开一个块；别处的括号是普通字符
 * （`echo (x)` 打印的就是 `(x)`），`for … in (…)` 的集合是一个字面词。把括号一律当分隔
 * 会凭空造出命令（`echo (format C:)`、`dir C:\Program Files (x86)`）。
 * 与 PowerShell 那一层同为宽松轨：只能用来发现危险，不能用来放行。
 */

export interface CmdToken {
  value: string | null
  start: number
  end: number
}

export interface CmdRedirect {
  kind: 'read' | 'write' | 'append' | 'fd-dup'
  target: string | null
  start: number
  end: number
}

export interface CmdSplit {
  /** 每条命令的词（第一项是命令名） */
  commands: CmdToken[][]
  redirects: CmdRedirect[]
}

const REDIRECT_RE = /^[0-9]?(>>?|<)(&[0-9])?/

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t'
}

/** 命令之间的分隔：`&` `&&` `||` `|` 与换行（括号块另算，见 splitCmdLine） */
function isSeparator(c: string): boolean {
  return c === '&' || c === '|' || c === '\n' || c === '\r'
}

/** 从 open（一个 `(`）起到与之配对的 `)` 的下标；引号里的括号不算；没有配对返回 -1 */
function matchingParen(text: string, open: number): number {
  let depth = 0
  let quoted = false
  for (let k = open; k < text.length; k++) {
    const c = text[k]
    if (c === '"') quoted = !quoted
    if (quoted) continue
    if (c === '(') depth++
    if (c === ')' && --depth === 0) return k
  }
  return -1
}

export function splitCmdLine(text: string): CmdSplit {
  const commands: CmdToken[][] = []
  const redirects: CmdRedirect[] = []
  let current: CmdToken[] = []
  let i = 0
  /** 当前所在的括号块层数 —— 只有块里的 `)` 才是块的结尾 */
  let blocks = 0

  const first = (): string => current[0]?.value?.toLowerCase() ?? ''
  const last = (): string => current[current.length - 1]?.value?.toLowerCase() ?? ''

  /** 读一个词（引号内不切、`^` 转义下一个字符） */
  const readToken = (): CmdToken => {
    const start = i
    let value = ''
    let quoted = false
    while (i < text.length) {
      const c = text[i]
      if (c === '"') {
        quoted = !quoted
        i++
        continue
      }
      if (!quoted) {
        if (isSpace(c) || isSeparator(c) || c === '>' || c === '<') break
        if (c === ')' && blocks > 0) break
        if (c === '^' && i + 1 < text.length) {
          value += text[i + 1]
          i += 2
          continue
        }
      }
      value += c
      i++
    }
    // %VAR% 在执行前展开 —— 成对的百分号里是变量名，值静态不可知
    const dynamic = /%[^%\s]+%/.test(value)
    return { value: dynamic ? null : value, start, end: i }
  }

  const flush = (): void => {
    if (current.length > 0) commands.push(current)
    current = []
  }

  while (i < text.length) {
    const c = text[i]
    if (isSpace(c)) {
      i++
      continue
    }
    if (isSeparator(c)) {
      flush()
      i++
      continue
    }
    if (c === '(') {
      // `for %i in (a b c) do …` 的集合：一个字面词，不是命令
      if (first() === 'for' && last() === 'in') {
        const close = matchingParen(text, i)
        const end = close < 0 ? text.length : close + 1
        current.push({ value: text.slice(i, end), start: i, end })
        i = end
        continue
      }
      if (
        current.length === 0 ||
        first() === 'if' ||
        first() === 'else' ||
        (first() === 'for' && last() === 'do')
      ) {
        flush()
        blocks++
        i++
        continue
      }
    }
    if (c === ')' && blocks > 0) {
      flush()
      blocks--
      i++
      continue
    }
    const redirect = REDIRECT_RE.exec(text.slice(i))
    if (redirect) {
      const start = i
      i += redirect[0].length
      if (redirect[2]) {
        redirects.push({ kind: 'fd-dup', target: null, start, end: i })
        continue
      }
      while (i < text.length && isSpace(text[i])) i++
      const target = i < text.length && !isSeparator(text[i]) ? readToken() : null
      redirects.push({
        kind: redirect[1] === '<' ? 'read' : redirect[1] === '>>' ? 'append' : 'write',
        target: target?.value ?? null,
        start,
        end: i
      })
      continue
    }
    const token = readToken()
    // `@` 前缀只是「不回显这一行」，不属于命令名
    if (current.length === 0 && token.value?.startsWith('@')) {
      token.value = token.value.slice(1)
      if (token.value === '') continue
    }
    current.push(token)
  }
  flush()
  return { commands, redirects }
}
