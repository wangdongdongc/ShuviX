/**
 * 工具输出后处理（桌面 wrapper）—— 截断/落盘内核已下沉 @shuvix/agent-runtime。
 * 此处只注入「Node fs 写 tool_results」作为 SpillSink（`desktopSpillSink`，durable 工具包装器
 * wrapToolOutput.ts 用的也是它），并保留既有导出签名给调用方。
 */
import { join } from 'path'
import { writeFileSync } from 'fs'
import {
  processToolOutput as sharedProcessToolOutput,
  type SpillSink,
  type TruncateStrategy,
  type ProcessToolOutputResult
} from '@shuvix/agent-runtime'
import { getToolResultsDir } from '../paths'

export type { TruncateStrategy, ProcessToolOutputResult }

export interface ProcessToolOutputOptions {
  sessionId: string
  toolCallId: string
  fullText: string
  strategy: TruncateStrategy
  maxLines?: number
  maxBytes?: number
  /**
   * 超限时落盘、回预览 + 「用 read 工具取全文」。缺省 true。false = 只在内存里截断：这个 agent
   * 没有 read 工具，落盘的全文它取不回来，那句指引就成了死路（Chrome 标签页会话的 `tab` 档案即如此）。
   */
  spill?: boolean
}

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

export function processToolOutput(
  opts: ProcessToolOutputOptions
): Promise<ProcessToolOutputResult> {
  return sharedProcessToolOutput({
    toolCallId: opts.toolCallId,
    fullText: opts.fullText,
    strategy: opts.strategy,
    maxLines: opts.maxLines,
    maxBytes: opts.maxBytes,
    sink: opts.spill === false ? undefined : desktopSpillSink(opts.sessionId)
  })
}
