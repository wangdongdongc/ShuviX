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

/** 顶层目录中识别为指令文件的候选名（大小写敏感） */
export const INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
