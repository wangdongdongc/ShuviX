import { registerAgentHandlers } from './agentHandlers'
import { registerSessionHandlers } from './sessionHandlers'
import { registerCalendarHandlers } from './calendarHandlers'
import { registerProjectHandlers } from './projectHandlers'
import { registerMessageHandlers } from './messageHandlers'
import { registerSettingsHandlers } from './settingsHandlers'
import { registerProviderHandlers } from './providerHandlers'
import { registerHttpLogHandlers } from './httpLogHandlers'
import { registerMcpHandlers } from './mcpHandlers'
import { registerSkillHandlers } from './skillHandlers'
import { registerDbCredentialHandlers } from './dbCredentialHandlers'
import { registerTelegramHandlers } from './telegramHandlers'
import { registerCommandHandlers } from './commandHandlers'
import { registerTtsHandlers } from './ttsHandlers'
import { registerDownloadHandlers } from './downloadHandlers'
import { registerUpdateHandlers } from './updateHandlers'
import { registerSubAgentHandlers } from './subAgentHandlers'
import { registerPolicyHandlers } from './policyHandlers'
import { registerHookHandlers } from './hookHandlers'
import { registerBotHandlers } from './botHandlers'
import { registerShuvixMdHandlers } from './shuvixMdHandlers'
import { registerTerminalHandlers } from './terminalHandlers'
import { registerBgTaskHandlers } from './bgTaskHandlers'
import { registerBrowserViewHandlers } from './browserViewHandlers'
import { registerBrowserDataHandlers } from './browserDataHandlers'
import { registerContextMenuHandlers } from './contextMenuHandlers'
import { registerWidgetHandlers } from './widgetHandlers'
import { registerConfigShareHandlers } from './configShareHandlers'
import { registerFilesHandlers } from './filesHandlers'
import { registerKnowledgeHandlers } from './knowledgeHandlers'
import { registerMemoryHandlers } from './memoryHandlers'
import { registerPinChatHandlers } from './pinChatHandlers'
import { registerNotificationHandlers } from './notificationHandlers'
import { registerLiveDocumentHandlers } from './liveDocumentHandlers'
import { registerChromeExtensionHandlers } from './chromeExtensionHandlers'

/**
 * 统一注册所有 IPC 处理器
 * 各业务域拆分为独立模块，此文件仅做聚合
 */
export function registerIpcHandlers(): void {
  registerAgentHandlers()
  registerSessionHandlers()
  registerCalendarHandlers()
  registerProjectHandlers()
  registerMessageHandlers()
  registerSettingsHandlers()
  registerProviderHandlers()
  registerHttpLogHandlers()
  registerMcpHandlers()
  registerSkillHandlers()
  registerDbCredentialHandlers()
  registerTelegramHandlers()
  registerCommandHandlers()
  registerTtsHandlers()
  registerDownloadHandlers()
  registerUpdateHandlers()
  registerSubAgentHandlers()
  registerPolicyHandlers()
  registerHookHandlers()
  registerBotHandlers()
  registerShuvixMdHandlers()
  registerTerminalHandlers()
  registerBgTaskHandlers()
  registerBrowserViewHandlers()
  registerBrowserDataHandlers()
  registerContextMenuHandlers()
  registerWidgetHandlers()
  registerConfigShareHandlers()
  registerFilesHandlers()
  registerKnowledgeHandlers()
  registerMemoryHandlers()
  registerPinChatHandlers()
  registerNotificationHandlers()
  registerLiveDocumentHandlers()
  registerChromeExtensionHandlers()
}
