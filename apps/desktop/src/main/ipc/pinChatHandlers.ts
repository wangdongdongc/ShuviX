import { defineHandler } from './registry'
import * as pinnedChatService from '../services/pinnedChatService'

/**
 * 悬浮聊天（Floating Pin Chat）IPC 处理器
 *
 * 多窗模型：每个 sessionId 对应一个独立的悬浮窗口；多个会话可同时悬浮、并行运行 Agent。
 * pin / unpin / focus 都按 sessionId 操作；getState 返回当前所有正在悬浮的 sessionId。
 */
export function registerPinChatHandlers(): void {
  defineHandler('pinChat:pin', async (_ctx, sessionId: string) => {
    await pinnedChatService.pin(sessionId)
    return { success: true }
  })

  defineHandler('pinChat:unpin', async (_ctx, sessionId: string) => {
    await pinnedChatService.unpin(sessionId, 'user')
    return { success: true }
  })

  defineHandler('pinChat:focus', (_ctx, sessionId: string) => {
    pinnedChatService.focusFloating(sessionId)
    return { success: true }
  })

  defineHandler('pinChat:getState', () => {
    return pinnedChatService.getState()
  })

  /** 切换悬浮窗"始终置顶"特性,关闭后窗口降为普通窗口 */
  defineHandler('pinChat:setAlwaysOnTop', (_ctx, params: { sessionId: string; value: boolean }) => {
    return { alwaysOnTop: pinnedChatService.setAlwaysOnTop(params.sessionId, params.value) }
  })

  defineHandler('pinChat:getAlwaysOnTop', (_ctx, sessionId: string) => {
    return { alwaysOnTop: pinnedChatService.getAlwaysOnTop(sessionId) }
  })
}
