/**
 * `widgetServer` 的组件 API 路由 `POST /w/<id>/api/<op>`、SQLite 组件没有 `/db/`、SSE 的 `data` 事件（设计稿 docs/widget-tool-design.md §9）。
 * 真的 `widgetServer` 单例（127.0.0.1 随机端口；模块加载时它向 widgetApi 订阅了 data 变化）；`../api/widgetApi` 换成 spy
 * （callWidgetOp、存储归属、onWidgetDataChanged 收下监听者、自己的 WidgetApiError），打包服务、widgetDb、logger 换成空壳。
 * 注册的组件：`book-shelf`（SQLite）与 `old-widget`（PGlite）。请求用 `node:http`（`agent:false`），默认带那个组件的 ui 令牌。
 *
 *   W-1 ui 令牌 + JSON 的 POST → 200 {result}；callWidgetOp(id, op, body, {kind:'user', label:'user'})；空 body / null → {}
 *   W-2 GET / PUT → 405；坏 JSON → 400 invalid_json；body 超过 4 MB → 400；都不调 callWidgetOp
 *   W-3 状态码：invalid_args 400；unknown_op / no_api 404；自定义码与 failed 422；internal / bad_output / too_large /
 *       out_of_memory 500；interrupted / host_* 503；timeout 504；正文 {error:{code,message}}；意外的抛错 → 500 internal，
 *       下一个请求照常
 *   W-4 没有 / 乱写 / 别的组件的令牌 → 403 JSON FORBIDDEN；
 *       没注册的组件 → 404
 *   W-5 SQLite 组件的 /db（任何方法）→ 404 NO_DB_ROUTE，不调 handleRestRequest；PGlite 组件的 /db 照旧
 *   W-6 监听者收到 A 的变化 → A 的 SSE 连接收到 `event: data\ndata: {"op":"addBook","source":"agent"}\n\n`，B 的什么都没有；
 *       不认识的 id 不抛；reload 事件照旧
 *   WC-S30 存储归属每个请求现读：同一个注册（不重新注册）从 pglite 换成 sqlite 之后，/db 从照常变成 404 NO_DB_ROUTE，
 *          /api 照常
 *   WC-S31 组件页面把自己那条 EventSource 挂在 `window.__shuvixEvents` 上（界面的 shuvix/widget 共用它，每页一条连接），
 *          它仍管 reload；页面只开这一条
 *   WT4-PV-10 preview 令牌（会话 s1）+ 快照里的读操作 + 判定放行 → 200；caller 是那条会话的 agent（actor/label preview），
 *       选项 {allowUiOnly, expectedMode:'read'}；判定拿到 (s1, read, id, op)
 *   WT4-PV-11 判定只放行读：写操作 → 403 not_authorized、不调 callWidgetOp；读操作 → 200
 *   WT4-PV-12 认得的操作 + preview 令牌不带会话 / 没注入判定 → 403 not_authorized；不带会话时判定不问
 *   WT4-PV-13 快照里没有这个操作 / 根本没有快照 → 判定不问，交给 callWidgetOp（没有 expectedMode），它的 404 原样回
 *   WT4-PV-14 ui 令牌调写操作、纯界面操作 → caller 用户、选项只有 allowUiOnly，不读快照、不问判定
 *   WT4-PV-10b 判了授权之后 callWidgetOp 报 changed（其间重新构建改了读写）→ 409 {error:{code:'changed'}}
 *   W-7a SSE 连上后（`:\n\n` 之后）第一条就是 `event: theme`，data 是注入的设置算出的那一份选择
 *   W-7b 设置读取换了值，发 settings.changed：keys 含三个主题键之一、或者 keys 不给 → A、B 的每条连接都恰好多一条
 *        theme（新的那份）；keys 是空数组 → 什么都没有
 *   W-7c keys 只有 general.language、别的事件类型 → 什么都没有
 *   W-7d dispose() 之后再发 → 不写、不抛（订阅退了）；重新起来后发一次 → 恰好一条（没有重复订阅）
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type DataChange = { widgetId: string; op: string; source: 'user' | 'agent' }

const h = vi.hoisted(() => {
  class WidgetApiError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
  return {
    WidgetApiError,
    /** 模块加载时 widgetServer 交给 onWidgetDataChanged 的监听者 */
    listeners: [] as Array<(c: DataChange) => void>,
    storage: {} as Record<string, 'sqlite' | 'pglite'>,
    callWidgetOp: vi.fn(
      async (
        _id: string,
        _op: string,
        _args: unknown,
        _caller: unknown,
        _options?: unknown
      ): Promise<unknown> => ({
        op: 'addBook',
        mode: 'write',
        result: { outcome: { ok: true, value: { id: 1 } }, wrote: true, logs: [] }
      })
    ),
    /** readApiSnapshot 的返回（预览令牌按它判读 / 写）；null = 没有快照 */
    snapshot: null as null | {
      ops: Array<{ name: string; mode: 'read' | 'write'; agent?: boolean }>
    },
    readApiSnapshot: vi.fn((_id: string): unknown => null),
    handleRestRequest: vi.fn(async () => ({ rows: [{ a: 1 }] as unknown[] })),
    build: vi.fn(async () => ({ success: true, outputJS: 'js', outputCSS: 'css' }))
  }
})

vi.mock('../api/widgetApi', () => ({
  callWidgetOp: h.callWidgetOp,
  onWidgetDataChanged: (fn: (c: DataChange) => void) => {
    h.listeners.push(fn)
    return () => {}
  },
  readApiSnapshot: h.readApiSnapshot,
  WidgetApiError: h.WidgetApiError,
  widgetStorageOf: (id: string) => h.storage[id] ?? 'pglite'
}))
vi.mock('../../bundler', () => ({
  bundlerService: { build: h.build },
  bundlerResourcePath: (p: string) => p
}))
vi.mock('../widgetDb', () => ({
  handleRestRequest: h.handleRestRequest,
  WidgetDbError: class WidgetDbError extends Error {}
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { setWidgetPreviewJudge, widgetServer } from '../widgetServer'
import { issueWidgetToken, WIDGET_TOKEN_HEADER } from '../widgetToken'
import { setWidgetThemeReader, type WidgetThemeSettings } from '../widgetTheme'
import { appEventBus } from '../../../utils/appEventBus'

const A = 'book-shelf'
const B = 'other-shelf'
const OLD = 'old-widget'

let tmp = ''
let port = 0

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
  json: unknown
}

function http(
  path: string,
  options: {
    method?: string
    body?: string | Buffer
    /** 缺省 = 路径里那个组件的 ui 令牌；null = 不带 */
    token?: string | null
    headers?: Record<string, string>
  } = {}
): Promise<HttpResult> {
  const widgetId = path.match(/^\/w\/([^/]+)/)?.[1]
  const token =
    options.token === undefined
      ? widgetId
        ? issueWidgetToken(widgetId, 'ui')
        : null
      : options.token
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          ...(token === null ? {} : { [WIDGET_TOKEN_HEADER]: token }),
          ...options.headers
        },
        agent: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          let json: unknown = undefined
          try {
            json = JSON.parse(body)
          } catch {
            // 不是 JSON
          }
          done({ status: res.statusCode ?? 0, headers: res.headers, body, json })
        })
        res.on('error', fail)
      }
    )
    req.on('error', fail)
    req.end(options.body)
  })
}

/** 打开一条 SSE 连接：收到的文本累加在 `text()` 里；`close()` 断开 */
async function openSse(
  id: string
): Promise<{ text: () => string; waitFor: (s: string) => Promise<void>; close: () => void }> {
  let text = ''
  let req: ClientRequest | null = null
  const waiters: Array<() => void> = []
  const res = await new Promise<IncomingMessage>((done, fail) => {
    req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: `/w/${id}/sse`,
        headers: { host: `127.0.0.1:${port}`, [WIDGET_TOKEN_HEADER]: issueWidgetToken(id, 'ui') },
        agent: false
      },
      done
    )
    req.on('error', () => {})
    req.once('error', fail)
    req.end()
  })
  expect(res.statusCode).toBe(200)
  res.setEncoding('utf8')
  res.on('data', (c: string) => {
    text += c
    for (const w of waiters.splice(0)) w()
  })
  res.on('error', () => {})
  const waitFor = async (s: string): Promise<void> => {
    const deadline = Date.now() + 3000
    while (!text.includes(s)) {
      if (Date.now() > deadline) throw new Error(`SSE never got ${JSON.stringify(s)}: ${text}`)
      await new Promise<void>((r) => {
        waiters.push(r)
        setTimeout(r, 50)
      })
    }
  }
  await waitFor(':\n\n')
  return { text: () => text, waitFor, close: () => (req as ClientRequest | null)?.destroy() }
}

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms))

const outcomeError = (code: string, message = `msg for ${code}`): unknown => ({
  op: 'addBook',
  mode: 'write',
  result: { outcome: { ok: false, error: { code, message } }, wrote: false, logs: [] }
})

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-widget-server-api-'))
  writeFileSync(join(tmp, 'index.tsx'), 'export {}')
  h.storage = { [A]: 'sqlite', [B]: 'sqlite', [OLD]: 'pglite' }
  h.callWidgetOp.mockClear()
  h.handleRestRequest.mockClear()
  h.snapshot = null
  h.readApiSnapshot.mockReset().mockImplementation(() => h.snapshot)
  await widgetServer.registerAndBuild(A, tmp, 'index.tsx')
  await widgetServer.registerAndBuild(B, tmp, 'index.tsx')
  await widgetServer.registerAndBuild(OLD, tmp, 'index.tsx')
  port = widgetServer.getStatus().port
})

afterEach(() => {
  widgetServer.dispose()
  setWidgetPreviewJudge(null)
  setWidgetThemeReader(null)
  rmSync(tmp, { recursive: true, force: true })
})

// ────────────────────────────── W-1 ──────────────────────────────

describe('W-1 调用一个操作', () => {
  it('W-1 ui 令牌 + JSON → 200 {result}；callWidgetOp(id, op, body, 用户)', async () => {
    const res = await http(`/w/${A}/api/addBook`, { body: JSON.stringify({ title: 'Dune', n: 2 }) })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(res.json).toEqual({ result: { id: 1 } })
    expect(h.callWidgetOp.mock.calls).toEqual([
      [
        A,
        'addBook',
        { title: 'Dune', n: 2 },
        { kind: 'user', label: 'user' },
        { allowUiOnly: true }
      ]
    ])
  })

  it.each([
    ['空 body', undefined],
    ['空白 body', '  \n '],
    ['null', 'null']
  ])('W-1 %s → args {}', async (_l, body) => {
    const res = await http(`/w/${A}/api/listBooks`, { body })
    expect(res.status).toBe(200)
    expect(h.callWidgetOp.mock.calls[0][2]).toEqual({})
  })

  it('W-1 返回值是 null / 数组也原样包在 result 里', async () => {
    h.callWidgetOp.mockResolvedValueOnce({
      op: 'x',
      mode: 'read',
      result: { outcome: { ok: true, value: null }, wrote: false, logs: [] }
    })
    expect((await http(`/w/${A}/api/x`)).json).toEqual({ result: null })
    h.callWidgetOp.mockResolvedValueOnce({
      op: 'x',
      mode: 'read',
      result: { outcome: { ok: true, value: [1, 'a'] }, wrote: false, logs: ['log line'] }
    })
    // 日志不给界面
    expect((await http(`/w/${A}/api/x`)).json).toEqual({ result: [1, 'a'] })
  })
})

// ────────────────────────────── W-2 ──────────────────────────────

describe('W-2 方法与请求体', () => {
  it.each(['GET', 'PUT', 'PATCH', 'DELETE'])('W-2 %s → 405 method_not_allowed', async (method) => {
    const res = await http(`/w/${A}/api/addBook`, {
      method,
      body: method === 'GET' ? undefined : '{}'
    })
    expect(res.status).toBe(405)
    expect(res.json).toEqual({
      error: { code: 'method_not_allowed', message: 'Call a widget operation with POST.' }
    })
    expect(h.callWidgetOp).not.toHaveBeenCalled()
  })

  it.each(['{bad', '{"a":', "{'a':1}", 'undefined'])(
    'W-2 坏 JSON %j → 400 invalid_json',
    async (body) => {
      const res = await http(`/w/${A}/api/addBook`, { body })
      expect(res.status).toBe(400)
      const err = (res.json as { error: { code: string; message: string } }).error
      expect(err.code).toBe('invalid_json')
      expect(err.message).toMatch(/^Invalid JSON: /)
      expect(h.callWidgetOp).not.toHaveBeenCalled()
    }
  )

  it('W-2 body 超过 4 MB → 400，不调 callWidgetOp', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(4 * 1024 * 1024 + 10) })
    const res = await http(`/w/${A}/api/addBook`, { body: big }).catch((e: Error) => e)
    expect(res).not.toBeInstanceOf(Error)
    const r = res as HttpResult
    expect(r.status).toBe(400)
    expect((r.json as { error: { code: string; message: string } }).error).toEqual({
      code: 'invalid_json',
      message: `Request body too large (> ${4 * 1024 * 1024} bytes)`
    })
    expect(h.callWidgetOp).not.toHaveBeenCalled()
  })

  it('W-2 正好 4 MB 以内的 body 照常', async () => {
    const value = 'x'.repeat(4 * 1024 * 1024 - 20)
    const res = await http(`/w/${A}/api/addBook`, { body: JSON.stringify({ v: value }) })
    expect(res.status).toBe(200)
    expect((h.callWidgetOp.mock.calls[0][2] as { v: string }).v).toHaveLength(value.length)
  })
})

// ────────────────────────────── W-3 ──────────────────────────────

describe('W-3 错误的状态码', () => {
  const table: Array<[string, number]> = [
    ['invalid_args', 400],
    ['unknown_op', 404],
    ['no_api', 404],
    ['not_found', 422],
    ['out_of_stock', 422],
    ['failed', 422],
    ['sql_refused', 422],
    ['internal', 500],
    ['bad_output', 500],
    ['too_large', 500],
    ['out_of_memory', 500],
    ['interrupted', 503],
    ['host_exited', 503],
    ['host_unavailable', 503],
    ['host_stopped', 503],
    ['timeout', 504]
  ]

  it.each(table)('W-3 结果里的错误 %s → %i，正文 {error:{code,message}}', async (code, status) => {
    h.callWidgetOp.mockResolvedValueOnce(outcomeError(code))
    const res = await http(`/w/${A}/api/addBook`, { body: '{}' })
    expect(res.status).toBe(status)
    expect(res.json).toEqual({ error: { code, message: `msg for ${code}` } })
  })

  it.each(table)(
    'W-3 抛出的 WidgetApiError %s → %i，正文 {error:{code,message}}',
    async (code, status) => {
      h.callWidgetOp.mockRejectedValueOnce(new h.WidgetApiError(code, `thrown ${code}`))
      const res = await http(`/w/${A}/api/addBook`, { body: '{}' })
      expect(res.status).toBe(status)
      expect(res.json).toEqual({ error: { code, message: `thrown ${code}` } })
    }
  )

  it('W-3 意外的抛错 → 500 internal；下一个请求照常', async () => {
    h.callWidgetOp.mockRejectedValueOnce(new TypeError('kaboom'))
    const res = await http(`/w/${A}/api/addBook`, { body: '{}' })
    expect(res.status).toBe(500)
    expect(res.json).toEqual({ error: { code: 'internal', message: 'kaboom' } })

    const next = await http(`/w/${A}/api/addBook`, { body: '{}' })
    expect(next.status).toBe(200)
    expect(next.json).toEqual({ result: { id: 1 } })
  })
})

// ────────────────────────────── W-4 ──────────────────────────────

describe('W-4 令牌与注册', () => {
  it.each<[string, string | null]>([
    ['没有令牌', null],
    ['空令牌', ''],
    ['乱写的令牌', 'garbage.token'],
    ['别的组件的令牌', issueWidgetToken(B, 'ui')],
    ['别的组件的预览令牌', issueWidgetToken(B, 'preview', 's1')]
  ])('W-4 %s → 403 JSON FORBIDDEN，不调 callWidgetOp', async (_l, token) => {
    const res = await http(`/w/${A}/api/addBook`, { token, body: '{}' })
    expect(res.status).toBe(403)
    expect((res.json as { code: string }).code).toBe('FORBIDDEN')
    expect(typeof (res.json as { message: unknown }).message).toBe('string')
    expect(h.callWidgetOp).not.toHaveBeenCalled()
  })

  it('W-4 ui 令牌 → caller {kind:user, label:user}（没有 actor / sessionId）', async () => {
    await http(`/w/${A}/api/addBook`, { body: '{}' })
    expect(h.callWidgetOp.mock.calls[0][3]).toStrictEqual({ kind: 'user', label: 'user' })
  })

  it('W-4 没注册的组件（带它自己的令牌）→ 404，不调 callWidgetOp', async () => {
    const res = await http('/w/never-registered/api/addBook', { body: '{}' })
    expect(res.status).toBe(404)
    expect(res.body).toBe('Widget never-registered not registered')
    expect(h.callWidgetOp).not.toHaveBeenCalled()
  })
})

// ────────────────────────────── W-5 ──────────────────────────────

describe('W-5 SQLite 组件没有 /db', () => {
  it.each(['GET', 'POST', 'PATCH', 'DELETE', 'PUT'])(
    'W-5 SQLite 组件的 /db（%s）→ 404 NO_DB_ROUTE，不调 handleRestRequest',
    async (method) => {
      const res = await http(`/w/${A}/db/books?select=*`, {
        method,
        body: method === 'GET' ? undefined : '{}'
      })
      expect(res.status).toBe(404)
      expect(res.json).toEqual({
        code: 'NO_DB_ROUTE',
        message: `This widget keeps its data in SQLite and has no /db route; call its API at /w/${A}/api/<operation>.`
      })
      expect(h.handleRestRequest).not.toHaveBeenCalled()
    }
  )

  it('W-5 PGlite 组件的 /db 照旧（200 rows，handleRestRequest 收到请求）', async () => {
    const res = await http(`/w/${OLD}/db/books?select=*`, { method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.json).toEqual([{ a: 1 }])
    expect(h.handleRestRequest).toHaveBeenCalledTimes(1)
    expect(h.handleRestRequest.mock.calls[0]).toMatchObject([
      { widgetId: OLD, table: 'books', method: 'GET' }
    ])
  })
})

// ────────────────────────────── W-6 ──────────────────────────────

describe('W-6 SSE 的 data 事件', () => {
  it('W-6 只有一个监听者（模块加载时订阅）', () => {
    expect(h.listeners).toHaveLength(1)
  })

  it('W-6 A 的变化 → A 的每条 SSE 连接都收到 data 事件；B 的什么都没有', async () => {
    const a1 = await openSse(A)
    const a2 = await openSse(A)
    const b = await openSse(B)
    try {
      h.listeners[0]({ widgetId: A, op: 'addBook', source: 'agent' })
      const expected = 'event: data\ndata: {"op":"addBook","source":"agent"}\n\n'
      await a1.waitFor(expected)
      await a2.waitFor(expected)
      await tick()
      // 连上时先来一条 theme（此刻的主题选择；单测没注入设置读取 = 默认那一对）
      const theme =
        'event: theme\ndata: {"mode":"dark","light":"github-light","dark":"github-dark"}\n\n'
      expect(a1.text()).toBe(':\n\n' + theme + expected)
      expect(b.text()).toBe(':\n\n' + theme)
    } finally {
      a1.close()
      a2.close()
      b.close()
    }
  })

  it('W-6 来源是用户 → source user', async () => {
    const a = await openSse(A)
    try {
      h.listeners[0]({ widgetId: A, op: 'saveLayout', source: 'user' })
      await a.waitFor('event: data\ndata: {"op":"saveLayout","source":"user"}\n\n')
    } finally {
      a.close()
    }
  })

  it('W-6 不认识的 id（没注册 / 已注销）→ 不抛', async () => {
    expect(() => h.listeners[0]({ widgetId: 'nobody-here', op: 'x', source: 'user' })).not.toThrow()
    widgetServer.unregisterWidget(B)
    expect(() => h.listeners[0]({ widgetId: B, op: 'x', source: 'user' })).not.toThrow()
  })

  it('W-6 reload 事件照旧（rebuild → event: reload）', async () => {
    const a = await openSse(A)
    try {
      await widgetServer.rebuild(A)
      await a.waitFor('event: reload\ndata: ok\n\n')
      expect(a.text()).not.toContain('event: data')
    } finally {
      a.close()
    }
  })
})

// ────────────────────────────── W-7 ──────────────────────────────

describe('W-7 SSE 的 theme 事件', () => {
  type Sse = Awaited<ReturnType<typeof openSse>>
  let settings: WidgetThemeSettings
  const themeEvent = (state: object): string => `event: theme\ndata: ${JSON.stringify(state)}\n\n`
  const themesIn = (text: string): number => text.split('event: theme\n').length - 1
  /** 一条连接上最后一条 theme 的 data */
  const lastTheme = (text: string): unknown => {
    const parts = text.split('event: theme\ndata: ')
    return JSON.parse(parts[parts.length - 1].split('\n')[0])
  }
  /** 等每条连接都收到第 n 条 theme，再等一会儿确认没有多的 */
  async function eachHas(streams: Sse[], n: number): Promise<void> {
    for (const s of streams) {
      const deadline = Date.now() + 3000
      while (themesIn(s.text()) < n) {
        if (Date.now() > deadline) throw new Error(`stream never got theme #${n}: ${s.text()}`)
        await tick(10)
      }
    }
    await tick(80)
    for (const s of streams) expect(themesIn(s.text())).toBe(n)
  }

  beforeEach(() => {
    settings = { mode: 'system', light: 'one-light', dark: 'nord' }
    setWidgetThemeReader(() => settings)
  })

  it('W-7a 连上后第一条就是 theme，带着设置那一份', async () => {
    const a = await openSse(A)
    try {
      const expected = ':\n\n' + themeEvent({ mode: 'system', light: 'one-light', dark: 'nord' })
      await a.waitFor(expected)
      await tick()
      expect(a.text()).toBe(expected)
    } finally {
      a.close()
    }
  })

  it('W-7b 三个主题键之一 / keys 不给 → 每条连接恰好多一条新的；keys 为空 → 没有', async () => {
    const streams = [await openSse(A), await openSse(A), await openSse(B)]
    try {
      await eachHas(streams, 1)
      const cases: Array<[string[] | undefined, WidgetThemeSettings]> = [
        [['general.lightTheme'], { mode: 'system', light: 'solarized-light', dark: 'nord' }],
        [['general.darkTheme'], { mode: 'system', light: 'solarized-light', dark: 'dracula' }],
        [['general.theme'], { mode: 'light', light: 'solarized-light', dark: 'dracula' }],
        [undefined, { mode: 'dark', light: 'one-light', dark: 'tokyo-night' }],
        [
          ['general.language', 'general.darkTheme'],
          { mode: 'dark', light: 'one-light', dark: 'nord' }
        ]
      ]
      let n = 1
      for (const [keys, next] of cases) {
        settings = next
        appEventBus.publish(
          keys ? { type: 'settings.changed', keys } : { type: 'settings.changed' }
        )
        n++
        await eachHas(streams, n)
        for (const s of streams) expect(lastTheme(s.text()), JSON.stringify(keys)).toEqual(next)
      }

      settings = { mode: 'light', light: 'catppuccin-latte', dark: 'gruvbox-dark' }
      appEventBus.publish({ type: 'settings.changed', keys: [] })
      await tick(150)
      for (const s of streams) expect(themesIn(s.text())).toBe(n)
    } finally {
      for (const s of streams) s.close()
    }
  })

  it('W-7c 别的键、别的事件类型 → 什么都没有', async () => {
    const a = await openSse(A)
    const b = await openSse(B)
    try {
      await eachHas([a, b], 1)
      settings = { mode: 'light', light: 'catppuccin-latte', dark: 'dracula' }
      appEventBus.publish({ type: 'settings.changed', keys: ['general.language'] })
      appEventBus.publish({
        type: 'settings.changed',
        keys: ['general.fontSize', 'httpLog.enabled']
      })
      appEventBus.publish({ type: 'providers.changed' })
      appEventBus.publish({ type: 'project.changed' })
      appEventBus.publish({ type: 'session.listChanged' })
      await tick(150)
      expect(themesIn(a.text())).toBe(1)
      expect(themesIn(b.text())).toBe(1)
    } finally {
      a.close()
      b.close()
    }
  })

  it('W-7d dispose 之后发不写不抛；重新起来发一次 → 恰好一条', async () => {
    const notify = vi.spyOn(widgetServer, 'notifyTheme')
    const before = await openSse(A)
    try {
      await eachHas([before], 1)
      widgetServer.dispose()
      await tick()
      const ended = before.text()
      expect(() => appEventBus.publish({ type: 'settings.changed' })).not.toThrow()
      await tick()
      expect(notify).not.toHaveBeenCalled()
      expect(before.text()).toBe(ended)
    } finally {
      before.close()
    }

    await widgetServer.registerAndBuild(A, tmp, 'index.tsx')
    port = widgetServer.getStatus().port
    const after = await openSse(A)
    try {
      await eachHas([after], 1)
      settings = { mode: 'dark', light: 'one-light', dark: 'catppuccin-mocha' }
      appEventBus.publish({ type: 'settings.changed', keys: ['general.darkTheme'] })
      await eachHas([after], 2)
      expect(notify).toHaveBeenCalledTimes(1)
      expect(lastTheme(after.text())).toEqual(settings)
    } finally {
      after.close()
      notify.mockRestore()
    }
  })
})

// ────────────────────────────── WT4-PV（预览令牌） ──────────────────────────────

describe('WT4-PV 预览页面调 API：按发起预览的会话判', () => {
  const SNAPSHOT = {
    ops: [
      { name: 'listBooks', mode: 'read' as const, agent: true },
      { name: 'addBook', mode: 'write' as const, agent: true },
      { name: 'saveLayout', mode: 'write' as const, agent: false }
    ]
  }
  const preview = (sid?: string): string => issueWidgetToken(A, 'preview', sid)
  const judge = (
    allow: (access: 'read' | 'write') => boolean
  ): { widget: ReturnType<typeof vi.fn>; readPath: ReturnType<typeof vi.fn> } => {
    const j = {
      widget: vi.fn((_sid: string, access: 'read' | 'write', _id: string, _op: string) =>
        allow(access)
      ),
      readPath: vi.fn(() => false)
    }
    setWidgetPreviewJudge(j)
    return j
  }
  const AGENT = { kind: 'agent', sessionId: 's1', actor: 'preview', label: 'preview' }

  beforeEach(() => {
    h.snapshot = SNAPSHOT
  })

  it('WT4-PV-10 读操作 + 放行 → 200；caller 是会话的 agent，选项带 expectedMode', async () => {
    const j = judge(() => true)
    h.callWidgetOp.mockResolvedValueOnce({
      op: 'listBooks',
      mode: 'read',
      result: { outcome: { ok: true, value: [{ id: 1 }] }, wrote: false, logs: [] }
    })

    const res = await http(`/w/${A}/api/listBooks`, {
      token: preview('s1'),
      body: JSON.stringify({ status: 'read' })
    })

    expect(res.status).toBe(200)
    expect(res.json).toEqual({ result: [{ id: 1 }] })
    expect(j.widget.mock.calls).toEqual([['s1', 'read', A, 'listBooks']])
    expect(h.callWidgetOp.mock.calls).toEqual([
      [A, 'listBooks', { status: 'read' }, AGENT, { allowUiOnly: true, expectedMode: 'read' }]
    ])
    expect(h.callWidgetOp.mock.calls[0][3]).toStrictEqual(AGENT)
  })

  it('WT4-PV-10b 判了授权之后 callWidgetOp 报 changed → 409', async () => {
    judge(() => true)
    h.callWidgetOp.mockRejectedValueOnce(
      new h.WidgetApiError('changed', 'Operation "listBooks" is now a write operation.')
    )
    const res = await http(`/w/${A}/api/listBooks`, { token: preview('s1'), body: '{}' })
    expect(res.status).toBe(409)
    expect(res.json).toEqual({
      error: { code: 'changed', message: 'Operation "listBooks" is now a write operation.' }
    })
    expect(h.callWidgetOp.mock.calls[0][4]).toEqual({ allowUiOnly: true, expectedMode: 'read' })
  })

  it('WT4-PV-11 只放行读：写操作 403 not_authorized、不调；读操作 200', async () => {
    const j = judge((access) => access === 'read')

    const write = await http(`/w/${A}/api/addBook`, { token: preview('s1'), body: '{}' })
    expect(write.status).toBe(403)
    expect(write.json).toEqual({
      error: {
        code: 'not_authorized',
        message:
          "This preview's session may not call write operations of this widget without asking."
      }
    })
    expect(h.callWidgetOp).not.toHaveBeenCalled()

    const read = await http(`/w/${A}/api/listBooks`, { token: preview('s1'), body: '{}' })
    expect(read.status).toBe(200)
    expect(h.callWidgetOp).toHaveBeenCalledTimes(1)
    expect(h.callWidgetOp.mock.calls[0][1]).toBe('listBooks')
    expect(j.widget.mock.calls).toEqual([
      ['s1', 'write', A, 'addBook'],
      ['s1', 'read', A, 'listBooks']
    ])
  })

  it('WT4-PV-12 认得的操作 + 不带会话的 preview 令牌 → 403，判定不问', async () => {
    const j = judge(() => true)
    for (const token of [preview(), preview('')]) {
      const res = await http(`/w/${A}/api/listBooks`, { token, body: '{}' })
      expect(res.status).toBe(403)
      expect((res.json as { error: { code: string } }).error.code).toBe('not_authorized')
    }
    expect(j.widget).not.toHaveBeenCalled()
    expect(h.callWidgetOp).not.toHaveBeenCalled()
  })

  it('WT4-PV-12 认得的操作 + 没注入判定 → 403 not_authorized', async () => {
    setWidgetPreviewJudge(null)
    for (const op of ['listBooks', 'addBook']) {
      const res = await http(`/w/${A}/api/${op}`, { token: preview('s1'), body: '{}' })
      expect(res.status, op).toBe(403)
      expect((res.json as { error: { code: string } }).error.code, op).toBe('not_authorized')
    }
    expect(h.callWidgetOp).not.toHaveBeenCalled()
  })

  it('WT4-PV-13 快照里没有这个操作 → 判定不问，交给 callWidgetOp（没有 expectedMode），404 原样回', async () => {
    const j = judge(() => false)
    h.callWidgetOp.mockRejectedValueOnce(
      new h.WidgetApiError('unknown_op', 'Widget "book-shelf" has no operation "nope".')
    )
    const res = await http(`/w/${A}/api/nope`, { token: preview('s1'), body: '{}' })
    expect(res.status).toBe(404)
    expect(res.json).toEqual({
      error: { code: 'unknown_op', message: 'Widget "book-shelf" has no operation "nope".' }
    })
    expect(j.widget).not.toHaveBeenCalled()
    expect(h.callWidgetOp.mock.calls).toEqual([[A, 'nope', {}, AGENT, { allowUiOnly: true }]])
  })

  it('WT4-PV-13 根本没有快照 → 判定不问，callWidgetOp 的 no_api 404 原样回', async () => {
    h.snapshot = null
    const j = judge(() => false)
    h.callWidgetOp.mockRejectedValueOnce(new h.WidgetApiError('no_api', 'no api'))
    const res = await http(`/w/${A}/api/listBooks`, { token: preview('s1'), body: '{}' })
    expect(res.status).toBe(404)
    expect(res.json).toEqual({ error: { code: 'no_api', message: 'no api' } })
    expect(j.widget).not.toHaveBeenCalled()
    expect(h.callWidgetOp.mock.calls[0][4]).toStrictEqual({ allowUiOnly: true })
  })

  it('WT4-PV-14 ui 令牌调写操作、纯界面操作 → 用户、只有 allowUiOnly，不读快照、不问判定', async () => {
    const j = judge(() => false)
    for (const op of ['addBook', 'saveLayout']) {
      const res = await http(`/w/${A}/api/${op}`, { body: '{}' })
      expect(res.status, op).toBe(200)
    }
    expect(h.callWidgetOp.mock.calls).toEqual([
      [A, 'addBook', {}, { kind: 'user', label: 'user' }, { allowUiOnly: true }],
      [A, 'saveLayout', {}, { kind: 'user', label: 'user' }, { allowUiOnly: true }]
    ])
    expect(h.callWidgetOp.mock.calls[0][4]).toStrictEqual({ allowUiOnly: true })
    expect(j.widget).not.toHaveBeenCalled()
    expect(h.readApiSnapshot).not.toHaveBeenCalled()
  })
})

// ────────────────────────────── WC-S30..S31 ──────────────────────────────

describe('WC-S30..S31 换存储之后的路由、页面的事件流', () => {
  it('WC-S30 不重新注册、存储从 pglite 换成 sqlite → /db 变成 404 NO_DB_ROUTE，/api 照常', async () => {
    const before = await http(`/w/${OLD}/db/books?select=*`, { method: 'GET' })
    expect(before.status).toBe(200)
    expect(h.handleRestRequest).toHaveBeenCalledTimes(1)

    h.storage[OLD] = 'sqlite'

    const after = await http(`/w/${OLD}/db/books?select=*`, { method: 'GET' })
    expect(after.status).toBe(404)
    expect(after.json).toMatchObject({ code: 'NO_DB_ROUTE' })
    expect(h.handleRestRequest).toHaveBeenCalledTimes(1)

    const api = await http(`/w/${OLD}/api/addBook`, { body: JSON.stringify({ title: 'Dune' }) })
    expect(api.status).toBe(200)
    expect(api.json).toEqual({ result: { id: 1 } })
    expect(h.callWidgetOp.mock.calls.map((c) => [c[0], c[1]])).toEqual([[OLD, 'addBook']])
  })

  it('WC-S31 页面把自己的 EventSource 挂在 window.__shuvixEvents 上，仍管 reload，只开这一条', async () => {
    const page = await http(`/w/${A}/`, { method: 'GET' })

    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.body).toContain(`<base href="/w/${A}/" />`)
    const opened = page.body.match(/new EventSource\('sse'\)/g) ?? []
    expect(opened).toHaveLength(1)
    expect(page.body).toMatch(
      /const es = new EventSource\('sse'\);[\s\S]*window\.__shuvixEvents = es;/
    )
    expect(page.body).toContain("es.addEventListener('reload', () => location.reload())")
  })
})
