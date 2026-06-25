import { appEventBus } from './appEventBus'

/**
 * 发布"会话配置已变更"事件（AppEvent 'session.configChanged'）。
 *
 * 触发场景:
 * - 工具允许列表(allowList)变化(命令审批"允许并记住" / 设置面板手动删除)
 * - LAN 分享开启/关闭
 * - Telegram 绑定切换
 *
 * 渲染端经 events.subscribe 监听,根据 sessionId 重新拉取该会话的设置并写回 chatStore。
 */
export function broadcastSessionConfigChanged(sessionId: string): void {
  appEventBus.publish({ type: 'session.configChanged', sessionId })
}
