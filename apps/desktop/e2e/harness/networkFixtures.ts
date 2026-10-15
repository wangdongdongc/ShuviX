/**
 * 网络访问（server mode phase B / C）的 e2e 夹具 —— `specs/network/` 共用。
 *
 * 只放原始的网络与 IPC 小工具，不放任何 DOM 选择器（那些在 pages.ts：`webClientPane` / `networkSettingsPane`）：
 *
 *   networkStatus(main)         `window.api.network.status()`（主窗口的 IPC）
 *   privateIPv4Addresses()      spec 进程自己看到的私有 IPv4 网卡地址（服务在局域网共享时列出的应当恰是这些）
 *   httpProbe(opts)             一次普通 HTTP 请求：**永远连 127.0.0.1**（或显式给的 `connectHost`），只伪造 `Host` 头 ——
 *                               服务只绑 IPv4，`localhost` 在 macOS 上可能先解析成 ::1
 *   rawHttpProbe(port, text)    原样写一段请求报文（Node 的 http 客户端只会说 HTTP/1.1、总要带 Host）
 *   upgradeProbe(opts)          一次 WebSocket 升级握手（101 → 交出 socket，调用方要尽快 `destroy()`：服务端每 30s
 *                               ping 一次，不回 pong 的连接下一拍被断开）
 *   openWebClient(app, port)    在应用自己的浏览器里开一个 `http://127.0.0.1:<port>/` 的 tab，连上它的 DevTools，
 *                               等到 web 客户端的 `window.api` 真的连通、React 挂上
 *   wsInvokeInPage(page, …)     在 web 页面里**另开**一条 WebSocket（浏览器自己带 Origin），发原始的 invoke 帧，
 *                               只收对应 id 的结果帧（推送帧照样会来），然后关掉
 *   shellOpens(app)             实例交给系统文件管理器的路径（bootstrap.cjs 把 `shell.openPath` / `showItemInFolder`
 *                               换成了记录器：`openPath <路径>` / `showItemInFolder <路径>`，按顺序）
 *   nativeDialogRequests(app)   实例请求过的原生「打开文件」框（bootstrap.cjs 记的 `e2e-native-dialogs.log`，按顺序）
 *   httpStreamProbe(opts)       一次不等结束的 HTTP 请求（事件流）：正文满足条件就交出、断开
 *   evalWithGesture(page, expr) 带一次用户手势的 `Runtime.evaluate`（`window.open` / 合成点击开新标签页要它）
 *   browserTabs / waitBrowserTab / closeBrowserTab
 *                               应用浏览器里开着的 tab（主窗口的 `browserView.listTabs()`）；web 客户端开的新标签页按
 *                               地址认
 *
 * 零依赖：只用 Node 自带的 `node:http` / `node:net` / `node:crypto`。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { connectTabPage } from './browserFixtures'
import { until, type CdpClient } from './cdp'
import type { E2EApp, E2EAppBase } from './launch'
import { waitRendererReady } from './seed'

/** `network:status` 的回包（与 `src/shared/network.ts` 同形；e2e 按值钉住，不引产品代码） */
export interface NetworkClientInfo {
  id: string
  remoteAddress: string
  userAgent: string
  connectedAt: number
}

export interface NetworkStatus {
  enabled: boolean
  port: number
  /** 允许局域网里的其他设备（关 → 只监听 127.0.0.1） */
  lan: boolean
  /** 此刻监听的地址（`127.0.0.1` / `0.0.0.0`）；没在监听 → 没有 */
  bindAddress?: string
  listening: boolean
  addresses: string[]
  clients: NetworkClientInfo[]
  error?: string
  /** 无头运行 → true；桌面 → 没有 */
  headless?: true
}

/** 主窗口里读一次网络状态 */
export function networkStatus(main: CdpClient): Promise<NetworkStatus> {
  return main.eval<NetworkStatus>('window.api.network.status()')
}

/**
 * spec 进程自己看到的私有 IPv4 网卡地址（非内部；10/8、172.16/12、192.168/16、169.254/16；去重、按网卡顺序）——
 * 与服务在局域网共享时列出的应当相同。手写判断，不引产品的 guards.ts
 */
export function privateIPv4Addresses(): string[] {
  const out: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family as unknown
      if (entry.internal || (family !== 'IPv4' && family !== 4)) continue
      const [a, b] = entry.address.split('.').map(Number)
      const isPrivate =
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)
      if (isPrivate && !out.includes(entry.address)) out.push(entry.address)
    }
  }
  return out
}

/** 一次探测的结果：拿到了应答，或者连接层面的错误码（`ECONNREFUSED` / `ETIMEDOUT` …） */
export type HttpProbeResult =
  | { status: number; headers: IncomingHttpHeaders; body: Buffer; error?: undefined }
  | { error: string; status?: undefined; headers?: undefined; body?: undefined }

/** 探测的上限：本机回环上的一次请求，超过它就当作挂住了 */
const PROBE_TIMEOUT_MS = 8000

export interface HttpProbeOptions {
  port: number
  path?: string
  method?: string
  /** `Host` 头；不给 = `<connectHost>:<port>`；`null` = 不带 Host */
  host?: string | null
  /** 带一个 `Origin` 头 */
  origin?: string
  /** 真正连去的地址（缺省 127.0.0.1） */
  connectHost?: string
  /** 额外的请求头（`Range` …）；与上面两个同名时以上面为准 */
  headers?: Record<string, string>
}

/** 一次普通 HTTP 请求（`agent: false`：每次一条新连接，不复用） */
export function httpProbe(opts: HttpProbeOptions): Promise<HttpProbeResult> {
  const connectHost = opts.connectHost ?? '127.0.0.1'
  const host = opts.host === undefined ? `${connectHost}:${opts.port}` : opts.host
  const headers: Record<string, string> = { ...opts.headers }
  if (host !== null) headers.Host = host
  if (opts.origin !== undefined) headers.Origin = opts.origin
  return new Promise((resolve) => {
    let settled = false
    const done = (result: HttpProbeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const req = request(
      {
        host: connectHost,
        port: opts.port,
        path: opts.path ?? '/',
        method: opts.method ?? 'GET',
        agent: false,
        setHost: false,
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        )
        res.on('error', (error: NodeJS.ErrnoException) => done({ error: error.code ?? 'ERESET' }))
      }
    )
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      done({ error: 'ETIMEDOUT' })
      req.destroy()
    })
    req.on('error', (error: NodeJS.ErrnoException) => done({ error: error.code ?? error.message }))
    req.end()
  })
}

/** rawHttpProbe 的结果：状态码 + 报文头 + 正文，或连接层面的错误 */
export type RawHttpResult = { status: number; head: string; body: string } | { error: string }

/** 原样写一段请求报文，读到对端关掉为止；回状态码与正文（报文头之后的部分） */
export function rawHttpProbe(port: number, text: string): Promise<RawHttpResult> {
  return new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    const socket = netConnect({ host: '127.0.0.1', port })
    const done = (result: RawHttpResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    const finish = (): void => {
      const all = Buffer.concat(chunks).toString('utf8')
      const split = all.indexOf('\r\n\r\n')
      const head = split < 0 ? all : all.slice(0, split)
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(head)
      if (!match) {
        done({ error: `no status line: ${JSON.stringify(all.slice(0, 120))}` })
        return
      }
      done({ status: Number(match[1]), head, body: split < 0 ? '' : all.slice(split + 4) })
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done({ error: 'ETIMEDOUT' }))
    socket.on('connect', () => socket.write(text))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', finish)
    socket.on('close', finish)
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (chunks.length > 0) finish()
      else done({ error: error.code ?? error.message })
    })
  })
}

/** 升级握手的结果（`upgraded` 区分：成功才有 socket） */
export type UpgradeProbeResult =
  | { upgraded: true; status: 101; headers: IncomingHttpHeaders; socket: Socket }
  | { upgraded: false; status: number; body: string; headers: IncomingHttpHeaders }
  | { upgraded: false; error: string; status?: undefined }

export interface UpgradeProbeOptions {
  port: number
  path?: string
  /** `Host` 头；不给 = `127.0.0.1:<port>` */
  host?: string
  /** `Origin` 头；不给 = 恰好对的那个（`http://<host>`）；`null` = 不带 */
  origin?: string | null
  userAgent?: string
}

/**
 * 一次 WebSocket 升级握手。101 → `{status:101, socket}`（**调用方负责 `socket.destroy()`**）；被拒（服务端写了个
 * 普通应答）→ `{status, body}`；连接层面失败 → `{error}`
 */
export function upgradeProbe(opts: UpgradeProbeOptions): Promise<UpgradeProbeResult> {
  const host = opts.host ?? `127.0.0.1:${opts.port}`
  const origin = opts.origin === undefined ? `http://${host}` : opts.origin
  const headers: Record<string, string> = {
    Host: host,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64')
  }
  if (origin !== null) headers.Origin = origin
  if (opts.userAgent !== undefined) headers['User-Agent'] = opts.userAgent
  return new Promise((resolve) => {
    let settled = false
    const done = (result: UpgradeProbeResult): void => {
      if (settled) {
        if (result.upgraded) result.socket.destroy()
        return
      }
      settled = true
      resolve(result)
    }
    const req = request({
      host: '127.0.0.1',
      port: opts.port,
      path: opts.path ?? '/ws',
      method: 'GET',
      agent: false,
      setHost: false,
      headers
    })
    req.on('upgrade', (res, socket) => {
      socket.on('error', () => socket.destroy())
      done({ upgraded: true, status: 101, headers: res.headers, socket })
    })
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        done({
          upgraded: false,
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
      )
      res.on('error', (error: NodeJS.ErrnoException) =>
        done({ upgraded: false, error: error.code ?? 'ERESET' })
      )
    })
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      done({ upgraded: false, error: 'ETIMEDOUT' })
      req.destroy()
    })
    req.on('error', (error: NodeJS.ErrnoException) =>
      done({ upgraded: false, error: error.code ?? error.message })
    )
    req.end()
  })
}

/** 应用浏览器里开着的一个 web 客户端页面 */
export interface WebClientHandle {
  /** 那个页面的 DevTools 客户端 */
  page: CdpClient
  /** 浏览器 tab 的 id（`browserView.closeTab` 用） */
  tabId: string
  /** 页面地址（`http://127.0.0.1:<port>/`） */
  url: string
  /** 断开 DevTools、关掉 tab（不抛） */
  close(): Promise<void>
}

/**
 * 在应用自己的浏览器（没有 preload 的 WebContentsView）里开 web 客户端：
 * 建 tab → 按**完全相等**的地址连上它的 DevTools target → 等 `app.platform === 'web'` → 等一次 invoke 真的回来
 * （第一次连上之前的调用会排着，所以它回来就证明 socket 通了）→ 等 React 挂上
 */
export async function openWebClient(app: E2EApp, port: number): Promise<WebClientHandle> {
  const url = `http://127.0.0.1:${port}/`
  const tabId = await app.main.eval<string>(
    `window.api.browserView.createTab(${JSON.stringify(url)})`
  )
  let page: CdpClient | undefined
  try {
    page = await until(
      () => connectTabPage(app.port, (u) => u === url),
      `web client page target ${url}`
    )
    const client = page
    await until(
      () => client.eval<boolean>(`window.api?.app?.platform === 'web'`),
      'web client window.api (platform web)'
    )
    await client.eval('window.api.app.getVersion()')
    await waitRendererReady(client)
  } catch (error) {
    page?.close()
    await app.main
      .eval(`window.api.browserView.closeTab(${JSON.stringify(tabId)})`)
      .catch(() => undefined)
    throw error
  }
  const opened = page
  return {
    page: opened,
    tabId,
    url,
    close: async () => {
      try {
        opened.close()
      } catch {
        /* 已经关了 */
      }
      await app.main
        .eval(`window.api.browserView.closeTab(${JSON.stringify(tabId)})`)
        .catch(() => undefined)
    }
  }
}

/** 一条原始 invoke（`args` 原样 JSON 编码；不要放 undefined） */
export interface RawInvoke {
  id: number
  channel: string
  args: unknown[]
}

/** 一条原样发出的文本帧，等的是 id 为 `id` 的结果 */
export interface RawFrame {
  id: number
  text: string
}

/** 结果帧（原样） */
export interface ResultFrame {
  t: 'result'
  id: number
  ok: boolean
  value?: unknown
  error?: { message: string; code?: string }
}

/**
 * 在 web 页面里另开一条 WebSocket（`ws://<location.host>/ws`，浏览器自己带 Origin = 页面的 origin），把 `calls`
 * 编成 `{t:'invoke', id, channel, args}`、`frames` 原样发出，只收 `t === 'result'` 且 id 对得上的帧，收齐（或 8s
 * 到点）后关掉 socket。回的结果按 `calls` 再 `frames` 的顺序，没等到的那一项是 null
 */
export function wsInvokeInPage(
  page: CdpClient,
  calls: RawInvoke[],
  frames: RawFrame[] = []
): Promise<Array<ResultFrame | null>> {
  const texts = [
    ...calls.map((c) => ({
      id: c.id,
      text: JSON.stringify({ t: 'invoke', id: c.id, channel: c.channel, args: c.args })
    })),
    ...frames
  ]
  return page.eval<Array<ResultFrame | null>>(`new Promise((resolve, reject) => {
    const texts = ${JSON.stringify(texts)}
    const results = new Map()
    const ws = new WebSocket('ws://' + location.host + '/ws')
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve(texts.map((t) => results.get(t.id) ?? null))
    }
    const timer = setTimeout(finish, 8000)
    ws.onopen = () => { for (const t of texts) ws.send(t.text) }
    ws.onmessage = (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (!msg || msg.t !== 'result' || !texts.some((t) => t.id === msg.id)) return
      results.set(msg.id, msg)
      if (results.size === texts.length) finish()
    }
    ws.onclose = (event) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('socket closed early: ' + event.code)) }
    }
  })`)
}

/** bootstrap.cjs 记「交给系统文件管理器」的文件名（在 userData 下） */
export const SHELL_OPEN_LOG = 'e2e-shell-open.log'

/** 实例交给系统文件管理器的路径（每行 `openPath <路径>` / `showItemInFolder <路径>`，按顺序）；一个都没有 → [] */
export function shellOpens(app: Pick<E2EAppBase, 'userData'>): string[] {
  const file = join(app.userData, SHELL_OPEN_LOG)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

/** bootstrap.cjs 记原生「打开文件」框请求的文件名（在 userData 下） */
export const NATIVE_DIALOG_LOG = 'e2e-native-dialogs.log'

/** 实例请求过的原生「打开文件」框（每行 `showOpenDialog <选项 JSON>`，按顺序）；一个都没有 → [] */
export function nativeDialogRequests(app: Pick<E2EAppBase, 'userData'>): string[] {
  const file = join(app.userData, NATIVE_DIALOG_LOG)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

/** httpStreamProbe 的结果：交出那一刻的状态、头与已收到的正文（`ended` = 对端已经结束了应答） */
export type HttpStreamProbeResult =
  | {
      status: number
      headers: IncomingHttpHeaders
      body: Buffer
      ended: boolean
      error?: undefined
    }
  | {
      error: string
      status?: undefined
      headers?: undefined
      body?: undefined
      ended?: undefined
    }

/**
 * 一次**不等应答结束**的请求 —— 事件流（`text/event-stream`）永远不结束，httpProbe 等它只会超时。
 * 头一到就开始看正文：`until(body)` 为真（或应答结束、或 8s 到点）就交出此刻收到的一切并断开连接。
 */
export function httpStreamProbe(
  opts: HttpProbeOptions & { until: (body: Buffer) => boolean }
): Promise<HttpStreamProbeResult> {
  const connectHost = opts.connectHost ?? '127.0.0.1'
  const host = opts.host === undefined ? `${connectHost}:${opts.port}` : opts.host
  const headers: Record<string, string> = { ...opts.headers }
  if (host !== null) headers.Host = host
  if (opts.origin !== undefined) headers.Origin = opts.origin
  return new Promise((resolve) => {
    let settled = false
    const req = request(
      {
        host: connectHost,
        port: opts.port,
        path: opts.path ?? '/',
        method: opts.method ?? 'GET',
        agent: false,
        setHost: false,
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        const deliver = (ended: boolean): void => {
          if (settled) return
          settled = true
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            ended
          })
          req.destroy()
        }
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          if (opts.until(Buffer.concat(chunks))) deliver(false)
        })
        res.on('end', () => deliver(true))
        res.on('error', () => deliver(false))
        req.setTimeout(PROBE_TIMEOUT_MS, () => deliver(false))
      }
    )
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      if (settled) return
      settled = true
      resolve({ error: 'ETIMEDOUT' })
      req.destroy()
    })
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      resolve({ error: error.code ?? error.message })
    })
    req.end()
  })
}

/**
 * 带一次用户手势执行一个表达式（`Runtime.evaluate` 的 `userGesture: true`，等 Promise、按值回）—— 页面里
 * `window.open` / 合成的 `el.click()` 开新标签页要它（与用户在页面上点一下等价）。页内异常抛错。
 */
export async function evalWithGesture<T = unknown>(
  page: CdpClient,
  expression: string
): Promise<T> {
  const r = await page.send<{ exceptionDetails?: unknown; result?: { value?: unknown } }>(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true }
  )
  if (r.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 800))
  }
  return r.result?.value as T
}

/** 应用浏览器里的一个 tab（`browserView.listTabs()` 的一行，只声明这里读的字段） */
export interface BrowserTab {
  id: string
  url: string
}

/** 应用浏览器里此刻开着的 tab（主窗口的 IPC） */
export function browserTabs(app: Pick<E2EApp, 'main'>): Promise<BrowserTab[]> {
  return app.main.eval<BrowserTab[]>(
    'window.api.browserView.listTabs().then((ts) => ts.map((t) => ({ id: t.id, url: t.url })))'
  )
}

/** 等应用浏览器里出现一个地址满足 `match` 的 tab（web 客户端经 `window.open` 开的新标签页） */
export function waitBrowserTab(
  app: Pick<E2EApp, 'main'>,
  match: (url: string) => boolean,
  what: string,
  timeoutMs?: number
): Promise<BrowserTab> {
  return until(
    async () => (await browserTabs(app)).find((t) => match(t.url)) ?? null,
    what,
    timeoutMs
  )
}

/** 关掉应用浏览器里的一个 tab（不抛） */
export async function closeBrowserTab(app: Pick<E2EApp, 'main'>, tabId: string): Promise<void> {
  await app.main
    .eval(`window.api.browserView.closeTab(${JSON.stringify(tabId)})`)
    .catch(() => undefined)
}
