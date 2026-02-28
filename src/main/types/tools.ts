/** 全部内置工具名称（固定顺序） */
export const ALL_TOOL_NAMES = [
  'bash',
  'read',
  'write',
  'edit',
  'ask',
  'ls',
  'grep',
  'glob',
  'ssh',
  'shuvix-project',
  'shuvix-setting'
] as const
export type ToolName = (typeof ALL_TOOL_NAMES)[number]

/** 默认启用的核心工具（不含 shuvix-project、shuvix-setting、MCP、skills） */
export const DEFAULT_TOOL_NAMES = [
  'bash',
  'read',
  'write',
  'edit',
  'ask',
  'ls',
  'grep',
  'glob'
] as const
