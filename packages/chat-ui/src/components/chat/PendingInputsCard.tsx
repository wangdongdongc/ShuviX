/**
 * PendingInputsCard — 对话流末尾那张等人回答的卡片（审批 / 选择题），外框与语义色在这里，内容是 PendingInputsPanel。
 *
 * 它不再钉在输入框上，所以可能在屏幕外：翻历史时的提示见 ScrollToBottomButton 的 `waiting`，数字键由这里把关 ——
 * 卡片要整张露在滚动区里（且没被悬浮输入卡片压着）才算数，否则一次按键就批准了一张没看见的卡。焦点在右侧收件箱
 * 面板里时它也让开（那边开着的卡归它，`useOptionHotkeys` 里统一判断）。
 */
import { useCallback, useRef } from 'react'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { selectActivePendingInput, useChatStore } from '../../stores/chatStore'
import { OptionHotkeyGuardContext } from './inputs/OptionRows'
import { PendingInputsPanel } from './PendingInputsPanel'

/** 量位置的容差（px）：亚像素取整不该让数字键失灵 */
const ON_SCREEN_SLACK_PX = 1

/**
 * 卡片是否整张在可见区里：可见区 = 滚动容器减去底部被悬浮输入卡片盖住的那一截。纯函数，只比数字
 */
export function isCardOnScreen(
  card: { top: number; bottom: number },
  view: { top: number; bottom: number },
  coveredBottomPx: number
): boolean {
  return (
    card.top >= view.top - ON_SCREEN_SLACK_PX &&
    card.bottom <= view.bottom - coveredBottomPx + ON_SCREEN_SLACK_PX
  )
}

/**
 * 量这张卡片此刻是否整张露着（数字键与「等你批准」提示共用一份判断）。不在滚动容器里 = 看不见，宁可不算。
 * --chat-input-h 由 Conversation 写在对话列根上，这里读到的是继承来的值
 */
export function pendingCardOnScreen(card: HTMLElement): boolean {
  const scroller = card.closest<HTMLElement>('[data-virtuoso-scroller]')
  if (!scroller) return false
  const covered = parseFloat(getComputedStyle(card).getPropertyValue('--chat-input-h')) || 0
  return isCardOnScreen(card.getBoundingClientRect(), scroller.getBoundingClientRect(), covered)
}

export function PendingInputsCard({
  onResponse
}: {
  onResponse: (requestId: string, response: InputResponse) => void | Promise<void>
}): React.JSX.Element | null {
  const kind = useChatStore((s) => selectActivePendingInput(s)?.kind)
  const cardRef = useRef<HTMLDivElement>(null)
  // 焦点在收件箱面板里时数字键归那边的卡（见 OptionRows 的 OPTION_HOTKEY_SCOPE_ATTR）
  const hotkeyGuard = useCallback(
    () => !!cardRef.current && pendingCardOnScreen(cardRef.current),
    []
  )

  if (!kind) return null
  return (
    <div className="relative max-w-[784px] mx-auto px-4 pt-1.5 pb-3">
      <div
        ref={cardRef}
        data-pending-card={kind}
        className={`rounded-2xl border bg-bg-primary overflow-hidden ring-[3px] ${
          kind === 'ask' ? 'border-warning/45 ring-warning/10' : 'border-accent/45 ring-accent/10'
        }`}
      >
        <OptionHotkeyGuardContext.Provider value={hotkeyGuard}>
          <PendingInputsPanel onResponse={onResponse} placement="conversation" />
        </OptionHotkeyGuardContext.Provider>
      </div>
    </div>
  )
}
