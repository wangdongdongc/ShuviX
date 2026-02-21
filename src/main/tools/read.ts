/**
 * Read 工具 — 读取文件内容
 * 从 pi-coding-agent 移植，支持分页读取、行号、截断
 */

import { readFile as fsReadFile, stat as fsStat } from 'fs/promises'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { truncateHead, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { resolveReadPath } from './utils/pathUtils'
import { resolveProjectConfig, isPathWithinWorkspace, type ToolContext } from './types'
import { t } from '../i18n'

const ReadParamsSchema = Type.Object({
  path: Type.String({
    description: t('tool.paramPath')
  }),
  offset: Type.Optional(
    Type.Number({
      description: t('tool.paramOffset')
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: t('tool.paramLimit')
    })
  )
})

/** 创建 read 工具实例 */
export function createReadTool(ctx: ToolContext): AgentTool<typeof ReadParamsSchema> {

  return {
    name: 'read',
    label: t('tool.readLabel'),
    description:
      'Read the contents of a file. Supports text files with optional line offset and limit for pagination. Returns content with line numbers.',
    parameters: ReadParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { path: string; offset?: number; limit?: number },
      signal?: AbortSignal
    ) => {
      if (signal?.aborted) throw new Error(t('tool.aborted'))

      const config = resolveProjectConfig(ctx)
      const absolutePath = resolveReadPath(params.path, config.workingDirectory)
      console.log(`[Tool: read] ${absolutePath}`)

      // 沙箱模式：路径越界检查
      if (config.sandboxEnabled && !isPathWithinWorkspace(absolutePath, config.workingDirectory)) {
        return {
          content: [{ type: 'text' as const, text: t('tool.sandboxBlocked', { path: params.path, workspace: config.workingDirectory }) }],
          details: undefined
        }
      }

      try {
        // 获取文件信息
        const s = await fsStat(absolutePath)
        const fileStat = { size: s.size, isFile: s.isFile() }
        if (!fileStat.isFile) {
          return {
            content: [{ type: 'text' as const, text: t('tool.notAFile', { path: params.path }) }],
            details: undefined
          }
        }

        if (signal?.aborted) throw new Error(t('tool.aborted'))

        // 读取文件
        const buffer = await fsReadFile(absolutePath)
        const content = buffer.toString('utf-8')
        const allLines = content.split('\n')
        const totalLines = allLines.length

        // 分页处理
        let lines = allLines
        let startLine = 1
        if (params.offset && params.offset > 0) {
          startLine = params.offset
          lines = allLines.slice(startLine - 1)
        }
        if (params.limit && params.limit > 0) {
          lines = lines.slice(0, params.limit)
        }

        // 添加行号
        const numbered = lines.map((line, i) => {
          const lineNum = startLine + i
          return `${String(lineNum).padStart(String(totalLines).length, ' ')}│${line}`
        })

        let text = numbered.join('\n')

        // 截断处理
        const truncated = truncateHead(text, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)
        if (truncated.truncated) {
          text = `${t('tool.outputTruncated', { lines: totalLines, size: formatSize(fileStat.size) })}\n\n${truncated.text}`
        } else {
          text = truncated.text
        }

        // 添加文件信息头
        const header = t('tool.fileHeader', { path: params.path, lines: totalLines, size: formatSize(fileStat.size) })
        if (params.offset || params.limit) {
          const endLine = startLine + lines.length - 1
          text = `${header}\n${t('tool.showingLines', { start: startLine, end: endLine })}\n\n${text}`
        } else {
          text = `${header}\n\n${text}`
        }

        return {
          content: [{ type: 'text' as const, text }],
          details: {
            totalLines,
            fileSize: fileStat.size,
            truncated: truncated.truncated
          }
        }
      } catch (err: any) {
        if (err.message === t('tool.aborted')) throw err
        if (err.code === 'ENOENT') {
          return {
            content: [{ type: 'text' as const, text: t('tool.fileNotFound', { path: params.path }) }],
            details: undefined
          }
        }
        return {
          content: [{ type: 'text' as const, text: t('tool.cmdFailed', { message: err.message }) }],
          details: undefined
        }
      }
    }
  }
}
