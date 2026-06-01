/**
 * Write 工具 — 写入文件内容
 * 从 pi-coding-agent 移植，支持创建父目录、abort
 */

import { mkdir as fsMkdir, writeFile as fsWriteFile } from 'fs/promises'
import { dirname } from 'path'
import { Type } from 'typebox'
import { resolveToCwd } from '../utils/toolUtils/pathUtils'
import {
  assertNotModifiedSinceRead,
  withFileLock,
  recordRead,
  getReadTime
} from '../utils/toolUtils/fileTime'
import { BaseTool } from '../services/baseTool'
import {
  resolveProjectConfig,
  assertSandboxWrite,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:write')

const WriteParamsSchema = Type.Object({
  path: Type.String({ description: 'The file path to write to (relative or absolute)' }),
  content: Type.String({ description: 'The content to write to the file' })
})

/** Write 工具类 */
export class WriteTool extends BaseTool<typeof WriteParamsSchema> {
  readonly name = 'write'
  readonly label = t('tool.writeLabel')
  readonly description =
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories."
  readonly parameters = WriteParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(
    toolCallId: string,
    params: { path: string; content: string }
  ): Promise<void> {
    const config = resolveProjectConfig(this.ctx.sessionId)
    const absolutePath = resolveToCwd(params.path, config.workingDirectory)

    // 沙箱守卫:工作目录 + readwrite 参考目录 + allowList 内直接通过,否则挂起等待审批
    await assertSandboxWrite(this.ctx, config, toolCallId, 'write', absolutePath, params.path)
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { path: string; content: string },
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    const config = resolveProjectConfig(this.ctx.sessionId)
    const absolutePath = resolveToCwd(params.path, config.workingDirectory)
    const dir = dirname(absolutePath)

    log.info(absolutePath)

    return new Promise<AgentToolResult<undefined>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(TOOL_ABORTED))
        return
      }

      let aborted = false

      const onAbort = (): void => {
        aborted = true
        reject(new Error(TOOL_ABORTED))
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      ;(async () => {
        try {
          // 仅当文件已存在且曾被读取过时，校验是否被外部修改（新建文件无需检查）
          if (getReadTime(this.ctx.sessionId, absolutePath)) {
            assertNotModifiedSinceRead(this.ctx.sessionId, absolutePath)
          }

          await fsMkdir(dir, { recursive: true })
          if (aborted) return

          await withFileLock(absolutePath, async () => {
            await fsWriteFile(absolutePath, params.content, 'utf-8')
          })
          // 写入后更新读取时间
          recordRead(this.ctx.sessionId, absolutePath)
          if (aborted) return

          if (signal) signal.removeEventListener('abort', onAbort)

          resolve({
            content: [
              { type: 'text', text: `Wrote ${params.content.length} bytes to ${params.path}` }
            ],
            details: undefined
          })
        } catch (error: unknown) {
          if (signal) signal.removeEventListener('abort', onAbort)
          if (!aborted) reject(error)
        }
      })()
    })
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'write',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.writeLabel'),
  getHint: () => t('tool.writeHint'),
  factory: (ctx) => new WriteTool(ctx),
  presentation: {
    icon: 'FileOutput',
    summaryField: 'path',
    formItems: [
      { field: 'path' },
      { field: 'content', renderer: { type: 'code', language: 'typescript' } }
    ]
  }
})
