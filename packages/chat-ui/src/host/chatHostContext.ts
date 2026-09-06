/**
 * ChatHost 上下文 — 宿主向聊天对话框注入的状态契约。
 *
 * 聊天对话框（Conversation 及其子组件/hooks）不再直接读 renderer 的
 * settingsStore / sidebarStore / browserStore，而是从这里取它需要的少量宿主状态：
 *   - appearance：外观（桌面来自 settingsStore；服务端来自浏览器本地配置）
 *   - models：模型/供应商选择（桌面来自 settingsStore；服务端经 ChatApi.provider.* 拉取）
 *   - voice：语音配置（可选；不提供则朗读相关 UI 隐藏、自动朗读跳过）
 *
 * 这样 settingsStore 等宿主状态既不搬入包、也不被拆分；
 * “外观存后端 / 存浏览器”等差异天然落在宿主侧。
 */

import { createContext, useContext } from 'react'

/** 外观（主题/字号/专注模式） */
export interface ChatAppearance {
  theme: 'dark' | 'light' | 'system'
  /** 暗色主题 ID（宿主自有取值；对话框不做语义解析，仅透传/展示） */
  darkTheme: string
  /** 亮色主题 ID */
  lightTheme: string
  fontSize: number
  focusMode: boolean
}

/**
 * 模型/供应商「当前选中」状态 + 切换动作。
 * 注意：供应商/模型「目录」(providers/availableModels)已收进 chat-ui 共享 modelCatalogStore
 * （经 ChatApi.provider 拉取 + 订阅 providers.changed），ChatHost 只注入当前会话的选中模型镜像。
 */
export interface ChatModelSelection {
  activeProvider: string
  activeModel: string
  setActiveProvider: (id: string) => void
  setActiveModel: (id: string) => void
}

/** 语音配置（可选端口） */
export interface ChatVoiceConfig {
  /** 是否启用 TTS 自动朗读 */
  ttsEnabled: boolean
}

export interface ChatHostValue {
  appearance: ChatAppearance
  models: ChatModelSelection
  voice?: ChatVoiceConfig
}

export const ChatHostContext = createContext<ChatHostValue | null>(null)

/** 对话框组件/hooks 读取宿主注入状态的唯一入口 */
export function useChatHost(): ChatHostValue {
  const ctx = useContext(ChatHostContext)
  if (!ctx) {
    throw new Error(
      '[chat-ui] 缺少 ChatHostProvider：请在挂载 <Conversation> 前用 <ChatHostProvider value={…}> 包裹'
    )
  }
  return ctx
}
