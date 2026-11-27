/**
 * 桌面端持久化代码模式（`pi-durable/codemode`）的 QuickJS 沙箱构造。
 *
 * - 打包后：`workerUrl` 指向 `app.asar.unpacked/out/main/codemodeWorker.js`，
 *   `wasm` 指向 `Resources/codemode/quickjs.wasm`（均在 electron-builder.yml 中显式配置）；
 * - 开发 / 单测：若同目录存在打包后的 `codemodeWorker.js` 则用它，否则回落到 `@earendil-works/pi-codemode` 默认路径，
 *   wasm 默认解析 `quickjs-wasi/quickjs.wasm`。
 *
 * 懒单例：从未开启代码模式时不加载 wasm、不创建沙箱实例。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { CodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-codemode'

/** 全局会话设置键：`'true'` 时为新创建的 root agent 启用持久化代码模式（默认关闭） */
export const CODEMODE_ENABLED_KEY = 'session.codemode'

/** 全局会话设置键：`'true'` 且启用代码模式时，将 MCP 工具标为 `callers: ['tools']`（仅在代码模式内调用） */
export const CODEMODE_MCP_ONLY_KEY = 'session.codemodeMcpOnly'

let singleton: CodemodeSandbox | undefined

function resolveWorkerUrl(): URL | undefined {
  if (app?.isPackaged === true) {
    return pathToFileURL(
      join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'codemodeWorker.js')
    )
  }
  const bundled = join(__dirname, 'codemodeWorker.js')
  if (existsSync(bundled)) return pathToFileURL(bundled)
  return undefined
}

function resolveWasmPath(): string | undefined {
  if (app?.isPackaged === true) {
    return join(process.resourcesPath, 'codemode', 'quickjs.wasm')
  }
  return undefined
}

/** 桌面主进程共享的 QuickJS 代码模式沙箱（每次执行都会启独立 worker 线程，运行完毕即销毁） */
export function getCodemodeSandbox(): CodemodeSandbox {
  if (singleton === undefined) {
    const workerUrl = resolveWorkerUrl()
    const wasmPath = resolveWasmPath()
    singleton = new CodemodeSandbox({
      ...(workerUrl === undefined ? {} : { workerUrl }),
      ...(wasmPath === undefined ? {} : { wasm: loadQuickJSWasm(wasmPath) })
    })
  }
  return singleton
}
