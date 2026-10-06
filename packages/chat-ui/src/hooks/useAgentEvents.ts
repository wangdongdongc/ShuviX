import { getChatApi, getSessionChannelApi, useChatHost } from '@shuvix/chat-ui'
import { useEffect, useCallback, useRef } from 'react'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { AssistantMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { useChatStore, onSessionRunSettled } from '../stores/chatStore'
import { useSubSessionStore, isSubSession } from '../stores/subSessionStore'
import { useBgTaskStore } from '../stores/bgTaskStore'
import { ttsPlayer } from '../services/tts/ttsPlayer'
import { useAppEvent } from './useAppEvents'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash.startsWith('#settings')

/** 朗读的上限（与从前同口径） */
const TTS_MAX_CHARS = 4000

/**
 * 运行收尾的朗读协调（PIN-03）：终答来自视图（`onSessionRunSettled`），结局来自 `agent_end{reason}` ——
 * 两路走两条 IPC、先后不定（P3-08-30），哪路后到就由哪路触发判定。只有 `ok` 才读；每个条目 id 至多读一次。
 */
interface SettleSlot {
  answer?: AssistantMessage
  reason?: 'ok' | 'aborted' | 'error'
}

/**
 * Agent 余项事件分发 Hook（P3-08）。
 *
 * 会话内容（消息、流式卡、工具进度、队列、询问）全部经视图同步进 store（`useSessionView` →
 * `applySessionView`），这里只剩**不属于内容**的信号：派生 agent 的登记 / 收尾、运行时出生 / 关停、MCP
 * 惰性连接、没有条目的错误（本地错误行）、自动审查的「审查中」、资源 / 后台任务、询问计数，以及运行
 * 生命周期 —— `agent_start` 停掉正在播的朗读、给没人订阅视图的会话置运行标记（侧栏转圈），`agent_end`
 * 收掉 MCP 连接态、清运行标记、参与朗读判定。没有缓冲、没有 rAF：剩下的事件都是低频的。
 */
export function useAgentEvents(): void {
  // TTS 自动朗读开关来自宿主注入（语音为可选端口）；用 ref 供事件回调内同步读取
  const host = useChatHost()
  const ttsEnabledRef = useRef(host.voice?.ttsEnabled)
  useEffect(() => {
    ttsEnabledRef.current = host.voice?.ttsEnabled
  }, [host.voice?.ttsEnabled])

  // 会话标题变更（后端 AI 自动生成 → AppEvent 广播）：各端统一刷新列表标题，单一数据源
  useAppEvent('session.titleChanged', (event) => {
    useChatStore.getState().updateSessionTitle(event.sessionId, event.title)
  })

  // 会话列表成员变化（创建/删除/移动项目）：信号事件 → 重拉全量。覆盖非 UI 发起的变更
  // （IPC/CLI 直建、知识库/记忆去重开会话）与其它窗口的操作；UI 流程自身的乐观刷新照旧。
  // seq 守卫丢弃乱序返回 —— 连续两次变更时旧响应不得覆盖新列表。
  const sessionsRefetchSeq = useRef(0)
  useAppEvent('session.listChanged', () => {
    const seq = ++sessionsRefetchSeq.current
    void getChatApi()
      .session.list()
      .then((sessions) => {
        if (seq === sessionsRefetchSeq.current) useChatStore.getState().setSessions(sessions)
      })
      .catch(() => {
        /* 列表拉取失败：保持现状，等下一次事件/UI 刷新 */
      })
  })

  // ─── 运行收尾的朗读（PIN-03） ───
  const settleSlots = useRef(new Map<string, SettleSlot>())
  const spoken = useRef(new Set<string>())
  const trySpeak = useCallback((sessionId: string): void => {
    const slot = settleSlots.current.get(sessionId)
    if (!slot?.answer || !slot.reason) return
    settleSlots.current.delete(sessionId)
    const { answer, reason } = slot
    if (reason !== 'ok') return
    if (spoken.current.has(answer.id)) return
    if (!ttsEnabledRef.current) return
    if (sessionId !== useChatStore.getState().activeSessionId) return
    const text = answer.content?.trim() ? answer.content : ''
    if (!text) return
    spoken.current.add(answer.id)
    ttsPlayer.speak(text.slice(0, TTS_MAX_CHARS), String(answer.id)).catch(() => {})
  }, [])

  useEffect(() => {
    if (isSettingsWindow) return
    return onSessionRunSettled((sessionId, answer) => {
      const slot = settleSlots.current.get(sessionId) ?? {}
      slot.answer = answer
      settleSlots.current.set(sessionId, slot)
      trySpeak(sessionId)
    })
  }, [trySpeak])

  const handleAgentEvent = useCallback(
    (event: ChatEvent): void => {
      const sid: string = event.sessionId

      // sub_session_register / sub_session_end 由 subSessionStore 消费（与 chatStore 无关）
      if (event.type === 'sub_session_register') {
        useSubSessionStore.getState().register({
          subSessionId: event.sessionId,
          parentSessionId: event.parentSessionId,
          parentToolCallId: event.parentToolCallId,
          subAgentName: event.subAgentName,
          displayName: event.displayName,
          description: event.description,
          systemPrompt: event.systemPrompt,
          prompt: event.prompt,
          promptInlineTokens: event.inlineTokens,
          contextNote: event.contextNote
        })
        // 刻意不自动打开右侧 Sub-agent 面板：工具派发的（有 parentToolCallId）内联在对话流的
        // ToolCallBlock 卡片中；非工具派发的（如 hook 派发的 agent）经工具栏胶囊的
        // 数量徽标可见，用户自己决定看不看 —— 自动弹面板打断当前阅读。
        return
      }
      if (event.type === 'sub_session_end') {
        useSubSessionStore.getState().markEnded({
          subSessionId: event.sessionId,
          result: event.result,
          isError: event.isError
        })
        return
      }

      // 派生 agent 的生命周期：没订阅它的视图时据此显示「在跑」（转写走 agent 视图）
      if (isSubSession(sid)) {
        if (event.type === 'agent_start') useSubSessionStore.getState().setRunning(sid, true)
        else if (event.type === 'agent_end') useSubSessionStore.getState().setRunning(sid, false)
        return
      }

      const store = useChatStore.getState()

      switch (event.type) {
        case 'agent_start':
          // 中断正在播放的 TTS；新一轮的朗读判定从头来
          if (ttsPlayer.isPlaying || ttsPlayer.isLoading) ttsPlayer.stop()
          settleSlots.current.delete(sid)
          // 只给没人订阅视图的会话置运行标记（订阅着的以视图为准，P3-08-30 / -40）
          store.markSessionRunning(sid, true)
          break

        case 'agent_end': {
          store.markSessionRunning(sid, false)
          // 轮结束：MCP 连接态不该再留着（乐观占位由视图 / 发送方收尾，这里不碰）
          store.clearMcpConnecting(sid)
          const slot = settleSlots.current.get(sid) ?? {}
          slot.reason = event.reason
          settleSlots.current.set(sid, slot)
          trySpeak(sid)
          break
        }

        case 'tool_review':
          // 自动审查在替用户看这次调用：工具卡显示「审查中」，落定后收掉（事件可能先于工具进度到）
          store.setToolReviewing(sid, event.toolCallId, event.reviewing)
          break

        case 'ask_count':
          store.setAskCount(sid, event.count)
          break

        case 'runtime_event':
          store.setRuntime(sid, event.runtimeId, event.status)
          break

        // 后台任务状态变更（started / exited / killed）。输出不走事件 —— 面板展开时
        // 按字节范围轮询日志文件自取，见 bgTaskStore 的说明。
        case 'bg_task':
          useBgTaskStore.getState().upsert(event.task)
          break

        // 注：browser_event（右侧浏览器/预览面板）由宿主的 useRightPanelBridge 处理，对话框本身不响应

        // ─── 运行时出生：扩展能力勾选从此只读，直到它关停完毕 ───
        case 'agent_created':
          store.setAgentCreated(sid, true)
          // 运行时出生 = 工具装配完了：惰性连接全部落定，占位卡上的「正在连接」到此为止
          store.clearMcpConnecting(sid)
          break

        // ─── 创建运行时期间的 MCP 惰性连接：占位卡上写明在等哪几台 ───
        case 'mcp_connecting':
          store.setMcpConnecting(sid, event.server, event.connecting)
          break

        // ─── 运行时关停（回退/切档案/清空：旧运行时停稳前不许有新的） ───
        case 'agent_closing':
          store.setAgentClosing(sid, event.closing)
          // 关停完毕 = 这条会话又没有运行时了：扩展能力勾选重新可改（下一个运行时创建时读）
          if (!event.closing) store.setAgentCreated(sid, false)
          break

        case 'error':
          // 没有条目的错误（MCP 连不上、hook 拒绝……）：本地错误行，只在当前视图里（PIN-02）。
          // 只撤连接态。**刻意不碰乐观占位**：MCP 惰性连接失败的 error 发生在创建运行时那一步，
          // 早于用户条目被受理，在这里撤会让刚发出的消息先消失几秒再补回来 —— 正是占位要解决的那个
          // 毛病。占位的收尾在视图（用户条目出现）与发送方的 finally 里（见 InputArea）
          store.clearMcpConnecting(sid)
          store.addLocalError(sid, event.error || 'Unknown error')
          break

        // 其余（以及线上可能残留的已删除类型）一律忽略
        default:
          break
      }
    },
    [trySpeak]
  )

  // 注册 Agent 事件监听器（仅主窗口）
  useEffect(() => {
    if (isSettingsWindow) return
    return getSessionChannelApi().agent.onEvent(handleAgentEvent)
  }, [handleAgentEvent])
}
