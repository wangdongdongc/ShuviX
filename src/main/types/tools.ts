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
  'sql',
  'shuvix-project',
  'shuvix-setting',
  'explore',
  'claude-code'
] as const
export type ToolName = (typeof ALL_TOOL_NAMES)[number]

/** 默认启用的核心内置工具（不含 ripgrep 工具、shuvix-project、shuvix-setting） */
export const DEFAULT_TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'ask'] as const
