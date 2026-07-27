/**
 * 指令文件扫描器 — 扫描工作目录顶层（不递归子目录）
 * 候选名大小写敏感：AGENTS.md / CLAUDE.md
 */

import { existsSync, statSync } from 'fs'
import { join } from 'path'
import {
  INSTRUCTION_FILE_CANDIDATES,
  type InstructionFileEntry
} from '@shuvix/chat-protocol/types/instructionFile'
import { createLogger } from '../../logger'

const log = createLogger('InstructionFileScanner')

/** 扫描工作目录顶层的候选指令文件 */
export function scanInstructionFiles(workingDir: string): InstructionFileEntry[] {
  if (!workingDir) {
    return []
  }
  const result: InstructionFileEntry[] = []
  for (const name of INSTRUCTION_FILE_CANDIDATES) {
    const absolutePath = join(workingDir, name)
    if (!existsSync(absolutePath)) continue
    try {
      const st = statSync(absolutePath)
      if (!st.isFile()) continue
      result.push({ filename: name, absolutePath, size: st.size })
    } catch (err: unknown) {
      log.warn(`stat 失败: ${absolutePath} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  if (result.length > 0) {
    log.info(
      `扫描 ${workingDir} 命中 ${result.length} 个指令文件: [${result.map((f) => f.filename).join(', ')}]`
    )
  }
  return result
}
