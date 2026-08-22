/**
 * 词的静态求值 —— 把语法树上的一个「词」还原成 shell 实际会传给程序的字符串。
 *
 * 这一步不是可选的装饰：GuardFall（2026-06 对 11 个 agent 的绕过研究）里两类绕过
 * 正是靠词法层的还原差异吃掉的 ——
 *   - 引号剥离：`r''m -rf /` 在源串里没有 `rm`，但 shell 拼接后有；
 *   - ANSI-C 转义：`$'\x72\x6d'` 展开成 `rm`。
 * 只要照抄源串文本（node.text）就会漏掉这两类，所以必须逐节点还原。
 *
 * 求值三态：
 *   - string  静态可知的确定值；
 *   - null    含运行时展开（$VAR / $( ) / $(( )) / <( )），值不可静态确定；
 * glob 不是第三态而是**旁路标记**：`*.ts` 的文本是确定的，但它会被 shell 展开成
 * 别的东西（甚至展开成 `-delete` 这样的 flag），所以值照给，同时把 glob 标出来
 * 让上层自己决定要不要因此不放行。
 */
import type { Node } from 'web-tree-sitter'

/** 词求值结果 */
export interface WordValue {
  /** 静态可知的值；含运行时展开时为 null */
  value: string | null
  /** 该词含未加引号的 glob 元字符（* ? [ ]） */
  glob: boolean
  /** 该词含大括号展开（{a,b} / {1..3}） */
  brace: boolean
}

const DYNAMIC_KINDS = new Set([
  'simple_expansion',
  'expansion',
  'command_substitution',
  'arithmetic_expansion',
  'process_substitution',
  'extglob_pattern'
])

const UNKNOWN: WordValue = { value: null, glob: false, brace: false }

/** 未加引号文本里的 glob 元字符 */
function hasGlobMeta(text: string): boolean {
  return /[*?[]/.test(text)
}

/** 未加引号文本里的大括号展开（保守：只认含逗号或 `..` 的花括号） */
function hasBraceExpansion(text: string): boolean {
  return /\{[^{}]*(,|\.\.)[^{}]*\}/.test(text)
}

/** 去掉未加引号文本里的反斜杠转义 —— bash 对未加引号的 `\x` 一律取字面 `x` */
function unescapeUnquoted(text: string): string {
  return text.replace(/\\(.)/gs, '$1')
}

/**
 * 把被反斜杠转义的字符换成占位符，供元字符判定使用。
 *
 * 元字符判定必须在**去转义之前**做：`a\*b` 在 bash 里是字面量 `a*b`，不参与路径展开，
 * 而去转义后的字符串里那个 `*` 已经和真 glob 无法区分了。判定与取值因此走两条路 ——
 * 取值用 unescapeUnquoted，判定用本函数的掩码串。
 */
function maskEscapes(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) {
      out += '\u0000'
      i++
      continue
    }
    out += text[i]
  }
  return out
}

/** 双引号内 bash 只对这几个字符识别反斜杠转义，其余保留反斜杠原样 */
const DQ_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n'])

function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\(.)/gs, (m, c: string) => (DQ_ESCAPABLE.has(c) ? c : m))
}

const ANSI_C_SIMPLE: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?'
}

/**
 * 解码 `$'...'` 的 C 风格转义。未识别的转义按 bash 的行为保留反斜杠 + 原字符
 * （而不是判为不可知）—— 这一层宁可给出「某个确定字符串」也不要给出 null，
 * 因为宽松轨丢字符串等于漏检。
 */
export function decodeAnsiC(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\' || i === body.length - 1) {
      out += body[i]
      continue
    }
    const c = body[++i]
    const simple = ANSI_C_SIMPLE[c]
    if (simple !== undefined) {
      out += simple
      continue
    }
    if (c === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1))
      if (m) {
        out += String.fromCharCode(parseInt(m[0], 16))
        i += m[0].length
        continue
      }
    } else if (c === 'u' || c === 'U') {
      const width = c === 'u' ? 4 : 8
      const m = new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(body.slice(i + 1))
      if (m) {
        out += String.fromCodePoint(parseInt(m[0], 16))
        i += m[0].length
        continue
      }
    } else if (c >= '0' && c <= '7') {
      const m = /^[0-7]{1,3}/.exec(body.slice(i))
      if (m) {
        out += String.fromCharCode(parseInt(m[0], 8))
        i += m[0].length - 1
        continue
      }
    } else if (c === 'c') {
      const ctrl = body[i + 1]
      if (ctrl) {
        out += String.fromCharCode(ctrl.toUpperCase().charCodeAt(0) ^ 0x40)
        i += 1
        continue
      }
    }
    out += '\\' + c
  }
  return out
}

/**
 * 拼出 concatenation 的「未加引号形状」：裸 word/number 片段保留原文（并做转义掩码），
 * 其余片段（引号串、展开、替换）换成占位符 —— 它们的内容不参与 glob/大括号展开。
 */
function maskConcatenationParts(node: Node): string {
  let out = ''
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (!child) continue
    out += child.type === 'word' || child.type === 'number' ? maskEscapes(child.text) : '\u0000'
  }
  return out
}

/** 合并两个词片段的求值结果（用于 concatenation / string 的逐片拼接） */
function join(a: WordValue, b: WordValue): WordValue {
  return {
    value: a.value === null || b.value === null ? null : a.value + b.value,
    glob: a.glob || b.glob,
    brace: a.brace || b.brace
  }
}

/**
 * 求值一个词节点。传入的应当是命令的实参节点或 command_name 的子节点。
 * 未知节点种类一律返回 null（保守：宁可当作不可知）。
 */
export function evaluateWord(node: Node): WordValue {
  const kind = node.type
  if (DYNAMIC_KINDS.has(kind)) return UNKNOWN

  switch (kind) {
    case 'word': {
      const raw = node.text
      const masked = maskEscapes(raw)
      return {
        value: unescapeUnquoted(raw),
        glob: hasGlobMeta(masked),
        brace: hasBraceExpansion(masked)
      }
    }
    case 'number':
      return { value: node.text, glob: false, brace: false }
    case 'raw_string':
      // '...' 内无任何转义与展开
      return { value: node.text.slice(1, -1), glob: false, brace: false }
    case 'ansi_c_string': {
      // $'...' —— 去掉 $' 与结尾 '
      const body = node.text.slice(2, -1)
      return { value: decodeAnsiC(body), glob: false, brace: false }
    }
    case 'string':
    case 'translated_string': {
      // 双引号串：由 string_content 与内嵌展开交替组成
      let acc: WordValue = { value: '', glob: false, brace: false }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (!child) continue
        if (child.type === '"' || child.type === '$"') continue
        if (child.type === 'string_content') {
          acc = join(acc, {
            value: unescapeDoubleQuoted(child.text),
            glob: false,
            brace: false
          })
          continue
        }
        acc = join(acc, evaluateWord(child))
      }
      return acc
    }
    case 'concatenation': {
      // pre"mid"post / r''m —— 逐片求值后拼接，这是引号剥离类绕过的还原点
      let acc: WordValue = { value: '', glob: false, brace: false }
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i)
        if (!child) continue
        acc = join(acc, evaluateWord(child))
      }
      // 元字符还要按**整段拼起来的形状**再判一次：tree-sitter 把 `{a,/etc/passwd}`
      // 切成三个 word 塞进 concatenation，单看任何一片都不含逗号型大括号，
      // 只有拼回去才看得出。判定只覆盖未加引号的片段（引号内的 `{a,b}` 不展开）。
      const masked = maskConcatenationParts(node)
      return {
        value: acc.value,
        glob: acc.glob || hasGlobMeta(masked),
        brace: acc.brace || hasBraceExpansion(masked)
      }
    }
    case 'command_name': {
      const inner = node.namedChild(0) ?? node.child(0)
      return inner ? evaluateWord(inner) : UNKNOWN
    }
    default:
      return UNKNOWN
  }
}
