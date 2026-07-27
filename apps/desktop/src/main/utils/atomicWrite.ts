/**
 * 原子写文件 —— 先写同目录临时文件再 rename。
 *
 * 用于"这个文件就是真源"的场景：writeFileSync 默认 'w' 会先截断再写，写到一半崩溃
 * 就把原内容毁了。rename 在同一文件系统内是原子的，读者要么看到旧内容要么看到新内容。
 */

import { writeFileSync, renameSync, rmSync } from 'fs'

export function writeFileAtomic(filePath: string, data: string | Uint8Array): void {
  const tempPath = `${filePath}.partial`
  try {
    writeFileSync(tempPath, data)
    renameSync(tempPath, filePath)
  } catch (err) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw err
  }
}
