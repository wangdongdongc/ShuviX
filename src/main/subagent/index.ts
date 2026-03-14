/**
 * 子智能体模块 — 公共导出 & Provider 注册
 *
 * 统一管理所有子智能体 Provider 的注册。
 * 使用方只需 import { subAgentRegistry, SubAgentTool } from '../subagent'
 */

import { subAgentRegistry } from './registry'
import { ExploreProvider } from './providers/ExploreProvider'
import { AcpProvider } from './providers/AcpProvider'
import { acpService } from '../services/acpService'

// ─── 注册内置 Provider ──────────────────────────────────────

subAgentRegistry.register(new ExploreProvider())

for (const config of acpService.getRegisteredAgents()) {
  subAgentRegistry.register(new AcpProvider(config))
}

// ─── 导出 ──────────────────────────────────────────────────

export { subAgentRegistry } from './registry'
export { SubAgentTool } from './SubAgentTool'
export type {
  SubAgentProvider,
  SubAgentRunParams,
  SubAgentRunResult,
  SubAgentModelConfig
} from './types'
