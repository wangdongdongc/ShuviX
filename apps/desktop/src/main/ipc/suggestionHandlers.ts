import { defineHandler } from './registry'
import { chatGateway, operationContext, createClientContext } from '../frontend'
import { suggestionRefOf } from '@shuvix/chat-protocol/types/inputOrigin'
import type {
  AcceptSuggestionResult,
  SuggestionAcceptParams
} from '@shuvix/chat-protocol/suggestions'

/**
 * 提议（`suggest` 工具）IPC —— 采纳一条：载荷只是「哪条会话的哪一条」，要发的话由网关从会话里取，来源按这次调用的
 * 连接盖章（本机窗口 / 远程连接），载荷碰不到
 */
export function registerSuggestionHandlers(): void {
  defineHandler(
    'suggestion:accept',
    (
      ctx,
      params: SuggestionAcceptParams
    ): Promise<AcceptSuggestionResult> | AcceptSuggestionResult => {
      const ref = suggestionRefOf(params)
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
      if (!ref || !sessionId) return { success: false, reason: 'not-found' }
      return operationContext.run(createClientContext(ctx, sessionId), () =>
        chatGateway.acceptSuggestion(sessionId, ref)
      )
    }
  )
}
