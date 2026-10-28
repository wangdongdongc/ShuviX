// Copied from ShuviX (src/renderer/src/widgetClient/widgetClient.ts) when ShuviX was built.
// `import ... from "shuvix/widget"` resolves here (see vite.config.ts). It calls `api/<operation>` and
// listens on `sse` relative to the page, which only ShuviX serves: see EXPORT_NOTES.md.
/**
 * `shuvix/widget` —— 组件界面调自己 API 的客户端（设计稿 docs/widget-tool-design.md §4）。
 *
 * **不是 ShuviX 自己界面的代码**：scripts/bundle-widget-api.mjs 把它打成 `resources/bundler/deps/widget.esm.js`，
 * 组件构建时打包器把 `import … from 'shuvix/widget'` 映射到那一份（和 React 一样是预置依赖，react 外置、与组件共用
 * 同一个 React 实例）。放在渲染层目录下只为借它的 DOM 类型检查与测试环境。
 *
 *   const api = createClient<typeof Api>()          // `import type Api from './api'`：只取类型，handler 不进浏览器
 *   const { data, error, loading } = api.use('listBooks', { status: 'want' })
 *   await api.call('addBook', { title })             // 失败抛 WidgetError（code + message）
 *
 * 地址一律相对：组件页面的 `<base href="/w/<id>/">` 把 `api/<op>`、`sse` 解析到这个组件自己的路由 —— 桌面、独立窗口、
 * 远程浏览器（网络服务按同一路径转发）都一样，不用知道组件 id、端口和令牌（令牌由宿主补在请求头上）。
 *
 * `use` 在任何一次提交了写的调用之后自动重取：服务端在 SSE 上推 `data` 事件（不管写的是这个界面、另一台设备上的
 * 界面，还是 agent）。用的是组件页面自己那条 EventSource（宿主页面挂在 `window.__shuvixEvents` 上，原来只收 reload）：
 * 所有组件都在同一个 127.0.0.1:<端口> 上，浏览器对一个主机只开 6 条 HTTP/1.1 连接，每页再开一条，开着几个组件就会把
 * 别的页面的请求挤住。没有那一条（测试、导出的独立项目）才自己开一条。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** 调用失败：`code` 是机器读的（`invalid_args`、handler 的 `ctx.fail` 码、`network` …），`message` 给人看 */
export class WidgetError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WidgetError'
    this.code = code
  }
}

// ───────────────────────── 类型：从 api.ts 的默认导出推出来 ─────────────────────────

/** zod v4 的 schema 在类型上带 `_zod.input` / `_zod.output` */
interface SchemaTypes {
  _zod: { input: unknown; output: unknown }
}

/** 没给类型参数时的记号：任何操作名、任何参数、unknown 结果 */
export interface LooseApi {
  readonly __shuvixLooseApi: true
}

type InputOf<O> = O extends { input: infer S }
  ? S extends SchemaTypes
    ? S['_zod']['input']
    : Record<string, unknown>
  : Record<string, unknown>

type HandlerResult<O> = O extends { handler: (...args: never[]) => infer R } ? Awaited<R> : unknown

/** 结果：给了 `output` 就是它校验之后的形状（服务端按它解析，界面拿到的是 output 那一侧），否则是 handler 的返回值 */
type OutputOf<O> = O extends { output?: infer S }
  ? [NonNullable<S>] extends [never]
    ? HandlerResult<O>
    : NonNullable<S> extends SchemaTypes
      ? NonNullable<S>['_zod']['output']
      : HandlerResult<O>
  : HandlerResult<O>

type OpNames<A> = A extends LooseApi ? string : Extract<keyof A, string>

type ResultOf<A, K> = A extends LooseApi ? unknown : K extends keyof A ? OutputOf<A[K]> : unknown

/** 参数：输入里有必填的键就必须给，全是可选的才能省略 */
type ArgsOf<A, K> = A extends LooseApi
  ? [args?: unknown]
  : K extends keyof A
    ? Record<string, never> extends InputOf<A[K]>
      ? [args?: InputOf<A[K]>]
      : [args: InputOf<A[K]>]
    : [args?: unknown]

/** `use` 的参数：同上，另外可以是 null（先不取） */
type UseArgsOf<A, K> = A extends LooseApi
  ? [args?: unknown]
  : K extends keyof A
    ? Record<string, never> extends InputOf<A[K]>
      ? [args?: InputOf<A[K]> | null]
      : [args: InputOf<A[K]> | null]
    : [args?: unknown]

/** `use` 交回的状态 */
export interface UseResult<T> {
  /** 最近一次成功取到的结果（重取期间留着上一份，不闪空） */
  data: T | undefined
  /** 最近一次失败；成功一次就清掉 */
  error: WidgetError | undefined
  /** 正在取（第一次，或参数变了、有写入之后的重取） */
  loading: boolean
  /** 手动重取 */
  refetch: () => void
}

export interface WidgetClient<A> {
  /** 调一个操作：成功交回它的返回值，失败抛 WidgetError */
  call<K extends OpNames<A>>(op: K, ...args: ArgsOf<A, K>): Promise<ResultOf<A, K>>
  /**
   * React hook：挂载时、参数变了、以及任何写操作提交之后取一次。`args` 为 null 时不取（等条件齐了再取）。
   * 参数按 JSON 比较，每次渲染新建一个同样的对象不会引起重取
   */
  use<K extends OpNames<A>>(op: K, ...args: UseArgsOf<A, K>): UseResult<ResultOf<A, K>>
  /** 有写入提交时回调（`op` = 写的那个操作，`source` = `user` / `agent`）；交回取消订阅 */
  onData(listener: (change: DataChange) => void): () => void
}

/** SSE `data` 事件的内容 */
export interface DataChange {
  op: string
  source: string
}

// ───────────────────────── 调用 ─────────────────────────

/** 参数编成 JSON；编不了（BigInt、循环引用）→ WidgetError('invalid_args') */
function encodeArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {})
  } catch (e) {
    throw new WidgetError(
      'invalid_args',
      `The arguments cannot be sent as JSON: ${(e as Error)?.message ?? String(e)}`
    )
  }
}

async function callOp(op: string, args: unknown): Promise<unknown> {
  return send(op, encodeArgs(args))
}

async function send(op: string, body: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`api/${encodeURIComponent(op)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    })
  } catch (e) {
    throw new WidgetError('network', (e as Error)?.message || 'The request failed.')
  }
  let reply: unknown
  try {
    reply = await res.json()
  } catch {
    throw new WidgetError(`http_${res.status}`, `The widget answered ${res.status} without JSON.`)
  }
  // 应答不是对象（一个字符串、一个数）：当作答得不对，不在 `in` 上抛 TypeError
  const obj = (typeof reply === 'object' && reply !== null ? reply : {}) as {
    result?: unknown
    error?: unknown
    code?: unknown
    message?: unknown
  }
  if (res.ok && 'result' in obj) return obj.result
  // 操作失败是 `{ error: { code, message } }`；令牌不对之类的拒绝是 `{ code, message }`
  const err = (obj.error ?? obj) as { code?: unknown; message?: unknown }
  throw new WidgetError(
    typeof err.code === 'string' ? err.code : `http_${res.status}`,
    typeof err.message === 'string' ? err.message : `The widget answered ${res.status}.`
  )
}

// ───────────────────────── 写入事件（页面那一条 EventSource） ─────────────────────────

const listeners = new Set<(change: DataChange) => void>()
let source: EventSource | null = null
/** `source` 是这里开的（要关），还是页面的（不能关：它还管 reload） */
let ownSource = false

function onDataEvent(event: Event): void {
  let change: DataChange = { op: '', source: '' }
  try {
    const parsed = JSON.parse((event as MessageEvent<string>).data) as Partial<DataChange>
    change = { op: String(parsed?.op ?? ''), source: String(parsed?.source ?? '') }
  } catch {
    // 内容坏了也照样当作「有写入」：宁可多取一次
  }
  // 一个监听者抛错不拦着别的（`use` 的重取也在里面），也不冒到页面的 onerror 把整个界面换成错误页
  for (const fn of [...listeners]) {
    try {
      fn(change)
    } catch (e) {
      console.error('shuvix/widget: a data listener threw', e)
    }
  }
}

function subscribe(listener: (change: DataChange) => void): () => void {
  listeners.add(listener)
  if (!source) {
    const shared =
      typeof window === 'undefined'
        ? undefined
        : (window as unknown as { __shuvixEvents?: EventSource }).__shuvixEvents
    if (shared) {
      source = shared
      ownSource = false
    } else if (typeof EventSource !== 'undefined') {
      source = new EventSource('sse')
      ownSource = true
    }
    source?.addEventListener('data', onDataEvent)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && source) {
      source.removeEventListener('data', onDataEvent)
      if (ownSource) source.close()
      source = null
      ownSource = false
    }
  }
}

// ───────────────────────── 客户端 ─────────────────────────

function toWidgetError(error: unknown): WidgetError {
  return error instanceof WidgetError ? error : new WidgetError('internal', String(error))
}

/** `client.use` 本体（直接交给 `use`，中间不套一层：它是 hook） */
function useWidgetOp(op: string, args?: unknown): UseResult<unknown> {
  // 参数编成 JSON（按它比较）；null = 先不取；编不了 = 这一组参数本身就是错的
  let json: string | null = null
  let argsError: WidgetError | undefined
  if (args !== null) {
    try {
      json = encodeArgs(args)
    } catch (e) {
      argsError = e as WidgetError
    }
  }
  // `key` 记的是这份结果属于哪个操作的哪一组参数：变了，结果还没回来之前就是在取（loading），上一份留着不闪空
  const key = json === null ? null : `${op}\u0000${json}`
  const [state, setState] = useState<{
    key: string | null
    data: unknown
    error: WidgetError | undefined
    refreshing: boolean
  }>({ key: null, data: undefined, error: undefined, refreshing: false })
  // 只认最后发出的那一次：参数连着变、写入事件连着来时，早发的晚回来不能盖掉晚发的
  const latest = useRef(0)
  const live = useRef(true)

  // 发一次请求；只在结果回来时（异步）改状态
  const request = useCallback(() => {
    if (key === null || json === null) return
    const ticket = ++latest.current
    send(op, json).then(
      (data) => {
        if (live.current && ticket === latest.current) {
          setState({ key, data, error: undefined, refreshing: false })
        }
      },
      (error: unknown) => {
        if (live.current && ticket === latest.current) {
          setState((s) => ({ key, data: s.data, error: toWidgetError(error), refreshing: false }))
        }
      }
    )
  }, [op, json, key])

  // 重取（写入事件、手动）：先标上正在取，再发请求
  const refetch = useCallback(() => {
    if (key === null) return
    setState((s) => (s.refreshing ? s : { ...s, refreshing: true }))
    request()
  }, [key, request])

  useEffect(() => {
    live.current = true
    if (key === null) {
      // 不取：在途的那一次作废
      latest.current++
      return () => {
        live.current = false
      }
    }
    request()
    const off = subscribe(() => refetch())
    return () => {
      live.current = false
      off()
    }
  }, [key, request, refetch])

  if (argsError) return { data: state.data, error: argsError, loading: false, refetch }
  return {
    data: state.data,
    // 上一组参数的失败不挂到这一组上
    error: state.key === key ? state.error : undefined,
    loading: key !== null && (state.key !== key || state.refreshing),
    refetch
  }
}

/** 建一个客户端。类型参数给 `typeof Api`（`import type Api from './api'`）就有操作名、参数、结果的类型 */
export function createClient<A = LooseApi>(): WidgetClient<A> {
  return {
    call: ((op: string, args?: unknown) => callOp(op, args)) as WidgetClient<A>['call'],
    use: useWidgetOp as WidgetClient<A>['use'],
    onData: (listener) => subscribe(listener)
  }
}
