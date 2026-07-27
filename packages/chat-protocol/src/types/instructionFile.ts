/**
 * 项目指令文件元信息（main / preload / renderer 共用）
 */
export interface InstructionFileEntry {
  /** 文件名（保留原始大小写） */
  filename: string
  /** 绝对路径 */
  absolutePath: string
  /** 文件大小（字节） */
  size: number
}

/** 顶层目录中识别为指令文件的候选名（大小写敏感，数组顺序即默认优先级） */
export const INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const

/**
 * 解析会话实际注入的项目指令文件 —— **单选**，至多一个文件。
 *
 * @param configured 会话配置值：undefined = 未显式配置（按优先级自动选）；
 *                   null = 用户显式关闭注入；字符串 = 用户指定的文件名
 * @param available  磁盘上实际存在的候选文件名
 * @returns 应注入的文件名；null 表示不注入
 *
 * 默认策略：有 AGENTS.md 则用 AGENTS.md，否则有 CLAUDE.md 则用 CLAUDE.md，都没有则不注入。
 * 已配置的文件若已从磁盘消失同样退化为不注入（不回退到另一个候选，避免注入用户没选的文件）。
 */
export function resolveInstructionFile(
  configured: string | null | undefined,
  available: readonly string[]
): string | null {
  if (configured === null) return null
  if (configured !== undefined) return available.includes(configured) ? configured : null
  return INSTRUCTION_FILE_CANDIDATES.find((name) => available.includes(name)) ?? null
}
