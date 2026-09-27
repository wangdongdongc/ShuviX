/**
 * Shell 命令解析层 —— 纯数据类型（不含任何 tree-sitter 类型）。
 *
 * 这一层的产物是「事实」，不是「判决」：它只回答命令的**语法形状**，
 * 不回答命令做什么。判定留给上层策略。
 *
 * 只有一条轨 —— 宽松轨（literalCommands / dynamics / redirects，见 analyze.ts 文件头）：
 * 接受任意复杂语法，尽力抽出字面命令，**只能用于发现危险（拦截/询问），不能用于放行**。
 * 它会漏，而「没看见危险」不等于「无害」—— 把这些字段当成放行依据是本模块最主要的误用风险。
 *
 * 曾经还有一条严格轨（wordOnly / wordOnlyCommands：只在命令整体落入「字面词 + 安全算子」
 * 子集时才有值，预留为唯一可证明安全的字段），但从没有策略或产品代码消费过它；
 * 「先证明无害再放行」交给了 OS 级命令沙箱，严格轨随之删除。
 */

/**
 * 源串中的索引区间（左闭右开）。
 *
 * 单位是 **UTF-16 code unit**，与 `String.prototype.slice` 一致（不是字节）——
 * `source.slice(span.start, span.end)` 恒等于该节点原文，含 emoji 等星外字符时也成立。
 */
export interface ShellSpan {
  start: number
  end: number
}

/** 会让静态推理失效或需要额外警惕的构造 */
export type ShellDynamicKind =
  | 'command-substitution' // $( ) 与反引号
  | 'process-substitution' // <( ) >( )
  | 'parameter-expansion' // $VAR ${...}
  | 'arithmetic-expansion' // $(( ))
  | 'glob' // 未加引号的 * ? [ —— 可能展开成 flag（如 -delete），故单列
  | 'brace-expansion' // {a,b} {1..3}
  | 'extglob' // ?( ) *( ) 等
  | 'subshell' // ( )
  | 'control-flow' // if / for / while / case / function / select
  | 'redirect'
  | 'heredoc'
  | 'background' // &
  | 'assignment' // 变量赋值（独立语句或命令前缀）
  | 'nested-shell' // sh -c / bash -c / eval 的载荷未能静态取得而无法递归展开

/**
 * 重定向的方向。`fd-dup` 是文件描述符复制（`2>&1` / `<&3`）—— 它不写任何文件，
 * 单列出来是为了不让上层把 `1` 当成一个叫「1」的路径去查。
 */
export type ShellRedirectKind =
  | 'read'
  | 'write'
  | 'append'
  | 'heredoc'
  | 'herestring'
  | 'fd-dup'
  | 'unknown'

/** 一处重定向 */
export interface ShellRedirect {
  kind: ShellRedirectKind
  /**
   * 字面可知的目标；动态（含展开/替换）或 `fd-dup` / heredoc 时为 null。
   *
   * ⚠️ target 不保证是路径：它可能是 `/dev/null`、可能是相对路径（需按 cwd 解析），
   * kind 为 `fd-dup` 时更不是路径。上层送进路径策略前必须先看 kind。
   */
  target: string | null
  span: ShellSpan
}

/** 宽松轨抽出的一条命令 */
export interface LiteralCommand {
  /** argv[0] 的字面值；不可静态确定时为空串 */
  name: string
  /** name 的 basename（`/usr/bin/env` → `env`）；name 为空时同为空串 */
  base: string
  /**
   * 各参数的字面值，**动态词以 null 占位以保留位置** ——
   * 位置不能丢：`find . -name $X -delete` 里 `-delete` 的位置决定了它的语义。
   * argv[0] 与 name 重复出现在此，便于逐位扫 flag。
   */
  argv: (string | null)[]
  /** argv 是否整条静态可知（无 null） */
  complete: boolean
  /** 该命令在**其所属源串**中的区间；depth>0 时相对于载荷串而非原始命令 */
  span: ShellSpan
  /** 嵌套深度：0 = 原始命令，>0 = 由 `sh -c` / `eval` 载荷递归再解析而来 */
  depth: number
}

/** analyzeShellCommand 未能完整解析时的原因 */
export type ShellUnparsedReason = 'ok' | 'not-initialized' | 'too-long' | 'syntax-error'

/** 一条命令的结构事实 */
export interface ShellFacts {
  /** 原始命令串 */
  source: string
  /**
   * 解析器就绪且语法无误。**为 false 时，下面的结构化字段可能是空的**（什么都没抽到）——
   * 空集在「全称判断」下恒真，任何「所有命令都……」式的判断都必须先看它。
   */
  parsed: boolean
  /** parsed 为 false 的原因；parsed 为 true 时恒为 'ok' */
  reason: ShellUnparsedReason
  /** ERROR / MISSING 节点区间。可用于 span 级判断：错误是否落在关心的那段上 */
  errorSpans: ShellSpan[]

  // ── 宽松轨（只可用于拦截/询问） ───────────────────────────
  /**
   * 树中每个命令节点的字面 argv，含递归展开的嵌套 shell 载荷。
   *
   * ⚠️ argv[0] **不一定**是真正要跑的程序。`time rm x` 会原样给出一条
   * `['time','rm','x']`（tree-sitter 的压平点），按 argv[0] 去查表查到的是 `time`。
   * 所以消费方在按程序名匹配之前**必须先过 `stripWrappers`**（commandFacts 投影层已做）。
   *
   * 这不是本层的缺陷而是分层：解析层只负责「这条命令的字面形状是什么」，
   * 「谁是真正的程序」是 wrappers.ts 的职责，两层合起来才覆盖全部执行路径
   * （`__tests__/bashOracle.test.ts` 的不变式正是按这个并集写的，任一层退化即红）。
   */
  literalCommands: LiteralCommand[]
  /** 出现过的动态构造（去重、按首次出现排序） */
  dynamics: ShellDynamicKind[]
  /** 重定向 */
  redirects: ShellRedirect[]
  /** 递归嵌套 shell 时触到深度上限而仍有载荷未扫 —— 上层应据此 fail-safe */
  depthExceeded: boolean
}

/** 初始化解析器所需的两份 wasm 字节 */
export interface ShellParserWasm {
  /** web-tree-sitter 运行时（node_modules/web-tree-sitter/web-tree-sitter.wasm） */
  runtime: Uint8Array
  /** bash 语法（node_modules/tree-sitter-bash/tree-sitter-bash.wasm） */
  grammar: Uint8Array
}
