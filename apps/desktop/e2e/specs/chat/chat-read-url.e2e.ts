/**
 * `read` 读 http(s) 地址 —— 单测（urlFetch / read / readPageRenderer）把 Electron 的网络栈和窗口都替身掉了，这里走它们替身掉的那几段：
 * 真的 `shuvix-read-url` 内存 session 发出去的请求长什么样（服务器这边记下每个头）、真的隐藏窗口里跑页面的脚本、窗口有没有被看见、
 * 分区落没落盘、中止时窗口和连接有没有放掉。
 *
 * 一个真的 isolated 实例 + 脚本化的假提供商（每一轮：模型调 `read` → 收尾正文，按这一轮的提示词认领）+ 一个 127.0.0.1:0 的内联服务器。
 *
 *   E-1  第一次读：UA 里没有 Electron / ShuviX、Chrome 主版本与渲染进程的相同，带语言，没有 Cookie
 *   E-2  真的 GBK 页面（只有 meta 声明）不乱码
 *   E-3  JSON（地址是 .html）一个字节不改，converted=false，没开窗
 *   E-4  一直 403 的静态页：两次请求（Chrome UA、ShuviX UA）+ 一次渲染，工具行是失败的，错误只有一次前缀，正文不在错误里
 *   E-5  正文只由脚本写出来的 200 页面：结果里是脚本写的字；渲染窗口从没显示 / 聚焦、关了（E-8 前半）
 *   E-6  对请求回 403、对导航回正文（服务器按 Sec-Fetch-Mode 分）：结果是渲染出来的正文
 *   E-7  隐藏页面想开弹窗：服务器收不到弹窗的请求，没留下多余的窗口，也没交给系统打开
 *   E-8  整个 spec 的隐藏窗口都没显示、没聚焦、都关了，页面 target 回到起来时那一份
 *   E-9  响应体卡住时用户按停：这一轮落定，工具行是中止（不是 Failed to fetch URL），连接被放掉
 *   E-10 302 到 file:///etc/hosts、隐藏页面里 302 / 脚本跳到本地文件：失败，文件内容哪儿都没有
 *   E-11 渲染中途用户按停：很快落定，工具行是中止，窗口关了
 *   E-12 先发 cookie 再跳回自己的站点：第二次带着 cookie，读得到（credentials: include）
 *   E-13 服务器不存在（连接被拒）：错误里有原因
 *   E-14 `Partitions/shuvix-read-url` 不在 userData 下（内存分区）；整个 spec 没有未捕获异常、没弹原生框
 *
 * 弹框、打印、下载、mailto 不进 e2e（守卫一旦回退，那些会在开发者屏幕上弹出系统界面）—— 由单测覆盖。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listTargets, until } from '../../harness/cdp'
import {
  startFakeProvider,
  userTextsOf,
  type FakeProvider,
  type FakeRequest
} from '../../harness/fakeProvider'
import {
  launchApp,
  uncaughtExceptions,
  windowEvents,
  windowsOf,
  type E2EApp,
  type WindowHistory
} from '../../harness/launch'
import { nativeDialogRequests } from '../../harness/networkFixtures'
import { externalOpens } from '../../harness/providerOAuthFixtures'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'
import { syncProbe, toolResultsIn, type SyncProbe, type ToolResult } from '../../harness/sync'

const MODEL = 'e2e-model'
const USAGE = { prompt: 120, completion: 8 }
const IT_TIMEOUT = 120_000
const RUN_TIMEOUT = 60_000
const JS_TEXT = 'JS-ADDED-TEXT'
const NAV_TEXT = 'NAV-ONLY-TEXT'
const STATIC_MARKER = 'STATIC-403-BODY'
/** GBK 的「中文」 */
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])

interface Hit {
  method: string
  path: string
  headers: IncomingHttpHeaders
}

let app: E2EApp
let provider: FakeProvider
let probe: SyncProbe
let server: Server
let origin = ''
let seq = 0
/** 起来时已有的窗口与页面 target：结束时要回到这一份 */
let baselineWindows = new Set<number>()
let baselineTargets: string[] = []

const hits: Hit[] = []
const sockets = new Set<Socket>()
/** 卡住的响应：对方放弃时记一笔 */
const closedByClient = new Set<string>()

const hitsOf = (path: string): Hit[] => hits.filter((h) => h.path === path)
const isNavigation = (headers: IncomingHttpHeaders): boolean =>
  headers['sec-fetch-mode'] === 'navigate'
const longText = (word: string): string => `${word} `.repeat(Math.ceil(600 / (word.length + 1)))
const htmlPage = (body: string): string =>
  `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`

function sendHtml(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}

function route(path: string, headers: IncomingHttpHeaders, res: ServerResponse): void {
  switch (path) {
    case '/plain':
      return sendHtml(res, htmlPage(`<p>${longText('plain')}</p>`))
    case '/gbk':
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        Buffer.concat([
          Buffer.from('<html><head><meta charset="gbk"><title>t</title></head><body><p>'),
          GBK_ZHONGWEN,
          Buffer.from('</p></body></html>')
        ])
      )
      return
    case '/data.html':
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{\n\n  "a":   1\n}\n')
      return
    case '/blocked':
      return sendHtml(res, htmlPage(`<p>${STATIC_MARKER}</p>`), 403)
    case '/spa':
      return sendHtml(
        res,
        htmlPage(
          `<div id="root"></div><script>document.getElementById('root').innerHTML = '<p>${JS_TEXT}</p>'</script>`
        )
      )
    case '/nav-only':
      return isNavigation(headers)
        ? sendHtml(res, htmlPage(`<p>${longText(NAV_TEXT)}</p>`))
        : sendHtml(res, 'refused', 403)
    case '/popup-opener':
      return sendHtml(
        res,
        htmlPage(
          `<div id="root"></div><script>window.open('/popup-target');document.getElementById('root').textContent='opener done'</script>`
        )
      )
    case '/stall':
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
      res.on('close', () => closedByClient.add(path))
      return
    case '/to-file':
      res.writeHead(302, { location: 'file:///etc/hosts' })
      res.end()
      return
    case '/refused-to-file':
      if (!isNavigation(headers)) return sendHtml(res, 'refused', 403)
      res.writeHead(302, { location: 'file:///etc/hosts' })
      res.end()
      return
    case '/script-to-file':
      return sendHtml(
        res,
        htmlPage(`<div id="root"></div><script>location.href = 'file:///etc/hosts'</script>`)
      )
    case '/slow-render':
      if (!isNavigation(headers)) return sendHtml(res, 'refused', 403)
      // 字一直在变：不中止的话要等满预算（15s）
      return sendHtml(
        res,
        htmlPage(
          `<div id="root"></div><script>let n = 0; setInterval(() => { document.getElementById('root').textContent = 'x'.repeat(++n) }, 50)</script>`
        )
      )
    case '/cookie-loop':
      if (headers.cookie?.includes('passed=1')) {
        return sendHtml(res, htmlPage(`<p>${longText('cookie-accepted')}</p>`))
      }
      res.writeHead(302, { location: '/cookie-loop', 'set-cookie': 'passed=1; Path=/' })
      res.end()
      return
    default:
      res.writeHead(404)
      res.end()
  }
}

const newSession = (title: string): Promise<string> =>
  // 不是缺省标题：自动起标题不出场，请求只有这里脚本化的那些
  app.main.eval<string>(
    `window.api.session.create({ title: ${JSON.stringify(title)} }).then((s) => s.id)`
  )

/** 发出这一轮：模型调 `read(url)`，拿到结果后收尾 */
async function startRead(session: string, url: string): Promise<{ callId: string; done: string }> {
  const n = ++seq
  const marker = `READ-RUN-${n}: ${url}`
  const callId = `call_read_${n}`
  const done = `READ-DONE-${n}`
  const mine = (r: FakeRequest): boolean => userTextsOf(r).at(-1) === marker
  provider.script(
    {
      toolCalls: [{ id: callId, name: 'read', args: JSON.stringify({ path: url }) }],
      when: mine,
      usage: USAGE
    },
    { text: done, when: mine, usage: USAGE }
  )
  await app.main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: session, text: marker })}).catch(() => undefined), true)`
  )
  return { callId, done }
}

/** 跑一轮直到工具块落盘、这一轮落定；`read` 读地址不该问任何东西 */
async function runRead(url: string): Promise<ToolResult> {
  const session = await newSession(`read ${seq + 1}`)
  const { callId, done } = await startRead(session, url)
  const result = await until(
    async () => {
      const view = await probe.viewOf(session)
      if (!view) return null
      if (view.asks.length > 0) throw new Error(`unexpected ask: ${JSON.stringify(view.asks[0])}`)
      const tool = toolResultsIn(view.messages).find((t) => t.toolCallId === callId)
      const settled =
        view.run.state !== 'busy' &&
        view.messages.some((m) => m.role === 'assistant' && m.content.includes(done))
      return tool && settled ? tool : null
    },
    `read ${url} settled`,
    RUN_TIMEOUT
  )
  await probe.release(session)
  return result
}

/** 工具抛出恰好是 Aborted（单测钉着）时，durable 落盘的工具行就是这一句；抛别的文字会落成 Failed to fetch URL 的错误 */
const ABORTED_ROW = 'Tool read was aborted'
const abortedRow = (
  messages: Parameters<typeof toolResultsIn>[0],
  callId: string
): string | undefined => toolResultsIn(messages).find((t) => t.toolCallId === callId)?.result

/** 地址是 `path` 的那些隐藏窗口（`since` = windowEvents 的下标） */
function renderWindows(path: string, since = 0): WindowHistory[] {
  return windowsOf(windowEvents(app).slice(since)).filter((w) =>
    w.urls.some((u) => u.startsWith(origin) && new URL(u).pathname === path)
  )
}

function expectUnseen(w: WindowHistory): void {
  expect(w.created?.visible, `window ${w.id} created visible`).toBe(false)
  expect(w.created?.focusable, `window ${w.id} created focusable`).toBe(false)
  expect(w.shown, `window ${w.id} shown`).toBe(false)
  expect(w.focused, `window ${w.id} focused`).toBe(false)
}

const pageTargets = async (): Promise<string[]> =>
  (await listTargets(app.port))
    .filter((t) => t.type === 'page')
    .map((t) => t.webSocketDebuggerUrl)
    .sort()

/** /etc/hosts 里有内容的行：这些字样不能从任何一条结果里漏出来 */
const hostsLines = (): string[] =>
  readFileSync('/etc/hosts', 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

function expectNoHostsContent(text: string): void {
  for (const line of hostsLines()) expect(text).not.toContain(line)
}

beforeAll(async () => {
  provider = await startFakeProvider()
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    hits.push({ method: req.method ?? '', path, headers: req.headers })
    route(path, req.headers, res)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  app = await launchApp()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  probe = syncProbe(app.main)
  baselineWindows = new Set(windowsOf(windowEvents(app)).map((w) => w.id))
  baselineTargets = await pageTargets()
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
})

describe('read 读地址', () => {
  it(
    'E-1 第一次读：UA 像这个内置 Chromium 的 Chrome，带语言，没有 Cookie',
    async () => {
      const rendererUa = await app.main.eval<string>('navigator.userAgent')
      const major = /Chrome\/(\d+)/.exec(rendererUa)?.[1]
      expect(major).toBeTruthy()

      const tool = await runRead(`${origin}/plain`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toContain('plain plain')
      expect(tool.details).toMatchObject({ format: 'URL', converted: true })

      const [first, ...rest] = hitsOf('/plain')
      expect(rest).toEqual([])
      const ua = String(first.headers['user-agent'])
      expect(ua).toContain(`Chrome/${major}.0.0.0`)
      expect(ua).not.toMatch(/Electron|ShuviX/i)
      expect(first.headers['accept']).toContain('text/html')
      expect(first.headers['accept-language']).toBeTruthy()
      expect(first.headers.cookie).toBeUndefined()
    },
    IT_TIMEOUT
  )

  it(
    'E-2 GBK 页面不乱码',
    async () => {
      const tool = await runRead(`${origin}/gbk`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toContain('中文')
      expect(tool.result).not.toContain('�')
    },
    IT_TIMEOUT
  )

  it(
    'E-3 JSON 一个字节不改，地址的扩展名不算数，没开窗',
    async () => {
      const since = windowEvents(app).length
      const tool = await runRead(`${origin}/data.html`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toBe(
        `URL: ${origin}/data.html (application/json)\n\n{\n\n  "a":   1\n}\n`
      )
      expect(tool.details).toMatchObject({ converted: false })
      expect(
        windowEvents(app)
          .slice(since)
          .filter((e) => e.event === 'created')
      ).toEqual([])
    },
    IT_TIMEOUT
  )

  it(
    'E-4 一直 403 的静态页：两次请求 + 一次渲染，工具行失败',
    async () => {
      const tool = await runRead(`${origin}/blocked`)
      expect(tool.isError).toBe(true)
      expect(tool.result).toMatch(/^Failed to fetch URL: HTTP 403 from /)
      expect(tool.result.match(/Failed to fetch URL/g)).toHaveLength(1)
      expect(tool.result).toContain('refused')
      expect(tool.result).toContain('Calling read again will not help')
      expect(tool.result).toContain('browser tools')
      expect(tool.result).not.toContain(STATIC_MARKER)

      const seen = hitsOf('/blocked')
      expect(seen).toHaveLength(3)
      const uas = seen.map((h) => String(h.headers['user-agent']))
      expect(uas[0]).toMatch(/Chrome\/\d+\.0\.0\.0/)
      expect(uas[1]).toBe('Mozilla/5.0 (compatible; ShuviX/1.0)')
      expect(uas[2]).toMatch(/Chrome\/\d+\.0\.0\.0/)
      expect(uas[2]).not.toMatch(/Electron|ShuviX/i)
      // 前两次是请求，第三次才是页面导航
      expect(seen.map((h) => isNavigation(h.headers))).toEqual([false, false, true])

      await until(
        () => renderWindows('/blocked').every((w) => w.closed) || null,
        'render window closed'
      )
      expect(renderWindows('/blocked')).toHaveLength(1)
    },
    IT_TIMEOUT
  )

  it(
    'E-5 正文只由脚本写出来：结果里是脚本写的字，窗口没被看见',
    async () => {
      const since = windowEvents(app).length
      const tool = await runRead(`${origin}/spa`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toContain(JS_TEXT)
      // 脚本本身不进结果
      expect(tool.result).not.toContain('getElementById')
      expect(tool.details).toMatchObject({ converted: true })

      const wins = renderWindows('/spa', since)
      expect(wins).toHaveLength(1)
      expectUnseen(wins[0])
      await until(() => renderWindows('/spa', since)[0].closed || null, 'render window closed')
    },
    IT_TIMEOUT
  )

  it(
    'E-6 拒绝请求、只放行导航的页面：拿到渲染出来的正文',
    async () => {
      const tool = await runRead(`${origin}/nav-only`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toContain(NAV_TEXT)
      expect(tool.result).not.toContain('Note: the page returned very little text')
      const seen = hitsOf('/nav-only')
      expect(seen.map((h) => isNavigation(h.headers))).toEqual([false, false, true])
    },
    IT_TIMEOUT
  )

  it(
    'E-7 隐藏页面开弹窗：被拒，服务器收不到，也没交给系统',
    async () => {
      const opensBefore = externalOpens(app).length
      const tool = await runRead(`${origin}/popup-opener`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toContain('opener done')
      expect(hitsOf('/popup-target')).toEqual([])
      expect(externalOpens(app).length).toBe(opensBefore)
    },
    IT_TIMEOUT
  )

  it(
    'E-9 响应体卡住时用户按停：这一轮落定，工具行是中止，连接放掉',
    async () => {
      const session = await newSession('read stall')
      const { callId } = await startRead(session, `${origin}/stall`)
      await until(() => hitsOf('/stall').length > 0 || null, 'stalling request arrived')
      await app.main.eval(`window.api.agent.abort(${JSON.stringify(session)})`)

      const started = Date.now()
      const view = await probe.waitView(
        session,
        (v) => v.run.state !== 'busy',
        RUN_TIMEOUT,
        'run settled after abort'
      )
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(abortedRow(view.messages, callId)).toBe(ABORTED_ROW)
      await until(() => closedByClient.has('/stall') || null, 'connection released')
      await probe.release(session)
    },
    IT_TIMEOUT
  )

  it.each([
    ['直接请求 302 到本地文件', '/to-file', /^Failed to fetch URL: /],
    [
      '隐藏页面 302 到本地文件',
      '/refused-to-file',
      /^Failed to fetch URL: HTTP 403 from .*refused/
    ],
    [
      '隐藏页面的脚本跳到本地文件',
      '/script-to-file',
      /^Failed to fetch URL: the page at .* has no readable text/
    ]
  ])(
    'E-10 %s：失败，文件内容哪儿都没有',
    async (_name, path, message) => {
      const tool = await runRead(`${origin}${path}`)
      expect(tool.isError, tool.result).toBe(true)
      expect(tool.result).toMatch(message)
      expectNoHostsContent(tool.result)
    },
    IT_TIMEOUT
  )

  it(
    'E-11 渲染中途用户按停：很快落定，工具行是中止，窗口关了',
    async () => {
      const session = await newSession('read render stop')
      const { callId } = await startRead(session, `${origin}/slow-render`)
      await until(
        () => hitsOf('/slow-render').some((h) => isNavigation(h.headers)) || null,
        'render navigation arrived'
      )
      await app.main.eval(`window.api.agent.abort(${JSON.stringify(session)})`)

      const started = Date.now()
      const view = await probe.waitView(
        session,
        (v) => v.run.state !== 'busy',
        RUN_TIMEOUT,
        'run settled after abort'
      )
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(abortedRow(view.messages, callId)).toBe(ABORTED_ROW)
      await until(
        () => renderWindows('/slow-render').every((w) => w.closed) || null,
        'render window closed'
      )
      await probe.release(session)
    },
    IT_TIMEOUT
  )

  it(
    'E-12 先发 cookie 再跳回自己：第二次带着 cookie，读得到',
    async () => {
      const tool = await runRead(`${origin}/cookie-loop`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toContain('cookie-accepted')
      const seen = hitsOf('/cookie-loop')
      expect(seen[0].headers.cookie).toBeUndefined()
      expect(seen[1].headers.cookie).toContain('passed=1')
    },
    IT_TIMEOUT
  )

  it(
    'E-13 连接被拒：错误里有原因，不渲染',
    async () => {
      const since = windowEvents(app).length
      // 占一个端口再放掉：这个端口上一定没人听
      const probeServer = createServer()
      await new Promise<void>((resolve) => probeServer.listen(0, '127.0.0.1', resolve))
      const { port } = probeServer.address() as AddressInfo
      await new Promise<void>((resolve) => probeServer.close(() => resolve()))

      const tool = await runRead(`http://127.0.0.1:${port}/x`)
      expect(tool.isError).toBe(true)
      expect(tool.result).toMatch(/^Failed to fetch URL: .*ERR_CONNECTION_REFUSED/)
      expect(
        windowEvents(app)
          .slice(since)
          .filter((e) => e.event === 'created')
      ).toEqual([])
    },
    IT_TIMEOUT
  )

  it(
    'E-8 整个 spec 的隐藏窗口：都没显示、没聚焦、都关了，页面 target 回到起来时那一份',
    async () => {
      const hidden = await until(() => {
        const list = windowsOf(windowEvents(app)).filter((w) => !baselineWindows.has(w.id))
        return list.every((w) => w.closed) ? list : null
      }, 'every hidden window closed')
      expect(hidden.length).toBeGreaterThanOrEqual(4)
      for (const w of hidden) expectUnseen(w)
      await until(async () => {
        const now = await pageTargets()
        return now.join('\n') === baselineTargets.join('\n') || null
      }, 'page targets back to the baseline')
    },
    IT_TIMEOUT
  )

  it('E-14 分区不落盘；没有未捕获异常、没弹原生框', () => {
    const partitions = join(app.userData, 'Partitions')
    expect(existsSync(join(partitions, 'shuvix-read-url'))).toBe(false)
    if (existsSync(partitions)) {
      expect(readdirSync(partitions).filter((d) => d.includes('read-url'))).toEqual([])
    }
    expect(uncaughtExceptions(app)).toBe('')
    expect(nativeDialogRequests(app)).toEqual([])
  })
})
