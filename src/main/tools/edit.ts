/**
 * Edit 工具 — 精确文本替换编辑文件
 * 从 pi-coding-agent 移植，支持模糊匹配、BOM 处理、行尾规范化
 */

import { constants } from 'fs'
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { resolveToCwd } from './utils/pathUtils'
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
  path: Type.String({ description: '要编辑的文件路径（相对或绝对路径）' }),
  oldText: Type.String({ description: '要查找并替换的精确文本（必须完全匹配，包括空白字符）' }),
  newText: Type.String({ description: '替换后的新文本' })
})

/** 创建 edit 工具实例 */
export function createEditTool(cwd: string): AgentTool<typeof EditParamsSchema> {

  return {
    name: 'edit',
    label: '编辑文件',
    description:
      'Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.',
    parameters: EditParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { path: string; oldText: string; newText: string },
      signal?: AbortSignal
    ) => {
      const absolutePath = resolveToCwd(params.path, cwd)
      console.log(`[Tool: edit] ${absolutePath}`)

      return new Promise<{
        content: Array<{ type: 'text'; text: string }>
        details: { diff: string; firstChangedLine?: number } | undefined
      }>((resolve, reject) => {
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
            // 检查文件是否存在
            try {
              await fsAccess(absolutePath, constants.R_OK | constants.W_OK)
            } catch {
              if (signal) signal.removeEventListener('abort', onAbort)
              reject(new Error(`文件不存在: ${params.path}`))
              return
            }

            if (aborted) return

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
                  `在 ${params.path} 中未找到匹配文本。oldText 必须精确匹配，包括所有空白和换行。`
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
                  `在 ${params.path} 中找到 ${occurrences} 处匹配。文本必须唯一，请提供更多上下文。`
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
              reject(new Error(`替换未产生变化: ${params.path}`))
              return
            }

            const finalContent = bom + restoreLineEndings(newContent, originalEnding)
            await fsWriteFile(absolutePath, finalContent, 'utf-8')

            if (aborted) return

            if (signal) signal.removeEventListener('abort', onAbort)

            const diffResult = generateDiffString(baseContent, newContent)
            resolve({
              content: [
                {
                  type: 'text',
                  text: `成功替换 ${params.path} 中的文本。`
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
