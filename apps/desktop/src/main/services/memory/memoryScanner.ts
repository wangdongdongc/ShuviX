/**
 * 项目记忆扫描 —— 读 ~/.shuvix/memory/<projectId>/*.md，解析为 ParsedMemoryFile。
 *
 * 纯 md 驱动，无数据库表、无启用开关：文件在即存在，同 agents / policies 的做法。
 * 解析失败的文件跳过并记警告 —— 一条坏记忆不该让整个索引消失。
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { parseMemoryFile, type ParsedMemoryFile } from '@shuvix/agent-runtime'
import { getProjectMemoryDir } from '../../utils/paths'
import { createLogger } from '../../logger'

const log = createLogger('memory')

/** 扫描某项目的全部记忆，按 slug 字母序（渲染顺序稳定，diff 可读） */
export function scanProjectMemories(projectId: string): ParsedMemoryFile[] {
  const dir = getProjectMemoryDir(projectId)
  if (!existsSync(dir)) return []

  let entries: string[]
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch (e) {
    log.warn(`failed to read memory dir ${dir}: ${(e as Error).message}`)
    return []
  }

  const out: ParsedMemoryFile[] = []
  for (const file of entries.sort()) {
    const full = join(dir, file)
    try {
      const parsed = parseMemoryFile(readFileSync(full, 'utf-8'), basename(file, '.md'), (msg) =>
        log.warn(msg)
      )
      if (parsed) out.push(parsed)
    } catch (e) {
      log.warn(`failed to read memory ${full}: ${(e as Error).message}`)
    }
  }
  return out
}
