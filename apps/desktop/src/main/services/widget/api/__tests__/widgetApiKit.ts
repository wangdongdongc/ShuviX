/**
 * 组件 API 测试的共用工具（不是用例文件）：
 *   - `bundleApi`：用本机 esbuild 把一份 `api.ts`（加同目录的辅助文件）打成宿主要的 IIFE —— 与 BundlerService.buildApi 生成同样的入口，
 *     `shuvix/widget-api` / `zod` 映射到随包的 `resources/bundler/deps/widget-api.esm.js` / `zod.esm.js`（同一个 zod 实例）；
 *   - `buildHostBundle`：把 widgetHost.ts 打成 Node 的 cjs（QuickJS 打进去，better-sqlite3 外置成它的绝对路径）；
 *   - `electronBinary` / `electronCanLoadSqlite`：仓库里的 better-sqlite3 是为 Electron 编的，只能在
 *     `ELECTRON_RUN_AS_NODE=1` 的 Electron 里加载；加载不了（CI=1 跳过了 electron-rebuild）就跳过真宿主的用例；
 *   - `startRawHost`：拉起一个真宿主，按 hostProtocol 收发（请求自带 cpuMs / mode）。
 */
import { spawnSync, fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import type { HostRequestBody, HostResponse } from '../hostProtocol'

const req = createRequire(__filename)

/** apps/desktop */
export const DESKTOP_DIR = resolve(__dirname, '../../../../../..')
export const DEPS_DIR = join(DESKTOP_DIR, 'resources/bundler/deps')
export const HOST_ENTRY = join(DESKTOP_DIR, 'src/main/services/widget/api/widgetHost.ts')

/** 与 BundlerService.buildApi 一样的入口 */
const API_ENTRY = [
  `import api from './api.ts'`,
  `import { __installWidgetRuntime } from 'shuvix/widget-api'`,
  '__installWidgetRuntime(api)'
].join('\n')

/**
 * 打一份 API 包。`files` 是组件目录里的文件（至少有 `api.ts`）；写进一个临时目录打包，打完就删。
 * 返回 IIFE 文本（给 `manifest` 的 bundleCode，或写成 api.js 给 `call` 的 bundlePath）
 */
export async function bundleApi(files: Record<string, string> | string): Promise<string> {
  const all = typeof files === 'string' ? { 'api.ts': files } : files
  const dir = mkdtempSync(join(tmpdir(), 'wapi-src-'))
  try {
    for (const [name, content] of Object.entries(all)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), content)
    }
    const result = await build({
      stdin: { contents: API_ENTRY, resolveDir: dir, loader: 'ts', sourcefile: 'api-entry.ts' },
      bundle: true,
      format: 'iife',
      write: false,
      platform: 'neutral',
      target: 'es2020',
      logLevel: 'silent',
      plugins: [
        {
          name: 'widget-api-deps',
          setup(b) {
            b.onResolve({ filter: /^shuvix\/widget-api$/ }, () => ({
              path: join(DEPS_DIR, 'widget-api.esm.js')
            }))
            b.onResolve({ filter: /^zod$/ }, () => ({ path: join(DEPS_DIR, 'zod.esm.js') }))
          }
        }
      ]
    })
    return result.outputFiles[0].text
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** better-sqlite3 的绝对入口（宿主包里外置成它） */
export function betterSqlitePath(): string {
  return req.resolve('better-sqlite3')
}

/** 把 widgetHost.ts 打成 `<outDir>/widgetHost.js`（cjs / node），返回路径 */
export async function buildHostBundle(outDir: string): Promise<string> {
  const bs = betterSqlitePath()
  const outfile = join(outDir, 'widgetHost.js')
  await build({
    entryPoints: [HOST_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    plugins: [
      {
        name: 'external-better-sqlite3',
        setup(b) {
          b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: bs, external: true }))
        }
      }
    ]
  })
  return outfile
}

/** Electron 可执行文件（在 Node 里 `require('electron')` 给的就是它的路径） */
export function electronBinary(): string | null {
  try {
    const p = req('electron') as unknown
    return typeof p === 'string' ? p : null
  } catch {
    return null
  }
}

let canLoad: boolean | undefined
/** Electron（node 模式）能不能加载这里的 better-sqlite3 —— 不能就跳过真宿主的用例 */
export function electronCanLoadSqlite(): boolean {
  if (canLoad !== undefined) return canLoad
  const bin = electronBinary()
  if (!bin) return (canLoad = false)
  const r = spawnSync(
    bin,
    ['-e', `new (require(${JSON.stringify(betterSqlitePath())}))(':memory:').close()`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 }
  )
  return (canLoad = r.status === 0)
}

export interface RawHost {
  child: ChildProcess
  /** 发一条请求，等它的应答（不管成败） */
  request(body: HostRequestBody): Promise<HostResponse>
  /** 发一条原样的消息（不配 id），用来测宿主怎么对待坏消息 */
  sendRaw(message: unknown): void
  /** 收到的每一条消息（含 ready） */
  messages: unknown[]
  /** 子进程的 stderr 文本 */
  stderr(): string
  /** 等进程退出 → [code, signal] */
  exited: Promise<[number | null, NodeJS.Signals | null]>
  /** 断开 IPC（宿主会自己退出）；已经退了就什么都不做 */
  stop(): Promise<void>
}

/** 拉起一个真宿主（Electron 的 node 模式），等它的 `{ready:true}` */
export async function startRawHost(hostPath: string): Promise<RawHost> {
  const bin = electronBinary()
  if (!bin) throw new Error('no electron binary')
  const child = fork(hostPath, [], {
    execPath: bin,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json'
  })
  let err = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (c: string) => (err += c))
  child.stdout?.resume()
  const messages: unknown[] = []
  const waiting = new Map<number, (r: HostResponse) => void>()
  let nextId = 1
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((done) =>
    child.once('exit', (code, signal) => done([code, signal]))
  )
  const ready = new Promise<void>((done, fail) => {
    child.on('message', (m) => {
      messages.push(m)
      if ((m as { ready?: unknown })?.ready === true) done()
      const id = (m as { id?: unknown })?.id
      if (typeof id === 'number') waiting.get(id)?.(m as HostResponse)
    })
    void exited.then(([code, signal]) =>
      fail(new Error(`widget host exited before ready (${code}, ${signal}): ${err}`))
    )
  })
  await ready
  return {
    child,
    messages,
    stderr: () => err,
    exited,
    request(body) {
      const id = nextId++
      return new Promise((done) => {
        waiting.set(id, (r) => {
          waiting.delete(id)
          done(r)
        })
        child.send({ ...body, id })
      })
    },
    sendRaw(message) {
      child.send(message as never)
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (child.connected) child.disconnect()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    }
  }
}
