/**
 * Shell 命令解析层 —— 模块导览：
 *   types.ts     纯数据类型（ShellFacts / LiteralCommand / 双轨字段的红线说明）
 *   parser.ts    tree-sitter-bash 生命周期（宿主注入 wasm 字节；异步 init + 同步 parse）
 *   words.ts     词的静态求值（引号剥离 / ANSI-C 转义 / glob 标记）
 *   wrappers.ts  wrapper 解包表与 `sh -c` / `eval` 载荷提取
 *   analyze.ts   一次解析产出严格轨 + 宽松轨
 *   nodeWasm.ts  Node 侧 wasm 读取（**故意不在此导出**，避免污染扩展端 bundle）
 *
 * 红线：`wordOnly` / `wordOnlyCommands` 才是可用于放行的字段；
 * `literalCommands` / `dynamics` 只能用于拦截或询问。理由见 analyze.ts 文件头。
 */
export type {
  ShellSpan,
  ShellDynamicKind,
  ShellRedirect,
  ShellRedirectKind,
  ShellFacts,
  ShellUnparsedReason,
  ShellParserWasm,
  LiteralCommand
} from './types'
export {
  initShellParser,
  isShellParserReady,
  resetShellParserForTests,
  MAX_SHELL_SOURCE_LENGTH
} from './parser'
export { analyzeShellCommand, spanIntersectsError, MAX_NESTED_SHELL_DEPTH } from './analyze'
export { evaluateWord, decodeAnsiC, type WordValue } from './words'
export {
  stripWrappers,
  extractShellPayload,
  SHELL_RUNNERS,
  MULTICALL_BINARIES,
  EVAL_LIKE,
  TRANSPARENT_WRAPPERS,
  type UnwrapResult
} from './wrappers'
