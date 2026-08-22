/**
 * 命令事实抽取 —— 一次解析同时产出严格轨与宽松轨。
 *
 * 双轨的分工直接照搬 OpenAI Codex CLI 的做法（codex-rs/shell-command/src/bash.rs），
 * 那里把红线写进了函数注释：宽松轨 "is suitable for identifying dangerous literal
 * commands, but **must not be used to prove that a command is safe**"。
 *
 *   严格轨 wordOnly —— 节点种类白名单，凡是名单外的命名节点或算子一律判否。
 *     它回答的是「这条命令能不能被证明只是若干字面命令的安全组合」。
 *     tree-sitter 已知的两个静默压平点（`time cmd` 被拍成普通命令、嵌套反引号只识别
 *     一层）都落在白名单外或被 glob/动态词判据挡掉，因此不影响本轨的可靠性。
 *
 *   宽松轨 literalCommands —— 接受任意语法，尽力抽字面命令，并对 `sh -c` / `eval`
 *     载荷递归再解析（深度上限 8，与 Codex、OpenHands 独立收敛到的常数一致）。
 *     它会漏（上面那两个压平点就漏），所以只配用来触发拦截或询问。
 *
 * parsed=false 时两轨都不可信：**空集在全称判断下恒真**，
 * `literalCommands.every(危险?)` 对空数组返回 true 会静默放行，这是本模块最容易写错的地方。
 */
import { isShellParserReady, withTree, MAX_SHELL_SOURCE_LENGTH } from './parser'
import { evaluateWord } from './words'
import { extractShellPayload } from './wrappers'
import type {
  LiteralCommand,
  ShellDynamicKind,
  ShellFacts,
  ShellRedirect,
  ShellRedirectKind,
  ShellSpan,
  ShellUnparsedReason
} from './types'
import type { Node } from 'web-tree-sitter'

/** 嵌套 shell 载荷的递归上限 */
export const MAX_NESTED_SHELL_DEPTH = 8

/** 严格轨允许出现的命名节点 —— 名单外一律判否 */
const WORD_ONLY_NAMED_KINDS: ReadonlySet<string> = new Set([
  'program',
  'list',
  'pipeline',
  'command',
  'command_name',
  'word',
  'string',
  'string_content',
  'raw_string',
  'number',
  'concatenation'
])

/**
 * 严格轨允许出现的匿名 token。
 * `ansi_c_string`（`$'...'`）刻意**不在**白名单里：它的值我们能正确解码，
 * 但它是 GuardFall 里的绕过载体，多问一次的成本远低于放行一条解码错的命令。
 */
const WORD_ONLY_TOKENS: ReadonlySet<string> = new Set(['&&', '||', ';', '|', '"', "'"])

const REDIRECT_KINDS: ReadonlySet<string> = new Set([
  'file_redirect',
  'heredoc_redirect',
  'herestring_redirect'
])

const CONTROL_FLOW_KINDS: ReadonlySet<string> = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'for_statement',
  'c_style_for_statement',
  'while_statement',
  'case_statement',
  'case_item',
  'function_definition',
  'do_group',
  'compound_statement',
  'test_command',
  'negated_command'
])

const DYNAMIC_NODE_KINDS: ReadonlyMap<string, ShellDynamicKind> = new Map([
  ['command_substitution', 'command-substitution'],
  ['process_substitution', 'process-substitution'],
  ['simple_expansion', 'parameter-expansion'],
  ['expansion', 'parameter-expansion'],
  ['arithmetic_expansion', 'arithmetic-expansion'],
  ['brace_expression', 'brace-expansion'],
  ['extglob_pattern', 'extglob'],
  ['subshell', 'subshell'],
  ['variable_assignment', 'assignment'],
  ['variable_assignments', 'assignment'],
  ['declaration_command', 'assignment'],
  ['unset_command', 'assignment'],
  ['heredoc_redirect', 'heredoc'],
  ['file_redirect', 'redirect'],
  ['herestring_redirect', 'redirect']
])

function span(node: Node): ShellSpan {
  return { start: node.startIndex, end: node.endIndex }
}

function basename(name: string): string {
  const idx = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return idx >= 0 ? name.slice(idx + 1) : name
}

function unparsed(
  source: string,
  reason: ShellUnparsedReason,
  errorSpans: ShellSpan[] = []
): ShellFacts {
  return {
    source,
    parsed: false,
    reason,
    errorSpans,
    wordOnly: false,
    wordOnlyCommands: [],
    literalCommands: [],
    dynamics: [],
    redirects: [],
    depthExceeded: false
  }
}

/** 遍历整棵树（含匿名节点），回调返回 false 表示不再深入该子树 */
function walk(node: Node, visit: (n: Node) => boolean): void {
  if (!visit(node)) return
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child) walk(child, visit)
  }
}

/**
 * 判定重定向方向。
 *
 * `>&` / `<&` 既可能是 fd 复制（`2>&1`）也可能是重定向到文件（`ls >& out`，bash 里等价
 * 于 `&>`）——区别只在目标是不是纯数字（或 `-`，表示关闭 fd）。所以运算符与目标要一起看。
 */
function redirectKind(node: Node, target: string | null): ShellRedirectKind {
  if (node.type === 'heredoc_redirect') return 'heredoc'
  if (node.type === 'herestring_redirect') return 'herestring'
  let operator = ''
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child || child.isNamed) continue
    if (child.type.includes('>') || child.type.includes('<')) {
      operator = child.type
      break
    }
  }
  if (
    (operator.includes('>&') || operator.includes('<&')) &&
    target !== null &&
    /^(\d+|-)$/.test(target)
  ) {
    return 'fd-dup'
  }
  if (operator.includes('>>')) return 'append'
  if (operator.includes('>')) return 'write'
  if (operator.includes('<')) return 'read'
  return 'unknown'
}

/** 抽出一个 command 节点的字面 argv（动态词以 null 占位，重定向子节点跳过） */
function literalArgv(node: Node): { argv: (string | null)[]; glob: boolean; brace: boolean } {
  const argv: (string | null)[] = []
  let glob = false
  let brace = false
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (!child) continue
    if (REDIRECT_KINDS.has(child.type)) continue
    if (child.type === 'variable_assignment' || child.type === 'variable_assignments') continue
    const value = evaluateWord(child)
    if (value.glob) glob = true
    if (value.brace) brace = true
    argv.push(value.value)
  }
  return { argv, glob, brace }
}

/**
 * 严格轨：整棵树是否只由字面词命令与 `&&` `||` `;` `|` 组成。
 * 返回 null 表示不满足；满足时返回各命令的 argv 序列（按源码顺序）。
 */
function collectWordOnly(root: Node): string[][] | null {
  const commands: { argv: string[]; start: number }[] = []
  let ok = true

  walk(root, (n) => {
    if (!ok) return false
    if (n.isError || n.isMissing) {
      ok = false
      return false
    }
    if (n.isNamed) {
      if (!WORD_ONLY_NAMED_KINDS.has(n.type)) {
        ok = false
        return false
      }
      if (n.type === 'command') {
        const { argv, glob, brace } = literalArgv(n)
        // 任一词动态、含 glob 或含大括号展开 → 不属于可证明子集。
        // brace 与 glob 同等对待：`cp x {a,/etc/passwd}` 的字面 argv 完全看不出第二个目标，
        // 而 tree-sitter 把逗号型大括号当普通 word，光看节点种类发现不了。
        if (glob || brace || argv.some((a) => a === null)) {
          ok = false
          return false
        }
        commands.push({ argv: argv as string[], start: n.startIndex })
      }
      return true
    }
    // 匿名 token：只放行安全算子与引号
    if (n.type.trim() === '') return true
    if (!WORD_ONLY_TOKENS.has(n.type)) {
      ok = false
      return false
    }
    return true
  })

  if (!ok || commands.length === 0) return null
  return commands.sort((a, b) => a.start - b.start).map((c) => c.argv)
}

/** 单层（不含递归）的树扫描结果 */
interface ScanResult {
  errorSpans: ShellSpan[]
  hasError: boolean
  wordOnlyCommands: string[][] | null
  commands: { argv: (string | null)[]; span: ShellSpan }[]
  dynamics: ShellDynamicKind[]
  redirects: ShellRedirect[]
}

function scan(root: Node): ScanResult {
  const errorSpans: ShellSpan[] = []
  const commands: { argv: (string | null)[]; span: ShellSpan }[] = []
  const dynamics: ShellDynamicKind[] = []
  const redirects: ShellRedirect[] = []
  const seenDynamic = new Set<ShellDynamicKind>()

  const addDynamic = (kind: ShellDynamicKind): void => {
    if (seenDynamic.has(kind)) return
    seenDynamic.add(kind)
    dynamics.push(kind)
  }

  walk(root, (n) => {
    if (n.isError || n.isMissing) {
      errorSpans.push(span(n))
      // 继续深入：ERROR 子树里仍可能有可识别的命令，宽松轨要尽力抽
      return true
    }
    if (!n.isNamed) {
      if (n.type === '&') addDynamic('background')
      return true
    }
    const dynamic = DYNAMIC_NODE_KINDS.get(n.type)
    if (dynamic) addDynamic(dynamic)
    if (CONTROL_FLOW_KINDS.has(n.type)) addDynamic('control-flow')
    if (REDIRECT_KINDS.has(n.type)) {
      const destination = n.childForFieldName('destination') ?? n.namedChild(n.namedChildCount - 1)
      const target = destination ? evaluateWord(destination).value : null
      const kind = redirectKind(n, target)
      // fd 复制不指向文件，target 置空以免上层当路径消费
      redirects.push({ kind, target: kind === 'fd-dup' ? null : target, span: span(n) })
    }
    if (n.type === 'command') {
      const { argv, glob, brace } = literalArgv(n)
      if (glob) addDynamic('glob')
      if (brace) addDynamic('brace-expansion')
      commands.push({ argv, span: span(n) })
    }
    return true
  })

  return {
    errorSpans,
    hasError: root.hasError,
    wordOnlyCommands: root.hasError ? null : collectWordOnly(root),
    commands,
    dynamics,
    redirects
  }
}

/**
 * 抽取一条命令的结构事实。同步调用；解析器未就绪时返回 reason='not-initialized'。
 */
export function analyzeShellCommand(source: string): ShellFacts {
  if (!isShellParserReady()) return unparsed(source, 'not-initialized')
  if (source.length > MAX_SHELL_SOURCE_LENGTH) return unparsed(source, 'too-long')
  return analyzeAtDepth(source, 0)
}

function analyzeAtDepth(source: string, depth: number): ShellFacts {
  const scanned = withTree(source, (root) => scan(root))
  if (!scanned) return unparsed(source, 'not-initialized')

  const dynamics = [...scanned.dynamics]
  const addDynamic = (kind: ShellDynamicKind): void => {
    if (!dynamics.includes(kind)) dynamics.push(kind)
  }

  const literalCommands: LiteralCommand[] = scanned.commands.map(({ argv, span: cmdSpan }) => {
    const head = argv[0]
    const name = typeof head === 'string' ? head : ''
    return {
      name,
      base: name ? basename(name) : '',
      argv,
      complete: argv.every((a) => a !== null),
      span: cmdSpan,
      depth
    }
  })

  // 嵌套 shell 载荷递归 —— 关闭 `bash -c "..."` / `eval "..."` 这一类绕过
  let depthExceeded = false
  for (const cmd of literalCommands) {
    if (cmd.depth !== depth) continue
    const payload = extractShellPayload(cmd.argv)
    if (!payload) continue
    if (payload.payload === null) {
      addDynamic('nested-shell')
      continue
    }
    if (depth + 1 >= MAX_NESTED_SHELL_DEPTH) {
      depthExceeded = true
      addDynamic('nested-shell')
      continue
    }
    const inner = analyzeAtDepth(payload.payload, depth + 1)
    if (!inner.parsed) {
      // 载荷本身解析不了：标记出来，别假装看懂了
      addDynamic('nested-shell')
      continue
    }
    literalCommands.push(...inner.literalCommands)
    for (const kind of inner.dynamics) addDynamic(kind)
    if (inner.depthExceeded) depthExceeded = true
  }

  if (scanned.hasError) {
    const facts = unparsed(source, 'syntax-error', scanned.errorSpans)
    // 语法错时仍把宽松轨的抽取结果带出来：它只用于发现危险，多给不少给
    facts.literalCommands = literalCommands
    facts.dynamics = dynamics
    facts.redirects = scanned.redirects
    facts.depthExceeded = depthExceeded
    return facts
  }

  return {
    source,
    parsed: true,
    reason: 'ok',
    errorSpans: scanned.errorSpans,
    wordOnly: scanned.wordOnlyCommands !== null,
    wordOnlyCommands: scanned.wordOnlyCommands ?? [],
    literalCommands,
    dynamics,
    redirects: scanned.redirects,
    depthExceeded
  }
}

/**
 * 某个区间是否与语法错误区间相交。
 *
 * 用途来自 OpenHands 的 defense_in_depth：整棵树 hasError 就全盘判「不确定」过于粗暴
 * （非 shell 文本经常解析失败，会把上层淹掉），真正该 fail-safe 的是
 * **检测所依赖的那一段**落在错误区间里的情况。
 */
export function spanIntersectsError(facts: ShellFacts, target: ShellSpan): boolean {
  return facts.errorSpans.some((e) => e.start < target.end && target.start < e.end)
}
