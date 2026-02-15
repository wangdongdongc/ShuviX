import { registerAgentHandlers } from './agentHandlers'
import { registerSessionHandlers } from './sessionHandlers'
import { registerMessageHandlers } from './messageHandlers'
import { registerSettingsHandlers } from './settingsHandlers'
import { registerProviderHandlers } from './providerHandlers'
import { registerHttpLogHandlers } from './httpLogHandlers'

/**
 * 统一注册所有 IPC 处理器
 * 各业务域拆分为独立模块，此文件仅做聚合
 */
export function registerIpcHandlers(): void {
  registerAgentHandlers()
  registerSessionHandlers()
  registerMessageHandlers()
  registerSettingsHandlers()
  registerProviderHandlers()
  registerHttpLogHandlers()
}
