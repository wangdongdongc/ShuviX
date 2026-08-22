import { appEventBus } from './appEventBus'

/**
 * 发布"会话配置已变更"事件（AppEvent 'session.configChanged'）。
 *
 * 触发场景:
 * - 工具允许列表(allowList)变化(命令询问"允许并记住" / 设置面板手动删除)
 * - LAN 分享开启/关闭
 * - Telegram 绑定切换
 *
 * 渲染端经 events.subscribe 监听,根据 sessionId 重新拉取该会话的设置并写回 chatStore。
 */
export function broadcastSessionConfigChanged(sessionId: string): void {
  appEventBus.publish({ type: 'session.configChanged', sessionId })
}

/**
 * 发布"会话标题已变更"事件（AppEvent 'session.titleChanged'）。
 *
 * 触发场景: AI 自动生成标题（首轮快速 / 精修）落库后。载荷带 title，各端消费者直接更新
 * 会话列表标题，无需回查——保证桌面/悬浮窗/扩展/Telegram 等所有端一致。
 */
export function broadcastSessionTitleChanged(sessionId: string, title: string): void {
  appEventBus.publish({ type: 'session.titleChanged', sessionId, title })
}
