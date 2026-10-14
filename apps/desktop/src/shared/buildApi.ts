/**
 * 由通道表建出 `window.api`（server mode phase A，docs/server/phase-a-channel-registry.md §2）。
 *
 * `buildApi(table, transport, overrides)`：表里每个条目按种类变成一个函数（invoke → `transport.invoke`，
 * send → `transport.send`，event → `transport.on` 返回注销函数），再把宿主的 override 并进各命名空间
 * （override 与表条目同名直接抛错 —— 一个成员只能有一个来源）。建出来的是纯对象：命名空间对象里只有函数
 * （外加 `app.platform` 这样的 override 值），`contextBridge` 照旧能整个拷过去。
 *
 * `createCommonOverrides(transport)` 是与宿主无关的那几个 override（`events.subscribe` 扇出、`liveDoc.respond`
 * 打包、`knowledge.baseOptions` 缺省）；`app.platform` 与 `sync` 由各宿主自己给（preload：`process.platform`、
 * `createSyncBridge(ipcRenderer)`）。
 */
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { LiveDocResult } from '@shuvix/chat-protocol/liveDocument'
import type { SyncLinkChannel } from '@shuvix/chat-protocol/sync'
import {
  API_OVERRIDE_CHANNELS,
  type API_TABLE,
  type ApiArity,
  type ApiMember,
  type ApiTable
} from './apiTable'

/** 建 API 要的传输：Electron 的 preload 包一层 ipcRenderer，phase C 的浏览器包一条 WebSocket */
export interface ApiTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  /** 订阅一条推送通道；监听器只收载荷。返回注销函数 */
  on(channel: string, listener: (...payload: unknown[]) => void): () => void
}

/** override 的形状：命名空间 → 成员对象（成员是函数，或 `app.platform` 那样的值） */
export type ApiOverrides = { readonly [ns: string]: object }

/**
 * 表条目建出来的成员的类型。故意取最宽的形状，让 `const api: ShuviXAPI = buildApi(…)` 只核对**结构**（成员在不在、
 * 是哪一种调用）：invoke 回 `Promise<never>`（可赋给任何 `Promise<T>`），event 的回调参数是 `never[]`（任何回调都能交）。
 * 参数个数与声明是否一致由守卫测试另外核对。
 */
export type ApiMemberFn<M> = M extends { readonly kind: 'invoke' }
  ? (...args: unknown[]) => Promise<never>
  : M extends { readonly kind: 'send' }
    ? (...args: unknown[]) => void
    : M extends { readonly kind: 'event' }
      ? (callback: (...payload: never[]) => void) => () => void
      : never

type TableApi<T extends ApiTable> = {
  -readonly [NS in keyof T]: { -readonly [K in keyof T[NS]]: ApiMemberFn<T[NS][K]> }
}

type Empty = Record<never, never>

/** 表 + override 建出来的对象的类型 */
export type BuiltApi<T extends ApiTable, O extends ApiOverrides> = {
  -readonly [NS in keyof T | keyof O]: (NS extends keyof T ? TableApi<T>[NS] : Empty) &
    (NS extends keyof O ? { -readonly [K in keyof O[NS]]: O[NS][K] } : Empty)
}

/** 恰好转发 n 个参数：多的丢掉、少的补 undefined（与改造前显式列出形参的成员一致） */
function forwarded(given: readonly unknown[], n: ApiArity): unknown[] {
  return Array.from({ length: n }, (_, i) => given[i])
}

function memberFn(member: ApiMember, transport: ApiTransport): (...args: unknown[]) => unknown {
  const { channel, args } = member
  switch (member.kind) {
    case 'invoke':
      return (...given) => transport.invoke(channel, ...forwarded(given, args))
    case 'send':
      return (...given) => {
        transport.send(channel, ...forwarded(given, args))
      }
    case 'event':
      return (callback) => {
        const cb = callback as (...payload: unknown[]) => void
        return transport.on(
          channel,
          args === 0 ? () => cb() : (...payload) => cb(...forwarded(payload, args))
        )
      }
  }
}

export function buildApi<T extends ApiTable, O extends ApiOverrides>(
  table: T,
  transport: ApiTransport,
  overrides: O
): BuiltApi<T, O> {
  const api: Record<string, Record<string, unknown>> = {}
  for (const [ns, members] of Object.entries(table)) {
    const target: Record<string, unknown> = {}
    for (const [name, member] of Object.entries(members)) target[name] = memberFn(member, transport)
    api[ns] = target
  }
  for (const [ns, members] of Object.entries(overrides)) {
    const target = (api[ns] ??= {})
    for (const [name, value] of Object.entries(members)) {
      if (name in target) throw new Error(`api.${ns}.${name} is both a table entry and an override`)
      target[name] = value
    }
  }
  return api as BuiltApi<T, O>
}

/**
 * `events.subscribe` 的扇出：整页只在 `app:event` 上挂**一个**监听（第一次订阅时），再派发给本地订阅者集合。
 * 否则每个 events.subscribe（= 每个 useAppEvent）都会新挂一个监听，>10 个并存时触发 MaxListenersExceededWarning，
 * 1:1 累积本身也是浪费。单监听在页面生命周期内常驻，无需回收。
 */
function createAppEventFanOut(
  transport: ApiTransport
): (callback: (event: AppEvent) => void) => () => void {
  const listeners = new Set<(event: AppEvent) => void>()
  let bridged = false
  return (callback) => {
    if (!bridged) {
      bridged = true
      transport.on(API_OVERRIDE_CHANNELS.events.subscribe.channel, (event) => {
        // 复制一份再派发：回调内退订不影响本轮
        for (const cb of [...listeners]) {
          try {
            cb(event as AppEvent)
          } catch {
            /* 单个订阅者抛错不影响其它 */
          }
        }
      })
    }
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  }
}

/** 与宿主无关的 override（type 而非 interface：要满足 `ApiOverrides` 的索引签名） */
export type CommonApiOverrides = {
  events: { subscribe: (callback: (event: AppEvent) => void) => () => void }
  liveDoc: {
    respond: (requestId: string, result: LiveDocResult) => Promise<{ success: boolean }>
  }
  knowledge: {
    baseOptions: (params?: { sessionId?: string }) => Promise<{
      options: { name: string; label: string }[]
      selected: string[]
      explicit: boolean
    }>
  }
}

/** 桌面 preload 交给 `buildApi` 的 override（公共的 + 本宿主的平台与视图同步桥） */
export type DesktopApiOverrides = CommonApiOverrides & {
  app: { platform: 'darwin' | 'win32' | 'linux' }
  sync: SyncLinkChannel
}

/** 桌面 preload 建出来的 `window.api` 的类型（类型守卫拿它与 `ShuviXAPI` 对上） */
export type DesktopApi = BuiltApi<typeof API_TABLE, DesktopApiOverrides>

/** 浏览器里的 web 客户端交给 `buildApi` 的 override（公共的 + 平台 'web' + WebSocket 上的视图同步渠道） */
export type WebApiOverrides = CommonApiOverrides & {
  app: { platform: 'web' }
  sync: SyncLinkChannel
}

/** web 客户端建出来的 `window.api` 的类型 */
export type WebApi = BuiltApi<typeof API_TABLE, WebApiOverrides>

/** 与宿主无关的 override（每次调用各建一份状态 —— 一页建一次） */
export function createCommonOverrides(transport: ApiTransport): CommonApiOverrides {
  return {
    events: { subscribe: createAppEventFanOut(transport) },
    liveDoc: {
      respond: (requestId, result) =>
        transport.invoke(API_OVERRIDE_CHANNELS.liveDoc.respond.channel, {
          requestId,
          result
        }) as Promise<{ success: boolean }>
    },
    knowledge: {
      baseOptions: (params) =>
        transport.invoke(
          API_OVERRIDE_CHANNELS.knowledge.baseOptions.channel,
          params ?? {}
        ) as Promise<{
          options: { name: string; label: string }[]
          selected: string[]
          explicit: boolean
        }>
    }
  }
}
