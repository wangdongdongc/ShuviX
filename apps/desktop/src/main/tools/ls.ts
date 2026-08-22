/**
 * ls 工具 — 列出目录文件树
 * 基于 @vscode/ripgrep 遍历文件（自动遵循 .gitignore），构建树形输出
 */

import { stat } from 'fs/promises'
import { relative, resolve } from 'path'
import { Type } from 'typebox'
import {
  resolveProjectConfig,
  assertReadAllowed,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { LsToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { BaseTool, buildTree } from '@shuvix/agent-runtime'
import { resolveToCwd } from '../utils/toolUtils/pathUtils'
import { rgFilesList } from '../utils/toolUtils/ripgrep'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:ls')

/** 最大返回文件数 */
const LIMIT = 100

const LsParamsSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description: 'The directory path to list (optional, defaults to current working directory)'
    })
  ),
  ignore: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Additional glob patterns to exclude (e.g. "*.log", "tmp/")'
    })
  )
})

const LS_DESCRIPTION =
  'Lists files and directories in a given path as a tree structure. Uses ripgrep to respect .gitignore rules automatically. The path parameter is optional and defaults to the current working directory. Use the ignore parameter to exclude additional patterns.'

/** ls 工具 */
export class ListTool extends BaseTool<typeof LsParamsSchema> {
  readonly name = 'ls'
  readonly label = t('tool.lsLabel')
  readonly description = LS_DESCRIPTION
  readonly parameters = LsParamsSchema
  readonly outputStrategy = 'tail' as const

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(
    toolCallId: string,
    params: { path?: string; ignore?: string[] },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const config = resolveProjectConfig(this.ctx.sessionId)
    const searchPath = params.path
      ? resolve(config.workingDirectory, resolveToCwd(params.path, config.workingDirectory))
      : config.workingDirectory

    // 询问守卫：走统一评估 —— 内置 ask-on-read 豁免工作区与应用只读目录，
    // 会话授权过的路径由 consent 层放行；都不命中则挂起等待用户询问
    await assertReadAllowed(this.ctx, config, toolCallId, 'ls', searchPath, params.path)
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { path?: string; ignore?: string[] },
    signal?: AbortSignal
  ): Promise<AgentToolResult<LsToolDetails>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const config = resolveProjectConfig(this.ctx.sessionId)
    const searchPath = params.path
      ? resolve(config.workingDirectory, resolveToCwd(params.path, config.workingDirectory))
      : config.workingDirectory

    log.info(`ls ${searchPath}`)

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

    // 构建 glob 排除列表
    const globs: string[] = []
    if (params.ignore) {
      for (const pattern of params.ignore) {
        globs.push(`!${pattern}`)
      }
    }

    // 使用 ripgrep 列举文件（自动遵循 .gitignore）
    const { files, truncated } = await rgFilesList({
      cwd: searchPath,
      glob: globs.length > 0 ? globs : undefined,
      limit: LIMIT,
      signal
    })

    // 排序后构建树形输出
    files.sort()

    const relPath = relative(config.workingDirectory, searchPath) || '.'
    const tree = buildTree(files)
    let output = `${relPath}/\n${tree}`

    if (truncated) {
      output += `\n[Results truncated, showing first ${LIMIT} files. Use the glob tool to filter by pattern, or narrow the directory scope.]`
    }

    // 输出长度的截断/落盘统一由 wrapToolOutput 在构建工具时处理
    return {
      content: [{ type: 'text' as const, text: output }],
      details: {
        type: 'ls',
        path: searchPath,
        count: files.length,
        truncated
      }
    }
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'ls',
  group: 'ripgrep',
  getLabel: () => t('tool.lsLabel'),
  getHint: () => t('tool.lsHint'),
  factory: (ctx) => new ListTool(ctx),
  presentation: {
    icon: 'FolderTree'
  },
  describe: () => ({ description: LS_DESCRIPTION, parameters: LsParamsSchema })
})
