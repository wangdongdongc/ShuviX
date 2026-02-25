/**
 * Edit 工具 — 精确文本替换编辑文件
 * 从 pi-coding-agent 移植，支持模糊匹配、BOM 处理、行尾规范化
 */

import { constants } from 'fs'
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { resolveToCwd } from './utils/pathUtils'
import { assertNotModifiedSinceRead, withFileLock, recordRead } from './utils/fileTime'
import { resolveProjectConfig, assertSandboxWrite, type ToolContext } from './types'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:edit')
import {
  detectLineEnding,
  fuzzyFindText,
  generateDiffString,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom
} from './utils/editDiff'

const EditParamsSchema = Type.Object({
  path: Type.String({ description: 'The absolute path to the file to modify' }),
  oldText: Type.String({ description: 'Exact text to find and replace (must match exactly, including whitespace)' }),
  newText: Type.String({ description: 'New text to replace with' })
})

/** 创建 edit 工具实例 */
export function createEditTool(ctx: ToolContext): AgentTool<typeof EditParamsSchema> {

  return {
    name: 'edit',
    label: t('tool.editLabel'),
    description:
      'Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.',
    parameters: EditParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { path: string; oldText: string; newText: string },
      signal?: AbortSignal
    ) => {
      const config = resolveProjectConfig(ctx)
      const absolutePath = resolveToCwd(params.path, config.workingDirectory)
      log.info(absolutePath)

      // 沙箱模式：路径越界检查
      assertSandboxWrite(config, absolutePath, params.path)

      return new Promise<{
        content: Array<{ type: 'text'; text: string }>
        details: { diff: string; firstChangedLine?: number } | undefined
      }>((resolve, reject) => {
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
            // 检查文件是否存在
            try {
              await fsAccess(absolutePath, constants.R_OK | constants.W_OK)
            } catch {
              if (signal) signal.removeEventListener('abort', onAbort)
              reject(new Error(t('tool.fileNotFound', { path: params.path })))
              return
            }

            if (aborted) return

            // 校验文件是否在上次读取后被外部修改
            assertNotModifiedSinceRead(ctx.sessionId, absolutePath)

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

            // 模糊匹配查找
            const matchResult = fuzzyFindText(normalizedContent, normalizedOldText)

            if (!matchResult.found) {
              if (signal) signal.removeEventListener('abort', onAbort)
              reject(
                new Error(
                  t('tool.editNoMatch', { path: params.path })
                )
              )
              return
            }

            // 检查唯一性
            const fuzzyContent = normalizeForFuzzyMatch(normalizedContent)
            const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText)
            const occurrences = fuzzyContent.split(fuzzyOldText).length - 1

            if (occurrences > 1) {
              if (signal) signal.removeEventListener('abort', onAbort)
              reject(
                new Error(
                  t('tool.editMultiMatch', { path: params.path, count: occurrences })
                )
              )
              return
            }

            if (aborted) return

            // 执行替换
            const baseContent = matchResult.contentForReplacement
            const newContent =
              baseContent.substring(0, matchResult.index) +
              normalizedNewText +
              baseContent.substring(matchResult.index + matchResult.matchLength)

            // 验证替换是否有效
            if (baseContent === newContent) {
              if (signal) signal.removeEventListener('abort', onAbort)
              reject(new Error(t('tool.editNoChange', { path: params.path })))
              return
            }

            const finalContent = bom + restoreLineEndings(newContent, originalEnding)
            await withFileLock(absolutePath, async () => {
              await fsWriteFile(absolutePath, finalContent, 'utf-8')
            })
            // 写入后更新读取时间，避免后续编辑被自己的写入触发警告
            recordRead(ctx.sessionId, absolutePath)

            if (aborted) return

            if (signal) signal.removeEventListener('abort', onAbort)

            const diffResult = generateDiffString(baseContent, newContent)
            resolve({
              content: [
                {
                  type: 'text',
                  text: t('tool.editSuccess', { path: params.path })
                }
              ],
              details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine }
            })
          } catch (error: any) {
            if (signal) signal.removeEventListener('abort', onAbort)
            if (!aborted) reject(error)
          }
        })()
      })
    }
  }
}
