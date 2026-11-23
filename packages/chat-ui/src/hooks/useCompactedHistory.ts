/**
 * 压缩前的历史（只读回看）—— 往上翻到顶，就把压缩掉的那一段接在上面。
 *
 * 当前视图只有活上下文：有压缩时第一条是压缩摘要（它之上的消息被换成了这段摘要）。这里按需把那一段取回来
 * （HostApi `message.listCompacted`），接在列表最上面；那一段若以更早一次压缩的摘要开头，再往上翻就接着取。
 * 状态只活在这一次打开里：调用方（MessageList）按会话重挂，换会话就随它一起没了；当前视图的第一条压缩摘要换了
 * （又压缩了一次 / 回退到了别处）也整段丢掉。取失败了这次打开就不再取（不在每次翻到顶时重试一个坏掉的读取）。
 *
 * 取回的消息只给人看：不进 chatStore、不进模型上下文，界面也不在它们身上给回退 / 重新生成 / 分支。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { getHostApi } from '../api/chatApi'

/** 一段压缩前的历史：`compactionId` 那条压缩摘要压缩掉的消息（最旧在前） */
export interface CompactedSegment {
  readonly compactionId: string
  readonly messages: readonly ChatMessage[]
}

interface State {
  readonly sessionId: string
  /** 这些段挂在哪条压缩摘要之上（当前视图的第一条）；它换了，段就作废 */
  readonly anchorId: string | null
  /** 最旧的一段在前 */
  readonly segments: readonly CompactedSegment[]
  readonly loading: boolean
  /** 再往上没有了（取回空段），或取失败了：这次打开不再取 */
  readonly done: boolean
}

function isCompactionSummary(message: ChatMessage | undefined): boolean {
  return (
    message !== undefined &&
    message.role === 'assistant' &&
    message.type === 'message' &&
    message.metadata?.isCompactionSummary === true
  )
}

/** 当前视图的锚点：第一条是压缩摘要才有（压缩头总在活上下文的最前面） */
export function compactionAnchorOf(messages: readonly ChatMessage[]): string | null {
  const first = messages[0]
  return isCompactionSummary(first) ? first.id : null
}

/** 再往上要取哪条压缩摘要之上的一段：还没取过 = 锚点；否则看最上面那段是不是以压缩摘要开头 */
export function nextCompactionId(
  anchorId: string | null,
  segments: readonly CompactedSegment[]
): string | null {
  if (segments.length === 0) return anchorId
  const top = segments[0].messages[0]
  return isCompactionSummary(top) ? top.id : null
}

const EMPTY: readonly CompactedSegment[] = []

function blank(sessionId: string, anchorId: string | null): State {
  return { sessionId, anchorId, segments: EMPTY, loading: false, done: false }
}

export interface CompactedHistory {
  /** 已取回的段，最旧在前（没有 → 空数组，引用稳定） */
  readonly segments: readonly CompactedSegment[]
  /** 还能往上取（有下一段、没在取、宿主有这条读取路径） */
  readonly canLoad: boolean
  /** 取上面一段；不能取时什么都不做 */
  readonly load: () => void
}

export interface CompactedHistoryOptions {
  /**
   * 取回来、马上要接上去之前（DOM 还是接上之前的样子）：列表在这里记下眼前那一项的位置，接上之后照着摆回去。
   * 取回的是空段 / 失败 / 已作废时不调
   */
  readonly onBeforePrepend?: () => void
}

export function useCompactedHistory(
  sessionId: string,
  messages: readonly ChatMessage[],
  options: CompactedHistoryOptions = {}
): CompactedHistory {
  const anchorId = compactionAnchorOf(messages)
  const [state, setState] = useState<State>(() => blank(sessionId, anchorId))
  // 这份状态只属于它记下的会话与锚点。锚点换了（又压缩了一次 / 回退到了别处）就按空白算 —— 不在 effect 里重置
  // （那会多一轮渲染），下一次取的时候才真的换成空白（见 load 里的 ownState）。旧锚点上还没回来的那次取，
  // 结果落在旧的那份状态里，不会被看见，也不会让新锚点卡在「正在取」
  const own =
    state.sessionId === sessionId && state.anchorId === anchorId
      ? state
      : blank(sessionId, anchorId)

  const segments = own.segments
  const cursor = own.done ? null : nextCompactionId(anchorId, segments)
  // 宿主面可能不带这条读取路径（Chrome 侧边栏、旧宿主）：那就和从前一样，压缩之前的看不到
  const listCompacted = getHostApi()?.message?.listCompacted
  const canLoad = cursor !== null && !own.loading && listCompacted !== undefined

  const messagesRef = useRef(messages)
  const beforePrependRef = useRef(options.onBeforePrepend)
  useEffect(() => {
    messagesRef.current = messages
    beforePrependRef.current = options.onBeforePrepend
  }, [messages, options.onBeforePrepend])

  const load = useCallback(() => {
    if (!canLoad || cursor === null || listCompacted === undefined) return
    const mine = (s: State): boolean => s.sessionId === sessionId && s.anchorId === anchorId
    setState((s) => ({ ...(mine(s) ? s : blank(sessionId, anchorId)), loading: true }))
    listCompacted({ sessionId, compactionId: cursor })
      .then((loaded) => {
        if (loaded.length > 0) beforePrependRef.current?.()
        setState((s) => {
          // 期间又为别的锚点取过：这次的结果作废
          if (!mine(s)) return s
          // 防御：已经在列表里的 id 不再出现第二次（条目 id 就是消息 id）
          const seen = new Set<string>(messagesRef.current.map((m) => m.id))
          for (const segment of s.segments) for (const m of segment.messages) seen.add(m.id)
          const fresh = loaded.filter((m) => !seen.has(m.id))
          if (fresh.length === 0) return { ...s, loading: false, done: true }
          return {
            ...s,
            loading: false,
            segments: [{ compactionId: cursor, messages: fresh }, ...s.segments]
          }
        })
      })
      .catch(() => {
        setState((s) => (mine(s) ? { ...s, loading: false, done: true } : s))
      })
  }, [canLoad, cursor, listCompacted, sessionId, anchorId])

  return { segments, canLoad, load }
}
