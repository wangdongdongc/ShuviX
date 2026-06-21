/**
 * ChatApi — 可复用聊天前端与后端之间的唯一接口契约。
 *
 * 聊天组件树（components/chat + 相关 hooks）只通过 `getChatApi()` 访问后端，
 * 不直接依赖任何宿主的全局 `window.api`。这样：
 *   - 桌面端（Electron preload）/ WebUI 通过暴露 `window.api` 满足契约；
 *   - 外部宿主（Chrome 扩展、HTTP/WS 服务端）在挂载前 `setChatApi(myAdapter)` 注入实现。
 *
 * 契约本身（接口与协议数据形状）定义在 `@shuvix/chat-protocol/chatApi`，与 ChatEvent /
 * ChatMessage 并列为前↔后端协议的单一来源。Electron 侧通过编译期断言保证 window.api
 * 结构满足该契约（见 apps/desktop/src/preload/chatApiContract.ts），零漂移。
 */
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'

export type { ChatApi }

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
