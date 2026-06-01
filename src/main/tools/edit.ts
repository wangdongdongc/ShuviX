/**
 * Edit 工具 — 精确文本替换编辑文件
 * 从 pi-coding-agent 移植，支持模糊匹配、BOM 处理、行尾规范化
 */

import { constants } from 'fs'
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises'
import { Type } from 'typebox'
import { resolveToCwd } from '../utils/toolUtils/pathUtils'
import { assertNotModifiedSinceRead, withFileLock, recordRead } from '../utils/toolUtils/fileTime'
import { BaseTool } from '../services/baseTool'
import {
  resolveProjectConfig,
  assertSandboxWrite,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { EditToolDetails } from '../../shared/types/chatMessage'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:edit')
import {
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom
} from '../utils/toolUtils/editDiff'
import { replaceWithFallback } from '../utils/toolUtils/replacers'

const EditParamsSchema = Type.Object({
  path: Type.String({ description: 'The absolute path to the file to modify' }),
  oldText: Type.String({
    description: 'Exact text to find and replace (must match exactly, including whitespace)'
  }),
  newText: Type.String({ description: 'New text to replace with' })
})

/** Edit 工具类 */
export class EditTool extends BaseTool<typeof EditParamsSchema> {
  readonly name = 'edit'
  readonly label = t('tool.editLabel')
  readonly description =
    'Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.'
  readonly parameters = EditParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(
    toolCallId: string,
    params: { path: string; oldText: string; newText: string }
  ): Promise<void> {
    const config = resolveProjectConfig(this.ctx.sessionId)
    const absolutePath = resolveToCwd(params.path, config.workingDirectory)

    // 沙箱守卫:工作目录 + readwrite 参考目录 + allowList 内直接通过,否则挂起等待审批
    await assertSandboxWrite(this.ctx, config, toolCallId, 'edit', absolutePath, params.path)
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { path: string; oldText: string; newText: string },
    signal?: AbortSignal
  ): Promise<AgentToolResult<EditToolDetails>> {
    const config = resolveProjectConfig(this.ctx.sessionId)
    const absolutePath = resolveToCwd(params.path, config.workingDirectory)
    log.info(absolutePath)

    return new Promise<AgentToolResult<EditToolDetails>>((resolve, reject) => {
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
          // 检查文件是否存在
          try {
            await fsAccess(absolutePath, constants.R_OK | constants.W_OK)
          } catch {
            if (signal) signal.removeEventListener('abort', onAbort)
            reject(new Error(`File not found: ${params.path}`))
            return
          }

          if (aborted) return

          // 校验文件是否在上次读取后被外部修改
          assertNotModifiedSinceRead(this.ctx.sessionId, absolutePath)

          // 读取文件
          const buffer = await fsReadFile(absolutePath)
          const rawContent = buffer.toString('utf-8')

          if (aborted) return

          // BOM 和行尾处理
          const { bom, text: content } = stripBom(rawContent)
          const originalEnding = detectLineEnding(content)
          const normalizedContent = normalizeToLF(content)
          const normalizedOldText = normalizeToLF(params.oldText)
          const normalizedNewText = normalizeToLF(params.newText)

          // 多级回退链匹配 + 替换
          let replaceResult: { content: string; replacerName: string }
          try {
            replaceResult = replaceWithFallback(
              normalizedContent,
              normalizedOldText,
              normalizedNewText
            )
          } catch (err: unknown) {
            if (signal) signal.removeEventListener('abort', onAbort)
            const msg = err instanceof Error ? err.message : String(err)
            reject(new Error(`${params.path}: ${msg}`))
            return
          }

          if (aborted) return

          const newContent = replaceResult.content

          // 验证替换是否有效
          if (normalizedContent === newContent) {
            if (signal) signal.removeEventListener('abort', onAbort)
            reject(new Error(`No change produced: ${params.path}`))
            return
          }

          const finalContent = bom + restoreLineEndings(newContent, originalEnding)
          await withFileLock(absolutePath, async () => {
            await fsWriteFile(absolutePath, finalContent, 'utf-8')
          })
          // 写入后更新读取时间，避免后续编辑被自己的写入触发警告
          recordRead(this.ctx.sessionId, absolutePath)

          if (aborted) return

          if (signal) signal.removeEventListener('abort', onAbort)

          const diffResult = generateDiffString(normalizedContent, newContent)
          resolve({
            content: [
              {
                type: 'text',
                text: `Successfully edited ${params.path}`
              }
            ],
            details: {
              type: 'edit',
              diff: diffResult.diff,
              firstChangedLine: diffResult.firstChangedLine
            }
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
  name: 'edit',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.editLabel'),
  getHint: () => t('tool.editHint'),
  factory: (ctx) => new EditTool(ctx),
  presentation: {
    icon: 'FilePen',
    summaryField: 'path',
    formItems: [
      { field: 'path' },
      { field: 'oldText', renderer: { type: 'code', language: 'typescript' } },
      { field: 'newText', renderer: { type: 'code', language: 'typescript' } }
    ]
  }
})
