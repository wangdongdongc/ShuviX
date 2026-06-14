/**
 * ChatApi — 可复用聊天前端与后端之间的唯一接口契约。
 *
 * 聊天组件树（components/chat + 相关 hooks）只通过 `getChatApi()` 访问后端，
 * 不直接依赖 Electron 的全局 `window.api`。这样：
 *   - 桌面端（Electron preload）/ WebUI 通过暴露 `window.api` 自动满足契约；
 *   - 外部服务端项目可在挂载前 `setChatApi(myAdapter)` 注入自己的 HTTP/WS 实现。
 *
 * 当前 `ChatApi` 直接取自本仓库的全局 `ShuviXAPI`（零漂移：window.api 改了这里编译期即报错）。
 * 迁移到外部仓库时，将下面的 `Pick<ShuviXAPI, …>` 替换为独立声明的同形接口即可，
 * 取数点（getChatApi 调用）无需改动。
 */

/** 聊天前端实际依赖的 window.api 命名空间子集 */
export type ChatApiNamespace =
  | 'agent'
  | 'session'
  | 'message'
  | 'app'
  | 'provider'
  | 'tools'
  | 'settings'
  | 'command'
  | 'runtime'
  | 'compact'
  | 'webui'
  | 'telegram'
  | 'pinChat'
  | 'project'
  | 'update'

export type ChatApi = Pick<ShuviXAPI, ChatApiNamespace>

let injected: ChatApi | null = null

/** 由宿主在挂载聊天 UI 前注入后端实现（外部项目用；Electron/WebUI 走 window.api 回退） */
export function setChatApi(api: ChatApi): void {
  injected = api
}

/** 聊天组件树取后端的唯一入口 */
export function getChatApi(): ChatApi {
  if (injected) return injected
  const w = (globalThis as { window?: { api?: ChatApi } }).window
  if (w?.api) return w.api
  throw new Error(
    '[chat-ui] ChatApi 未提供：请在挂载前调用 setChatApi(api)，或在 Electron/WebUI 环境暴露 window.api'
  )
}
