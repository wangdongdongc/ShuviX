import { getHostApi, getSessionChannelApi } from '@shuvix/chat-ui'
import { useEffect, useReducer, useState } from 'react'
import type { KnowledgeBaseOptionsResult } from '@shuvix/chat-protocol/chatApi'
import { useChatStore } from '../stores/chatStore'

/** 空常量，避免每次渲染返回新引用 */
const NO_OPTIONS: KnowledgeBaseOptionsResult['options'] = []
const NO_NAMES: string[] = []

export interface SessionKnowledgeBasesState {
  /**
   * 候选库（用户库 + 内置库；项目库不在其中 —— 项目会话恒带它）。还没拉到、或宿主没有知识库
   * （渠道端、扩展端）时为空，调用方据此不画这一组
   */
  options: KnowledgeBaseOptionsResult['options']
  /** 此刻生效的选择（含回落链算出来的）；没有会话时是欢迎页的草稿 */
  selected: string[]
  /** 这条会话（或它的父会话 / 项目）明确设过；欢迎页恒为 false */
  explicit: boolean
  /** 勾上 / 取消一个库：会话立刻落库（不上锁），没有会话时只改欢迎页的草稿 */
  toggle: (name: string) => void
}

/** 勾上没勾的、取消勾了的 */
function flip(names: readonly string[], name: string): string[] {
  return names.includes(name) ? names.filter((n) => n !== name) : [...names, name]
}

/**
 * 会话启用的知识库的读写 —— 会话设置里扩展能力卡的知识库一行与输入框的工具选择器共用。
 *
 * 与扩展能力（useSessionTools）**不同**：知识库不进 Agent 的工具表，是 `knowledge` 工具每次调用时
 * 由宿主现查的，所以没有只读态，运行时存在期间照样可改、改完下一次调用就作数。
 * 选择要走回落链（会话 → 父会话 → 项目），只有宿主算得出来，所以这里不从 store 派生，而是现取
 * `knowledge.baseOptions`；别处改了（`session.configChanged`）、库建了删了（`knowledge.changed`）都重取，
 * 两个界面因此一处改了另一处跟着变。
 *
 * 没有会话（欢迎页）时勾的是 store 里的草稿 `welcomeKnowledgeBases`，直接发送新建会话时由输入框
 * 写进新会话（InputArea 的 `createSessionForSend`），之后清空。
 */
export function useSessionKnowledgeBases(sessionId: string | null): SessionKnowledgeBasesState {
  // 连同它是哪条会话的一起存：会话一换，上一条的那份不上屏
  const [loaded, setLoaded] = useState<{
    sessionId: string | null
    result: KnowledgeBaseOptionsResult
  } | null>(null)
  const [version, reload] = useReducer((n: number) => n + 1, 0)
  const draft = useChatStore((s) => s.welcomeKnowledgeBases)

  useEffect(() => {
    const kb = getHostApi()?.knowledge
    if (!kb) return
    let alive = true
    void kb.baseOptions(sessionId ? { sessionId } : {}).then((result) => {
      // 会话换了、或又有一次更新的重取：晚到的这份作废
      if (alive) setLoaded({ sessionId, result })
    })
    return () => {
      alive = false
    }
  }, [sessionId, version])

  useEffect(() => {
    if (!getHostApi()?.knowledge) return
    return getSessionChannelApi().events.subscribe((event) => {
      if (
        event.type === 'knowledge.changed' ||
        (event.type === 'session.configChanged' && event.sessionId === sessionId)
      ) {
        reload()
      }
    })
  }, [sessionId])

  const result = loaded?.sessionId === sessionId ? loaded.result : null

  const toggle = (name: string): void => {
    const host = getHostApi()
    if (!host) return
    if (!sessionId) {
      const store = useChatStore.getState()
      store.setWelcomeKnowledgeBases(flip(store.welcomeKnowledgeBases, name))
      return
    }
    if (!result) return
    const next = flip(result.selected, name)
    // 乐观更新：这条写入没有锁，不会被拒；会话不在了才失败，那就回到真实值
    setLoaded({ sessionId, result: { ...result, selected: next, explicit: true } })
    void host.session
      .updateKnowledgeBases({ id: sessionId, knowledgeBases: next })
      .then(({ success }) => {
        if (!success) reload()
      })
  }

  return {
    options: result?.options ?? NO_OPTIONS,
    selected: sessionId ? (result?.selected ?? NO_NAMES) : draft,
    explicit: !!sessionId && !!result?.explicit,
    toggle
  }
}
