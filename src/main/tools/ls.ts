/**
 * ls 工具 — 列出目录文件树
 * 基于 @vscode/ripgrep 遍历文件（自动遵循 .gitignore），构建树形输出
 */

import { stat } from 'fs/promises'
import { relative, basename, dirname, resolve, sep } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { resolveProjectConfig, isPathWithinWorkspace, type ToolContext } from './types'
import { resolveToCwd } from './utils/pathUtils'
import { rgFilesList } from './utils/ripgrep'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:ls')

/** 最大返回文件数 */
const LIMIT = 100

const LsParamsSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: 'The directory path to list (optional, defaults to current working directory)' })
  ),
  ignore: Type.Optional(
    Type.Array(Type.String(), { description: 'Additional glob patterns to exclude (e.g. "*.log", "tmp/")' })
  )
})

/**
 * 从文件列表构建树形目录结构并渲染为缩进文本
 */
function buildTree(files: string[]): string {
  // 统一分隔符为 /
  const normalized = files.map(f => f.split(sep).join('/'))

  // 构建目录→文件映射
  const dirs = new Set<string>()
  const filesByDir = new Map<string, string[]>()

  for (const file of normalized) {
    const dir = dirname(file)
    const parts = dir === '.' ? [] : dir.split('/')

    // 注册所有父目录
    for (let i = 0; i <= parts.length; i++) {
      const dirPath = i === 0 ? '.' : parts.slice(0, i).join('/')
      dirs.add(dirPath)
    }

    // 文件归入所属目录
    if (!filesByDir.has(dir)) filesByDir.set(dir, [])
    filesByDir.get(dir)!.push(basename(file))
  }

  function renderDir(dirPath: string, depth: number): string {
    const indent = '  '.repeat(depth)
    let output = ''

    if (depth > 0) {
      output += `${indent}${basename(dirPath)}/\n`
    }

    const childIndent = '  '.repeat(depth + 1)

    // 子目录（排序）
    const children = Array.from(dirs)
      .filter(d => dirname(d) === dirPath && d !== dirPath)
      .sort()

    for (const child of children) {
      output += renderDir(child, depth + 1)
    }

    // 文件（排序）
    const dirFiles = filesByDir.get(dirPath) || []
    for (const file of dirFiles.sort()) {
      output += `${childIndent}${file}\n`
    }

    return output
  }

  return renderDir('.', 0)
}

/** 创建 ls 工具实例 */
export function createListTool(ctx: ToolContext): AgentTool<typeof LsParamsSchema> {
  return {
    name: 'ls',
    label: t('tool.lsLabel'),
    description:
      'Lists files and directories in a given path as a tree structure. Uses ripgrep to respect .gitignore rules automatically. The path parameter is optional and defaults to the current working directory. Use the ignore parameter to exclude additional patterns.',
    parameters: LsParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { path?: string; ignore?: string[] },
      signal?: AbortSignal
    ) => {
      if (signal?.aborted) throw new Error(t('tool.aborted'))

      const config = resolveProjectConfig(ctx)
      const searchPath = params.path
        ? resolve(config.workingDirectory, resolveToCwd(params.path, config.workingDirectory))
        : config.workingDirectory

      log.info(`ls ${searchPath}`)

      // 沙箱模式：路径越界检查
      if (config.sandboxEnabled && !isPathWithinWorkspace(searchPath, config.workingDirectory)) {
        throw new Error(t('tool.outsideSandbox', { path: searchPath }))
      }

      // 验证目录存在
      let dirStat
      try {
        dirStat = await stat(searchPath)
      } catch {
        throw new Error(t('tool.fileNotFound', { path: searchPath }))
      }
      if (!dirStat.isDirectory()) {
        throw new Error(t('tool.lsNotDirectory', { path: searchPath }))
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
        output += `\n${t('tool.lsTruncated', { limit: LIMIT })}`
      }

      return {
        content: [{ type: 'text' as const, text: output }],
        details: {
          path: searchPath,
          count: files.length,
          truncated
        }
      }
    }
  }
}
