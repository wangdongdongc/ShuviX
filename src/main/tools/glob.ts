/**
 * glob 工具 — 文件模式匹配
 * 基于 @vscode/ripgrep 按 glob 模式查找文件，按修改时间降序排序
 */

import { stat } from 'fs/promises'
import { resolve, relative } from 'path'
import { statSync } from 'fs'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { resolveProjectConfig, assertSandboxRead, TOOL_ABORTED, type ToolContext } from './types'
import { resolveToCwd } from './utils/pathUtils'
import { rgFilesList } from './utils/ripgrep'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:glob')

/** 最大返回文件数 */
const LIMIT = 100

const GlobParamsSchema = Type.Object({
  pattern: Type.String({
    description:
      'The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.{js,jsx}", "*.json")'
  }),
  path: Type.Optional(
    Type.String({
      description: 'The directory to search in (optional, defaults to current working directory)'
    })
  )
})

/** 创建 glob 工具实例 */
export function createGlobTool(ctx: ToolContext): AgentTool<typeof GlobParamsSchema> {
  return {
    name: 'glob',
    label: t('tool.globLabel'),
    description:
      'Fast file pattern matching tool that finds files by name/path patterns. Returns matching file paths sorted by modification time (most recent first). Respects .gitignore automatically. Use this when you need to find files by name patterns. For searching file contents, use the grep tool instead.',
    parameters: GlobParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { pattern: string; path?: string },
      signal?: AbortSignal
    ) => {
      if (signal?.aborted) throw new Error(TOOL_ABORTED)

      if (!params.pattern) {
        throw new Error('pattern is required')
      }

      const config = resolveProjectConfig(ctx)
      const searchPath = params.path
        ? resolve(config.workingDirectory, resolveToCwd(params.path, config.workingDirectory))
        : config.workingDirectory

      log.info(`glob "${params.pattern}" in ${searchPath}`)

      // 沙箱模式：路径越界检查（工作目录 + 参考目录均允许）
      assertSandboxRead(config, searchPath)

      // 验证目录存在
      let dirStat
      try {
        dirStat = await stat(searchPath)
      } catch {
        throw new Error(`Path not found: ${searchPath}`)
      }
      if (!dirStat.isDirectory()) {
        throw new Error(`${searchPath} is not a directory`)
      }

      // 使用 ripgrep 列举匹配文件
      const { files, truncated } = await rgFilesList({
        cwd: searchPath,
        glob: [params.pattern],
        limit: LIMIT,
        signal
      })

      if (files.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No files found' }],
          details: { count: 0, truncated: false }
        }
      }

      // 获取 mtime 并按修改时间降序排序
      const filesWithMtime = files.map((f) => {
        const fullPath = resolve(searchPath, f)
        let mtime = 0
        try {
          mtime = statSync(fullPath).mtime.getTime()
        } catch {
          /* 忽略 */
        }
        return { path: f, mtime }
      })
      filesWithMtime.sort((a, b) => b.mtime - a.mtime)

      // 转为相对于工作目录的路径
      const outputLines = filesWithMtime.map((f) => {
        const absPath = resolve(searchPath, f.path)
        return relative(config.workingDirectory, absPath)
      })

      if (truncated) {
        outputLines.push('')
        outputLines.push(
          `(Results truncated: showing first ${LIMIT} results. Use a more specific path or pattern.)`
        )
      }

      return {
        content: [{ type: 'text' as const, text: outputLines.join('\n') }],
        details: {
          count: files.length,
          truncated
        }
      }
    }
  }
}
