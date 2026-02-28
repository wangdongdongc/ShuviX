/**
 * 工具名称常量、启用工具解析、工具 prompt 注册表
 * 独立于 agent / sessionService，避免循环依赖
 */

import { t } from '../i18n'
import { mcpService } from '../services/mcpService'
import { skillService } from '../services/skillService'
import { getSettingKeyDescriptions } from '../services/settingsService'
import { getProjectFieldDescriptions } from '../services/projectService'
import { sshCredentialDao } from '../dao/sshCredentialDao'
import { ALL_TOOL_NAMES, DEFAULT_TOOL_NAMES } from '../types/tools'
export { ALL_TOOL_NAMES, type ToolName } from '../types/tools'

/** 获取所有可用工具名（内置 + MCP 动态 + 已启用 Skill） */
export function getAllToolNames(): string[] {
  const skillNames = skillService.findEnabled().map((s) => `skill:${s.name}`)
  return [...ALL_TOOL_NAMES, ...mcpService.getAllToolNames(), ...skillNames]
}

/** 工具 prompt 构建上下文 */
export interface ToolPromptContext {
  /** 是否存在项目路径 */
  hasProjectPath: boolean
}

/**
 * 工具 prompt 注册表
 * 每个条目定义：当 tools 中任一工具启用时，追加对应 prompt 文本
 * - key: 使用 i18n key 的静态文本
 * - textFn: 运行时动态生成文本（优先于 key，适合从注册表拼接字段列表）
 * condition 为可选额外条件（如需要项目路径）
 * 新增工具 prompt 只需在此追加一行即可
 */
const TOOL_PROMPT_REGISTRY: Array<{
  tools: string[]
  key?: string
  textFn?: (matchedTools: string[]) => string
  condition?: (ctx: ToolPromptContext) => boolean
}> = [
  {
    tools: ['bash', 'read', 'write', 'edit', 'ls', 'grep', 'glob'],
    textFn: (matched) =>
      `You can use the following tools to work with files in the current project directory: ${matched.join(', ')}. All relative paths are based on the project directory.`,
    condition: (ctx) => ctx.hasProjectPath
  },
  { tools: ['ask'], key: 'agent.askToolGuidance' },
  {
    tools: ['shuvix-project'],
    textFn: () =>
      `You have the shuvix-project tool to read and modify the current project's configuration. Use action="get" to view settings, action="update" to change them. Updatable fields: ${getProjectFieldDescriptions()}. Update operations require user approval.`
  },
  {
    tools: ['shuvix-setting'],
    textFn: () =>
      `You have the shuvix-setting tool to read and modify global application settings. Use action="get" to view all settings, action="set" with key and value to change one. Known keys: ${getSettingKeyDescriptions()}. Set operations require user approval.`
  },
  {
    tools: ['ssh'],
    textFn: () => {
      const savedNames = sshCredentialDao.findAllNames()
      let prompt =
        'You have the ssh tool to connect to a remote server via SSH and execute commands.'
      if (savedNames.length > 0) {
        prompt += ` The user has pre-configured SSH credentials: [${savedNames.join(', ')}]. Connect directly using: ssh({ action: "connect", credentialName: "<name>" }).`
      }
      prompt +=
        ' Alternatively, use action="connect" without credentialName and the user will provide credentials through a secure UI dialog that you cannot see.'
      prompt +=
        ' Use action="exec" with a command to run it on the remote server (each command requires user approval). Use action="disconnect" to close the connection. You do NOT have access to any credentials — never ask the user for passwords in chat.'
      return prompt
    }
  }
]

/** 根据启用的工具和上下文，构建需要追加到 system prompt 的文本 */
export function buildToolPrompts(enabledTools: string[], ctx: ToolPromptContext): string {
  return TOOL_PROMPT_REGISTRY.filter((entry) =>
    entry.tools.some((name) => enabledTools.includes(name))
  )
    .filter((entry) => !entry.condition || entry.condition(ctx))
    .map((entry) => {
      const matched = entry.tools.filter((name) => enabledTools.includes(name))
      return entry.textFn ? entry.textFn(matched) : t(entry.key!)
    })
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
  } catch {
    /* 忽略 */
  }
  // 其次使用 project settings
  try {
    const settings = JSON.parse(projectSettings || '{}')
    if (Array.isArray(settings.enabledTools)) return settings.enabledTools
  } catch {
    /* 忽略 */
  }
  // 默认仅启用核心内置工具（不含 shuvix-project、shuvix-setting、MCP、skills）
  return DEFAULT_TOOL_NAMES as unknown as string[]
}
