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
import type { ChatApi, SessionChannelApi, HostApi } from '@shuvix/chat-protocol/chatApi'
import type { ChannelBindingApi } from '@shuvix/chat-protocol/channelBindingApi'

export type { ChatApi, SessionChannelApi, HostApi, ChannelBindingApi }

let injected: ChatApi | null = null
let injectedSessionChannel: SessionChannelApi | null = null

/** 由完整宿主注入后端实现（外部项目用；Electron/WebUI 走 window.api 回退） */
export function setChatApi(api: ChatApi): void {
  injected = api
}

/**
 * 由「渠道端」（如 WebUI 局域网分享、Telegram、扩展）注入**仅** SessionChannelApi 实现。
 * 此时 getHostApi() 返回 null，宿主管理类 UI（模型/项目/设置/绑定…）自动隐藏。
 */
export function setSessionChannelApi(api: SessionChannelApi): void {
  injectedSessionChannel = api
}

/** 取 window.api（桌面/WebUI Electron 环境），无则 undefined */
function windowApi(): ChatApi | undefined {
  return (globalThis as { window?: { api?: ChatApi } }).window?.api
}

/**
 * 完整宿主入口 —— 仅供宿主壳（app-shell / 桌面 renderer）使用。
 * 渠道端（仅 setSessionChannelApi）下不可用，应改用 getSessionChannelApi() / getHostApi()。
 */
export function getChatApi(): ChatApi {
  if (injected) return injected
  const w = windowApi()
  if (w) return w
  throw new Error(
    '[chat-ui] ChatApi 未提供：请在挂载前调用 setChatApi(api)，或在 Electron/WebUI 环境暴露 window.api'
  )
}

/**
 * 单会话渠道入口 —— 对话核心（消息/发送/事件/文件预览）的唯一后端入口，所有端都可用。
 * 优先级：渠道注入 > 完整 ChatApi 注入（超集）> window.api。
 */
export function getSessionChannelApi(): SessionChannelApi {
  if (injectedSessionChannel) return injectedSessionChannel
  if (injected) return injected
  const w = windowApi()
  if (w) return w
  throw new Error(
    '[chat-ui] SessionChannelApi 未提供：请调用 setSessionChannelApi(api) / setChatApi(api)，或暴露 window.api'
  )
}

/**
 * 宿主管理能力入口 —— 可空。返回 null 表示当前端是「渠道」，不具备应用级管理能力。
 * 消费方须降级：`getHostApi()?.provider.listAll()`，并据此显隐对应 UI。
 */
export function getHostApi(): HostApi | null {
  if (injected) return injected
  return windowApi() ?? null
}

// ── 会话渠道绑定（webui / telegram）—— 与 ChatApi 正交的可选能力轴 ──

let injectedBindings: ChannelBindingApi | null = null

/**
 * 由宿主注入「渠道绑定」实现（可选能力轴）。
 * 桌面 / WebUI 的 window.api 已结构化满足 ChannelBindingApi，无需显式注入；
 * 扩展等宿主可注入仅含其支持渠道（如只 telegram）的部分实现。
 */
export function setChannelBindingApi(api: ChannelBindingApi): void {
  injectedBindings = api
}

/**
 * 取「渠道绑定」实现 —— 返回 null 表示当前宿主不支持任何渠道绑定。
 * 消费方须做能力降级：`getChannelBindingApi()?.webui?.setShared(...)`。
 */
export function getChannelBindingApi(): ChannelBindingApi | null {
  if (injectedBindings) return injectedBindings
  const w = (globalThis as { window?: { api?: ChannelBindingApi } }).window
  return w?.api ?? null
}
