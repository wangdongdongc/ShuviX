/**
 * 自定义子智能体生命周期管理
 *
 * 负责从 DB 加载自定义子智能体并注册到 SubAgentRegistry + 工具注册表。
 * CRUD 操作时实时更新注册状态。
 */

import { customSubAgentDao } from '../dao/customSubAgentDao'
import { registerBuiltinTool, unregisterBuiltinTool } from '../tools/registry'
import { subAgentRegistry } from './registry'
import { CustomSubAgentProvider } from './providers/CustomSubAgentProvider'
import type { CustomSubAgent } from '../dao/types'
import { createLogger } from '../logger'

const log = createLogger('CustomSubAgent')

/** 注册单个自定义子智能体到 registry + 工具注册表 */
export function registerCustomSubAgent(config: CustomSubAgent): void {
  const provider = new CustomSubAgentProvider(config)
  subAgentRegistry.register(provider)
  registerBuiltinTool({
    name: config.name,
    group: 'subagent',
    defaultEnabled: false,
    getLabel: () => config.displayName,
    getHint: () => config.description.split('\n')[0] || config.displayName
  })
}

/** 注销自定义子智能体 */
export function unregisterCustomSubAgent(name: string): void {
  subAgentRegistry.unregister(name)
  unregisterBuiltinTool(name)
}

/** 重新加载（更新配置后调用） */
export function reloadCustomSubAgent(config: CustomSubAgent): void {
  unregisterCustomSubAgent(config.name)
  registerCustomSubAgent(config)
}

/** 切换启用/禁用：禁用时注销，启用时重新注册 */
export function toggleCustomSubAgent(config: CustomSubAgent, enabled: boolean): void {
  if (enabled) {
    registerCustomSubAgent(config)
  } else {
    unregisterCustomSubAgent(config.name)
  }
}

/** 启动时从 DB 加载已启用的子智能体 */
export function loadCustomSubAgents(): void {
  const agents = customSubAgentDao.findEnabled()
  for (const agent of agents) {
    registerCustomSubAgent(agent)
  }
  if (agents.length > 0) {
    log.info(`Loaded ${agents.length} enabled sub-agent(s)`)
  }
}
