/**
 * Write 工具 — 写入文件内容
 * 从 pi-coding-agent 移植，支持创建父目录、abort
 */

import { mkdir as fsMkdir, writeFile as fsWriteFile } from 'fs/promises'
import { dirname } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { resolveToCwd } from './utils/pathUtils'
import { assertNotModifiedSinceRead, withFileLock, recordRead, getReadTime } from './utils/fileTime'
import { resolveProjectConfig, isPathWithinWorkspace, type ToolContext } from './types'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:write')

const WriteParamsSchema = Type.Object({
  path: Type.String({ description: 'The file path to write to (relative or absolute)' }),
  content: Type.String({ description: 'The content to write to the file' })
})

/** 创建 write 工具实例 */
export function createWriteTool(ctx: ToolContext): AgentTool<typeof WriteParamsSchema> {

  return {
    name: 'write',
    label: t('tool.writeLabel'),
    description:
      'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Automatically creates parent directories.',
    parameters: WriteParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { path: string; content: string },
      signal?: AbortSignal
    ) => {
      const config = resolveProjectConfig(ctx)
      const absolutePath = resolveToCwd(params.path, config.workingDirectory)
      const dir = dirname(absolutePath)
      
      log.info(absolutePath)

      // 沙箱模式：路径越界检查
      if (config.sandboxEnabled && !isPathWithinWorkspace(absolutePath, config.workingDirectory)) {
        throw new Error(t('tool.sandboxBlocked', { path: params.path, workspace: config.workingDirectory }))
      }

      return new Promise<{ content: Array<{ type: 'text'; text: string }>; details: undefined }>(
        (resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error(t('tool.aborted')))
            return
          }

          let aborted = false

          const onAbort = (): void => {
            aborted = true
            reject(new Error(t('tool.aborted')))
          }

          if (signal) {
            signal.addEventListener('abort', onAbort, { once: true })
          }

          ;(async () => {
            try {
              // 仅当文件已存在且曾被读取过时，校验是否被外部修改（新建文件无需检查）
              if (getReadTime(ctx.sessionId, absolutePath)) {
                assertNotModifiedSinceRead(ctx.sessionId, absolutePath)
              }

              await fsMkdir(dir, { recursive: true })
              if (aborted) return

              await withFileLock(absolutePath, async () => {
                await fsWriteFile(absolutePath, params.content, 'utf-8')
              })
              // 写入后更新读取时间
              recordRead(ctx.sessionId, absolutePath)
              if (aborted) return

              if (signal) signal.removeEventListener('abort', onAbort)

              resolve({
                content: [{ type: 'text', text: t('tool.writeSuccess', { bytes: params.content.length, path: params.path }) }],
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
