/**
 * 命令客体的结构属性 —— 把 shell 解析层的 ShellFacts 投影成 CEL 能消费的属性文档。
 *
 * 为什么要有这一层而不是把 ShellFacts 直接摊给 CEL：
 *
 * 1. **类型系统对不上**。cel-js 的列表是强类型的：`[null,'x']` 直接报
 *    "List elements must have the same type"，`null.startsWith(…)` 也无重载。而
 *    ShellFacts 的 argv 用 null 占位动态词（位置必须保留 —— `find . -name $X -delete`
 *    里 `-delete` 的位置决定语义）。投影时把 null 换成空串，另给 `complete` 标志，
 *    解析层保持诚实，CEL 那边保持可求值。
 * 2. **暴露面要小**。ShellFacts 有十来个字段，其中严格轨（wordOnly*）是「唯一可用于
 *    放行」的字段 —— 现阶段只落 deny 策略，不需要它，就不暴露：过早给出一个容易误用
 *    的放行依据，不如等真要做白名单豁免时连同轨道校验一起上。
 * 3. **重定向目标要变成绝对路径**才能和 protect-system 那套目录变量（inDir）拼在一起用。
 *
 * 这里的产出全部服务于 deny/ask 判定，属于宽松轨：可能漏（动态词看不出值），
 * 不会因为「没看见」而放行 —— 没看见的结果是规则不命中，命令落回 ask-on-command。
 */
import { spanIntersectsError } from './shell/analyze'
import { stripWrappers } from './shell/wrappers'
import type { ShellFacts, ShellRedirect, ShellSpan } from './shell/types'
import type { AttrScalar } from './types'

/** 投影给 CEL 的单条命令 —— base/argv 是**剥掉透明 wrapper 之后**的有效命令 */
export interface CommandAttr extends Record<string, AttrScalar | string[]> {
  /**
   * 真正会被执行的程序名（basename）。`sudo rm -rf /` 的 base 是 `rm` 而不是 `sudo` ——
   * 解析层承诺的是「argv 完整且字面」，「谁是真正的程序」要过 wrapper 解包才知道，
   * 这一步在这里做掉，规则里就不必每条都记得先解包。
   */
  base: string
  /** 剥掉 wrapper 后的各参数字面值，动态词以空串占位（位置保留），argv[0] 也在其中 */
  argv: string[]
  /** 依次剥掉的 wrapper 名（`sudo` / `env` / `timeout` …）；没剥则为空 */
  wrappers: string[]
  /** argv 是否整条静态可知（有动态词时为 false） */
  complete: boolean
  /** 0 = 原始命令，>0 = 由 `sh -c` / `eval` 载荷递归再解析而来 */
  depth: number
}

/** 命令客体上由解析层贡献的属性 */
export interface CommandFactAttrs extends Record<string, AttrScalar | string[] | CommandAttr[]> {
  /**
   * 整份命令解析器就绪且语法无误。
   *
   * 注意 false **不代表** commands/writes 为空：语法错时错误区间之外的节点照样交出来
   * （见下），所以想要"只信完整解析"的策略要自己合取这个字段。
   */
  parsed: boolean
  /**
   * 树中每个命令节点的字面 argv，含递归展开的嵌套 shell 载荷。
   *
   * 语法错时只丢弃**与错误区间相交**的节点，其余照给：整树 hasError 就全盘作废的话，
   * 在脚本末尾追加一个未闭合 heredoc 就能关掉整道结构化门 —— 而 bash 对这种脚本
   * `bash -n` 退出码是 0，照跑不误。落在任何错误区间之外的命令节点，与干净解析出来的
   * 一样可信（这条判据取自 OpenHands 的 defense_in_depth：整树告警太粗，该 fail-safe
   * 的是「检测所依赖的那一段」落在错误里的情况）。
   */
  commands: CommandAttr[]
  /** 重定向的写入目标（已按 cwd 解析成绝对路径）。fd 复制与目标不可知的重定向不在其中 */
  writes: string[]
}

const EMPTY: CommandFactAttrs = { parsed: false, commands: [], writes: [] }

/** 会真正落盘的重定向方向 */
const WRITE_KINDS: ReadonlySet<ShellRedirect['kind']> = new Set(['write', 'append'])

function basename(name: string): string {
  const idx = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return idx >= 0 ? name.slice(idx + 1) : name
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * 折叠 `.` 与 `..` 并统一分隔符。Node-free（agent-runtime 两端共用，不能 import path），
 * 且不碰文件系统 —— 不解析符号链接，也不判断存在性。
 */
function normalize(input: string, sep: string): string {
  const winDrive = /^([A-Za-z]:)[\\/]/.exec(input)
  const root = winDrive ? winDrive[1] + sep : input.startsWith('/') ? sep : ''
  const out: string[] = []
  for (const seg of input.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue
    if (winDrive && seg === winDrive[1]) continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!root) out.push('..')
      continue
    }
    out.push(seg)
  }
  return root + out.join(sep)
}

/** 把重定向目标解析成绝对路径；无 cwd（如 ssh 远端）时相对路径保持原样 */
function resolveTarget(target: string, cwd: string | undefined, sep: string): string {
  if (isAbsolute(target)) return normalize(target, sep)
  if (!cwd) return target
  return normalize(`${cwd}${sep}${target}`, sep)
}

/**
 * 投影。facts 为 undefined（宿主未注入解析器）或未解析时返回全空形态 ——
 * 调用方与策略都必须先看 `parsed`，别把空集当成「没有危险」。
 */
export function projectCommandFacts(
  facts: ShellFacts | undefined,
  cwd: string | undefined,
  sep: string
): CommandFactAttrs {
  if (!facts) return EMPTY
  // depth>0 的节点来自嵌套载荷的**独立且成功**的解析（见 analyze.ts 只在 inner.parsed
  // 时并入），它们的 span 属于载荷串的坐标系，不能拿去和外层错误区间比。
  const usable = <T extends { span: ShellSpan; depth?: number }>(item: T): boolean =>
    facts.parsed || (item.depth ?? 0) > 0 || !spanIntersectsError(facts, item.span)
  return {
    parsed: facts.parsed,
    commands: facts.literalCommands.filter(usable).map((c) => {
      // 解包是**宽松轨**的动作：拿不准时倾向于继续往里剥，过度解包对「找危险」是
      // 安全方向。严格轨（放行依据）绝不能这么做 —— 它现在压根没暴露给 CEL。
      const stripped = stripWrappers(c.argv)
      const argv = stripped.argv.map((a) => a ?? '')
      return {
        base: basename(argv[0] ?? ''),
        argv,
        wrappers: stripped.wrappers,
        complete: c.complete,
        depth: c.depth
      }
    }),
    writes: facts.redirects
      .filter((r) => WRITE_KINDS.has(r.kind) && r.target !== null && usable(r))
      .map((r) => resolveTarget(r.target as string, cwd, sep))
  }
}
