/**
 * 包装命令（wrapper）解包 —— 把 `sudo -u root env FOO=1 timeout 30 curl x` 还原成 `curl x`。
 *
 * 为什么这层单独存在：上一轮实测里，`exec` / `command` / `env` / `nohup` / `eval` /
 * `sh -c` 这类前缀让「谁会被执行」的抽取整体漏报 9/25，而两个解析器（tree-sitter 与
 * mvdan-sh）的 AST 都是对的 —— 漏的是语义不是语法。换解析器解决不了，必须在这里补。
 *
 * ⚠️ 本模块只服务**危险发现**（宽松轨）。它会在拿不准时倾向于继续往里剥，
 * 于是可能把不该等同的东西等同（例如 `xargs -n1 grep` 里 grep 其实拿的是 stdin 的参数）。
 * 过度解包对「找危险」是安全方向，对「证明安全」是致命方向 —— 严格轨绝不调用它。
 *
 * 名单取自 Claude Code 公开文档的 wrapper 剥离集合，并按上面的定位做了取舍：
 * 它为了**放行**而剥离，所以刻意不含 watch/setsid/ionice/flock 与 npx/docker exec 一类；
 * 我们为了**发现**而剥离，所以把它们收进来 —— 方向不同，名单也就不同。
 */

/** 其 `-c` 参数是一段新的 shell 脚本的命令 */
export const SHELL_RUNNERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'ash'
])

/** 多合一二进制：第一个定位参数是 applet 名，shell 语义从 applet 开始 */
export const MULTICALL_BINARIES: ReadonlySet<string> = new Set(['busybox', 'toybox'])

/**
 * 把余下参数拼接后当作一段脚本执行的命令（无需 `-c`）。
 *
 * 刻意**不含** `source` / `.`：它们的参数是**文件路径**而不是脚本文本，拼接后再解析
 * 会造出一条名为 `foo.sh` 的不存在的命令。被 source 的文件内容不在我们手里，
 * 静态分析看不见 —— 那属于「看不见」而不是「看错」，交给上层按未知命令处理。
 */
export const EVAL_LIKE: ReadonlySet<string> = new Set(['eval'])

/** wrapper 的选项处理规则 */
interface WrapperSpec {
  /** 需要吃掉下一个 token 作为取值的短/长选项 */
  optionsWithValue?: ReadonlySet<string>
  /** 是否允许 `VAR=value` 形式的前缀赋值（env / sudo 支持） */
  assignments?: boolean
  /** 是否吃掉一个**非**选项的定位参数（timeout 的时长、nice 的优先级在 -n 里则不算） */
  positional?: number
  /** 带任何选项时不再视为透明（如 `xargs -n1 grep` 的实际执行语义已经变了） */
  opaqueWithOptions?: boolean
}

/**
 * 透明包装命令表 —— 剥掉自身与自身的选项后，余下部分就是真正要执行的命令。
 */
export const TRANSPARENT_WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map<string, WrapperSpec>([
  [
    'sudo',
    {
      optionsWithValue: new Set(['-u', '-g', '-p', '-C', '-h', '-U', '-r', '-t']),
      assignments: true
    }
  ],
  ['doas', { optionsWithValue: new Set(['-u', '-C']) }],
  [
    'env',
    { optionsWithValue: new Set(['-u', '--unset', '-C', '--chdir', '-S']), assignments: true }
  ],
  ['command', {}],
  ['builtin', {}],
  ['exec', { optionsWithValue: new Set(['-a']) }],
  ['nohup', {}],
  ['setsid', {}],
  ['time', {}],
  [
    'timeout',
    { optionsWithValue: new Set(['-s', '--signal', '-k', '--kill-after']), positional: 1 }
  ],
  ['nice', { optionsWithValue: new Set(['-n', '--adjustment']) }],
  ['ionice', { optionsWithValue: new Set(['-c', '-n', '-p', '-P', '-u']) }],
  ['stdbuf', { optionsWithValue: new Set(['-i', '-o', '-e']) }],
  ['noglob', {}],
  ['nocorrect', {}],
  ['watch', { optionsWithValue: new Set(['-n', '--interval', '-d']) }],
  [
    'flock',
    { optionsWithValue: new Set(['-w', '--wait', '-E', '--conflict-exit-code']), positional: 1 }
  ],
  ['xargs', { opaqueWithOptions: true }],
  ['script', { opaqueWithOptions: true }]
])

/** 解包结果 */
export interface UnwrapResult {
  /** 剥离后的 argv（可能与入参相同）；null 占位保留 */
  argv: (string | null)[]
  /** 依次剥掉的 wrapper 名 */
  wrappers: string[]
  /**
   * 剥离过程中遇到不可静态确定的 token，或触到迭代上限 ——
   * 结果不完整，上层应按「不确定」处理而不是相信 argv。
   */
  uncertain: boolean
}

const MAX_UNWRAP_ITERATIONS = 8

function basename(name: string): string {
  const idx = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return idx >= 0 ? name.slice(idx + 1) : name
}

/** `VAR=value` 形式的前缀赋值 */
function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

/**
 * 逐层剥掉透明包装命令。遇到未知命令、动态 token 或迭代上限即停。
 *
 * 不处理 `sh -c` —— 那不是「剥掉前缀」而是「换一段源码重新解析」，由 analyze.ts
 * 负责递归；本函数只做同一条 argv 内的前缀剥离。
 */
export function stripWrappers(argv: readonly (string | null)[]): UnwrapResult {
  let rest = argv.slice()
  const wrappers: string[] = []
  let uncertain = false

  for (let iter = 0; iter < MAX_UNWRAP_ITERATIONS; iter++) {
    const head = rest[0]
    if (head === null) {
      // 头部就是动态词：无法知道真正执行的是什么
      uncertain = true
      break
    }
    if (head === undefined) break
    const spec = TRANSPARENT_WRAPPERS.get(basename(head))
    if (!spec) break

    let i = 1
    let sawOption = false
    while (i < rest.length) {
      const token = rest[i]
      if (token === null) {
        uncertain = true
        break
      }
      if (token === '--') {
        i++
        break
      }
      if (spec.assignments && isAssignment(token)) {
        i++
        continue
      }
      if (token.startsWith('-') && token.length > 1) {
        sawOption = true
        if (spec.optionsWithValue?.has(token)) i += 2
        else i += 1
        continue
      }
      break
    }
    if (uncertain) break
    if (spec.opaqueWithOptions && sawOption) {
      // 带了选项的 xargs 之流：执行语义已变，不再当作透明前缀
      break
    }
    if (spec.positional) i += spec.positional
    if (i >= rest.length) {
      // 剥完什么都不剩（如裸 `sudo`）—— 保持原样，交给上层判断
      break
    }
    wrappers.push(basename(head))
    rest = rest.slice(i)
    if (iter === MAX_UNWRAP_ITERATIONS - 1) uncertain = true
  }

  return { argv: rest, wrappers, uncertain }
}

/** shell runner 里会吃掉下一个 token 作为取值的选项 */
const RUNNER_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-o',
  '+o',
  '-O',
  '+O',
  '--rcfile',
  '--init-file'
])

/**
 * 从一条 argv 中取出「要作为新脚本再解析」的载荷。
 *
 * - shell runner：按 POSIX 的 `sh [options] -c command_string [name [arg...]]` 解析 ——
 *   选项区结束（`--` 或第一个定位参数）之后的**第一个定位参数**才是脚本文本，
 *   且只在此前出现过带 `c` 的短选项簇（`-c` / `-lc` / `-cx`）时才算内联脚本；
 * - 多合一二进制（busybox）：跳过 applet 名后按上面的规则继续；
 * - eval：把全部参数以空格拼接（bash 的 eval 语义就是拼接后再解析）。
 *
 * 返回 null 表示「没有内联脚本载荷」（如 `bash script.sh`）；
 * 返回 { payload: null } 表示「有载荷位但取不到值」，两者对上层意义不同：
 * 后者必须标记 nested-shell 并 fail-safe。
 */
export function extractShellPayload(
  argv: readonly (string | null)[]
): { payload: string | null } | null {
  const head = argv[0]
  if (typeof head !== 'string') return null
  const base = basename(head)

  if (EVAL_LIKE.has(base)) {
    const args = argv.slice(1)
    if (args.length === 0) return null
    if (args.some((a) => a === null)) return { payload: null }
    return { payload: (args as string[]).join(' ') }
  }

  if (MULTICALL_BINARIES.has(base)) {
    // busybox sh -c '...' —— applet 名之前的都是 busybox 自己的选项
    for (let i = 1; i < argv.length; i++) {
      const token = argv[i]
      if (token === null) return { payload: null }
      if (token.startsWith('-')) continue
      return SHELL_RUNNERS.has(basename(token)) ? extractShellPayload(argv.slice(i)) : null
    }
    return null
  }

  if (!SHELL_RUNNERS.has(base)) return null

  let sawScriptFlag = false
  let endOfOptions = false
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (token === null) return { payload: null }
    if (!endOfOptions) {
      if (token === '--') {
        endOfOptions = true
        continue
      }
      if (token.startsWith('-') || token.startsWith('+')) {
        if (RUNNER_OPTIONS_WITH_VALUE.has(token)) {
          i++
          continue
        }
        // 长选项不参与 `c` 判定，避免 `--color` 之类被误认成 -c
        if (!token.startsWith('--') && token.slice(1).includes('c')) sawScriptFlag = true
        continue
      }
    }
    // 选项区已结束，这是第一个定位参数：有 -c 则它是脚本文本，否则是脚本文件名
    return sawScriptFlag ? { payload: token } : null
  }
  // 见到了 -c 但后面没有任何定位参数
  return sawScriptFlag ? { payload: null } : null
}
