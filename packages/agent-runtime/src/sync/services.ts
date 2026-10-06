/**
 * 视图同步的服务定义与静态视图（phase 3，P3-04）。
 *
 * 每个同步目标一个 chord `RemoteServiceProvider`，目录里只有一个单例服务 `shuvix.chat.view`，
 * 它交出 `{ view: ReplicatedState<SessionView | AgentView> }`。实现换来换去（活投影 / 关闭后的静态
 * 拷贝 / 旧格式会话 / 还没有存储的空视图），服务的形状永远不变 —— chord 的 `replace` 要求形状一致，
 * 前端的远程门面也因此一直是同一个对象。
 *
 * 宿主无关、浏览器安全：只依赖 chord 根入口与 chat-protocol。
 */
import {
  copyJson,
  defineService,
  replicatedState,
  type JsonValue,
  type MutableReplicatedState,
  type ReplicatedState
} from '@earendil-works/chord'
import {
  capabilitiesOfStorageKind,
  HARNESS_V3_JSONL
} from '@shuvix/chat-protocol/sessionStorageKind'
import { CHAT_VIEW_SERVICE_ID } from '@shuvix/chat-protocol/sync'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'

/** 一个同步目标的视图：会话（SessionView）或派生 agent（AgentView） */
export type SyncView = SessionView | AgentView

/** `shuvix.chat.view` 服务的契约：一个复制状态成员 */
export interface ChatViewService {
  readonly view: ReplicatedState<SyncView>
}

/** 服务端与前端共用的服务身份（前端也可以自己 `defineService(CHAT_VIEW_SERVICE_ID)`，id 相同即可） */
export const chatViewService = defineService<ChatViewService>(CHAT_VIEW_SERVICE_ID)

/** 旧格式会话的冻结投影结果（桌面的 `readLegacyTranscript` 返回值满足它） */
export interface LegacyTranscript {
  readonly messages: readonly ChatMessage[]
}

/**
 * 一份静态视图的复制状态：先 `copyJson` 去掉 `undefined` 属性（旧投影会写 `images: undefined`
 * 这类键，chord 只收严格 JSON），拷贝也保证新状态不与调用方的对象共享容器。
 */
export function staticViewState<V extends SyncView>(value: V): MutableReplicatedState<V> {
  return replicatedState(
    copyJson(value as unknown as JsonValue, { omitUndefinedProperties: true }) as unknown as V
  )
}

/**
 * 旧格式（harness-v3-jsonl）会话的视图：只读（三项能力都关，取自存储类型能力表），没有对话 id、没有实时卡、不会再变。
 * 消息原样来自冻结投影，`undefined` 键由 `staticViewState` 去掉。
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
