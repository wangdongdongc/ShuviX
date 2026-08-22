/**
 * Node 侧的 wasm 字节加载 —— **不从 shell/index.ts 导出**。
 *
 * 它 import 了 node:fs，扩展端的 bundle 绝不能碰到它；靠「不出现在 index 的导出图里」
 * 保证 tree-shaking 不会把它拉进去。需要它的只有两类调用方：
 *   - 单测（vitest 跑在 Node 环境）；
 *   - 桌面主进程的开发态（打包态应改从 extraResources 读，见 electron-builder.yml
 *     里 esbuild-wasm 的同款写法；那一步等 PEP 接入时再做）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ShellParserWasm } from './types'

// 用 Node 原生 require.resolve 定位包内资源：
// web-tree-sitter 的 exports 显式导出了 ./web-tree-sitter.wasm；
// tree-sitter-bash 没有 exports 字段，任意子路径可解析。
const require = createRequire(import.meta.url)

/** 从 node_modules 读取两份 wasm 字节 */
export function loadShellParserWasmFromNodeModules(): ShellParserWasm {
  return {
    runtime: new Uint8Array(readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
    grammar: new Uint8Array(readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')))
  }
}
