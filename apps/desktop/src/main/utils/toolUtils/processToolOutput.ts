/**
 * 工具输出后处理（桌面 wrapper）—— 截断/落盘内核已下沉 @shuvix/agent-runtime。
 * 此处仅注入「Node fs 写 tool_results」作为 SpillSink，并保留既有导出签名给调用方。
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
}

export function processToolOutput(
  opts: ProcessToolOutputOptions
): Promise<ProcessToolOutputResult> {
  // 桌面落盘：写 userData/tool_results/{sessionId}/{toolCallId}.txt（绝对路径即 locator，
  // read 工具的沙箱已白名单 tool_results 目录，模型可直接 read 取回全文）
  const sink: SpillSink = {
    async write(toolCallId, fullText) {
      try {
        const filePath = join(getToolResultsDir(opts.sessionId), `${toolCallId}.txt`)
        writeFileSync(filePath, fullText, 'utf-8')
        return { locator: filePath }
      } catch {
        return null
      }
    }
  }
  return sharedProcessToolOutput({
    toolCallId: opts.toolCallId,
    fullText: opts.fullText,
    strategy: opts.strategy,
    maxLines: opts.maxLines,
    maxBytes: opts.maxBytes,
    sink
  })
}
