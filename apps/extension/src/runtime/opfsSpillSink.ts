/**
 * 扩展工具输出落盘 sink —— 写到会话工作目录内的 .shuvix/tool_results/，
 * 这样 agent 能用 read 工具按相对路径取回全文（read 的根就是同一个工作目录）。
 *
 * 临时会话根=OPFS 目录；项目会话根=用户 FSA 文件夹（额外懒写 .shuvix/.gitignore=* 避免污染仓库）。
 */
import type { SpillSink } from '@shuvix/agent-runtime'
import { createFsaPort } from './fsaPort'

const SPILL_DIR = '.shuvix/tool_results'

export interface CreateSpillSinkOptions {
  /** 项目根：懒写 .shuvix/.gitignore=* 忽略落盘产物（OPFS 临时根无需） */
  writeGitignore?: boolean
}

export function createSpillSink(
  root: FileSystemDirectoryHandle,
  opts: CreateSpillSinkOptions = {}
): SpillSink {
  const port = createFsaPort(root)
  let gitignoreWritten = false
  return {
    async write(toolCallId, fullText) {
      try {
        if (opts.writeGitignore && !gitignoreWritten) {
          gitignoreWritten = true
          await port.writeFile('.shuvix/.gitignore', '*\n').catch(() => {})
        }
        const locator = `${SPILL_DIR}/${toolCallId}.txt`
        await port.writeFile(locator, fullText)
        return { locator }
      } catch {
        return null
      }
    }
  }
}
