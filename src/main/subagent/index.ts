/**
 * 子智能体模块 — 公共导出 & Provider 注册
 *
 * 统一管理所有子智能体 Provider 的注册。
 * 使用方只需 import { subAgentRegistry, SubAgentTool } from '../subagent'
 */

import { subAgentRegistry } from './registry'
import { AcpProvider, BUILTIN_ACP_AGENTS } from './providers/AcpProvider'
import { registerBuiltinTool } from '../tools/registry'
import { loadCustomSubAgents } from './customSubAgentLifecycle'
import { t } from '../i18n'

// ─── 注册 ACP 类子智能体（claude-code 等，独立于 custom_sub_agents 表） ───

/** 连字符驼峰转换：'claude-code' → 'claudeCode' */
function toCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

for (const config of BUILTIN_ACP_AGENTS) {
  subAgentRegistry.register(new AcpProvider(config))
  const camel = toCamel(config.name)
  registerBuiltinTool({
    name: config.name,
    group: 'subagent',
    defaultEnabled: false,
    getLabel: () => t(`tool.${camel}Label`) || config.displayName,
    getHint: () => t(`tool.${camel}Hint`) || config.description.split('\n')[0]
  })
}

// ─── 从 DB 加载所有子智能体（含内置 explore + 用户自定义） ──────
loadCustomSubAgents()

// ─── 导出 ──────────────────────────────────────────────────

export { subAgentRegistry } from './registry'
export { SubAgentTool } from './SubAgentTool'
export { abortAllAcpSessions } from './providers/AcpProvider'
export {
  registerCustomSubAgent,
  unregisterCustomSubAgent,
  reloadCustomSubAgent,
  toggleCustomSubAgent
} from './customSubAgentLifecycle'
export type {
  SubAgentProvider,
  SubAgentRunParams,
  SubAgentRunResult,
  SubAgentModelConfig
} from './types'
