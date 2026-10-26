import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import type { AgentChangePreview, AgentPreviewChangeParams } from '@shuvix/chat-protocol/chatApi'
import { getHostApi } from '../../api/chatApi'
import { ConfirmDialog } from '../common/ConfirmDialog'

/**
 * 改动会打穿提示词缓存时的确认（用户裁决 2026-10-26）：锁住的 agent 换模型 / 扩展能力当场生效，提供商的
 * 提示词缓存保不保得住由主进程预判（`agent.previewChange`）；保不住就先问一句，每次都问。
 *
 * 确认框由 `<CacheBreakConfirmHost />` 画：输入框与会话设置面板各挂一个，最后挂上的那个画（会话设置弹窗
 * 开着时画在它上面，关了回到输入框那个），所以同一时刻只有一个框。一个宿主都没挂（不该发生）就照改不问。
 */

interface PendingConfirm {
  preview: AgentChangePreview
  resolve: (confirmed: boolean) => void
}

interface CacheBreakConfirmState {
  /** 挂着的宿主，后挂的在后 */
  hosts: string[]
  pending: PendingConfirm | undefined
}

const useCacheBreakConfirmStore = create<CacheBreakConfirmState>(() => ({
  hosts: [],
  pending: undefined
}))

/** 问用户要不要照改（一次只问一件：前一问还没答又来一问，前一问按取消落定） */
function askCacheBreak(preview: AgentChangePreview): Promise<boolean> {
  const store = useCacheBreakConfirmStore
  if (store.getState().hosts.length === 0) return Promise.resolve(true)
  store.getState().pending?.resolve(false)
  return new Promise((resolve) => store.setState({ pending: { preview, resolve } }))
}

/**
 * 改锁住的 agent 之前过一道：预判说缓存保不住就问用户，答应了（或保得住 / 没有 agent / 预判失败）才 true。
 * 渠道端（没有 HostApi）一律 true —— 它改不了这些。
 */
export async function confirmAgentChange(
  sessionId: string,
  change: Omit<AgentPreviewChangeParams, 'sessionId'>
): Promise<boolean> {
  const host = getHostApi()
  if (!host) return true
  let preview: AgentChangePreview
  try {
    preview = await host.agent.previewChange({ sessionId, ...change })
  } catch {
    return true
  }
  if (preview.cache !== 'lost') return true
  return askCacheBreak(preview)
}

/** 说明文字：为什么保不住 + 大约要重算多少 */
function useDescription(preview: AgentChangePreview): string {
  const { t } = useTranslation()
  const reason = preview.reasons.includes('model')
    ? t('cacheBreak.reasonModel')
    : preview.reasons.includes('tools')
      ? t('cacheBreak.reasonTools')
      : t('cacheBreak.reasonPrompt')
  const cost =
    preview.promptTokens > 0
      ? t('cacheBreak.costTokens', { tokens: preview.promptTokens.toLocaleString() })
      : t('cacheBreak.cost')
  return `${reason} ${cost}`
}

function CacheBreakDialog({ pending }: { pending: PendingConfirm }): React.JSX.Element {
  const { t } = useTranslation()
  const description = useDescription(pending.preview)
  const settle = (confirmed: boolean): void => {
    if (useCacheBreakConfirmStore.getState().pending === pending) {
      useCacheBreakConfirmStore.setState({ pending: undefined })
    }
    pending.resolve(confirmed)
  }
  return (
    <div data-cache-break-confirm>
      <ConfirmDialog
        title={t('cacheBreak.title')}
        description={description}
        confirmText={t('cacheBreak.confirm')}
        cancelText={t('common.cancel')}
        danger={false}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </div>
  )
}

/** 确认框的宿主：挂在会改模型 / 扩展能力的界面里（见文件头） */
export function CacheBreakConfirmHost(): React.JSX.Element | null {
  const id = useId()
  useEffect(() => {
    useCacheBreakConfirmStore.setState((s) => ({ hosts: [...s.hosts, id] }))
    return () => {
      const { hosts, pending } = useCacheBreakConfirmStore.getState()
      const rest = hosts.filter((host) => host !== id)
      // 最后一个宿主走了，问到一半的那一问按取消落定（没人能答它了）
      if (rest.length === 0 && pending) pending.resolve(false)
      useCacheBreakConfirmStore.setState({
        hosts: rest,
        ...(rest.length === 0 ? { pending: undefined } : {})
      })
    }
  }, [id])
  const active = useCacheBreakConfirmStore((s) => s.hosts[s.hosts.length - 1] === id)
  const pending = useCacheBreakConfirmStore((s) => s.pending)
  if (!active || !pending || typeof document === 'undefined') return null
  return createPortal(<CacheBreakDialog pending={pending} />, document.body)
}
