/**
 * ls 工具 — 列出目录文件树
 * 从 opencode ListTool 移植，使用纯 Node.js 递归遍历
 * 支持默认 IGNORE_PATTERNS、自定义 ignore glob、includeIgnored 跳过默认排除
 */

import { readdir, stat } from 'fs/promises'
import { join, relative, basename, dirname, resolve } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { resolveProjectConfig, isPathWithinWorkspace, type ToolContext } from './types'
import { resolveToCwd } from './utils/pathUtils'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:ls')

/** 默认忽略的目录模式（与 opencode 对齐） */
export const IGNORE_PATTERNS = [
  'node_modules',
  '__pycache__',
  '.git',
  'dist',
  'build',
  'target',
  'vendor',
  'bin',
  'obj',
  '.idea',
  '.vscode',
  '.zig-cache',
  'zig-out',
  '.coverage',
  'coverage',
  'tmp',
  'temp',
  '.cache',
  'cache',
  'logs',
  '.venv',
  'venv',
  'env',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.svelte-kit'
]

/** 最大返回文件数 */
const LIMIT = 100

const LsParamsSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: 'The directory path to list (optional, defaults to current working directory)' })
  ),
  ignore: Type.Optional(
    Type.Array(Type.String(), { description: 'List of additional directory names to ignore' })
  ),
  includeIgnored: Type.Optional(
    Type.Boolean({ description: 'Set to true to skip default ignore rules (e.g. to inspect node_modules)' })
  )
})

/**
 * 递归遍历目录，收集相对路径文件列表
 * 遇到 ignore 目录跳过，达到 limit 后提前中断
 */
async function walkDir(
  root: string,
  currentDir: string,
  ignoreDirs: Set<string>,
  extraIgnore: string[],
  files: string[],
  limit: number
): Promise<void> {
  if (files.length >= limit) return

  let entries
  try {
    entries = await readdir(currentDir, { withFileTypes: true })
  } catch {
    // 无权限或不存在，跳过
    return
  }

  // 按名称排序（目录优先）
  entries.sort((a, b) => {
    const aIsDir = a.isDirectory() ? 0 : 1
    const bIsDir = b.isDirectory() ? 0 : 1
    if (aIsDir !== bIsDir) return aIsDir - bIsDir
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    if (files.length >= limit) return

    const name = entry.name

    // 跳过隐藏文件（以 . 开头，但 .github 等常见目录除外）
    if (name.startsWith('.') && ignoreDirs.has(name.slice(0).toLowerCase())) continue

    if (entry.isDirectory()) {
      // 检查是否在忽略列表中
      if (ignoreDirs.has(name) || ignoreDirs.has(name.toLowerCase())) continue
      // 检查额外 ignore（简单前缀匹配）
      if (extraIgnore.some(pattern => name === pattern || name.startsWith(pattern))) continue

      await walkDir(root, join(currentDir, name), ignoreDirs, extraIgnore, files, limit)
    } else {
      const relPath = relative(root, join(currentDir, name))
      files.push(relPath)
    }
  }
}

/**
 * 从文件列表构建树形目录结构并渲染为缩进文本
 */
function buildTree(files: string[]): string {
  // 构建目录→文件映射
  const dirs = new Set<string>()
  const filesByDir = new Map<string, string[]>()

  for (const file of files) {
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
      'Lists files and directories in a given path as a tree structure. The path parameter is optional and defaults to the current working directory. Use the ignore parameter to exclude additional directories, or includeIgnored=true to skip default exclusion rules. You should generally prefer the bash tool with find/grep commands for precise searches.',
    parameters: LsParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { path?: string; ignore?: string[]; includeIgnored?: boolean },
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

      // 构建忽略目录集合
      const ignoreDirs = params.includeIgnored
        ? new Set<string>()
        : new Set(IGNORE_PATTERNS)
      const extraIgnore = params.ignore || []

      // 递归遍历
      const files: string[] = []
      await walkDir(searchPath, searchPath, ignoreDirs, extraIgnore, files, LIMIT)

      const truncated = files.length >= LIMIT

      // 构建树形输出
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
