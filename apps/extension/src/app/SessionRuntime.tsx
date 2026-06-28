import { useSessionInit, useAgentEvents, useModelCatalogSync } from '@shuvix/chat-ui'

/** 会话级运行时 hook 宿主（须在 ChatHostProvider 之下） */
export function SessionRuntime({ sessionId }: { sessionId: string | null }): null {
  useSessionInit(sessionId)
  useAgentEvents()
  useModelCatalogSync()
  return null
}
