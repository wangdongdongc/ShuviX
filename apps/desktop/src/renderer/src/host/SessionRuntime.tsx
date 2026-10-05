import { useSessionInit, useSessionView, useAgentEvents, useModelCatalogSync } from '@shuvix/chat-ui'
import { useRightPanelBridge } from './useRightPanelBridge'
import { useNotificationBridge } from './useNotificationBridge'

/**
 * 会话级运行时 hook 宿主。
 * useSessionInit / useAgentEvents 会读取 ChatHost 注入值，故必须渲染在 <ChatHostProvider> 之下。
 * useSessionView 订阅当前会话的视图（消息 / 流式卡 / 工具进度 / 询问 / 队列都从它来，P3-08）。
 * useRightPanelBridge 是宿主外壳侧的右面板桥（对话框 chat-ui 不处理浏览器/sub-agent 面板）；
 * useNotificationBridge 上报「在看哪个会话」并接收通知点击的跳转。
 */
export function SessionRuntime({ sessionId }: { sessionId: string | null }): null {
  useSessionView(sessionId)
  useSessionInit(sessionId)
  useAgentEvents()
  useModelCatalogSync()
  useRightPanelBridge()
  useNotificationBridge()
  return null
}
