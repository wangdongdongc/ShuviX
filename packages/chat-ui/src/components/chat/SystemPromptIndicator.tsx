import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileClock } from 'lucide-react'
import type { SystemPromptStatus } from '@shuvix/chat-protocol/systemPromptStatus'
import { getHostApi } from '../../api/chatApi'
import { selectIsStreaming, useChatStore } from '../../stores/chatStore'
import { useChatDensity } from '../../host/chatHostContext'

/**
 * 「系统提示词的来源改了」的提示（2026-11-06，用户裁决：缺省历史状态不变，提醒用户，用户点了才重建；提示本身要
 * 「放着不管也基本不影响用户体验」）。
 *
 * 系统提示词在这段对话第一次建 agent 时冻结，之后重启、升级、点芯片上的 X 都不改它（改了就会让不支持中途
 * system 消息的模型整段重算缓存）。这里问主进程 `agent.systemPromptStatus`：哪几段的来源与冻结的版本不同；有就在
 * 输入卡片底部工具行、用量环左边放一个与它同样大小的暗色小图标（不加横幅、不占输入区、不打断）。悬停说一句，
 * 点开一个小气泡：哪几样改了、重建的代价、[重建]（`agent.rebuildSystemPrompt`，下一条消息按此刻的来源重新渲染）。
 *
 * 什么时候问：换会话、一轮跑完、agent 建好 / 关停、窗口重新拿到焦点（多半是在别的编辑器里改了 CLAUDE.md 回来）。
 * 跑着的时候不重问，图标照旧（不随每一轮闪一下）；那时重建按钮不可点。
 * 没有 HostApi 或宿主不提供这两个方法（Chrome 侧边栏）→ 什么都不画。
 */
export function SystemPromptIndicator({
  sessionId
}: {
  sessionId: string | null
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const touch = useChatDensity() === 'touch'
  const host = getHostApi()
  const query = host?.agent.systemPromptStatus
  const rebuild = host?.agent.rebuildSystemPrompt
  const isStreaming = useChatStore(selectIsStreaming)
  const agentCreated = useChatStore((state) =>
    sessionId ? !!state.sessionAgentCreated[sessionId] : false
  )
  const [status, setStatus] = useState<{ sessionId: string; value: SystemPromptStatus } | null>(
    null
  )
  // 气泡开在哪条会话上（按会话记：开着切走再切回来、或切到另一条也有提示的会话，都不该带着它）
  const [openFor, setOpenFor] = useState<string | null>(null)
  const open = openFor !== null && openFor === sessionId
  // 正在重建 / 答了「忙」的那条会话（按会话记：重建途中切走，回答不该落到别的会话上）
  const [rebuildingFor, setRebuildingFor] = useState<string | null>(null)
  const [busyFor, setBusyFor] = useState<string | null>(null)
  // 只认最后一次发出的查询（切会话、连着几次触发时，旧的回答不该盖住新的）
  const requestRef = useRef(0)
  // 此刻显示的会话：异步回来的结果先对一下，不是它的就不动
  const currentRef = useRef(sessionId)
  const rootRef = useRef<HTMLSpanElement>(null)
  // 焦点 / 可见性的监听里读：跑着的时候不重问（与上面那条 effect 同一条规矩）
  const streamingRef = useRef(isStreaming)
  useEffect(() => {
    currentRef.current = sessionId
  }, [sessionId])
  useEffect(() => {
    streamingRef.current = isStreaming
  }, [isStreaming])

  const refresh = useCallback(() => {
    if (!sessionId || !query) return
    const request = ++requestRef.current
    query(sessionId)
      .then((value) => {
        if (requestRef.current !== request) return
        setStatus({ sessionId, value })
        // 新的一次回答：之前那句「正在运行，等它停下」作废
        setBusyFor((current) => (current === sessionId ? null : current))
      })
      .catch(() => {
        if (requestRef.current === request) setStatus(null)
      })
  }, [sessionId, query])

  // 换会话、一轮跑完、agent 建好 / 关停
  useEffect(() => {
    if (!isStreaming) refresh()
  }, [refresh, isStreaming, agentCreated])

  // 窗口重新拿到焦点 / 页面重新可见
  useEffect(() => {
    const onFocus = (): void => {
      if (!streamingRef.current) refresh()
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && !streamingRef.current) refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // 气泡开着：点到别处 / Esc 收起
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenFor(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenFor(null)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!sessionId || !query || !rebuild) return null
  if (status?.sessionId !== sessionId || !status.value.frozen) return null
  const stale = status.value.stale
  if (stale.length === 0) return null

  const sources = stale
    .map((entry) => (entry.file ? entry.file : t(`systemPrompt.source.${entry.key}`)))
    .join(t('systemPrompt.listSeparator'))
  const rebuilding = rebuildingFor === sessionId
  const busy = busyFor === sessionId || isStreaming

  const handleRebuild = async (): Promise<void> => {
    const target = sessionId
    setRebuildingFor(target)
    setBusyFor(null)
    let busyNow = false
    try {
      busyNow = !(await rebuild(target)).success
    } catch {
      // 失败：下面照样重问一次，按主进程的真实状态画
    }
    setRebuildingFor((current) => (current === target ? null : current))
    // 用户已经切到别的会话：那边有自己的查询，这里什么都不动
    if (currentRef.current !== target) return
    if (busyNow) {
      setBusyFor(target)
      return
    }
    setOpenFor(null)
    refresh()
  }

  return (
    <span
      ref={rootRef}
      data-system-prompt-indicator=""
      data-stale={stale.map((entry) => entry.key).join(' ')}
      className="relative flex-shrink-0 flex items-center"
    >
      <button
        type="button"
        data-system-prompt-indicator-button=""
        aria-label={t('systemPrompt.staleTitle')}
        aria-expanded={open}
        title={open ? undefined : t('systemPrompt.staleTitle')}
        onClick={() => setOpenFor(open ? null : sessionId)}
        className={`relative rounded flex items-center justify-center text-text-tertiary hover:text-text-secondary transition-colors ${
          // 触屏：与用量环同一种做法 —— 点按区 36px，左右伸进间距里，排版上只占 20px
          touch ? 'h-9 w-9 -mx-2' : 'p-1'
        }`}
      >
        <FileClock size={touch ? 16 : 14} strokeWidth={1.75} />
        {/* 一个很淡的点：看得出「有事」，不招眼 */}
        <span
          aria-hidden="true"
          className={`absolute rounded-full bg-accent/60 ${
            touch ? 'top-2 right-2 w-1.5 h-1.5' : 'top-0.5 right-0.5 w-1 h-1'
          }`}
        />
      </button>
      {open && (
        <div
          data-system-prompt-popover=""
          role="dialog"
          aria-label={t('systemPrompt.staleTitle')}
          className="absolute right-0 bottom-full mb-2 z-20 w-64 whitespace-normal rounded-lg border border-border-primary bg-bg-secondary p-3 shadow-xl text-left"
        >
          <div className="text-xs text-text-primary">
            {t('systemPrompt.staleDetail', { sources })}
          </div>
          <div
            data-system-prompt-hint=""
            className="mt-1.5 text-[11px] leading-snug text-text-tertiary"
          >
            {busy ? t('systemPrompt.rebuildBusy') : t('systemPrompt.staleHint')}
          </div>
          <div className="mt-2.5 flex justify-end">
            <button
              type="button"
              data-system-prompt-rebuild=""
              onClick={() => void handleRebuild()}
              disabled={rebuilding || isStreaming}
              className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                rebuilding || isStreaming
                  ? 'border border-border-secondary text-text-tertiary cursor-not-allowed'
                  : 'border border-border-primary text-text-primary hover:bg-bg-hover'
              }`}
            >
              {t('systemPrompt.rebuild')}
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
