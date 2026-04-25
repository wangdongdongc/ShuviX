/**
 * 子智能体模块 — 公共导出 & Provider 注册
 *
 * 统一管理所有子智能体 Provider 的注册。
 * 使用方只需 import { subAgentRegistry, SubAgentTool } from '../subagent'
 */

import { loadCustomSubAgents } from './customSubAgentLifecycle'
import { loadBuiltinSubAgents } from './builtinSubAgentLifecycle'

// ─── 加载内置 sub-agent（代码定义，i18n 懒解析） ──────
loadBuiltinSubAgents()

// ─── 加载用户自定义 sub-agent（DB 驱动） ──────
loadCustomSubAgents()

// ─── 导出 ──────────────────────────────────────────────────

export { subAgentRegistry } from './registry'
export { SubAgentTool } from './SubAgentTool'
export {
  registerCustomSubAgent,
  unregisterCustomSubAgent,
  reloadCustomSubAgent,
  toggleCustomSubAgent
} from './customSubAgentLifecycle'
export {
  listBuiltinSubAgents,
  setBuiltinSubAgentEnabled,
  isBuiltinSubAgent
} from './builtinSubAgentLifecycle'
export type { BuiltinSubAgentInfo } from './builtinSubAgentLifecycle'
export type {
  SubAgentProvider,
  SubAgentRunParams,
  SubAgentRunResult,
  SubAgentModelConfig
} from './types'
