import { AsyncLocalStorage } from 'node:async_hooks'
import { v4 as uuid } from 'uuid'
import type { HumanOrigin, SuggestionRef } from '@shuvix/chat-protocol/types/inputOrigin'
import type { ClientContext } from '../ipc/registry'

/** 操作来源 — 判别联合，新增前端只需添加新变体 */
export type OperationSource =
  | { type: 'electron' }
  | { type: 'telegram'; botId: string; userId: string; chatId: string }
  /** Chrome 扩展的侧边栏（经桥）：哪个浏览器（扩展安装 id） */
  | { type: 'chrome'; installId: string }
  /** 局域网里的浏览器（server mode phase B，经 WebSocket）：哪条连接、从哪来、哪个浏览器（User-Agent，没有就缺省） */
  | { type: 'network'; clientId: string; remoteAddress: string; userAgent?: string }

/** 操作上下文 — 每次用户操作一个实例 */
export interface OperationContext {
  requestId: string
  source: OperationSource
  sessionId?: string
  timestamp: number
  /**
   * 这次操作是采纳一条提议（`suggestion:accept`）：它送进会话的输入在来源上带上提议引用 —— 人点的，文字是 agent 写的。
   * 只有主进程在核对过那条提议之后才设它（见 DefaultChatGateway.acceptSuggestion），请求载荷碰不到
   */
  suggestion?: SuggestionRef
}

/** 全局 AsyncLocalStorage 实例 */
export const operationContext = new AsyncLocalStorage<OperationContext>()

/** 读取当前上下文（run() 外返回 undefined） */
export function getOperationContext(): OperationContext | undefined {
  return operationContext.getStore()
}

/** 工厂：Electron IPC 上下文 */
export function createElectronContext(sessionId?: string): OperationContext {
  return { requestId: uuid(), source: { type: 'electron' }, sessionId, timestamp: Date.now() }
}

/**
 * 工厂：渠道注册表（`ipc/registry`）里一次调用的上下文。来源标签按调用方取：桌面窗口（IPC）与
 * `createElectronContext` 同一个 `{ type: 'electron' }`；网络客户端另打 `{ type: 'network', clientId, remoteAddress }`。
 */
export function createClientContext(ctx: ClientContext, sessionId?: string): OperationContext {
  const client = ctx.client
  switch (client.kind) {
    case 'window':
      return createElectronContext(sessionId)
    case 'network':
      return {
        requestId: uuid(),
        source: {
          type: 'network',
          clientId: client.id,
          remoteAddress: client.remoteAddress,
          ...(client.userAgent ? { userAgent: client.userAgent } : {})
        },
        sessionId,
        timestamp: Date.now()
      }
  }
}

/** 工厂：Chrome 侧边栏上下文 */
export function createChromeContext(installId: string, sessionId?: string): OperationContext {
  return {
    requestId: uuid(),
    source: { type: 'chrome', installId },
    sessionId,
    timestamp: Date.now()
  }
}

/** 工厂：Telegram Bot 上下文 */
export function createTelegramContext(
  botId: string,
  userId: string,
  chatId: string,
  sessionId?: string
): OperationContext {
  return {
    requestId: uuid(),
    source: { type: 'telegram', botId, userId, chatId },
    sessionId,
    timestamp: Date.now()
  }
}

/**
 * 一次操作的来源 → 它送进会话的输入记下的来源（`InputOrigin`，会话存储的 `SourceDoc`）：宿主按连接盖章，渲染端、
 * 网络客户端递来的参数碰不到这一项
 */
export function humanOriginOf(source: OperationSource): HumanOrigin {
  switch (source.type) {
    case 'electron':
      return { kind: 'local' }
    case 'network':
      return {
        kind: 'remote',
        clientId: source.clientId,
        address: source.remoteAddress,
        ...(source.userAgent ? { userAgent: source.userAgent } : {})
      }
    case 'chrome':
      return source.installId ? { kind: 'chrome', installId: source.installId } : { kind: 'chrome' }
    case 'telegram':
      return {
        kind: 'telegram',
        botId: source.botId,
        userId: source.userId,
        chatId: source.chatId
      }
  }
}

/** 此刻这次操作（`operationContext.run` 之内）送进会话的输入的来源；不在任何操作里（主进程自己发的）→ undefined */
export function currentInputOrigin(): HumanOrigin | undefined {
  const ctx = getOperationContext()
  if (ctx === undefined) return undefined
  const origin = humanOriginOf(ctx.source)
  return ctx.suggestion === undefined ? origin : { ...origin, suggestion: { ...ctx.suggestion } }
}

/** 渠道注册表里一次调用（`ipc/registry`）送进会话的输入的来源：不经 AsyncLocalStorage，按调用方直接取 */
export function inputOriginOfClient(ctx: ClientContext): HumanOrigin {
  return humanOriginOf(createClientContext(ctx).source)
}
