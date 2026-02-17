/**
 * Write 工具 — 写入文件内容
 * 从 pi-coding-agent 移植，支持创建父目录、abort
 */

import { mkdir as fsMkdir, writeFile as fsWriteFile } from 'fs/promises'
import { dirname } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { resolveToCwd } from './utils/pathUtils'

const WriteParamsSchema = Type.Object({
  path: Type.String({ description: '要写入的文件路径（相对或绝对路径）' }),
  content: Type.String({ description: '要写入的文件内容' })
})

/** 创建 write 工具实例 */
export function createWriteTool(cwd: string): AgentTool<typeof WriteParamsSchema> {

  return {
    name: 'write',
    label: '写入文件',
    description:
      'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Automatically creates parent directories.',
    parameters: WriteParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { path: string; content: string },
      signal?: AbortSignal
    ) => {
      const absolutePath = resolveToCwd(params.path, cwd)
      const dir = dirname(absolutePath)
      
      console.log(`[Tool: write] ${absolutePath}`)

      return new Promise<{ content: Array<{ type: 'text'; text: string }>; details: undefined }>(
        (resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('操作已中止'))
            return
          }

          let aborted = false

          const onAbort = (): void => {
            aborted = true
            reject(new Error('操作已中止'))
          }

          if (signal) {
            signal.addEventListener('abort', onAbort, { once: true })
          }

          ;(async () => {
            try {
              await fsMkdir(dir, { recursive: true })
              if (aborted) return

              await fsWriteFile(absolutePath, params.content, 'utf-8')
              if (aborted) return

              if (signal) signal.removeEventListener('abort', onAbort)

              resolve({
                content: [{ type: 'text', text: `成功写入 ${params.content.length} 字节到 ${params.path}` }],
                details: undefined
              })
            } catch (error: any) {
              if (signal) signal.removeEventListener('abort', onAbort)
              if (!aborted) reject(error)
            }
          })()
        }
      )
    }
  }
}
