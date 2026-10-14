import { AsyncLocalStorage } from 'node:async_hooks'
import { v4 as uuid } from 'uuid'
import type { ClientContext } from '../ipc/registry'

/** 操作来源 — 判别联合，新增前端只需添加新变体 */
export type OperationSource =
  | { type: 'electron' }
  | { type: 'telegram'; botId: string; userId: string; chatId: string }
  /** Chrome 扩展的侧边栏（经桥）：哪个浏览器（扩展安装 id） */
  | { type: 'chrome'; installId: string }
  /** 局域网里的浏览器（server mode phase B，经 WebSocket）：哪条连接、从哪来 */
  | { type: 'network'; clientId: string; remoteAddress: string }

/** 操作上下文 — 每次用户操作一个实例 */
export interface OperationContext {
  requestId: string
  source: OperationSource
  sessionId?: string
  timestamp: number
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
        source: { type: 'network', clientId: client.id, remoteAddress: client.remoteAddress },
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
