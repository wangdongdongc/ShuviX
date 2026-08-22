/**
 * bash 命令解析器（tree-sitter-bash）的桌面接线。
 *
 * agent-runtime 的解析层是 Node-free 的，wasm 字节由宿主喂进去：
 *   - 开发态：仓库根 node_modules（workspace hoist 后两个包都在那里）
 *   - 打包态：Resources/tree-sitter/（electron-builder extraResources，与 esbuild.wasm 同款）
 *
 * 初始化失败不抛给调用方：安全模块拿不到解析结果时命令客体呈现为「未解析」，
 * 结构化规则不命中，命令落回 ask-on-command。wasm 加载不上属于开发期就该暴露的
 * 程序问题，这里只把它记成 error 并**记住失败**，避免每条命令重试一次 wasm 加载。
 */
import { app } from 'electron'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { initShellParser, analyzeShellCommand, type ShellFacts } from '@shuvix/agent-runtime'
import { createLogger } from '../logger'

const log = createLogger('ShellParser')

/** 两份 wasm 的定位：打包后在 Resources/tree-sitter/，开发时在仓库根 node_modules */
function wasmPath(pkg: string, file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tree-sitter', file)
    : resolve(__dirname, '../../../../node_modules', pkg, file)
}

let ready: Promise<void> | undefined
let failed = false

/** 幂等；失败后不再重试（只在首次记一条 error） */
async function ensureReady(): Promise<void> {
  if (failed) return
  if (!ready) {
    ready = initShellParser({
      runtime: new Uint8Array(readFileSync(wasmPath('web-tree-sitter', 'web-tree-sitter.wasm'))),
      grammar: new Uint8Array(readFileSync(wasmPath('tree-sitter-bash', 'tree-sitter-bash.wasm')))
    }).catch((err: unknown) => {
      failed = true
      log.error(
        'tree-sitter-bash 初始化失败，命令将按未解析处理（结构化安全策略不生效）:',
        err instanceof Error ? err.message : String(err)
      )
    })
  }
  await ready
}

/** 注入 SecurityHostProvider.shellParser 的实现 */
export const shellParser = {
  ensureReady,
  analyze: (command: string): ShellFacts => analyzeShellCommand(command)
}
