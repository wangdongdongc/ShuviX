import { AsyncLocalStorage } from 'node:async_hooks'
import { v4 as uuid } from 'uuid'

/** 操作来源 — 判别联合，新增前端只需添加新变体 */
export type OperationSource =
  | { type: 'electron' }
  | { type: 'webui'; ip: string; userAgent?: string; frontendId: string }
  | { type: 'telegram'; botId: string; userId: string; chatId: string }

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

/** 工厂：WebUI HTTP/WS 上下文 */
export function createWebUIContext(
  ip: string,
  frontendId: string,
  sessionId?: string,
  userAgent?: string
): OperationContext {
  return {
    requestId: uuid(),
    source: { type: 'webui', ip, frontendId, userAgent },
    sessionId,
    timestamp: Date.now()
  }
}
