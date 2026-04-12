import { registerAgentHandlers } from './agentHandlers'
import { registerSessionHandlers } from './sessionHandlers'
import { registerProjectHandlers } from './projectHandlers'
import { registerMessageHandlers } from './messageHandlers'
import { registerSettingsHandlers } from './settingsHandlers'
import { registerProviderHandlers } from './providerHandlers'
import { registerHttpLogHandlers } from './httpLogHandlers'
import { registerMcpHandlers } from './mcpHandlers'
import { registerSkillHandlers } from './skillHandlers'
import { registerSshCredentialHandlers } from './sshCredentialHandlers'
import { registerDbCredentialHandlers } from './dbCredentialHandlers'
import { registerWebUIHandlers } from './webUIHandlers'
import { registerTelegramHandlers } from './telegramHandlers'
import { registerCommandHandlers } from './commandHandlers'
import { registerSttHandlers } from './sttHandlers'
import { registerTtsHandlers } from './ttsHandlers'
import { registerDownloadHandlers } from './downloadHandlers'
import { registerPluginHandlers } from './pluginHandlers'
import { registerUpdateHandlers } from './updateHandlers'
import { registerMcpServerHandlers } from './mcpServerHandlers'
import { registerCompactionHandlers } from './compactionHandlers'
import { registerCustomSubAgentHandlers } from './customSubAgentHandlers'
import { registerTerminalHandlers } from './terminalHandlers'
import { registerPreviewViewHandlers } from './previewViewHandlers'
import { registerContextMenuHandlers } from './contextMenuHandlers'

/**
 * 统一注册所有 IPC 处理器
 * 各业务域拆分为独立模块，此文件仅做聚合
 */
export function registerIpcHandlers(): void {
  registerAgentHandlers()
  registerSessionHandlers()
  registerProjectHandlers()
  registerMessageHandlers()
  registerSettingsHandlers()
  registerProviderHandlers()
  registerHttpLogHandlers()
  registerMcpHandlers()
  registerSkillHandlers()
  registerSshCredentialHandlers()
  registerDbCredentialHandlers()
  registerWebUIHandlers()
  registerTelegramHandlers()
  registerCommandHandlers()
  registerSttHandlers()
  registerTtsHandlers()
  registerDownloadHandlers()
  registerPluginHandlers()
  registerUpdateHandlers()
  registerMcpServerHandlers()
  registerCompactionHandlers()
  registerCustomSubAgentHandlers()
  registerTerminalHandlers()
  registerPreviewViewHandlers()
  registerContextMenuHandlers()
}
