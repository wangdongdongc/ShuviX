/**
 * @shuvix/chat-ui — 可复用聊天对话框包。
 *
 * 对外提供 <Conversation> 对话区核心 + 注入口（ChatApi / ChatHost），
 * 以及对话域 stores / hooks / 渲染组件（桌面/WebUI 宿主复用；外部项目按需使用）。
 */

// ── 注入口 ──
export { getChatApi, setChatApi } from './api/chatApi'
export { getSessionChannelApi, setSessionChannelApi, getHostApi } from './api/chatApi'
export type { ChatApi, SessionChannelApi, HostApi } from './api/chatApi'
export { getChannelBindingApi, setChannelBindingApi } from './api/chatApi'
export type { ChannelBindingApi } from './api/chatApi'
export { ChatHostProvider } from './host/ChatHost'
export { useChatHost } from './host/chatHostContext'
export type {
  ChatHostValue,
  ChatAppearance,
  ChatModelSelection,
  ChatVoiceConfig
} from './host/chatHostContext'

// ── 对话区组件 ──
export { Conversation } from './components/chat/Conversation'
export { InputArea } from './components/chat/InputArea'
export { ModelPicker } from './components/chat/ModelPicker'
export { ModelSelect } from './components/chat/ModelSelect'
export type { ModelSelectProps, ModelSelectThinking } from './components/chat/ModelSelect'
export { ToolPicker } from './components/chat/ToolPicker'
export { MessageRenderer } from './components/chat/MessageRenderer'
export type { VisibleItem } from './components/chat/MessageRenderer'
export { AssistantBubble } from './components/chat/AssistantBubble'
export { UserBubble } from './components/chat/UserBubble'
export { StepBlock } from './components/chat/StepBlock'
export { ToolCallBlock } from './components/chat/ToolCallBlock'
export { CodeBlock } from './components/chat/CodeBlock'
export { DiffViewer } from './components/chat/DiffViewer'
export { TokenBadge, InvalidTokenBadge } from './components/chat/InlineTokenBadge'
export { TokenChip, TokenPayloadDialog } from './components/chat/TokenChip'
export { InstructionBubble } from './components/chat/InstructionBubble'
export { SystemNoticeCard } from './components/chat/SystemNoticeCard'
export { StreamingFooter } from './components/chat/StreamingFooter'
export { PendingInputsPanel } from './components/chat/PendingInputsPanel'
export { SlashCommandPopover } from './components/chat/SlashCommandPopover'

// ── 对话域 stores ──
export * from './stores/chatStore'
export * from './stores/subSessionStore'

// ── 对话域 hooks ──
export { useSessionInit } from './hooks/useSessionInit'
export { useAgentEvents } from './hooks/useAgentEvents'
export { useAppEvent } from './hooks/useAppEvents'
export { useModelCatalogSync } from './hooks/useModelCatalog'
export { useModelCatalogStore } from './stores/modelCatalogStore'
export { useSubAgentCount } from './hooks/useSubAgentCount'
export { useChatActions } from './hooks/useChatActions'
export { useSessionMeta } from './hooks/useSessionMeta'
export { useSlashCommands } from './hooks/useSlashCommands'
export { useImageUpload } from './hooks/useImageUpload'
export { useVoiceInput } from './hooks/useVoiceInput'
export { useTtsPlayback } from './hooks/useTtsPlayback'
// 通用 UI 小工具（app 其它处也复用）
export { useClickOutside } from './hooks/useClickOutside'
export { useDialogClose } from './hooks/useDialogClose'

// ── utils ──
export * from './utils/clipboard'
