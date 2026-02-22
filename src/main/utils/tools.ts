/**
 * 工具名称常量、启用工具解析、工具 prompt 注册表
 * 独立于 agent / sessionService，避免循环依赖
 */

import { t } from '../i18n'
import { mcpService } from '../services/mcpService'

/** 内置工具名称（固定顺序） */
export const ALL_TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'ask', 'now'] as const
export type ToolName = (typeof ALL_TOOL_NAMES)[number]

/** 获取所有可用工具名（内置 + MCP 动态） */
export function getAllToolNames(): string[] {
  return [...ALL_TOOL_NAMES, ...mcpService.getAllToolNames()]
}

/** 工具 prompt 构建上下文 */
export interface ToolPromptContext {
  /** 是否存在项目路径 */
  hasProjectPath: boolean
}

/**
 * 工具 prompt 注册表
 * 每个条目定义：当 tools 中任一工具启用时，追加对应 i18n key 的 prompt
 * condition 为可选额外条件（如需要项目路径）
 * 新增工具 prompt 只需在此追加一行即可
 */
const TOOL_PROMPT_REGISTRY: Array<{
  tools: string[]
  key: string
  condition?: (ctx: ToolPromptContext) => boolean
}> = [
  { tools: ['bash', 'read', 'write', 'edit'], key: 'agent.promptSupplement', condition: (ctx) => ctx.hasProjectPath },
  { tools: ['ask'], key: 'agent.askToolGuidance' }
]

/** 根据启用的工具和上下文，构建需要追加到 system prompt 的文本 */
export function buildToolPrompts(enabledTools: string[], ctx: ToolPromptContext): string {
  return TOOL_PROMPT_REGISTRY
    .filter((entry) => entry.tools.some((name) => enabledTools.includes(name)))
    .filter((entry) => !entry.condition || entry.condition(ctx))
    .map((entry) => t(entry.key))
    .join('\n\n')
}

/** 解析会话的 enabledTools（session 覆盖 > project settings > 全部） */
export function resolveEnabledTools(
  sessionMeta: string | undefined,
  projectSettings: string | undefined
): string[] {
  // 优先使用 session 级别覆盖
  try {
    const meta = JSON.parse(sessionMeta || '{}')
    if (Array.isArray(meta.enabledTools)) return meta.enabledTools
  } catch { /* 忽略 */ }
  // 其次使用 project settings
  try {
    const settings = JSON.parse(projectSettings || '{}')
    if (Array.isArray(settings.enabledTools)) return settings.enabledTools
  } catch { /* 忽略 */ }
  // 默认全部启用（内置 + MCP）
  return getAllToolNames()
}
