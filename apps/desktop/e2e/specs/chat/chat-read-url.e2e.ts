/**
 * `read` 读 http(s) 地址 —— 单测（urlFetch / read / readPageRenderer）把 Electron 的网络栈和窗口都替身掉了，这里走它们替身掉的那几段：
 * read 用的是内置浏览器的身份（2026-11-17）—— 真的 `persist:shuvix-browser` 分区发出去的请求长什么样（服务器这边记下每个头）、
 * 用户在内置浏览器里留下的 cookie 带没带上、真的隐藏窗口里跑页面的脚本、窗口有没有被看见、读过的地址进没进浏览历史、
 * 中止时窗口和连接有没有放掉。
 *
 * 一个真的 isolated 实例 + 脚本化的假提供商（每一轮：模型调 `read` → 收尾正文，按这一轮的提示词认领）+ 一个 127.0.0.1:0 的内联服务器。
 * 起来时先以用户的身份在内置浏览器里开一个 tab 去 `/id/set-login`（服务器发一个只对 `/id` 有效的 cookie）再关掉 —— 这就是
 * 「用户在内置浏览器里登录过」；那个 tab 的请求头里的 UA 就是内置浏览器的 UA。浏览器窗口从头到尾没打开（tab 住在停放窗口里）。
 *
 *   E-1  第一次读普通网页：一次请求 + 一次隐藏页面的导航，两次的 UA 都是内置浏览器的那个（与 tab 的相同；Chrome 的样子：
 *        主版本与内置 Chromium 的相同，没有 Electron / ShuviX）；没有 Cookie（这个站点路径上没登录过）；
 *        渲染窗口恰好一个、没被看见、关了；结果是页面本身，不带 note
 *   E-2  真的 GBK 页面（只有 meta 声明）不乱码
 *   E-3  JSON（地址是 .html）一个字节不改，converted=false，只有一次请求，没开窗
 *   E-4  一直 403 的静态页：两次请求（浏览器的 UA、ShuviX UA）+ 一次渲染，工具行是失败的，错误只有一次前缀，正文不在错误里，
 *        提示说的是去 ShuviX 的浏览器里登录 / 过验证
 *   E-5  正文只由脚本写出来的 200 页面：结果里是脚本写的字；渲染窗口从没显示 / 聚焦、关了（E-8 前半）
 *   E-6  对请求回 403、对导航回正文（服务器按 Sec-Fetch-Mode 分）：结果是渲染出来的正文
 *   E-7  隐藏页面想开弹窗：服务器收不到弹窗的请求，没留下多余的窗口，也没交给系统打开
 *   E-8  整个 spec 的隐藏窗口都没显示、没聚焦、都关了，页面 target 回到起来时那一份
 *   E-9  响应体卡住时用户按停：这一轮落定，工具行是中止（不是 Failed to fetch URL），连接被放掉
 *   E-10 302 到 file:///etc/hosts、隐藏页面里 302 / 脚本跳到本地文件：失败，文件内容哪儿都没有
 *   E-11 渲染中途用户按停：很快落定，工具行是中止，窗口关了
 *   E-12 先发 cookie 再跳回自己的站点：第二次带着 cookie，读得到（credentials: include）
 *   E-13 服务器不存在（连接被拒）：错误里有原因
 *   E-14 `Partitions/shuvix-read-url` 不在 userData 下；整个 spec 没有未捕获异常、没弹原生框
 *   E-15 用户在内置浏览器里登录过的站点：read 的请求带着那个 cookie、UA 与 tab 的相同，读到登录后才有的内容
 *   E-16 同上，但只有隐藏页面的导航拿得到正文：导航也带着 cookie、同一个 UA
 *   E-17 读过的地址进浏览历史：记在发起的会话名下、标题是页面的、不算用户的访问（地址栏建议的候选只看用户的访问数），
 *        没有开出 tab；用户自己那次访问照旧记在用户头上
 *   E-18 脚本把正文收起来的页面：用请求到的那份（渲染出来的字更少）
 *   E-20 JSON 也带着登录的 cookie，照样只请求一次、不开窗
 *
 * 弹框、打印、下载、mailto 不进 e2e（守卫一旦回退，那些会在开发者屏幕上弹出系统界面）—— 由单测覆盖。并发上限也只在单测里。
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
import { externalOpens } from '../../harness/providerOAuthFixtures'
import { browserTabs, closeBrowserTab, nativeDialogRequests } from '../../harness/networkFixtures'
import { seedFakeProvider, sqliteJson, waitRendererReady } from '../../harness/seed'
import { syncProbe, toolResultsIn, type SyncProbe, type ToolResult } from '../../harness/sync'

const MODEL = 'e2e-model'
const USAGE = { prompt: 120, completion: 8 }
const IT_TIMEOUT = 120_000
const RUN_TIMEOUT = 60_000
const JS_TEXT = 'JS-ADDED-TEXT'
const NAV_TEXT = 'NAV-ONLY-TEXT'
const STATIC_MARKER = 'STATIC-403-BODY'
const SIGNED_IN_TEXT = 'SIGNED-IN-TEXT'
const SIGNED_IN_NAV_TEXT = 'SIGNED-IN-NAV-TEXT'
const STATIC_FULL = 'STATIC-FULL'
const READ_TITLE = 'READ-TITLE'
const HISTORY_SESSION_TITLE = 'read history owner'
/** 「登录」的 cookie：只对 /id 下的路径有效，别的用例的请求不带它 */
const LOGIN_COOKIE = 'login=1'
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
/** 内置浏览器的 tab 发请求用的 UA（起来时那个「登录」的 tab 留下的） */
let browserUa = ''

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
    case '/id/set-login':
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `${LOGIN_COOKIE}; Path=/id`
      })
      res.end(htmlPage('<p>signed in</p>'))
      return
    case '/id/whoami':
      return headers.cookie?.includes(LOGIN_COOKIE)
        ? sendHtml(res, htmlPage(`<p>${longText(SIGNED_IN_TEXT)}</p>`))
        : sendHtml(res, 'sign in first', 403)
    case '/id/whoami-nav':
      return headers.cookie?.includes(LOGIN_COOKIE) && isNavigation(headers)
        ? sendHtml(res, htmlPage(`<p>${longText(SIGNED_IN_NAV_TEXT)}</p>`))
        : sendHtml(res, 'refused', 403)
    case '/id/data.json':
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"signedIn":true}')
      return
    case '/shrinks':
      // 请求到的那份有全文；脚本一跑就把正文换成一句短的
      return sendHtml(
        res,
        htmlPage(
          `<div id="root"><p>${longText(STATIC_FULL)}</p></div><script>document.getElementById('root').textContent = 'collapsed'</script>`
        )
      )
    case '/titled':
      return sendHtml(
        res,
        `<!doctype html><html><head><title>${READ_TITLE}</title></head><body><p>${longText('titled')}</p></body></html>`
      )
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

/** 跑一轮直到工具块落盘、这一轮落定；`read` 读地址不该问任何东西。`inSession` = 用这条会话（缺省新建一条） */
async function runRead(url: string, inSession?: string): Promise<ToolResult> {
  const session = inSession ?? (await newSession(`read ${seq + 1}`))
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

/** 浏览历史里这个地址的每一次访问（直接读库：历史记录页的 IPC 只认浏览器窗口，而这里不开它） */
interface VisitRow {
  title: string
  visitCount: number
  typedCount: number
  sessionId: string | null
}
const visitsOf = (url: string): VisitRow[] =>
  sqliteJson<VisitRow>(
    app.home,
    `SELECT u.title, u.visitCount, u.typedCount, v.sessionId
       FROM browser_history_visits v JOIN browser_history_urls u ON u.id = v.urlId
      WHERE u.url = '${url.replace(/'/g, "''")}' ORDER BY v.id`
  )

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

  // 用户在内置浏览器里「登录」：开一个 tab 去 /id/set-login，收到请求后关掉（浏览器窗口不打开，tab 住在停放窗口里）
  const loginTab = await app.main.eval<string>(
    `window.api.browserView.createTab(${JSON.stringify(`${origin}/id/set-login`)})`
  )
  const loginHit = await until(() => hitsOf('/id/set-login')[0] ?? null, 'login tab request')
  browserUa = String(loginHit.headers['user-agent'])
  await until(
    () => visitsOf(`${origin}/id/set-login`).length > 0 || null,
    'login visit recorded in history'
  )
  await closeBrowserTab(app, loginTab)
  await until(async () => (await browserTabs(app)).length === 0 || null, 'login tab closed')
  // 等页面 target 稳定下来再记基线（tab 的 target 关掉要一点时间）
  let lastTargets = ''
  await until(async () => {
    const now = (await pageTargets()).join('\n')
    const stable = now === lastTargets
    lastTargets = now
    return stable || null
  }, 'page targets settled')

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
    'E-1 第一次读普通网页：请求 + 隐藏页面各一次，UA 都是内置浏览器的那个（Chrome 的样子），没有 Cookie；窗口没被看见',
    async () => {
      // 内置浏览器分区的 UA 是 Chrome 的样子：主版本与内置 Chromium 的相同，没有 Electron / ShuviX
      const rendererUa = await app.main.eval<string>('navigator.userAgent')
      const major = /Chrome\/(\d+)/.exec(rendererUa)?.[1]
      expect(major).toBeTruthy()
      expect(browserUa).toContain(`Chrome/${major}.0.0.0`)
      expect(browserUa).not.toMatch(/Electron|ShuviX/i)
      const since = windowEvents(app).length
      const tool = await runRead(`${origin}/plain`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toContain('plain plain')
      expect(tool.result).not.toContain('Note: the page returned very little text')
      expect(tool.details).toMatchObject({ format: 'URL', converted: true })

      // 先直接请求，再在隐藏页面里载入一遍（网页总是渲染）
      const seen = hitsOf('/plain')
      expect(seen.map((h) => isNavigation(h.headers))).toEqual([false, true])
      for (const hit of seen) {
        expect(String(hit.headers['user-agent'])).toBe(browserUa)
        // 登录的 cookie 只对 /id 有效：这里什么 cookie 都没有
        expect(hit.headers.cookie).toBeUndefined()
      }
      expect(seen[0].headers['accept']).toContain('text/html')

      const wins = renderWindows('/plain', since)
      expect(wins).toHaveLength(1)
      expectUnseen(wins[0])
      await until(() => renderWindows('/plain', since)[0].closed || null, 'render window closed')
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
      expect(hitsOf('/data.html')).toHaveLength(1)
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
      expect(tool.result).toContain('Calling read again right now will not help')
      expect(tool.result).toContain("open this address in ShuviX's browser")
      expect(tool.result).not.toContain('browser tools')
      expect(tool.result).not.toContain(STATIC_MARKER)

      const seen = hitsOf('/blocked')
      expect(seen).toHaveLength(3)
      const uas = seen.map((h) => String(h.headers['user-agent']))
      expect(uas[0]).toBe(browserUa)
      expect(uas[1]).toBe('Mozilla/5.0 (compatible; ShuviX/1.0)')
      expect(uas[2]).toBe(browserUa)
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
    'E-15 用户在内置浏览器里登录过：read 的请求带着那个 cookie、同一个 UA，读到登录后的内容',
    async () => {
      const tool = await runRead(`${origin}/id/whoami`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toContain(SIGNED_IN_TEXT)

      const seen = hitsOf('/id/whoami')
      expect(seen.map((h) => isNavigation(h.headers))).toEqual([false, true])
      for (const hit of seen) {
        expect(hit.headers.cookie).toContain(LOGIN_COOKIE)
        expect(String(hit.headers['user-agent'])).toBe(browserUa)
      }
    },
    IT_TIMEOUT
  )

  it(
    'E-16 只有隐藏页面的导航拿得到正文：导航也带着登录的 cookie、同一个 UA，窗口没被看见',
    async () => {
      const since = windowEvents(app).length
      const tool = await runRead(`${origin}/id/whoami-nav`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toContain(SIGNED_IN_NAV_TEXT)

      const seen = hitsOf('/id/whoami-nav')
      expect(seen.map((h) => isNavigation(h.headers))).toEqual([false, false, true])
      const navigation = seen[2]
      expect(navigation.headers.cookie).toContain(LOGIN_COOKIE)
      expect(String(navigation.headers['user-agent'])).toBe(browserUa)
      // 直接请求也带着 cookie（被拒只因为不是导航）
      expect(seen[0].headers.cookie).toContain(LOGIN_COOKIE)

      const wins = renderWindows('/id/whoami-nav', since)
      expect(wins).toHaveLength(1)
      expectUnseen(wins[0])
    },
    IT_TIMEOUT
  )

  it(
    'E-17 读过的地址进浏览历史：记在这条会话名下、带页面标题、不算用户的访问；没有开出 tab',
    async () => {
      const session = await newSession(HISTORY_SESSION_TITLE)
      const url = `${origin}/titled`
      const tool = await runRead(url, session)
      expect(tool.isError, tool.result).toBe(false)

      const rows = await until(() => {
        const now = visitsOf(url)
        return now.length > 0 && now[0].title === READ_TITLE ? now : null
      }, 'read visit recorded with the page title')
      // 一次 read = 一次访问（请求和隐藏页面的导航不各记一次）
      expect(rows).toHaveLength(1)
      expect(rows[0].sessionId).toBe(session)
      // 地址栏建议的候选只取用户去过的（visitCount > 0）：agent 读的不算
      expect(rows[0].visitCount).toBe(0)
      expect(rows[0].typedCount).toBe(0)

      // 起来时用户自己开 tab 的那次：照旧记在用户头上
      const own = visitsOf(`${origin}/id/set-login`)
      expect(own).toHaveLength(1)
      expect(own[0].sessionId).toBeNull()
      expect(own[0].visitCount).toBe(1)

      // E-1 读过的普通网页：标题是页面自己的，不是隐藏页面起步那张空白页的
      const plain = visitsOf(`${origin}/plain`)
      expect(plain).toHaveLength(1)
      expect(plain[0].title).toBe('Fixture')
      expect(plain[0].sessionId).toBeTruthy()

      // JSON（不渲染）和一直 403 的也都记了一次，都在某条会话名下
      for (const path of ['/data.html', '/blocked']) {
        const visits = visitsOf(`${origin}${path}`)
        expect(visits, path).toHaveLength(1)
        expect(visits[0].sessionId, path).toBeTruthy()
        expect(visits[0].visitCount, path).toBe(0)
      }

      // read 不开 tab
      expect(await browserTabs(app)).toEqual([])
    },
    IT_TIMEOUT
  )

  it(
    'E-18 脚本把正文收起来的页面：渲染出来的字更少，用请求到的那份',
    async () => {
      const since = windowEvents(app).length
      const tool = await runRead(`${origin}/shrinks`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toContain(STATIC_FULL)
      expect(tool.result).not.toContain('collapsed')
      expect(tool.result).not.toContain('Note: the page returned very little text')

      expect(hitsOf('/shrinks').map((h) => isNavigation(h.headers))).toEqual([false, true])
      const wins = renderWindows('/shrinks', since)
      expect(wins).toHaveLength(1)
      expectUnseen(wins[0])
      await until(() => renderWindows('/shrinks', since)[0].closed || null, 'render window closed')
    },
    IT_TIMEOUT
  )

  it(
    'E-20 JSON 也带着登录的 cookie：只请求一次，不开窗',
    async () => {
      const since = windowEvents(app).length
      const tool = await runRead(`${origin}/id/data.json`)
      expect(tool.isError, tool.result).toBe(false)
      expect(tool.result).toBe(
        `URL: ${origin}/id/data.json (application/json)\n\n{"signedIn":true}`
      )
      const seen = hitsOf('/id/data.json')
      expect(seen).toHaveLength(1)
      expect(seen[0].headers.cookie).toContain(LOGIN_COOKIE)
      expect(String(seen[0].headers['user-agent'])).toBe(browserUa)
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
      // 每读一张网页就有一个隐藏窗口（JSON、连不上的那几次没有）
      expect(hidden.length).toBeGreaterThanOrEqual(12)
      for (const w of hidden) expectUnseen(w)
      await until(async () => {
        const now = await pageTargets()
        return now.join('\n') === baselineTargets.join('\n') || null
      }, 'page targets back to the baseline')
    },
    IT_TIMEOUT
  )

  it('E-14 shuvix-read-url 没落盘；没有未捕获异常、没弹原生框', () => {
    const partitions = join(app.userData, 'Partitions')
    expect(existsSync(join(partitions, 'shuvix-read-url'))).toBe(false)
    if (existsSync(partitions)) {
      expect(readdirSync(partitions).filter((d) => d.includes('read-url'))).toEqual([])
    }
    expect(uncaughtExceptions(app)).toBe('')
    expect(nativeDialogRequests(app)).toEqual([])
  })
})
