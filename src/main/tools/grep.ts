/**
 * grep 工具 — 正则内容搜索
 * 基于 @vscode/ripgrep 搜索文件内容，返回匹配的文件路径+行号+行内容
 */

import { stat } from 'fs/promises'
import { resolve, relative } from 'path'
import { Type } from '@sinclair/typebox'
import {
  BaseTool,
  resolveProjectConfig,
  assertSandboxRead,
  TOOL_ABORTED,
  type ToolContext
} from './types'
import { resolveToCwd } from './utils/pathUtils'
import { rgSearch } from './utils/ripgrep'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:grep')

/** 单行最大显示字符数 */
const MAX_LINE_LENGTH = 2000

/** 最大返回匹配数 */
const LIMIT = 100

const GrepParamsSchema = Type.Object({
  pattern: Type.String({
    description:
      'The regex pattern to search for in file contents (e.g. "function\\s+\\w+", "TODO|FIXME")'
  }),
  path: Type.Optional(
    Type.String({
      description: 'The directory to search in (optional, defaults to current working directory)'
    })
  ),
  include: Type.Optional(
    Type.String({ description: 'File glob pattern to filter (e.g. "*.ts", "*.{js,jsx}")' })
  )
})

/** Grep 工具类 */
export class GrepTool extends BaseTool<typeof GrepParamsSchema> {
  readonly name = 'grep'
  readonly label = t('tool.grepLabel')
  readonly description =
    'Search file contents using regex patterns. Returns matching file paths, line numbers, and line text. Results respect .gitignore automatically. Use the include parameter to filter by file type. For searching file names instead of content, use the glob tool.'
  readonly parameters = GrepParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(
    _toolCallId: string,
    params: { pattern: string; path?: string; include?: string },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    if (!params.pattern) {
      throw new Error('pattern is required')
    }

    const config = resolveProjectConfig(this.ctx)
    const searchPath = params.path
      ? resolve(config.workingDirectory, resolveToCwd(params.path, config.workingDirectory))
      : config.workingDirectory

    // 沙箱模式：路径越界检查（工作目录 + 参考目录均允许）
    assertSandboxRead(config, searchPath)
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { pattern: string; path?: string; include?: string },
    signal?: AbortSignal
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>
    details: { matches: number; truncated: boolean }
  }> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const config = resolveProjectConfig(this.ctx)
    const searchPath = params.path
      ? resolve(config.workingDirectory, resolveToCwd(params.path, config.workingDirectory))
      : config.workingDirectory

    log.info(`grep "${params.pattern}" in ${searchPath}`)

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

    // 使用 ripgrep 搜索
    const { matches, truncated } = await rgSearch({
      cwd: searchPath,
      pattern: params.pattern,
      include: params.include,
      limit: LIMIT,
      signal
    })

    if (matches.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No matches found' }],
        details: { matches: 0, truncated: false }
      }
    }

    // 格式化输出：按文件分组
    const outputLines: string[] = [
      `Found ${matches.length} matches${truncated ? ` (showing first ${LIMIT})` : ''}`
    ]

    let currentFile = ''
    for (const match of matches) {
      // 转为相对于工作目录的路径
      const absPath = resolve(searchPath, match.path)
      const relPath = relative(config.workingDirectory, absPath)

      if (currentFile !== relPath) {
        if (currentFile !== '') outputLines.push('')
        currentFile = relPath
        outputLines.push(`${relPath}:`)
      }

      const lineText =
        match.lineText.length > MAX_LINE_LENGTH
          ? match.lineText.substring(0, MAX_LINE_LENGTH) + '...'
          : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${lineText}`)
    }

    if (truncated) {
      outputLines.push('')
      outputLines.push(
        `(Results truncated: showing first ${LIMIT} matches. Use a more specific pattern or path.)`
      )
    }

    return {
      content: [{ type: 'text' as const, text: outputLines.join('\n') }],
      details: {
        matches: matches.length,
        truncated
      }
    }
  }
}
