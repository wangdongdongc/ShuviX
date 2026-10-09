/**
 * 渲染端的「dev server」—— 开发态加载（`startup/dev-renderer-load`）的夹具。
 *
 * spec 进程里起一台 `127.0.0.1:0` 的静态 HTTP 服务，把本 checkout 的构建产物 `out/renderer` 挂在
 * `/out/renderer/` 下；spec 把 `url`（`…/out/renderer/index.html`）作为 `ELECTRON_RENDERER_URL` 交给
 * `launchApp({ env })`，实例就像 `electron-vite dev` 那样经 http 加载渲染端（e2e 实例不是打包产物，
 * is.dev 为真），各窗口在后面拼 `#hash`。挂在 `/out/renderer/` 而不是根上，是因为 harness 认主窗口
 * 要求 target 的地址里带 `out/renderer`（cdp.ts 的 `isMainPage`）。
 *
 * 用处是**按需让 index.html 那一次请求出事**（`setIndexPolicy`），其余资源照常给：
 *  - `hold`：收下请求、永不回应 —— 「加载既不成功也不报错，就这么挂着」（VM 上网络服务崩溃那次的样子）；
 *  - `drop`：直接 `socket.destroy()` —— Chromium 报一次主框架加载失败（ERR_EMPTY_RESPONSE 之类）；
 *  - `serve`：照常给。
 * 策略可以是函数（按这是第几次 index.html 请求决定），也可以中途换。每个请求都记下来（到达顺序、
 * 处置），「重发真的发生了 / 之后再没有请求」按服务器这一侧断，不信产品自己的日志。
 *
 * `close()` 先掐掉挂着的连接：`server.close()` 要等所有连接结束，而 `hold` 的连接永远不会自己结束。
 */
import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/** 本 checkout 的渲染端构建产物（test:e2e 脚本先构建） */
const RENDERER_DIR = join(DESKTOP_ROOT, 'out', 'renderer')
/** 产物挂载点：地址里要带 `out/renderer`，harness 才认得出主窗口 */
const MOUNT = '/out/renderer/'
const INDEX_PATH = `${MOUNT}index.html`

/** index.html 那一次请求怎么处置 */
export type IndexPolicy = 'serve' | 'hold' | 'drop'

/** 一次记下的请求 */
export interface RendererRequest {
  /** 路径（不含 query；hash 本来就不发给服务器） */
  path: string
  /** 到达时刻（Date.now()） */
  at: number
  /** 怎么处置的 */
  outcome: 'served' | 'held' | 'dropped' | 'not-found' | 'forbidden'
}

export interface RendererServer {
  /** 交给 `ELECTRON_RENDERER_URL` 的地址：`http://127.0.0.1:<port>/out/renderer/index.html` */
  url: string
  /** 之后的 index.html 请求按它处置；函数的参数是这是第几次 index.html 请求（从 1 起） */
  setIndexPolicy(policy: IndexPolicy | ((nth: number) => IndexPolicy)): void
  /** 全部请求（按到达顺序） */
  requests(): RendererRequest[]
  /** 只看 index.html 的请求（按到达顺序） */
  indexRequests(): RendererRequest[]
  close(): Promise<void>
}

/** 模块脚本必须是 JavaScript MIME，否则 Chromium 拒绝执行（白屏，React 永远不挂载） */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

/** `/out/renderer/<rel>` → 产物目录里的文件；越出产物目录（`..`、编码过的 `%2e%2e`）回 null */
function resolveAsset(pathname: string): string | null {
  if (!pathname.startsWith(MOUNT)) return null
  let rel: string
  try {
    rel = decodeURIComponent(pathname.slice(MOUNT.length))
  } catch {
    return null
  }
  if (rel.includes('\0')) return null
  const file = resolve(RENDERER_DIR, rel || 'index.html')
  return file === RENDERER_DIR || file.startsWith(RENDERER_DIR + sep) ? file : null
}

export async function startRendererServer(
  initial: IndexPolicy | ((nth: number) => IndexPolicy) = 'serve'
): Promise<RendererServer> {
  let policy = initial
  let indexSeen = 0
  const log: RendererRequest[] = []
  const sockets = new Set<Socket>()

  const serveFile = (res: ServerResponse, file: string): boolean => {
    try {
      if (!statSync(file).isFile()) return false
      const body = readFileSync(file)
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        // 不让 Chromium 缓存：每次加载 index.html 都得真的到服务器，请求计数才可信
        'Cache-Control': 'no-store'
      })
      res.end(body)
      return true
    } catch {
      return false
    }
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const record = (outcome: RendererRequest['outcome']): void =>
      void log.push({ path: pathname, at: Date.now(), outcome })

    if (pathname === INDEX_PATH || pathname === MOUNT) {
      indexSeen++
      const now = typeof policy === 'function' ? policy(indexSeen) : policy
      if (now === 'hold') {
        record('held')
        return // 永不回应；连接由客户端（重发时取消）或 close() 掐掉
      }
      if (now === 'drop') {
        record('dropped')
        req.socket.destroy()
        return
      }
    }

    const file = resolveAsset(pathname)
    if (!file) {
      record('forbidden')
      res.writeHead(403).end()
      return
    }
    if (serveFile(res, file)) {
      record('served')
      return
    }
    record('not-found')
    res.writeHead(404).end()
  }

  const server = createServer(handle)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}${INDEX_PATH}`,
    setIndexPolicy(next) {
      policy = next
    },
    requests: () => [...log],
    indexRequests: () => log.filter((r) => r.path === INDEX_PATH || r.path === MOUNT),
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections()
        server.close(() => resolveClose())
      })
  }
}
