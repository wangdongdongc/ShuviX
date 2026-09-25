/**
 * PowerShell 命令的结构事实 —— 手写扫描器，不是完整的 PowerShell 解析器。
 *
 * 为什么手写而不是像 bash 那样挂一份 tree-sitter 语法：这一层只服务 deny / ask 规则，
 * 要的是「这段文字里有哪些命令、各带什么字面参数、往哪些文件重定向」，而这件事的难点
 * 全在 PowerShell 的**词法**（引号、转义、展开、here-string、参数冒号值）上，句法部分
 * 只需要认出语句与管道的边界、以及哪些括号里还装着命令。一个自己写的扫描器两端都能跑
 * （不依赖 wasm、不依赖 Windows），而交给 PowerShell 自己的 AST 意味着每条命令都要
 * 同步起一个进程，且只在 Windows 上成立。
 *
 * 读法：
 *   - 语句按 `;` / 换行 / `|` / `&&` / `||` / 结尾的 `&`（后台）切开；行尾反引号续行，
 *     行尾 `|` / `&&` / `||` 之后的换行不断句。
 *   - 语句开头若是表达式（变量、字符串、数字、括号、`[类型]`、`-not` …）就不是命令调用 ——
 *     `'C:\x.exe' arg` 在 PowerShell 里只是输出一个字符串，要 `&` 才会运行。
 *     赋值 `$x = …` 的右边是一条独立的语句，照常读。
 *   - `( … )` / `$( … )` / `@( … )` / `{ … }` / 哈希表的值里还是语句，递归进去读 ——
 *     `Invoke-Command { rm … }`、`foreach (…) { rm … }` 里的命令与顶层的一样是真命令。
 *     嵌在参数里的这些构造让那个参数变成动态（null）。
 *   - 词法：单引号字面（`''` 为引号本身），双引号与裸词里 `$变量` / `$( )` 是展开（动态），
 *     反引号转义（`` `n `` 等）；PowerShell 把弯引号（‘ ’ ‚ ‛ / “ ” „）当作引号、把
 *     en dash / em dash 当作 `-`，这里照办 —— 那是现成的绕过写法。
 *   - `-Name:value` 拆成两项；`-Switch:$true` 读成打开，`-Switch:$false` 不读成打开。
 *   - `--%` 之后到行尾（或 `|`）原样交给原生程序，按空白切词。
 *
 * 嵌套载荷（深度上限与 bash 一层相同，8）：`powershell` / `pwsh` 的 `-Command`、
 * `-EncodedCommand`（base64 的 UTF-16LE，照样解码再读）、`cmd /c`（按 cmd.exe 规则切，
 * 见 cmd.ts）、`Invoke-Expression '字面量'`、`bash -c` / `sh -c`（交给宿主注入的 bash 解析器）。
 *
 * 红线：这是**宽松轨** —— 只抽字面、会漏（运行时才定的东西一概看不见），所以只配用来
 * 触发拦截或询问，**不能用来证明一条命令安全**。PowerShell 遇到语法错误整段都不执行，
 * 这里遇到结构错误就停在那里（parsed=false），只交出错误之前读到的部分。
 */
import { splitCmdLine } from './cmd'
import { commandLeaf, powerShellCommandBase, stripPowerShellWrappers } from './commands'
import type {
  PowerShellAnalyzeOptions,
  PowerShellCommand,
  PowerShellFacts,
  PowerShellRedirect
} from './types'
import type { ShellFacts, ShellSpan } from '../shell/types'

/** 源串长度上限（字符）—— 超出按未解析处理 */
export const MAX_POWERSHELL_SOURCE_LENGTH = 64 * 1024

/** 嵌套载荷的递归上限（与 bash 一层的 MAX_NESTED_SHELL_DEPTH 相同） */
export const MAX_POWERSHELL_PAYLOAD_DEPTH = 8

/** 括号嵌套上限 —— 防御病态输入把递归栈撑爆 */
const MAX_GROUP_NESTING = 64

const SINGLE_QUOTES = "'\u2018\u2019\u201A\u201B"
const DOUBLE_QUOTES = '"\u201C\u201D\u201E'
const DASHES = '-\u2013\u2014\u2015'

const isSingleQuote = (c: string): boolean => c !== '' && SINGLE_QUOTES.includes(c)
const isDoubleQuote = (c: string): boolean => c !== '' && DOUBLE_QUOTES.includes(c)
const isQuote = (c: string): boolean => isSingleQuote(c) || isDoubleQuote(c)
const isDash = (c: string): boolean => c !== '' && DASHES.includes(c)
const isNewline = (c: string): boolean => c === '\n' || c === '\r'
/** 行内空白（不含换行）—— PowerShell 认 Unicode 空格，NBSP 也算 */
const isInlineSpace = (c: string): boolean => c !== '' && !isNewline(c) && /\s/.test(c)

/** 重定向算子：`>` `>>` `2>` `*>>` `3>&1` … */
const REDIRECT_RE = /^[1-6*]?>>?(&[1-6])?/

/**
 * 数字字面量开头 —— 语句以它开头就是表达式（`1..5 | …`），但 `7z x a.zip` 里的 `7z`
 * 是命令名：数字后面紧跟的若是继续组成单词的字符，就不是数字。
 */
const NUMBER_RE =
  /^(0x[0-9a-f]+|[0-9]+(\.[0-9]+)?(e[+-]?[0-9]+)?)(ul|lu|us|uy|l|u|y|s|n|d)?(kb|mb|gb|tb|pb)?/i

/**
 * 只在管道第一段、命令位置上生效的关键字。`return` / `throw` 后面是一条管道；
 * 其余的后面是条件、代码块、名字 —— 按表达式扫，里面的代码块照样递归读。
 */
const KEYWORDS: ReadonlySet<string> = new Set([
  'begin',
  'break',
  'catch',
  'class',
  'configuration',
  'continue',
  'data',
  'do',
  'dynamicparam',
  'else',
  'elseif',
  'end',
  'enum',
  'exit',
  'filter',
  'finally',
  'for',
  'foreach',
  'function',
  'if',
  'inlinescript',
  'parallel',
  'param',
  'process',
  'return',
  'sequence',
  'switch',
  'throw',
  'trap',
  'try',
  'until',
  'using',
  'while',
  'workflow'
])

class ParseError extends Error {
  constructor(readonly at: number) {
    super(`PowerShell structure error at ${at}`)
  }
}

interface Token {
  value: string | null
  start: number
  end: number
}

interface Collector {
  commands: PowerShellCommand[]
  redirects: PowerShellRedirect[]
  nestedBash: { facts: ShellFacts; depth: number }[]
  depthExceeded: boolean
}

class Scanner {
  private i = 0
  private nesting = 0

  constructor(
    private readonly src: string,
    private readonly depth: number,
    private readonly out: Collector,
    private readonly opts: PowerShellAnalyzeOptions
  ) {}

  run(): void {
    this.statements(null, 0)
  }

  // ─── 基础 ──────────────────────────────────────────────

  private peek(k = 0): string {
    return this.src[this.i + k] ?? ''
  }

  private eof(): boolean {
    return this.i >= this.src.length
  }

  /** 从 at 起的换行长度（`\r\n` 为 2），不是换行为 0 */
  private newlineLength(at: number): number {
    if (this.src[at] === '\r') return this.src[at + 1] === '\n' ? 2 : 1
    return this.src[at] === '\n' ? 1 : 0
  }

  /** 行内空白与反引号续行 */
  private skipInline(): void {
    for (;;) {
      const c = this.peek()
      if (c === '`') {
        const nl = this.newlineLength(this.i + 1)
        if (nl > 0) {
          this.i += 1 + nl
          continue
        }
      }
      if (isInlineSpace(c)) {
        this.i++
        continue
      }
      return
    }
  }

  /** 词首的注释：`#` 到行尾、`<# … #>` */
  private skipComment(): boolean {
    if (this.peek() === '#') {
      while (!this.eof() && !isNewline(this.peek())) this.i++
      return true
    }
    if (this.peek() === '<' && this.peek(1) === '#') {
      const end = this.src.indexOf('#>', this.i + 2)
      if (end < 0) throw new ParseError(this.i)
      this.i = end + 2
      return true
    }
    return false
  }

  /** 空白、换行、注释（以及 semicolons 为真时的空语句） */
  private skipBlank(semicolons: boolean): void {
    for (;;) {
      this.skipInline()
      const c = this.peek()
      if (isNewline(c) || (semicolons && c === ';')) {
        this.i++
        continue
      }
      if (this.skipComment()) continue
      return
    }
  }

  /** 一段管道元素到此为止 */
  private atElementEnd(): boolean {
    const c = this.peek()
    return c === '' || isNewline(c) || c === ';' || c === '|' || c === '&' || c === ')' || c === '}'
  }

  private enter(open: number): void {
    if (++this.nesting > MAX_GROUP_NESTING) throw new ParseError(open)
  }

  private leave(): void {
    this.nesting--
  }

  // ─── 语句层 ────────────────────────────────────────────

  /** 一串语句，直到 closer（null = 源串结尾）；open 是开括号的位置，用于报未闭合 */
  private statements(closer: ')' | '}' | null, open: number): void {
    for (;;) {
      this.skipBlank(true)
      if (this.eof()) {
        if (closer !== null) throw new ParseError(open)
        return
      }
      const c = this.peek()
      if (c === closer) {
        this.i++
        return
      }
      if (c === ')' || c === '}') throw new ParseError(this.i)
      const before = this.i
      this.chain()
      if (this.i === before) throw new ParseError(this.i)
    }
  }

  /** 管道链：`a && b || c`，可以以后台 `&` 结尾 */
  private chain(): void {
    this.pipeline()
    for (;;) {
      this.skipInline()
      const c = this.peek()
      const n = this.peek(1)
      if ((c === '&' && n === '&') || (c === '|' && n === '|')) {
        this.i += 2
        this.skipBlank(false)
        this.pipeline()
        continue
      }
      if (c === '&') this.i++ // 后台作业（PowerShell 7）：这条语句到此为止
      return
    }
  }

  private pipeline(): void {
    let first = true
    for (;;) {
      this.element(first)
      this.skipInline()
      if (this.peek() === '|' && this.peek(1) !== '|') {
        this.i++
        this.skipBlank(false)
        first = false
        continue
      }
      return
    }
  }

  private element(first: boolean): void {
    this.skipInline()
    if (this.skipComment()) return
    // 元素开头的单个 `&` 是调用运算符（`& "C:\x\app.exe" …`），不是后台 `&`
    if (this.atElementEnd() && !(this.peek() === '&' && this.peek(1) !== '&')) return
    // 循环标签 `:outer while (…)`
    if (this.peek() === ':' && /[A-Za-z_]/.test(this.peek(1))) {
      this.i++
      while (/\w/.test(this.peek())) this.i++
      this.skipInline()
      if (this.atElementEnd()) return
    }
    if (first) {
      const keyword = this.keywordAhead()
      if (keyword) {
        this.i += keyword.length
        if (keyword === 'return' || keyword === 'throw') {
          this.skipInline()
          if (!this.atElementEnd()) this.pipeline()
        } else {
          this.expression()
        }
        return
      }
    }
    if (this.commandAhead()) this.command()
    else this.expression()
  }

  private keywordAhead(): string | null {
    const m = /^[A-Za-z]+/.exec(this.src.slice(this.i, this.i + 16))
    if (!m) return null
    const word = m[0].toLowerCase()
    if (!KEYWORDS.has(word)) return null
    // 关键字后面必须是分隔：`if(`、`else{`、`return;` 是关键字，`data.exe`、`if.exe` 是命令
    const next = this.src[this.i + word.length] ?? ''
    return next === '' || /[\s({;|&)}]/.test(next) ? word : null
  }

  /** 语句开头是命令调用还是表达式 */
  private commandAhead(): boolean {
    const c = this.peek()
    if (c === '&') return this.peek(1) !== '&'
    if (c === '$' || c === '(' || c === '[' || c === '@' || c === '{' || c === '!') return false
    if (c === '+' || c === ',' || isQuote(c) || isDash(c)) return false
    if (/[0-9]/.test(c)) {
      const m = NUMBER_RE.exec(this.src.slice(this.i, this.i + 64))
      const next = this.src[this.i + (m ? m[0].length : 0)] ?? ''
      return !m || /[\w\\/]/.test(next)
    }
    return true
  }

  // ─── 命令 ──────────────────────────────────────────────

  private command(): void {
    const start = this.i
    const tokens: Token[] = []
    let invokesBlock = false
    // 重定向可以写在命令名前面（`> out.txt Get-Date`）
    while (REDIRECT_RE.test(this.src.slice(this.i, this.i + 6))) {
      this.redirect()
      this.skipInline()
      if (this.atElementEnd()) return
    }
    // 调用运算符 `& 名字` / 点源 `. 名字`
    if (this.peek() === '&' || (this.peek() === '.' && isInlineSpace(this.peek(1)))) {
      this.i++
      this.skipInline()
      if (this.peek() === '{') {
        const open = this.i++
        this.group('}', open)
        invokesBlock = true
      } else if (this.atElementEnd()) {
        return
      } else {
        tokens.push(...this.readArg())
      }
    } else {
      tokens.push(...this.readArg())
    }
    for (;;) {
      this.skipInline()
      if (this.skipComment()) continue
      if (this.atElementEnd()) break
      if (REDIRECT_RE.test(this.src.slice(this.i, this.i + 6))) {
        this.redirect()
        continue
      }
      const c = this.peek()
      if (c === ',') {
        // 数组参数 `a,b` —— 各元素分开记，规则逐项看
        this.i++
        continue
      }
      if (c === '<') throw new ParseError(this.i) // PowerShell 保留的 `<`
      if (this.src.startsWith('--%', this.i) && !/\S/.test(this.peek(3) || ' ')) {
        this.stopParsing(tokens)
        break
      }
      const before = this.i
      tokens.push(...this.readArg())
      if (this.i === before) throw new ParseError(this.i)
    }
    if (!invokesBlock) this.emit(tokens, start)
  }

  /** `--%`：其后到行尾或 `|` 原样交给原生程序（`%VAR%` 在那时展开） */
  private stopParsing(tokens: Token[]): void {
    this.i += 3
    let end = this.i
    while (end < this.src.length && !isNewline(this.src[end]) && this.src[end] !== '|') end++
    // 原生程序按 Windows 的命令行规则切参数：双引号里的空白不切开，引号本身去掉。
    // 引号不能丢了就算 —— `cmd --% /c echo "a & format C:"` 里引号保护着 `&`，拼回给 cmd
    // 时要靠「这一项含空白」把它还回去（见 joinPayload）
    const re = /(?:"[^"]*"?|[^\s"])+/g
    const rest = this.src.slice(this.i, end)
    for (let m = re.exec(rest); m; m = re.exec(rest)) {
      const word = m[0].replace(/"/g, '')
      tokens.push({
        value: /%[^%\s]+%/.test(word) ? null : word,
        start: this.i + m.index,
        end: this.i + m.index + m[0].length
      })
    }
    this.i = end
  }

  /** 一个参数位置上的词；`-Name:value` 拆成两项 */
  private readArg(): Token[] {
    const start = this.i
    if (isDash(this.peek()) && /[A-Za-z_?]/.test(this.peek(1))) return this.readParameter(start)
    return [this.readValue(start)]
  }

  /**
   * `-Name` / `-Name:value` / `-Name: value`（冒号后可以隔空白）。开关的冒号值只认几个
   * 常量：`$true` 读成打开；`$false` / `$null` / `0` 读成关 —— 原样留成一项，不能被当成打开。
   */
  private readParameter(start: number): Token[] {
    this.i++
    const name = this.bareword(this.i, true)
    const param: Token = {
      value: name.value === null ? null : '-' + name.value,
      start,
      end: this.i
    }
    if (this.peek() !== ':') return [param]
    this.i++
    this.skipInline()
    if (this.atElementEnd()) return [param]
    const valueStart = this.i
    const value = this.readValue(valueStart)
    const raw = this.src.slice(valueStart, this.i)
    if (/^\$true$/i.test(raw)) return [param]
    if (/^(\$false|\$null|0)$/i.test(raw)) {
      return [{ value: param.value === null ? null : param.value + ':' + raw, start, end: this.i }]
    }
    return [param, value]
  }

  /** 一个值位置上的词：括号 / 代码块 / 数组 / 哈希表 / here-string / 展开参数 / 裸词 */
  private readValue(start: number): Token {
    const c = this.peek()
    const n = this.peek(1)
    const dynamic = (): Token => ({ value: null, start, end: this.i })
    if (c === '(') {
      this.i++
      this.group(')', start)
      return dynamic()
    }
    if (c === '{') {
      this.i++
      this.group('}', start)
      return dynamic()
    }
    if (c === '@') {
      if (n === '(') {
        this.i += 2
        this.group(')', start)
        return dynamic()
      }
      if (n === '{') {
        this.i += 2
        this.hashtable(start)
        return dynamic()
      }
      if (isQuote(n) && this.hereStringAhead()) {
        return { value: this.hereString(), start, end: this.i }
      }
      if (/[A-Za-z_?]/.test(n)) {
        // 展开参数 `@args`
        this.i++
        this.skipVariableName()
        return dynamic()
      }
    }
    return this.bareword(start, false)
  }

  /**
   * 裸词（参数模式下的一个词）：引号、转义、展开按片拼起来。
   * 裸词在 PowerShell 里按可展开字符串处理 —— `$x` 与 `$( )` 展开、反引号转义生效。
   */
  private bareword(start: number, stopAtColon: boolean): Token {
    let value = ''
    let dynamic = false
    for (;;) {
      const c = this.peek()
      if (c === '' || isInlineSpace(c) || isNewline(c)) break
      if (c === ';' || c === '|' || c === '&' || c === ')' || c === '}' || c === ',') break
      if (c === '(' || c === '>' || c === '<') break
      if (stopAtColon && c === ':') break
      if (isSingleQuote(c)) {
        value += this.singleQuoted()
        continue
      }
      if (isDoubleQuote(c)) {
        const s = this.doubleQuoted()
        if (s === null) dynamic = true
        else value += s
        continue
      }
      if (c === '`') {
        if (this.i + 1 >= this.src.length || this.newlineLength(this.i + 1) > 0) break
        value += this.escape()
        continue
      }
      if (c === '$') {
        if (this.variable()) {
          dynamic = true
          continue
        }
      }
      value += c
      this.i++
    }
    return { value: dynamic ? null : value, start, end: this.i }
  }

  private emit(tokens: Token[], start: number): void {
    if (tokens.length === 0) return
    const raw = tokens.map((t) => t.value)
    const stripped = stripPowerShellWrappers(raw)
    // 只有 wrapper、后面什么都没有（`sudo` 一个词）：按字面记
    const { argv, wrappers } = stripped.argv.length > 0 ? stripped : { argv: raw, wrappers: [] }
    const name = argv[0] ?? null
    const span: ShellSpan = { start, end: tokens[tokens.length - 1].end }
    const base = name === null ? '' : powerShellCommandBase(name)
    this.out.commands.push({
      shell: 'powershell',
      name: name ?? '',
      base,
      argv,
      wrappers,
      complete: argv.every((a) => a !== null),
      span,
      depth: this.depth
    })
    expandPayload(this.out, base, argv, this.depth, this.opts)
  }

  private redirect(): void {
    const start = this.i
    const op = (REDIRECT_RE.exec(this.src.slice(this.i, this.i + 6)) as RegExpExecArray)[0]
    this.i += op.length
    if (op.includes('&')) {
      this.out.redirects.push({
        kind: 'fd-dup',
        target: null,
        span: { start, end: this.i },
        depth: this.depth
      })
      return
    }
    this.skipInline()
    if (this.atElementEnd() || this.peek() === '<') throw new ParseError(start)
    const [target] = this.readArg()
    this.out.redirects.push({
      kind: op.includes('>>') ? 'append' : 'write',
      target: target.value,
      span: { start, end: this.i },
      depth: this.depth
    })
  }

  // ─── 表达式与嵌套 ──────────────────────────────────────

  /** 表达式元素：不是命令调用，但其中的括号、代码块、赋值右边可能装着命令 */
  private expression(): void {
    for (;;) {
      this.skipInline()
      if (this.skipComment()) continue
      if (this.atElementEnd()) return
      const start = this.i
      const c = this.peek()
      const n = this.peek(1)
      if (REDIRECT_RE.test(this.src.slice(this.i, this.i + 6))) {
        this.redirect()
        continue
      }
      const assign = this.assignmentLength()
      if (assign > 0) {
        // 赋值的右边是一条独立的语句：`$x = Remove-Item …` 会运行
        this.i += assign
        this.skipBlank(false)
        if (!this.atElementEnd()) this.pipeline()
        return
      }
      if (c === '(') {
        this.i++
        this.group(')', start)
      } else if (c === '{') {
        this.i++
        this.group('}', start)
      } else if (c === '@' && n === '(') {
        this.i += 2
        this.group(')', start)
      } else if (c === '@' && n === '{') {
        this.i += 2
        this.hashtable(start)
      } else if (c === '@' && isQuote(n) && this.hereStringAhead()) {
        this.hereString()
      } else if (isSingleQuote(c)) {
        this.singleQuoted()
      } else if (isDoubleQuote(c)) {
        this.doubleQuoted()
      } else if (c === '$') {
        if (!this.variable()) this.i++
      } else if (c === '`') {
        this.i += 2
      } else if (c === '<') {
        throw new ParseError(this.i)
      } else {
        this.i++
      }
    }
  }

  /** `=` `+=` `-=` `*=` `/=` `%=` `??=` 的长度；不是赋值为 0 */
  private assignmentLength(): number {
    const c = this.peek()
    const n = this.peek(1)
    if (c === '=') return 1
    if ('+-*/%'.includes(c) && n === '=') return 2
    if (c === '?' && n === '?' && this.peek(2) === '=') return 3
    return 0
  }

  private group(closer: ')' | '}', open: number): void {
    this.enter(open)
    this.statements(closer, open)
    this.leave()
  }

  /** `@{ key = 语句; … }` —— 值是语句，照样读 */
  private hashtable(open: number): void {
    this.enter(open)
    for (;;) {
      this.skipBlank(true)
      if (this.eof()) throw new ParseError(open)
      if (this.peek() === '}') {
        this.i++
        break
      }
      const before = this.i
      this.expression()
      if (this.i === before) throw new ParseError(this.i)
    }
    this.leave()
  }

  // ─── 词法 ──────────────────────────────────────────────

  private singleQuoted(): string {
    const open = this.i++
    let value = ''
    for (;;) {
      if (this.eof()) throw new ParseError(open)
      const c = this.peek()
      if (isSingleQuote(c)) {
        if (isSingleQuote(this.peek(1))) {
          value += "'"
          this.i += 2
          continue
        }
        this.i++
        return value
      }
      value += c
      this.i++
    }
  }

  /** 双引号字符串；含展开时返回 null（动态） */
  private doubleQuoted(): string | null {
    const open = this.i++
    let value = ''
    let dynamic = false
    for (;;) {
      if (this.eof()) throw new ParseError(open)
      const c = this.peek()
      if (isDoubleQuote(c)) {
        if (isDoubleQuote(this.peek(1))) {
          value += '"'
          this.i += 2
          continue
        }
        this.i++
        return dynamic ? null : value
      }
      if (c === '`') {
        if (this.i + 1 >= this.src.length) throw new ParseError(open)
        value += this.escape()
        continue
      }
      if (c === '$' && this.variable()) {
        dynamic = true
        continue
      }
      value += c
      this.i++
    }
  }

  /** 反引号转义（停在反引号上），返回它代表的字符 */
  private escape(): string {
    const n = this.peek(1)
    this.i += 2
    switch (n) {
      case '0':
        return '\0'
      case 'a':
        return '\x07'
      case 'b':
        return '\b'
      case 'e':
        return '\x1b'
      case 'f':
        return '\f'
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case 'v':
        return '\v'
      case 'u': {
        const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(this.src.slice(this.i, this.i + 9))
        if (m) {
          const cp = parseInt(m[1], 16)
          if (cp <= 0x10ffff) {
            this.i += m[0].length
            return String.fromCodePoint(cp)
          }
        }
        return 'u'
      }
      default:
        return n
    }
  }

  /** 停在 `$` 上：是变量 / 子表达式就吃掉并返回 true，否则（孤立的 `$`）返回 false */
  private variable(): boolean {
    const n = this.peek(1)
    if (n === '(') {
      const open = this.i
      this.i += 2
      this.group(')', open)
      return true
    }
    if (n === '{') {
      const open = this.i
      this.i += 2
      for (;;) {
        if (this.eof()) throw new ParseError(open)
        const c = this.peek()
        if (c === '`') {
          this.i += 2
          continue
        }
        this.i++
        if (c === '}') return true
      }
    }
    if (/[\w?^$]/.test(n)) {
      this.i++
      this.skipVariableName()
      return true
    }
    return false
  }

  /** 变量名（停在名字第一个字符上）：`$?` `$^` `$$` 单字符；`$env:Path` 带作用域 */
  private skipVariableName(): void {
    if ('?^$'.includes(this.peek())) {
      this.i++
      return
    }
    for (;;) {
      const c = this.peek()
      if (/\w/.test(c) || (c === ':' && /\w/.test(this.peek(1)))) this.i++
      else return
    }
  }

  /** `@'` / `@"` 后面只跟空白与换行才是 here-string */
  private hereStringAhead(): boolean {
    let k = this.i + 2
    while (isInlineSpace(this.src[k] ?? '')) k++
    return this.newlineLength(k) > 0
  }

  /** here-string：到行首的 `'@` / `"@` 为止；可展开的那种含展开时返回 null */
  private hereString(): string | null {
    const open = this.i
    const single = isSingleQuote(this.peek(1))
    this.i += 2
    while (isInlineSpace(this.peek())) this.i++
    this.i += this.newlineLength(this.i)
    const contentStart = this.i
    let lineStart = contentStart
    let end = -1
    for (;;) {
      const q = this.src[lineStart] ?? ''
      if ((single ? isSingleQuote(q) : isDoubleQuote(q)) && this.src[lineStart + 1] === '@') {
        end = lineStart
        break
      }
      let k = lineStart
      while (k < this.src.length && !isNewline(this.src[k])) k++
      if (k >= this.src.length) throw new ParseError(open)
      lineStart = k + this.newlineLength(k)
    }
    // 终止行之前的那个换行不属于内容
    let contentEnd = end
    if (this.src[contentEnd - 1] === '\n') contentEnd--
    if (this.src[contentEnd - 1] === '\r') contentEnd--
    contentEnd = Math.max(contentEnd, contentStart)
    let value: string | null
    if (single) {
      value = this.src.slice(contentStart, contentEnd)
    } else {
      this.i = contentStart
      let text = ''
      let dynamic = false
      while (this.i < contentEnd) {
        const c = this.peek()
        if (c === '`' && this.i + 1 < contentEnd) {
          text += this.escape()
        } else if (c === '$' && this.variable()) {
          dynamic = true
        } else {
          text += c
          this.i++
        }
      }
      value = dynamic ? null : text
    }
    this.i = end + 2
    return value
  }
}

// ─── 嵌套载荷 ────────────────────────────────────────────

type Payload = { lang: 'powershell' | 'cmd' | 'bash'; text: string }

/** 这条命令若把一段代码交给另一个 shell 执行，展开它 */
function expandPayload(
  out: Collector,
  base: string,
  argv: (string | null)[],
  depth: number,
  opts: PowerShellAnalyzeOptions
): void {
  const kind = base.toLowerCase()
  let payload: Payload | null = null
  if (kind === 'powershell' || kind === 'pwsh') payload = powerShellCliPayload(kind, argv)
  else if (kind === 'cmd') payload = cmdPayload(argv)
  else if (kind === 'bash' || kind === 'sh') payload = bashPayload(argv)
  else if (kind === 'invoke-expression') payload = invokeExpressionPayload(argv)
  if (!payload) return
  if (depth + 1 >= MAX_POWERSHELL_PAYLOAD_DEPTH) {
    out.depthExceeded = true
    return
  }
  if (payload.text.length > MAX_POWERSHELL_SOURCE_LENGTH) return
  if (payload.lang === 'powershell') {
    const inner = analyzeAtDepth(payload.text, depth + 1, opts)
    // 与 bash 一层同一取舍：载荷自身读得通才并入（PowerShell 遇语法错误整段不执行）
    if (!inner.parsed) return
    out.commands.push(...inner.commands)
    out.redirects.push(...inner.redirects)
    out.nestedBash.push(...inner.nestedBash)
    if (inner.depthExceeded) out.depthExceeded = true
    return
  }
  if (payload.lang === 'cmd') {
    analyzeCmdPayload(out, payload.text, depth + 1, opts)
    return
  }
  if (!opts.analyzeBash) return
  let facts: ShellFacts
  try {
    facts = opts.analyzeBash(payload.text)
  } catch {
    // 读不了这段 bash 就当没读到 —— 不能连同外层已经读到的一起丢掉
    return
  }
  out.nestedBash.push({ facts, depth: depth + 1 })
}

/** `cmd /c …` 的载荷按 cmd.exe 规则切开，逐条记下（其中的 `cmd /c` / `powershell -c` 继续展开） */
function analyzeCmdPayload(
  out: Collector,
  text: string,
  depth: number,
  opts: PowerShellAnalyzeOptions
): void {
  const split = splitCmdLine(text)
  for (const tokens of split.commands) {
    const argv = tokens.map((t) => t.value)
    const name = argv[0] ?? null
    const base = name === null ? '' : commandLeaf(name)
    out.commands.push({
      shell: 'cmd',
      name: name ?? '',
      base,
      argv,
      wrappers: [],
      complete: argv.every((a) => a !== null),
      span: { start: tokens[0].start, end: tokens[tokens.length - 1].end },
      depth
    })
    expandPayload(out, base, argv, depth, opts)
  }
  for (const r of split.redirects) {
    if (r.kind === 'read') continue
    out.redirects.push({
      kind: r.kind,
      target: r.target,
      span: { start: r.start, end: r.end },
      depth
    })
  }
}

/** 参数名是否是 full 的前缀（至少 min 个字符）—— PowerShell 的 CLI 与 cmdlet 都认参数名前缀 */
function isPrefix(name: string, full: string, min: number): boolean {
  return name.length >= min && full.startsWith(name)
}

/** `powershell` / `pwsh` 命令行里带值的选项（不含 -Command / -EncodedCommand / -File） */
const PS_VALUE_OPTIONS: readonly [string, number][] = [
  ['executionpolicy', 2],
  ['ep', 2],
  ['windowstyle', 1],
  ['outputformat', 1],
  ['of', 2],
  ['inputformat', 2],
  ['version', 1],
  ['psconsolefile', 2],
  ['configurationname', 4],
  ['configurationfile', 14],
  ['workingdirectory', 2],
  ['wd', 2],
  ['settingsfile', 2],
  ['custompipename', 2],
  ['encodedarguments', 8],
  ['ea', 2]
]

/**
 * `powershell -Command …` / `pwsh -c …` / `-EncodedCommand <base64>`。
 * 5.1 的第一个位置参数就是命令；pwsh 的第一个位置参数是脚本文件（读不到）。
 */
function powerShellCliPayload(kind: string, argv: (string | null)[]): Payload | null {
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k]
    if (a === null) return null
    if (!a.startsWith('-') && !a.startsWith('/')) {
      if (kind !== 'powershell') return null
      return joinPayload('powershell', argv.slice(k))
    }
    const name = a.replace(/^(--|-|\/)/, '').toLowerCase()
    if (name === '') continue
    if (name === 'c' || isPrefix(name, 'command', 2)) {
      const rest = argv.slice(k + 1)
      if (rest[0] === '-') return null // 从 stdin 读
      return joinPayload('powershell', rest)
    }
    if (name === 'e' || name === 'ec' || isPrefix(name, 'encodedcommand', 3)) {
      const encoded = argv[k + 1]
      if (typeof encoded !== 'string') return null
      const text = decodeBase64Utf16le(encoded)
      return text === null ? null : { lang: 'powershell', text }
    }
    if (isPrefix(name, 'file', 1)) return null
    if (PS_VALUE_OPTIONS.some(([full, min]) => name === full || isPrefix(name, full, min))) k++
  }
  return null
}

/** `cmd /c …`（也认 `/k`、`/r`，以及贴着写的 `/cdir`） */
function cmdPayload(argv: (string | null)[]): Payload | null {
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k]
    if (a === null) return null
    const m = /^\/([ckr])(.*)$/i.exec(a)
    if (m) {
      const rest = argv.slice(k + 1)
      const joined = joinPayload('cmd', m[2] ? [m[2], ...rest] : rest)
      return joined && { lang: 'cmd', text: stripCmdOuterQuotes(joined.text) }
    }
    if (!a.startsWith('/')) return null
  }
  return null
}

/**
 * cmd.exe 对 `/c` 之后那一行的引号处理（`cmd /?` 写明的规则）：除非整行恰是一对引号包着
 * 一个可执行文件的路径，否则一个以引号开头的行会去掉**第一个与最后一个**引号，
 * 最后一个引号之后的内容保留。`cmd /c "format C: /q"` 因此执行的是 `format C: /q`。
 * 「是不是可执行文件」这里只能按扩展名近似。
 */
function stripCmdOuterQuotes(text: string): string {
  if (!text.startsWith('"')) return text
  const last = text.lastIndexOf('"')
  if (last === 0) return text.slice(1)
  const inner = text.slice(1, last)
  const quotes = text.split('"').length - 1
  if (
    quotes === 2 &&
    last === text.length - 1 &&
    !/[&<>()@^|]/.test(inner) &&
    /\s/.test(inner) &&
    /\.(exe|com|bat|cmd)$/i.test(inner)
  ) {
    return text
  }
  return inner + text.slice(last + 1)
}

/** `bash -c '…'` / `sh -lc '…'`：载荷是 `-c` 所在选项簇之后的第一个参数 */
function bashPayload(argv: (string | null)[]): Payload | null {
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k]
    if (a === null) return null
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
      const text = argv[k + 1]
      return typeof text === 'string' ? { lang: 'bash', text } : null
    }
    if (!a.startsWith('-')) return null
  }
  return null
}

/** 公共参数里的开关（不带值）；其余公共参数（`-ErrorAction` / `-OutVariable` …）都带一个值 */
const COMMON_SWITCHES: readonly [string, number][] = [
  ['verbose', 1],
  ['vb', 2],
  ['debug', 2],
  ['db', 2]
]

/** `Invoke-Expression '…'` / `iex -Command '…'` —— 字面量才读得到 */
function invokeExpressionPayload(argv: (string | null)[]): Payload | null {
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k]
    if (a === null) return null
    if (a.startsWith('-')) {
      const name = a.slice(1).toLowerCase()
      if (isPrefix(name, 'command', 1)) {
        const text = argv[k + 1]
        return typeof text === 'string' ? { lang: 'powershell', text } : null
      }
      // 认不出的参数一律当作带值的跳过：把一个值误当成载荷会凭空造出命令，
      // 跳过一个开关顶多漏掉 —— 宽松轨只许漏，不许造
      if (!COMMON_SWITCHES.some(([full, min]) => name === full || isPrefix(name, full, min))) k++
      continue
    }
    return { lang: 'powershell', text: a }
  }
  return null
}

/**
 * 把交给另一个 shell 的参数拼回它看到的那一行。
 *
 * - `powershell -Command a b`：powershell.exe 先按自己的命令行规则拆参数（去掉引号），
 *   再用空格把 -Command 之后的几项拼起来 —— 所以直接拼。
 * - `cmd /c a b`：PowerShell 调原生程序时，含空白的参数会被加上双引号；cmd 看到的就是
 *   带引号的那一行，引号里的 `&` 只是字符。拼的时候把引号还回去，否则
 *   `cmd /c echo "a & format C:"` 会凭空读出一条 `format C:`。
 *
 * 动态参数不让整段失明（那是一个现成的绕过：`cmd /c format C: $null`），而是换成目标语言里
 * 同样动态的占位 —— 字面写着的那些命令照样读得到，占位本身只会读成一个动态词。
 */
function joinPayload(lang: Payload['lang'], parts: (string | null)[]): Payload | null {
  if (parts.length === 0) return null
  const words = parts.map((p) => {
    if (p === null) return lang === 'cmd' ? '%SHUVIX_DYNAMIC%' : '$shuvixDynamic'
    return lang === 'cmd' && (p === '' || /\s/.test(p)) ? `"${p}"` : p
  })
  return { lang, text: words.join(' ') }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64 → UTF-16LE 文本（`-EncodedCommand` 的编码）；不是合法 base64 返回 null */
export function decodeBase64Utf16le(encoded: string): string | null {
  const clean = encoded.replace(/\s+/g, '').replace(/=+$/, '')
  if (clean === '' || !/^[A-Za-z0-9+/]+$/.test(clean) || clean.length % 4 === 1) return null
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of clean) {
    buffer = (buffer << 6) | BASE64_ALPHABET.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  let text = ''
  for (let k = 0; k + 1 < bytes.length; k += 2)
    text += String.fromCharCode(bytes[k] | (bytes[k + 1] << 8))
  return text
}

// ─── 入口 ────────────────────────────────────────────────

function analyzeAtDepth(
  source: string,
  depth: number,
  opts: PowerShellAnalyzeOptions
): PowerShellFacts {
  const out: Collector = { commands: [], redirects: [], nestedBash: [], depthExceeded: false }
  let errorAt: number | null = null
  try {
    new Scanner(source, depth, out, opts).run()
  } catch (err) {
    if (!(err instanceof ParseError)) throw err
    errorAt = err.at
  }
  return {
    source,
    parsed: errorAt === null,
    reason: errorAt === null ? 'ok' : 'syntax-error',
    errorAt,
    ...out
  }
}

/** 读一条 PowerShell 命令的结构事实（宽松轨：只可用于拦截 / 询问） */
export function analyzePowerShellCommand(
  source: string,
  opts: PowerShellAnalyzeOptions = {}
): PowerShellFacts {
  if (source.length > MAX_POWERSHELL_SOURCE_LENGTH) {
    return {
      source,
      parsed: false,
      reason: 'too-long',
      errorAt: null,
      commands: [],
      redirects: [],
      nestedBash: [],
      depthExceeded: false
    }
  }
  return analyzeAtDepth(source, 0, opts)
}
