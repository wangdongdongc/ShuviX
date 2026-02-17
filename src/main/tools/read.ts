/**
 * Read 工具 — 读取文件内容
 * 从 pi-coding-agent 移植，支持分页读取、行号、截断
 */

import { readFile as fsReadFile, stat as fsStat } from 'fs/promises'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { truncateHead, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { resolveReadPath } from './utils/pathUtils'

const ReadParamsSchema = Type.Object({
  path: Type.String({
    description: '要读取的文件路径（相对或绝对路径）'
  }),
  offset: Type.Optional(
    Type.Number({
      description: '起始行号（从 1 开始），用于分页读取大文件'
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: '读取的最大行数，与 offset 配合使用'
    })
  )
})

/** 创建 read 工具实例 */
export function createReadTool(cwd: string): AgentTool<typeof ReadParamsSchema> {

  return {
    name: 'read',
    label: '读取文件',
    description:
      'Read the contents of a file. Supports text files with optional line offset and limit for pagination. Returns content with line numbers.',
    parameters: ReadParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { path: string; offset?: number; limit?: number },
      signal?: AbortSignal
    ) => {
      if (signal?.aborted) throw new Error('操作已中止')

      const absolutePath = resolveReadPath(params.path, cwd)
      console.log(`[工具调用] read ${absolutePath}`)

      try {
        // 获取文件信息
        const s = await fsStat(absolutePath)
        const fileStat = { size: s.size, isFile: s.isFile() }
        if (!fileStat.isFile) {
          return {
            content: [{ type: 'text' as const, text: `错误：${params.path} 不是一个文件` }],
            details: undefined
          }
        }

        if (signal?.aborted) throw new Error('操作已中止')

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
          text = `[内容已截断：文件共 ${totalLines} 行 / ${formatSize(fileStat.size)}]\n\n${truncated.text}`
        } else {
          text = truncated.text
        }

        // 添加文件信息头
        const header = `文件: ${params.path} (${totalLines} 行, ${formatSize(fileStat.size)})`
        if (params.offset || params.limit) {
          const endLine = startLine + lines.length - 1
          text = `${header}\n显示: 第 ${startLine}-${endLine} 行\n\n${text}`
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
        if (err.message === '操作已中止') throw err
        if (err.code === 'ENOENT') {
          return {
            content: [{ type: 'text' as const, text: `文件不存在: ${params.path}` }],
            details: undefined
          }
        }
        return {
          content: [{ type: 'text' as const, text: `读取文件失败: ${err.message}` }],
          details: undefined
        }
      }
    }
  }
}
