/**
 * PendingInputsDrawer — 笔记本会话的「询问抽屉」：给 PendingInputsPanel 套一条可折叠细条。
 *
 * 普通会话的询问面板常驻展开（Agent 在等答复，注意力优先，Conversation 直接挂 accessory）；
 * 笔记本以 live preview 为主界面，输入卡片里对话抽屉与询问面板两块限高区同时展开会吃满
 * 整屏 —— 所以询问区在笔记本获得独立的折叠开关（对话区的开关在 ThreadDrawer，两者互不牵连；
 * ThreadDrawer 在询问出现的沿上自动折叠让位）。
 *
 * 默认展开；新询问到来（当前请求切换/从无到有）自动重新展开。折叠后细条保留语义色与计数；
 * 回车的「其它反馈」路由不受影响 —— 那由 chatStore 的 pending 状态驱动，与可见性无关。
 * 无待处理询问时整体隐藏（细条也不占高度）。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, MessageCircleQuestion, ShieldAlert } from 'lucide-react'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { useChatStore, selectPendingInputs, selectActivePendingInput } from '../../stores/chatStore'
import { PendingInputsPanel } from './PendingInputsPanel'

export function PendingInputsDrawer({
  onResponse
}: {
  onResponse: (requestId: string, response: InputResponse) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const pendingCount = useChatStore((s) => selectPendingInputs(s).length)
  const activeRequest = useChatStore(selectActivePendingInput)
  // 折叠态记的是「在哪条请求上折叠的」：当前请求换人（步进/新询问到来）时 key 不再匹配，
  // 面板自然回到展开 —— 无需 effect，新询问自动重新展开是推导出来的
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null)

  if (pendingCount === 0) return null

  const key = activeRequest?.id ?? ''
  const open = collapsedKey !== key

  const isAsk = activeRequest?.kind === 'ask'
  const Icon = isAsk ? ShieldAlert : MessageCircleQuestion
  return (
    <div className={isAsk ? 'bg-warning/[0.04]' : 'bg-accent/[0.04]'}>
      {/* 细条：语义色图标 + 计数；点任意处折叠/展开。展开时不带下边线 —— 与下方面板融为一块 */}
      <button
        type="button"
        onClick={() => setCollapsedKey(open ? key : null)}
        className={`w-full flex items-center gap-2 px-3.5 py-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors ${
          open ? '' : 'border-b border-border-secondary/40'
        }`}
        title={open ? t('pendingInputs.collapse') : t('pendingInputs.expand')}
      >
        <Icon size={12} className={`flex-shrink-0 ${isAsk ? 'text-warning' : 'text-accent/80'}`} />
        <span className="flex-1 min-w-0 truncate text-left">
          {t('pendingInputs.title', { count: pendingCount })}
        </span>
        {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </button>
      {open && <PendingInputsPanel onResponse={onResponse} />}
    </div>
  )
}
