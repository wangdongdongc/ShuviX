/**
 * 视图同步用到的视图值（phase 3，P3-04；pi 1.2 起服务定义换成 `viewContracts.ts` 的 chord2 契约）。
 *
 * 宿主无关、浏览器安全：只依赖 chord 根入口与 chat-protocol。
 */
import { copyJson, type JsonValue } from '@earendil-works/chord'
import {
  capabilitiesOfStorageKind,
  HARNESS_V3_JSONL
} from '@shuvix/chat-protocol/sessionStorageKind'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'

/** 一个同步目标的视图：会话（SessionView）或派生 agent（AgentView） */
export type SyncView = SessionView | AgentView

/** 旧格式会话的冻结投影结果（桌面的 `readLegacyTranscript` 返回值满足它） */
export interface LegacyTranscript {
  readonly messages: readonly ChatMessage[]
}

/**
 * 旧格式（harness-v3-jsonl）会话的视图：只读（三项能力都关，取自存储类型能力表），没有对话 id、没有实时卡、不会再变。
 * 消息原样来自冻结投影，先 `copyJson` 去掉 `undefined` 属性（旧投影会写 `images: undefined` 这类键，chord 只收
 * 严格 JSON），拷贝也保证视图不与调用方的对象共享容器。
 */
export function legacySessionView(sessionId: string, transcript: LegacyTranscript): SessionView {
  return {
    v: 1,
    sessionId,
    source: 'legacy',
    capabilities: capabilitiesOfStorageKind(HARNESS_V3_JSONL),
    conversationId: null,
    messages: copyJson(transcript.messages as unknown as JsonValue, {
      omitUndefinedProperties: true
    }) as unknown as ChatMessage[],
    live: null,
    toolRuns: {},
    run: { state: 'idle' },
    queue: [],
    asks: [],
    context: { usedTokens: null }
  }
}
