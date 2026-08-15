/**
 * glob 工具 — 文件模式匹配
 * 基于 @vscode/ripgrep 按 glob 模式查找文件，按修改时间降序排序
 */

import { stat } from 'fs/promises'
import { resolve, relative } from 'path'
import { statSync } from 'fs'
import { Type } from 'typebox'
import { BaseTool } from '@shuvix/agent-runtime'
import {
  resolveProjectConfig,
  assertReadApproved,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { GlobToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveToCwd } from '../utils/toolUtils/pathUtils'
import { rgFilesList } from '../utils/toolUtils/ripgrep'
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

const GLOB_DESCRIPTION =
  'Fast file pattern matching tool that finds files by name/path patterns. Returns matching file paths sorted by modification time (most recent first). Respects .gitignore automatically. Use this when you need to find files by name patterns. For searching file contents, use the grep tool instead.'

/** glob 工具 */
export class GlobTool extends BaseTool<typeof GlobParamsSchema> {
  readonly name = 'glob'
  readonly label = t('tool.globLabel')
  readonly description = GLOB_DESCRIPTION
  readonly parameters = GlobParamsSchema
  readonly outputStrategy = 'tail' as const

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(
    toolCallId: string,
    params: { pattern: string; path?: string },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    if (!params.pattern) {
      throw new Error('pattern is required')
    }

    const config = resolveProjectConfig(this.ctx.sessionId)
    const searchPath = params.path
      ? resolve(config.workingDirectory, resolveToCwd(params.path, config.workingDirectory))
      : config.workingDirectory

    // 审批守卫:工作目录 + 参考目录 + allowList 内直接通过,否则挂起等待审批
    await assertReadApproved(this.ctx, config, toolCallId, 'glob', searchPath, params.path)
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { pattern: string; path?: string },
    signal?: AbortSignal
  ): Promise<AgentToolResult<GlobToolDetails>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const config = resolveProjectConfig(this.ctx.sessionId)
    const searchPath = params.path
      ? resolve(config.workingDirectory, resolveToCwd(params.path, config.workingDirectory))
      : config.workingDirectory

    log.info(`glob "${params.pattern}" in ${searchPath}`)

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
        details: { type: 'glob', count: 0, truncated: false }
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

    // 输出长度的截断/落盘统一由 wrapToolOutput 在构建工具时处理
    return {
      content: [{ type: 'text' as const, text: outputLines.join('\n') }],
      details: {
        type: 'glob',
        count: files.length,
        truncated
      }
    }
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'glob',
  group: 'ripgrep',
  getLabel: () => t('tool.globLabel'),
  getHint: () => t('tool.globHint'),
  factory: (ctx) => new GlobTool(ctx),
  presentation: {
    icon: 'FileSearch2'
  },
  describe: () => ({ description: GLOB_DESCRIPTION, parameters: GlobParamsSchema })
})
