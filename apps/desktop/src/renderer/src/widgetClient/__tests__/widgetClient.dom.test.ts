// @vitest-environment jsdom
/**
 * `shuvix/widget` —— 组件界面调自己 API 的客户端（widgetClient.ts，设计稿 docs/widget-tool-design.md §4、§21）。
 *
 * `fetch` 是可控的假件（每次请求进 `reqs`，用例逐个答）；jsdom 没有 EventSource，换成 FakeEventSource（记下每个实例、
 * 收下监听者，`emit` 当作服务端推来的事件）。客户端的事件流是**模块级**的（每页一条），所以每条用例 resetModules 后
 * 把 react、react-dom/client 与客户端一起重新导入（客户端与 createRoot 必须是同一份 React）。
 * 渲染层单测不带 react 插件：一律 createElement；探针组件把每次 `use` 的返回记进 `renders`。
 *
 * call
 *   WC-1  `call('listBooks', {status})` → fetch 一次，地址正好是相对的 `api/listBooks`，init 是 POST + JSON 头 + JSON 正文
 *   WC-2  不给参数 / undefined / null → 正文 `{}`
 *   WC-3  200 {result} → 交回 result；null、0、false、'' 也照样交回（不当作失败）
 *   WC-4  操作失败 {error:{code,message}}（400/404/409/422/500/503/504）→ WidgetError，code、message 原样
 *   WC-5  令牌拒绝 403 {code,message}；预览拒绝 403 {error:{code:'not_authorized'}} → 同样的 code、message
 *   WC-6  不是 JSON 的应答（404 纯文本、502 HTML）→ `http_<status>`、`The widget answered <status> without JSON.`
 *   WC-7  JSON 但没有可用字段（500 {}、422 code/message 不是字符串、200 {}、200 null）→ `http_<status>`、
 *         `The widget answered <status>.`；200 没有 result 是**失败**，不交回 undefined
 *   WC-8  fetch 拒绝 → `network`，message 取错误的 message；不是 Error（或空 message）→ `The request failed.`
 *   WC-9  操作名按 URI 成分编码（`a/b`、`../db/books`、`x?y#z`）：永远是 `api/` 下的一段，到不了 `db/` 路由
 *   WC-10 只用 call → 不开 EventSource
 *   WC-11 200 但 JSON 是原始值（"ok"、42）→ WidgetError `http_200`（不再是 TypeError）
 *   WC-12 编不成 JSON 的参数（BigInt、循环引用）→ WidgetError `invalid_args`，不发请求
 * use
 *   WC-20 挂载：首帧 loading、一次请求、取到后 {data, loading:false}；开一条 `EventSource('sse')`
 *   WC-21 不给参数 ↔ `{}` 来回换：正文都是 `{}`，不重取
 *   WC-22 每次渲染新建一个同样的对象：只取一次、loading 不回到 true、refetch 引用不变
 *   WC-23 钉住：键顺序不同（`{a,b}` → `{b,a}`）→ 重取（按 JSON 文本比较）
 *   WC-24 参数变了：loading 且留着旧数据，按新正文取一次，回来换上
 *   WC-25 null → 不取、不开 EventSource、loading false；换成参数 → 取
 *   WC-26 在途时换成 null：晚到的结果 / 错误都不落进状态
 *   WC-27 钉住：取到之后换成 null → 数据留着；写入事件不重取；唯一的订阅者走了 → 关掉 EventSource
 *   WC-28 乱序：A、B 两次请求，不管哪个先回，最后都是 B 的；A 先回时不显示 A、也不结束 loading
 *   WC-29 写入事件 → 同一个操作、同一正文再取一次；其间 loading、旧数据留着
 *   WC-30 一页两个 hook + 一个 onData：一条 EventSource；一次事件各取一次、监听者一次；全走了才关；再来新开一条
 *   WC-31 坏的事件内容（不是 JSON、null、空串）→ 照样重取；监听者收到 {op:'', source:''}
 *   WC-32 reload 与不带名字的 message 事件 → 不重取、不通知
 *   WC-33 手动 refetch：同一正文、loading 真 → 假；参数是 null 时什么都不做
 *   WC-34 两个写入事件接连来、应答倒着回 → 最后是第二次请求的结果
 *   WC-35 取到 D1 → 重取失败（422）→ {data:D1, error, loading:false}；再成功 → error 清掉
 *   WC-36 A 的失败不挂到 B 上；B 也失败 → B 的错误，数据还是更早那组参数取到的（钉住）
 *   WC-37 use 里的各种失败都是 WidgetError，code 同 call
 *   WC-38 在途时卸载 → 结果 / 错误回来不改状态、不报错；最后一个订阅者 → 关掉 EventSource
 *   WC-39 StrictMode：第一次（被丢弃的）挂载的应答不算；最后只开着一条 EventSource
 *   WC-40 换操作、参数一样：在新操作回来之前是 loading，不显示旧操作的错误（结果按操作 + 参数认）
 *   WC-41 钉住：{x} 取到 → null → {x}：会再取一次，其间 loading 仍是 false、显示的是之前的数据
 *   WC-42 编不成 JSON 的参数：渲染不抛，{error: invalid_args, loading:false}，不发请求；之前的数据留着；换回好参数照常取
 * onData
 *   WC-50 收到 `{op, source}`；op 不是字符串转成字符串、缺的字段是 ''
 *   WC-51 退订之后不再收到；最后一个退订才关；重复退订不关别人还在用的流
 *   WC-52 钉住：派发中一个监听者退订另一个 → 这一轮两个都收到（按快照派发），下一轮被退订的不再收到
 *   WC-53 一个监听者抛错：后面的监听者、use 的重取照样跑；记一条 console.error
 *   WC-54 两个 createClient() 共用一条 EventSource（每页一条）
 *   WC-55 没有 EventSource：onData / use 不抛，use 照样取一次
 *   WC-56 页面自己的流（`window.__shuvixEvents`）：不另开；挂在它上面；最后一个走了只摘掉自己的监听、不关它
 *   WC-57 页面的流上别的监听（reload）不受影响；退订完再订阅 → 又挂回页面那一条，仍不新开
 * 主题（useTheme / themeColor；页面骨架在 `<html>` 上设 data-theme / data-scheme 并发 `shuvix:theme`）
 *   WC-60 `<html data-theme="nord" data-scheme="dark">` → {id:'nord', scheme:'dark'}；改属性 + 发 shuvix:theme → 带新值重渲染；
 *         什么都没变时发 → 不多渲染
 *   WC-61 没有 data-scheme → 明暗看（假的）matchMedia、id 是 ''；媒体查询变了 → 重渲染；根本没有 matchMedia → light、不抛；
 *         data-scheme="blue" → 也看媒体查询
 *   WC-62 没有「getSnapshot should be cached」的 console.error；卸载之后事件不再引起渲染、媒体查询的监听摘掉
 *   WC-63 themeColor：getComputedStyle 换成假的（jsdom 读不出变量的值）；'accent' 探 var(--widget-accent)、'--x' 探 var(--x)；
 *         探针在调用期间是 `<html>` 下 display:none 的子节点、之后移走；变量没定义 → '' 且不挂探针；计算值已经是 rgb(…)
 *         → 原样交回、不碰画布；oklch(…) → 画到（假的）2D 画布上读回：[0,212,146,255] → rgb(0, 212, 146)，
 *         [57,135,227,36] → rgba(57, 135, 227, 0.141)；没有 2D 上下文（jsdom 自己就是）→ 计算值原样
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import type { LooseApi, WidgetClient } from '../widgetClient'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type ClientModule = typeof import('../widgetClient')
/** 不带类型参数的客户端（类型参数缺省是 LooseApi；ReturnType 取泛型函数会落到 unknown） */
type Client = WidgetClient<LooseApi>

interface UseState {
  data: unknown
  error: unknown
  loading: boolean
  refetch: () => void
}

// ─── 假 EventSource ─────────────────────────────────────────────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readonly close = vi.fn()
  private readonly listeners = new Map<string, Set<(e: { data: string }) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: (e: { data: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }

  removeEventListener(type: string, fn: (e: { data: string }) => void): void {
    this.listeners.get(type)?.delete(fn)
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }

  /** 服务端推来一条事件 */
  emit(type: string, data: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ data })
  }
}

// ─── 假 fetch ───────────────────────────────────────────────────────────────

interface Req {
  url: string
  init: RequestInit
  body: string
  resolve: (r: Response) => void
  reject: (e: unknown) => void
}

/** 收到的请求（按顺序） */
let reqs: Req[] = []
/** 设了就自动答（否则请求挂着，由用例答） */
let responder: ((req: Req) => Response | Promise<Response>) | null = null

const fetchMock = vi.fn(
  (url: string, init: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const req: Req = { url, init, body: String(init?.body), resolve, reject }
      reqs.push(req)
      if (responder) {
        const answer = responder
        void Promise.resolve()
          .then(() => answer(req))
          .then(resolve, reject)
      }
    })
)

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const text = (status: number, body: string, type = 'text/plain'): Response =>
  new Response(body, { status, headers: { 'Content-Type': type } })

const ok = (result: unknown): Response => json(200, { result })

// ─── 环境 ───────────────────────────────────────────────────────────────────

let React: typeof import('react')
let ReactDOM: typeof import('react-dom/client')
let W: ClientModule
const roots = new Set<Root>()

beforeEach(async () => {
  vi.resetModules()
  React = await import('react')
  ReactDOM = await import('react-dom/client')
  W = await import('../widgetClient')
  FakeEventSource.instances = []
  reqs = []
  responder = null
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(async () => {
  for (const root of roots) await React.act(async () => root.unmount())
  roots.clear()
  delete (window as unknown as { __shuvixEvents?: unknown }).__shuvixEvents
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 让在途的 Promise（fetch → res.json → setState）落定，并在 act 里冲掉 React 的更新 */
async function flush(): Promise<void> {
  await React.act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

/** 答一个挂着的请求，再等它落定 */
async function answer(req: Req, res: Response): Promise<void> {
  req.resolve(res)
  await flush()
}

async function fail(req: Req, err: unknown): Promise<void> {
  req.reject(err)
  await flush()
}

/** 当作服务端推来的事件（在 act 里：监听者会改状态） */
async function emit(es: FakeEventSource, type: string, data: string): Promise<void> {
  await React.act(async () => es.emit(type, data))
}

/** 只有一个 EventSource 时取它 */
function onlySource(): FakeEventSource {
  expect(FakeEventSource.instances).toHaveLength(1)
  return FakeEventSource.instances[0]
}

/** 等一个 promise 以 WidgetError 拒绝，交回它 */
async function rejection(p: Promise<unknown>): Promise<InstanceType<ClientModule['WidgetError']>> {
  const err = await p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(W.WidgetError)
  expect(err).toBeInstanceOf(Error)
  return err as InstanceType<ClientModule['WidgetError']>
}

interface Mounted {
  renders: UseState[]
  last: () => UseState
  rerender: (op: string, args: unknown) => Promise<void>
  unmount: () => Promise<void>
}

/** 挂一个只调 `api.use(op, args)` 的探针组件 */
async function mount(
  op: string,
  args: unknown,
  opts: { strict?: boolean; api?: Client } = {}
): Promise<Mounted> {
  const api = opts.api ?? W.createClient()
  const renders: UseState[] = []
  function Probe(props: { op: string; args: unknown }): null {
    renders.push(api.use(props.op, props.args) as UseState)
    return null
  }
  const element = (o: string, a: unknown): ReturnType<typeof React.createElement> => {
    const probe = React.createElement(Probe, { op: o, args: a })
    return opts.strict ? React.createElement(React.StrictMode, null, probe) : probe
  }
  const root = ReactDOM.createRoot(document.createElement('div'))
  roots.add(root)
  await React.act(async () => root.render(element(op, args)))
  return {
    renders,
    last: () => renders[renders.length - 1],
    rerender: async (o, a) => {
      await React.act(async () => root.render(element(o, a)))
    },
    unmount: async () => {
      await React.act(async () => root.unmount())
      roots.delete(root)
    }
  }
}

// ═══════════════════════════════ call ═══════════════════════════════

describe('call', () => {
  it('WC-1 地址是相对的 `api/<op>`；POST、JSON 头、JSON 正文', async () => {
    responder = () => ok([])
    const api = W.createClient()

    await api.call('listBooks', { status: 'want' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    // 没有开头的 /、没有主机、没有组件 id、没有令牌：页面的 <base> 把它解析到这个组件自己的路由
    expect(url).toBe('api/listBooks')
    expect(init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"status":"want"}'
    })
  })

  it('WC-2 不给参数 / undefined / null → 正文 `{}`', async () => {
    responder = () => ok(1)
    const api = W.createClient()

    await api.call('x')
    await api.call('x', undefined)
    await api.call('x', null)

    expect(reqs.map((r) => r.body)).toEqual(['{}', '{}', '{}'])
  })

  it.each<[string, unknown]>([
    ['数组', [{ id: 1 }]],
    ['null', null],
    ['0', 0],
    ['false', false],
    ['空串', '']
  ])('WC-3 200 {result: %s} → 原样交回（假值也不当作失败）', async (_l, value) => {
    responder = () => ok(value)
    await expect(W.createClient().call('x')).resolves.toEqual(value)
  })

  it.each([
    [400, 'invalid_args'],
    [404, 'unknown_op'],
    [409, 'changed'],
    [422, 'duplicate'],
    [500, 'internal'],
    [503, 'host_unavailable'],
    [504, 'timeout']
  ])('WC-4 %i {error:{code:%j}} → WidgetError，code / message 原样', async (status, code) => {
    responder = () => json(status, { error: { code, message: `message of ${code}` } })

    const err = await rejection(W.createClient().call('addBook', { title: 'Dune' }))

    expect(err.name).toBe('WidgetError')
    expect(err.code).toBe(code)
    expect(err.message).toBe(`message of ${code}`)
  })

  it('WC-5 令牌拒绝 403 {code, message}；预览拒绝 403 {error:{code, message}}', async () => {
    const api = W.createClient()

    responder = () =>
      json(403, { code: 'FORBIDDEN', message: 'This widget route needs the widget token.' })
    const token = await rejection(api.call('x'))
    expect([token.code, token.message]).toEqual([
      'FORBIDDEN',
      'This widget route needs the widget token.'
    ])

    responder = () =>
      json(403, { error: { code: 'not_authorized', message: 'The session may not write.' } })
    const preview = await rejection(api.call('x'))
    expect([preview.code, preview.message]).toEqual([
      'not_authorized',
      'The session may not write.'
    ])
  })

  it.each([
    [404, text(404, 'Widget x not registered')],
    [502, text(502, '<html><body>Bad Gateway</body></html>', 'text/html')]
  ])('WC-6 %i 不是 JSON → http_%i、`…without JSON.`', async (status, res) => {
    responder = () => res
    const err = await rejection(W.createClient().call('x'))
    expect(err.code).toBe(`http_${status}`)
    expect(err.message).toBe(`The widget answered ${status} without JSON.`)
  })

  it.each<[string, number, unknown]>([
    ['500 {}', 500, {}],
    ['422 code / message 不是字符串', 422, { error: { code: 5, message: 7 } }],
    ['200 {}（没有 result）', 200, {}],
    ['200 null', 200, null],
    ['200 {error:null}', 200, { error: null }]
  ])('WC-7 %s → http_<status>、`The widget answered <status>.`', async (_l, status, body) => {
    responder = () => json(status, body)
    const err = await rejection(W.createClient().call('x'))
    expect(err.code).toBe(`http_${status}`)
    expect(err.message).toBe(`The widget answered ${status}.`)
  })

  it('WC-8 fetch 拒绝 → network；message 取错误的；不是 Error / 空 message → `The request failed.`', async () => {
    const api = W.createClient()
    const cases: Array<[unknown, string]> = [
      [new TypeError('Failed to fetch'), 'Failed to fetch'],
      ['boom', 'The request failed.'],
      [undefined, 'The request failed.'],
      [new Error(''), 'The request failed.']
    ]
    for (const [thrown, message] of cases) {
      fetchMock.mockImplementationOnce(() => Promise.reject(thrown))
      const err = await rejection(api.call('x'))
      expect([err.code, err.message], String(thrown)).toEqual(['network', message])
    }
  })

  it('WC-9 操作名按 URI 成分编码：永远是 `api/` 下的一段', async () => {
    responder = () => ok(null)
    const api = W.createClient()

    for (const op of ['a/b', '../db/books', 'x?y#z', 'addBook']) await api.call(op)

    const urls = reqs.map((r) => r.url)
    expect(urls).toEqual(['api/a%2Fb', 'api/..%2Fdb%2Fbooks', 'api/x%3Fy%23z', 'api/addBook'])
    // 按组件页面的 <base> 解析：`..%2F` 不是路径分隔，到不了 `/w/<id>/db/`
    const base = 'http://127.0.0.1:1/w/abc-def/'
    for (const url of urls) {
      const resolved = new URL(url, base)
      expect(resolved.pathname.startsWith('/w/abc-def/api/'), url).toBe(true)
      expect(resolved.pathname.slice('/w/abc-def/api/'.length)).not.toContain('/')
      expect(resolved.search + resolved.hash).toBe('')
    }
  })

  it('WC-10 只用 call → 不开 EventSource', async () => {
    responder = () => ok(1)
    const api = W.createClient()
    await api.call('a')
    await api.call('b', { x: 1 })
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('down')))
    await rejection(api.call('c'))
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it.each<[string, unknown]>([
    ['字符串', 'ok'],
    ['数', 42],
    ['true', true]
  ])('WC-11 200 但 JSON 是原始值（%s）→ WidgetError http_200，不是 TypeError', async (_l, body) => {
    responder = () => json(200, body)
    const err = await rejection(W.createClient().call('x'))
    expect(err.code).toBe('http_200')
    expect(err.message).toBe('The widget answered 200.')
  })

  it('WC-12 编不成 JSON 的参数（BigInt、循环引用）→ invalid_args，不发请求', async () => {
    const api = W.createClient()
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic

    for (const args of [{ n: 1n }, cyclic]) {
      const err = await rejection(api.call('x', args))
      expect(err.code).toBe('invalid_args')
      expect(err.message).toMatch(/^The arguments cannot be sent as JSON: \S/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════ use ═══════════════════════════════

describe('use', () => {
  it('WC-20 挂载：首帧 loading；一次请求；取到 → data、loading false；一条 EventSource("sse")', async () => {
    const m = await mount('listBooks', { status: 'want' })

    expect(m.renders[0]).toMatchObject({ data: undefined, error: undefined, loading: true })
    expect(typeof m.renders[0].refetch).toBe('function')
    expect(reqs).toHaveLength(1)
    expect(reqs[0].url).toBe('api/listBooks')
    expect(reqs[0].body).toBe('{"status":"want"}')
    expect(onlySource().url).toBe('sse')

    const rows = [{ id: 1, title: 'Dune' }]
    await answer(reqs[0], ok(rows))
    expect(m.last()).toMatchObject({ data: rows, error: undefined, loading: false })
    expect(reqs).toHaveLength(1)
  })

  it('WC-21 不给参数 → 正文 `{}`；undefined ↔ {} 来回换不重取', async () => {
    const m = await mount('listBooks', undefined)
    expect(reqs.map((r) => r.body)).toEqual(['{}'])
    await answer(reqs[0], ok([]))

    await m.rerender('listBooks', {})
    await m.rerender('listBooks', undefined)
    await flush()

    expect(reqs).toHaveLength(1)
    expect(m.last().loading).toBe(false)
  })

  it('WC-22 每次渲染新建一个同样的对象：只取一次、loading 不回到 true、refetch 引用不变', async () => {
    const m = await mount('listBooks', { status: 'want' })
    await answer(reqs[0], ok(['a']))
    const settledAt = m.renders.length
    const refetch = m.last().refetch

    for (let i = 0; i < 3; i++) await m.rerender('listBooks', { status: 'want' })
    await flush()

    expect(reqs).toHaveLength(1)
    const after = m.renders.slice(settledAt)
    expect(after.length).toBeGreaterThanOrEqual(3)
    for (const r of after) {
      expect(r.loading).toBe(false)
      expect(r.refetch).toBe(refetch)
      expect(r.data).toEqual(['a'])
    }
  })

  it('WC-23 钉住：只是键的顺序变了 → 重取（按 JSON 文本比较）', async () => {
    const m = await mount('listBooks', { a: 1, b: 2 })
    await answer(reqs[0], ok(1))

    await m.rerender('listBooks', { b: 2, a: 1 })

    expect(reqs.map((r) => r.body)).toEqual(['{"a":1,"b":2}', '{"b":2,"a":1}'])
    expect(m.last().loading).toBe(true)
  })

  it('WC-24 参数变了：loading 且留着旧数据；按新正文取一次；回来换上', async () => {
    const m = await mount('listBooks', { s: 'want' })
    await answer(reqs[0], ok(['w']))

    await m.rerender('listBooks', { s: 'done' })
    expect(m.last()).toMatchObject({ data: ['w'], error: undefined, loading: true })
    // 换参数的那一帧起就没有空白：每一帧都有旧数据
    expect(m.renders.every((r, i) => i === 0 || r.data !== undefined)).toBe(true)
    expect(reqs).toHaveLength(2)
    expect(reqs[1].body).toBe('{"s":"done"}')

    await answer(reqs[1], ok(['d']))
    expect(m.last()).toMatchObject({ data: ['d'], error: undefined, loading: false })
  })

  it('WC-25 null → 不取、不开 EventSource、loading false；换成参数 → 取', async () => {
    const m = await mount('listBooks', null)
    await flush()

    expect(reqs).toHaveLength(0)
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(m.last()).toMatchObject({ data: undefined, error: undefined, loading: false })

    await m.rerender('listBooks', { s: 'want' })
    expect(reqs).toHaveLength(1)
    expect(m.last().loading).toBe(true)
    expect(onlySource().url).toBe('sse')

    await answer(reqs[0], ok(['w']))
    expect(m.last()).toMatchObject({ data: ['w'], loading: false })
  })

  it.each(['resolve', 'reject'] as const)(
    'WC-26 在途时换成 null，再 %s 那次请求 → 不落进状态，loading false',
    async (how) => {
      const m = await mount('listBooks', { a: 1 })
      await m.rerender('listBooks', null)
      expect(m.last().loading).toBe(false)

      if (how === 'resolve') await answer(reqs[0], ok(['late']))
      else await answer(reqs[0], json(422, { error: { code: 'late', message: 'late' } }))

      expect(m.last()).toMatchObject({ data: undefined, error: undefined, loading: false })
      expect(reqs).toHaveLength(1)
    }
  )

  it('WC-27 钉住：取到之后换成 null → 数据留着；写入事件不重取；唯一的订阅者走了 → 关掉流', async () => {
    const m = await mount('listBooks', { a: 1 })
    await answer(reqs[0], ok(['kept']))
    const es = onlySource()

    await m.rerender('listBooks', null)
    expect(m.last()).toMatchObject({ data: ['kept'], error: undefined, loading: false })
    expect(es.close).toHaveBeenCalledTimes(1)

    await emit(es, 'data', '{"op":"addBook","source":"user"}')
    expect(reqs).toHaveLength(1)
    expect(m.last()).toMatchObject({ data: ['kept'], loading: false })
  })

  it.each(['B 先回', 'A 先回'] as const)(
    'WC-28 乱序（%s）：最后都是 B 的；A 回来时不显示 A、也不结束 loading',
    async (order) => {
      const m = await mount('listBooks', { s: 'A' })
      await m.rerender('listBooks', { s: 'B' })
      const [a, b] = reqs
      expect([a.body, b.body]).toEqual(['{"s":"A"}', '{"s":"B"}'])

      if (order === 'B 先回') {
        await answer(b, ok('B'))
        await answer(a, ok('A'))
      } else {
        await answer(a, ok('A'))
        expect(m.last()).toMatchObject({ data: undefined, loading: true })
        await answer(b, ok('B'))
      }
      expect(m.last()).toMatchObject({ data: 'B', error: undefined, loading: false })
      expect(m.renders.some((r) => r.data === 'A')).toBe(false)
    }
  )

  it('WC-29 写入事件 → 同一操作、同一正文再取；其间 loading、旧数据留着', async () => {
    const m = await mount('listBooks', { s: 'want' })
    await answer(reqs[0], ok(['old']))

    await emit(onlySource(), 'data', '{"op":"addBook","source":"agent"}')
    expect(reqs).toHaveLength(2)
    expect([reqs[1].url, reqs[1].body]).toEqual(['api/listBooks', '{"s":"want"}'])
    expect(m.last()).toMatchObject({ data: ['old'], error: undefined, loading: true })

    await answer(reqs[1], ok(['old', 'new']))
    expect(m.last()).toMatchObject({ data: ['old', 'new'], loading: false })
  })

  it('WC-30 一页两个 hook + 一个 onData：一条流；一次事件各取一次；全走了才关；之后新开一条', async () => {
    responder = (req) => ok(req.url)
    const api = W.createClient()
    const h1 = await mount('listA', {}, { api })
    const h2 = await mount('listB', {}, { api })
    const listener = vi.fn()
    const off = api.onData(listener)
    await flush()
    const es = onlySource()
    expect(es.url).toBe('sse')
    expect(reqs).toHaveLength(2)

    await emit(es, 'data', '{"op":"addBook","source":"user"}')
    await flush()
    expect(reqs.slice(2).map((r) => r.url)).toEqual(['api/listA', 'api/listB'])
    expect(listener.mock.calls).toEqual([[{ op: 'addBook', source: 'user' }]])

    await h1.unmount()
    expect(es.close).not.toHaveBeenCalled()
    await h2.unmount()
    expect(es.close).not.toHaveBeenCalled()
    off()
    expect(es.close).toHaveBeenCalledTimes(1)
    expect(es.listenerCount('data')).toBe(0)

    await mount('listA', {}, { api })
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1].close).not.toHaveBeenCalled()
  })

  it.each([
    ['不是 JSON', 'not json'],
    ['null', 'null'],
    ['空串', '']
  ])('WC-31 坏的事件内容（%s）→ hook 照样重取；监听者收到 {op:"", source:""}', async (_l, data) => {
    responder = () => ok(1)
    const api = W.createClient()
    await mount('listBooks', {}, { api })
    const listener = vi.fn()
    const off = api.onData(listener)
    await flush()

    await emit(onlySource(), 'data', data)
    await flush()

    expect(reqs).toHaveLength(2)
    expect(listener.mock.calls).toEqual([[{ op: '', source: '' }]])
    off()
  })

  it('WC-32 reload 与不带名字的 message 事件 → 不重取、不通知', async () => {
    responder = () => ok(1)
    const api = W.createClient()
    await mount('listBooks', {}, { api })
    const listener = vi.fn()
    const off = api.onData(listener)
    await flush()

    await emit(onlySource(), 'reload', '')
    await emit(onlySource(), 'message', '{"op":"addBook","source":"user"}')
    await flush()

    expect(reqs).toHaveLength(1)
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('WC-33 手动 refetch：同一正文、loading 真 → 假；参数是 null 时什么都不做', async () => {
    const m = await mount('listBooks', { s: 'x' })
    await answer(reqs[0], ok(1))

    await React.act(async () => m.last().refetch())
    expect(reqs).toHaveLength(2)
    expect(reqs[1].body).toBe('{"s":"x"}')
    expect(m.last()).toMatchObject({ data: 1, loading: true })
    await answer(reqs[1], ok(2))
    expect(m.last()).toMatchObject({ data: 2, loading: false })

    await m.rerender('listBooks', null)
    await React.act(async () => m.last().refetch())
    await flush()
    expect(reqs).toHaveLength(2)
    expect(m.last().loading).toBe(false)
  })

  it('WC-34 两个写入事件接连来、应答倒着回 → 最后是第二次请求的结果', async () => {
    const m = await mount('listBooks', {})
    await answer(reqs[0], ok('initial'))
    const es = onlySource()

    await emit(es, 'data', '{"op":"a","source":"user"}')
    await emit(es, 'data', '{"op":"b","source":"user"}')
    expect(reqs).toHaveLength(3)

    await answer(reqs[2], ok('second'))
    await answer(reqs[1], ok('first'))

    expect(m.last()).toMatchObject({ data: 'second', loading: false })
    expect(m.renders.some((r) => r.data === 'first')).toBe(false)
  })

  it('WC-35 取到 D1 → 重取失败 → {data:D1, error, loading:false}；再成功 → error 清掉', async () => {
    const m = await mount('listBooks', {})
    await answer(reqs[0], ok('D1'))
    const es = onlySource()

    await emit(es, 'data', '{"op":"x","source":"user"}')
    await answer(reqs[1], json(422, { error: { code: 'duplicate', message: 'Already there.' } }))
    const failed = m.last()
    expect(failed.data).toBe('D1')
    expect(failed.loading).toBe(false)
    expect(failed.error).toBeInstanceOf(W.WidgetError)
    expect(failed.error).toMatchObject({ code: 'duplicate', message: 'Already there.' })

    await emit(es, 'data', '{"op":"x","source":"user"}')
    expect(m.last()).toMatchObject({ data: 'D1', loading: true })
    await answer(reqs[2], ok('D2'))
    expect(m.last()).toMatchObject({ data: 'D2', error: undefined, loading: false })
  })

  it('WC-36 A 的失败不挂到 B 上；B 也失败 → B 的错误，数据是更早那组参数的（钉住）', async () => {
    const m = await mount('listBooks', { s: 'A' })
    await answer(reqs[0], ok('A-good'))
    await emit(onlySource(), 'data', '{"op":"x","source":"user"}')
    await answer(reqs[1], json(500, { error: { code: 'internal', message: 'A broke' } }))
    expect(m.last().error).toMatchObject({ code: 'internal' })

    await m.rerender('listBooks', { s: 'B' })
    expect(m.last()).toMatchObject({ data: 'A-good', error: undefined, loading: true })

    await answer(reqs[2], json(422, { error: { code: 'b_failed', message: 'B broke' } }))
    expect(m.last().error).toMatchObject({ code: 'b_failed', message: 'B broke' })
    expect(m.last()).toMatchObject({ data: 'A-good', loading: false })
  })

  it.each<[string, () => void, string]>([
    [
      '操作失败',
      () => (responder = () => json(422, { error: { code: 'duplicate', message: 'm' } })),
      'duplicate'
    ],
    [
      '令牌拒绝',
      () => (responder = () => json(403, { code: 'FORBIDDEN', message: 'm' })),
      'FORBIDDEN'
    ],
    ['不是 JSON', () => (responder = () => text(404, 'nope')), 'http_404'],
    ['200 原始值', () => (responder = () => json(200, 'ok')), 'http_200'],
    [
      '网络',
      () => fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('offline'))),
      'network'
    ]
  ])('WC-37 use 里的失败（%s）→ WidgetError，code 同 call', async (_l, arrange, code) => {
    arrange()
    const m = await mount('listBooks', {})
    await flush()
    expect(m.last().error).toBeInstanceOf(W.WidgetError)
    expect((m.last().error as { code: string }).code).toBe(code)
    expect(m.last().loading).toBe(false)
  })

  it.each(['resolve', 'reject'] as const)(
    'WC-38 在途时卸载，再 %s → 不改状态、不报错；最后一个订阅者 → 关流',
    async (how) => {
      const consoleError = vi.spyOn(console, 'error')
      const m = await mount('listBooks', {})
      const es = onlySource()
      const rendered = m.renders.length

      await m.unmount()
      expect(es.close).toHaveBeenCalledTimes(1)

      if (how === 'resolve') await answer(reqs[0], ok('late'))
      else await fail(reqs[0], new TypeError('late failure'))

      expect(m.renders).toHaveLength(rendered)
      expect(consoleError).not.toHaveBeenCalled()
    }
  )

  it('WC-39 StrictMode：被丢弃的第一次挂载的应答不算；最后只开着一条流', async () => {
    const m = await mount('listBooks', { s: 1 }, { strict: true })

    // 开发模式下 effect 跑两遍：两次请求、两条流（第一条已关）
    expect(reqs).toHaveLength(2)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.instances[1].close).not.toHaveBeenCalled()

    await answer(reqs[0], ok('discarded'))
    expect(m.last()).toMatchObject({ data: undefined, loading: true })
    await answer(reqs[1], ok('kept'))
    expect(m.last()).toMatchObject({ data: 'kept', error: undefined, loading: false })

    // 留下的那一条是活的
    await emit(FakeEventSource.instances[1], 'data', '{"op":"x","source":"user"}')
    expect(reqs).toHaveLength(3)
  })

  it('WC-40 换操作、参数一样：新操作回来之前 loading、不显示旧操作的错误', async () => {
    const m = await mount('listA', {})
    await answer(reqs[0], json(422, { error: { code: 'a_failed', message: 'A' } }))
    expect(m.last()).toMatchObject({ loading: false })
    expect(m.last().error).toMatchObject({ code: 'a_failed' })

    await m.rerender('listB', {})
    expect(reqs).toHaveLength(2)
    expect(reqs[1].url).toBe('api/listB')
    expect(m.last()).toMatchObject({ error: undefined, loading: true })

    await answer(reqs[1], ok('B'))
    expect(m.last()).toMatchObject({ data: 'B', error: undefined, loading: false })
  })

  it('WC-41 钉住：{x} 取到 → null → {x}：再取一次，其间 loading 仍是 false、显示之前的数据', async () => {
    const m = await mount('listBooks', { x: 1 })
    await answer(reqs[0], ok('first'))

    await m.rerender('listBooks', null)
    await m.rerender('listBooks', { x: 1 })

    expect(reqs).toHaveLength(2)
    expect(m.last()).toMatchObject({ data: 'first', error: undefined, loading: false })
    await answer(reqs[1], ok('second'))
    expect(m.last()).toMatchObject({ data: 'second', loading: false })
  })

  it('WC-42 编不成 JSON 的参数：渲染不抛，{error: invalid_args, loading:false}，不发请求；换回好参数照常取', async () => {
    const m = await mount('listBooks', { n: 1n })
    await flush()

    expect(reqs).toHaveLength(0)
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(m.last().loading).toBe(false)
    expect(m.last().data).toBeUndefined()
    expect(m.last().error).toBeInstanceOf(W.WidgetError)
    expect(m.last().error).toMatchObject({ code: 'invalid_args' })

    await m.rerender('listBooks', { n: 1 })
    expect(reqs.map((r) => r.body)).toEqual(['{"n":1}'])
    await answer(reqs[0], ok('good'))
    expect(m.last()).toMatchObject({ data: 'good', error: undefined, loading: false })

    // 之前取到的数据留着；不发请求
    await m.rerender('listBooks', { n: 2n })
    await flush()
    expect(reqs).toHaveLength(1)
    expect(m.last()).toMatchObject({ data: 'good', loading: false })
    expect(m.last().error).toMatchObject({ code: 'invalid_args' })
  })
})

// ═══════════════════════════════ onData ═══════════════════════════════

describe('onData', () => {
  it('WC-50 收到 {op, source}；不是字符串的转成字符串，缺的是 ""', async () => {
    const fn = vi.fn()
    const off = W.createClient().onData(fn)
    const es = onlySource()
    expect(es.url).toBe('sse')

    es.emit('data', '{"op":"addBook","source":"user"}')
    es.emit('data', '{"op":5}')
    es.emit('data', '{}')

    expect(fn.mock.calls).toEqual([
      [{ op: 'addBook', source: 'user' }],
      [{ op: '5', source: '' }],
      [{ op: '', source: '' }]
    ])
    // 只交回这两个字段
    expect(Object.keys(fn.mock.calls[0][0] as object)).toEqual(['op', 'source'])
    off()
  })

  it('WC-51 退订之后不再收到；重复退订不关别人还在用的流；最后一个退订才关', () => {
    const api = W.createClient()
    const a = vi.fn()
    const b = vi.fn()
    const offA = api.onData(a)
    const offB = api.onData(b)
    const es = onlySource()

    offA()
    offA()
    expect(es.close).not.toHaveBeenCalled()
    es.emit('data', '{"op":"x","source":"user"}')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)

    offB()
    expect(es.close).toHaveBeenCalledTimes(1)
    offB()
    expect(es.close).toHaveBeenCalledTimes(1)
  })

  it('WC-52 钉住：派发中一个监听者退订另一个 → 这一轮两个都收到，下一轮被退订的不再收到', () => {
    const api = W.createClient()
    // 留一个不相干的订阅者，免得流被关掉
    const keep = api.onData(() => {})
    let offB: () => void = () => {}
    const a = vi.fn(() => offB())
    const b = vi.fn()
    const offA = api.onData(a)
    offB = api.onData(b)
    const es = onlySource()

    es.emit('data', '{"op":"x","source":"user"}')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    es.emit('data', '{"op":"y","source":"user"}')
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    keep()
  })

  it('WC-53 一个监听者抛错：后面的监听者与 use 的重取照样跑；记一条 console.error', async () => {
    responder = () => ok(1)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = W.createClient()
    const boom = new Error('listener broke')
    const offA = api.onData(() => {
      throw boom
    })
    const b = vi.fn()
    const offB = api.onData(b)
    await mount('listBooks', {}, { api })
    await flush()
    expect(reqs).toHaveLength(1)

    await emit(onlySource(), 'data', '{"op":"addBook","source":"agent"}')
    await flush()

    expect(b).toHaveBeenCalledTimes(1)
    expect(reqs).toHaveLength(2)
    expect(consoleError.mock.calls).toEqual([['shuvix/widget: a data listener threw', boom]])
    offA()
    offB()
  })

  it('WC-54 两个 createClient() 共用一条流', async () => {
    const c1 = W.createClient()
    const c2 = W.createClient()
    const fn = vi.fn()
    const off = c1.onData(fn)
    await mount('listBooks', {}, { api: c2 })

    expect(onlySource().url).toBe('sse')
    await emit(onlySource(), 'data', '{"op":"x","source":"user"}')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(reqs).toHaveLength(2)
    off()
  })

  it('WC-55 没有 EventSource：onData / use 不抛，use 照样取一次', async () => {
    vi.stubGlobal('EventSource', undefined)
    responder = () => ok(['row'])
    const api = W.createClient()

    const off = api.onData(() => {})
    const m = await mount('listBooks', {}, { api })
    await flush()

    expect(reqs).toHaveLength(1)
    expect(m.last()).toMatchObject({ data: ['row'], error: undefined, loading: false })
    off()
    await m.unmount()
  })

  it('WC-56 页面自己的流（window.__shuvixEvents）：不另开；挂在它上面；最后一个走了只摘自己的监听、不关它', async () => {
    const page = new FakeEventSource('sse')
    ;(window as unknown as { __shuvixEvents: unknown }).__shuvixEvents = page
    FakeEventSource.instances = []
    responder = () => ok(1)
    const api = W.createClient()

    const fn = vi.fn()
    const off = api.onData(fn)
    const m = await mount('listBooks', {}, { api })
    await flush()
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(page.listenerCount('data')).toBe(1)

    await emit(page, 'data', '{"op":"addBook","source":"user"}')
    await flush()
    expect(fn.mock.calls).toEqual([[{ op: 'addBook', source: 'user' }]])
    expect(reqs).toHaveLength(2)

    off()
    await m.unmount()
    expect(page.listenerCount('data')).toBe(0)
    expect(page.close).not.toHaveBeenCalled()
  })

  it('WC-57 页面流上的 reload 监听不受影响；退订完再订阅 → 又挂回页面那一条，不新开', () => {
    const page = new FakeEventSource('sse')
    const reload = vi.fn()
    page.addEventListener('reload', reload)
    ;(window as unknown as { __shuvixEvents: unknown }).__shuvixEvents = page
    FakeEventSource.instances = []
    const api = W.createClient()

    const off1 = api.onData(() => {})
    off1()
    expect(page.listenerCount('reload')).toBe(1)
    expect(page.close).not.toHaveBeenCalled()

    const fn = vi.fn()
    const off2 = api.onData(fn)
    expect(FakeEventSource.instances).toHaveLength(0)
    page.emit('data', '{"op":"x","source":"agent"}')
    page.emit('reload', '')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
    off2()
    expect(page.close).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════ 主题 ═══════════════════════════════

describe('theme', () => {
  type Theme = { id: string; scheme: 'light' | 'dark' }

  interface FakeMql {
    matches: boolean
    listeners: Array<() => void>
    addEventListener: (type: string, fn: () => void) => void
    removeEventListener: (type: string, fn: () => void) => void
  }

  const html = (): HTMLElement => document.documentElement

  function fakeMedia(matches: boolean): FakeMql {
    const mql: FakeMql = {
      matches,
      listeners: [],
      addEventListener: (type, fn) => {
        if (type === 'change') mql.listeners.push(fn)
      },
      removeEventListener: (type, fn) => {
        if (type === 'change') mql.listeners = mql.listeners.filter((f) => f !== fn)
      }
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mql)
    )
    return mql
  }

  async function flipMedia(mql: FakeMql, dark: boolean): Promise<void> {
    await React.act(async () => {
      mql.matches = dark
      for (const fn of [...mql.listeners]) fn()
    })
  }

  async function themeEvent(attrs?: Record<string, string>): Promise<void> {
    await React.act(async () => {
      for (const [k, v] of Object.entries(attrs ?? {})) html().setAttribute(k, v)
      window.dispatchEvent(new CustomEvent('shuvix:theme'))
    })
  }

  async function mountTheme(): Promise<{
    renders: Theme[]
    last: () => Theme
    unmount: () => Promise<void>
  }> {
    const renders: Theme[] = []
    function Probe(): null {
      renders.push(W.useTheme())
      return null
    }
    const root = ReactDOM.createRoot(document.createElement('div'))
    roots.add(root)
    await React.act(async () => root.render(React.createElement(Probe)))
    return {
      renders,
      last: () => renders[renders.length - 1],
      unmount: async () => {
        await React.act(async () => root.unmount())
        roots.delete(root)
      }
    }
  }

  beforeEach(() => {
    html().removeAttribute('data-theme')
    html().removeAttribute('data-scheme')
  })

  afterEach(() => {
    html().removeAttribute('data-theme')
    html().removeAttribute('data-scheme')
  })

  it('WC-60 读 <html> 的两个属性；shuvix:theme 带来新值；什么都没变不多渲染', async () => {
    html().setAttribute('data-theme', 'nord')
    html().setAttribute('data-scheme', 'dark')
    const m = await mountTheme()
    expect(m.last()).toEqual({ id: 'nord', scheme: 'dark' })

    const n = m.renders.length
    await themeEvent({ 'data-theme': 'one-light', 'data-scheme': 'light' })
    expect(m.last()).toEqual({ id: 'one-light', scheme: 'light' })
    expect(m.renders).toHaveLength(n + 1)

    await themeEvent()
    await themeEvent()
    expect(m.renders).toHaveLength(n + 1)

    await themeEvent({ 'data-theme': 'dracula', 'data-scheme': 'dark' })
    expect(m.last()).toEqual({ id: 'dracula', scheme: 'dark' })
    expect(m.renders).toHaveLength(n + 2)
    await m.unmount()
  })

  it('WC-61 没有 data-scheme → 看媒体查询，id 是空串；媒体查询变了重渲染', async () => {
    const mql = fakeMedia(true)
    const m = await mountTheme()
    expect(m.last()).toEqual({ id: '', scheme: 'dark' })
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')

    await flipMedia(mql, false)
    expect(m.last()).toEqual({ id: '', scheme: 'light' })
    await m.unmount()
  })

  it('WC-61 data-scheme 不是 light / dark → 也看媒体查询', async () => {
    fakeMedia(true)
    html().setAttribute('data-theme', 'nord')
    html().setAttribute('data-scheme', 'blue')
    const m = await mountTheme()
    expect(m.last()).toEqual({ id: 'nord', scheme: 'dark' })
    await m.unmount()
  })

  it('WC-61 根本没有 matchMedia → light，不抛', async () => {
    vi.stubGlobal('matchMedia', undefined)
    const m = await mountTheme()
    expect(m.last()).toEqual({ id: '', scheme: 'light' })
    await themeEvent()
    expect(m.last()).toEqual({ id: '', scheme: 'light' })
    await m.unmount()
  })

  it('WC-62 没有 getSnapshot 的告警；卸载之后不再渲染、监听摘掉', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const mql = fakeMedia(false)
    html().setAttribute('data-theme', 'nord')
    html().setAttribute('data-scheme', 'dark')
    const m = await mountTheme()
    await themeEvent()
    await flipMedia(mql, true)
    await themeEvent({ 'data-theme': 'dracula' })
    expect(m.last()).toEqual({ id: 'dracula', scheme: 'dark' })
    expect(mql.listeners).toHaveLength(1)

    await m.unmount()
    expect(mql.listeners).toHaveLength(0)
    const n = m.renders.length
    await themeEvent({ 'data-theme': 'one-light', 'data-scheme': 'light' })
    await flipMedia(mql, false)
    expect(m.renders).toHaveLength(n)

    const messages = consoleError.mock.calls.map((c) => c.map(String).join(' '))
    expect(messages.filter((t) => /getSnapshot/.test(t))).toEqual([])
  })

  describe('WC-63 themeColor', () => {
    interface Probed {
      color: string
      display: string
      underHtml: boolean
      element: HTMLElement
    }
    let probed: Probed[]
    let rootValues: Record<string, string>
    let probeColor: string

    /** jsdom 的 getComputedStyle 读不出变量的值：换成假的（根 → 变量表；探针 → probeColor），并记下探针的样子 */
    function fakeComputedStyle(): void {
      vi.stubGlobal(
        'getComputedStyle',
        vi.fn((el: Element) => {
          if (el === html()) {
            return {
              getPropertyValue: (prop: string) => rootValues[prop] ?? ''
            } as unknown as CSSStyleDeclaration
          }
          const e = el as HTMLElement
          probed.push({
            color: e.style.color,
            display: e.style.display,
            underHtml: e.parentNode === html(),
            element: e
          })
          return { color: probeColor } as unknown as CSSStyleDeclaration
        })
      )
    }

    interface FakeCtx {
      canvas: { width: number; height: number }
      fillStyle: string
      fillRect: ReturnType<typeof vi.fn>
      getImageData: ReturnType<typeof vi.fn>
    }

    /** 2D 上下文换成假的：getImageData 交回 `data`；data 是 null = 没有上下文 */
    function fakeCanvas(data: number[] | null): {
      getContext: { mock: { calls: unknown[][] }; mockRestore: () => void }
      ctx: FakeCtx
    } {
      const ctx: FakeCtx = {
        canvas: { width: 300, height: 150 },
        fillStyle: '',
        fillRect: vi.fn(),
        getImageData: vi.fn(() => ({ data: Uint8ClampedArray.from(data ?? []) }))
      }
      const getContext = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockImplementation((() => (data ? ctx : null)) as never)
      return { getContext, ctx }
    }

    beforeEach(() => {
      probed = []
      rootValues = {
        '--widget-accent': ' var(--theme-accent)',
        '--x': 'red',
        '--widget-success': 'light-dark(oklch(59.6% 0.145 163.225), oklch(76.5% 0.177 163.223))',
        '--widget-viz-1-tint': 'color-mix(in srgb, var(--viz-1) 14%, transparent)'
      }
      probeColor = 'rgb(136, 192, 208)'
      fakeComputedStyle()
    })

    it('WC-63 名字 → 探 var(--widget-<名字>)；带 -- 的 → 探那个变量；探针用完移走；rgb 不碰画布', () => {
      const { getContext } = fakeCanvas(null)
      const before = html().childNodes.length

      expect(W.themeColor('accent')).toBe('rgb(136, 192, 208)')
      expect(probed).toHaveLength(1)
      expect(probed[0]).toMatchObject({
        color: 'var(--widget-accent)',
        display: 'none',
        underHtml: true
      })
      expect(probed[0].element.isConnected).toBe(false)

      probeColor = 'rgba(255, 0, 0, 0.5)'
      expect(W.themeColor('--x')).toBe('rgba(255, 0, 0, 0.5)')
      expect(probed[1]).toMatchObject({ color: 'var(--x)', display: 'none', underHtml: true })
      expect(probed[1].element.isConnected).toBe(false)

      expect(html().childNodes.length).toBe(before)
      expect(getContext.mock.calls).toEqual([])
    })

    it('WC-63 变量没定义 → 空串，不挂探针', () => {
      const append = vi.spyOn(html(), 'appendChild')
      expect(W.themeColor('nope')).toBe('')
      expect(W.themeColor('--nope')).toBe('')
      rootValues['--blank'] = '   '
      expect(W.themeColor('--blank')).toBe('')
      expect(append).not.toHaveBeenCalled()
      expect(probed).toEqual([])
    })

    it('WC-63 oklch / color(srgb …) → 画到一个像素上读回 rgb / rgba', () => {
      probeColor = 'oklch(0.765 0.177 163.223)'
      const opaque = fakeCanvas([0, 212, 146, 255])
      expect(W.themeColor('success')).toBe('rgb(0, 212, 146)')
      expect(opaque.ctx.fillStyle).toBe('oklch(0.765 0.177 163.223)')
      expect(opaque.ctx.fillRect).toHaveBeenCalledWith(0, 0, 1, 1)
      expect(opaque.ctx.getImageData).toHaveBeenCalledWith(0, 0, 1, 1)
      expect(opaque.ctx.canvas).toEqual({ width: 1, height: 1 })
      opaque.getContext.mockRestore()

      probeColor = 'color(srgb 0.224 0.529 0.89 / 0.14)'
      const translucent = fakeCanvas([57, 135, 227, 36])
      expect(W.themeColor('viz-1-tint')).toBe('rgba(57, 135, 227, 0.141)')
      expect(translucent.getContext.mock.calls[0][0]).toBe('2d')
    })

    it('WC-63 没有 2D 上下文 → 计算值原样交回', () => {
      probeColor = 'oklch(0.765 0.177 163.223)'
      fakeCanvas(null)
      expect(W.themeColor('success')).toBe('oklch(0.765 0.177 163.223)')
    })

    it('WC-63 jsdom 自己的画布（没有实现 getContext）→ 计算值原样交回，不抛', () => {
      probeColor = 'color(srgb 0.224 0.529 0.89 / 0.14)'
      // jsdom 会往控制台报一句 not implemented；这里只关心返回值
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(W.themeColor('viz-1-tint')).toBe('color(srgb 0.224 0.529 0.89 / 0.14)')
    })
  })
})
