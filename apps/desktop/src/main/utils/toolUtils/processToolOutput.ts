/**
 * 工具输出落盘口（桌面）—— 截断 / 落盘的内核在 @shuvix/agent-runtime（`processToolOutput` /
 * `wrapDurableOutput`）。此处只提供「Node fs 写 tool_results」这个 SpillSink（`desktopSpillSink`），
 * 由 durable 工具包装器 wrapToolOutput.ts 注入内核。
 */
import { join } from 'path'
import { writeFileSync } from 'fs'
import type { SpillSink } from '@shuvix/agent-runtime'
import { getToolResultsDir } from '../paths'

/**
 * 落盘文件名。toolCallId 来自模型提供商（自定义的 OpenAI 兼容中转也算），不能原样拼进路径 ——
 * 带 `/` 或 `..` 的 id 会写出 tool_results 目录之外；只留字母、数字、`_`、`-`，截到一个正常长度。
 */
export function spillFileName(toolCallId: string): string {
  const safe = toolCallId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
  return `${safe || 'tool-call'}.txt`
}

/**
 * 桌面落盘口：写 userData/tool_results/{sessionId}/{spillId}.txt（绝对路径即 locator，
 * read 工具的准入范围已白名单 tool_results 目录，模型可直接 read 取回全文）。
 * 目录在第一次真写的时候才建（getToolResultsDir 会 mkdir）—— 没落盘的会话不留空目录。
 * 写失败交回 null：内核据此降级为内存截断。
 */
export function desktopSpillSink(sessionId: string): SpillSink {
  return {
    async write(spillId, fullText) {
      try {
        const filePath = join(getToolResultsDir(sessionId), spillFileName(spillId))
        writeFileSync(filePath, fullText, 'utf-8')
        return { locator: filePath }
      } catch {
        return null
      }
    }
  }
}
