/**
 * tree-sitter-bash 解析器生命周期 —— 唯一持有 tree-sitter 类型的文件。
 *
 * 为什么由宿主喂 wasm 字节而不是模块自己去磁盘找：agent-runtime 要在 Electron 主进程
 * 与 Chrome 扩展两端跑，两端拿到 wasm 的路子完全不同（asar/extraResources vs 打包资源），
 * 且本模块必须保持 Node-free。字节注入把这个差异挡在模块外，同时让单测可以直接从
 * node_modules 读（见 nodeWasm.ts）。
 *
 * 初始化是**异步**的（wasm 实例化），解析是**同步**的 —— 这正是 CEL 求值同步所需：
 * 宿主在启动或首次用到时 await 一次 initShellParser，之后每次 analyze 都是同步调用。
 *
 * 内存：tree-sitter 的 Tree 是 wasm 堆上的对象，必须显式 delete。所有解析都经 withTree
 * 走 try/finally，树在回调返回后立即释放；因此**不允许把 Node 泄漏到回调之外**，
 * 上层拿到的一律是已经拷贝成 JS 值的纯数据。
 */
import { Parser, Language, type Node, type Tree } from 'web-tree-sitter'
import type { ShellParserWasm } from './types'

/** 超过此长度不解析 —— 与 Claude Code 的同名上限一致：超长命令一律走询问，不做分析 */
export const MAX_SHELL_SOURCE_LENGTH = 10_000

let parser: Parser | null = null
let initPromise: Promise<void> | null = null

/**
 * 初始化解析器（幂等；并发调用共享同一个 Promise）。
 * 重复传入不同 wasm 不会重新加载 —— 语法在进程生命周期内固定。
 */
export function initShellParser(wasm: ShellParserWasm): Promise<void> {
  if (parser) return Promise.resolve()
  if (initPromise) return initPromise
  initPromise = (async () => {
    // Parser.init 走 emscripten module options，wasmBinary 直接吃字节，绕开 locateFile
    await Parser.init({ wasmBinary: wasm.runtime })
    const language = await Language.load(wasm.grammar)
    const p = new Parser()
    p.setLanguage(language)
    parser = p
  })().catch((err) => {
    // 失败后允许重试：清掉 in-flight promise，否则后续调用会永远拿到同一个 rejected
    initPromise = null
    throw err
  })
  return initPromise
}

/** 解析器是否可用。未就绪时 analyzeShellCommand 返回 reason='not-initialized' */
export function isShellParserReady(): boolean {
  return parser !== null
}

/** 仅供测试：丢弃解析器实例，让下一次 initShellParser 重新加载 */
export function resetShellParserForTests(): void {
  parser = null
  initPromise = null
}

/**
 * 解析并在回调内使用语法树，返回后立即释放。
 * 未就绪或长度超限返回 null（两种情况由调用方区分，见 analyze.ts）。
 */
export function withTree<T>(source: string, fn: (root: Node, tree: Tree) => T): T | null {
  if (!parser) return null
  const tree = parser.parse(source)
  if (!tree) return null
  try {
    return fn(tree.rootNode, tree)
  } finally {
    tree.delete()
  }
}
