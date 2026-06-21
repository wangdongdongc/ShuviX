/**
 * useFocusDim —— 专注模式淡化判定（桌面/扩展单一来源）。
 *
 * 专注模式开关从 ChatHost 注入的外观读取（桌面来自 settingsStore，扩展来自 chrome.storage——
 * 仅存储不同），活动会话来自 chatStore。开关开启 + 已选中会话时，淡化未选中区域。
 */
import { useChatHost, useChatStore } from '@shuvix/chat-ui'

export function useFocusDim(): { focusMode: boolean; dim: boolean } {
  const focusMode = useChatHost().appearance.focusMode
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  return { focusMode, dim: focusMode && !!activeSessionId }
}
