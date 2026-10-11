import {
  useSessionInit,
  useSessionView,
  useAgentEvents,
  useModelCatalogSync
} from '@shuvix/chat-ui'
import { useFilePreviewBridge } from './useFilePreviewBridge'
import { useNotificationBridge } from './useNotificationBridge'

/**
 * 会话级运行时 hook 宿主。
 * useSessionInit / useAgentEvents 会读取 ChatHost 注入值，故必须渲染在 <ChatHostProvider> 之下。
 * useSessionView 订阅当前会话的视图（消息 / 流式卡 / 工具进度 / 询问 / 队列都从它来，P3-08）。
 * useFilePreviewBridge 把「打开文件预览」信号交给主进程开独立窗口（chat-ui 只发信号）；
 * useNotificationBridge 上报「在看哪个会话」并接收通知点击的跳转。
 */
export function SessionRuntime({ sessionId }: { sessionId: string | null }): null {
  useSessionView(sessionId)
  useSessionInit(sessionId)
  useAgentEvents()
  useModelCatalogSync()
  useFilePreviewBridge()
  useNotificationBridge()
  return null
}
