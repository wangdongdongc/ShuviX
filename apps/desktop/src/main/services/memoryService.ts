/**
 * 项目记忆的 **GUI 门面** —— 侧栏「项目记忆」子文件夹的后端。
 *
 * 与内聚模块 `services/memory/` 的分工：那边是**注入侧**（扫描 + 渲染索引，喂系统提示词），
 * 这边是**用户侧**（列清单给侧栏、把一条记忆打开成笔记本会话）。之所以是平铺文件而不是
 * 并进 memory 模块：打开笔记本要用 sessionService，而内聚模块按边界规则不得反向依赖
 * 平铺上层 service（同 wikiService 的位置与理由）。
 *
 * 记忆文件在项目目录**之外**（`~/.shuvix/memory/<projectId>/`），所以笔记本会话绑的是
 * **绝对路径**：相对路径会被当作相对项目根解析，指到一个不存在的地方。会话仍归属该项目
 * （工作目录 = 项目根），一条记忆至多一个会话，重复打开复用 —— 与 wiki 笔记同一套做法。
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseMemoryFile } from '@shuvix/agent-runtime'
import type { ProjectMemoryEntry } from '@shuvix/chat-protocol/types/memory'
import { sessionDao } from '../dao/sessionDao'
import { getProjectMemoryDir } from '../utils/paths'
import { scanProjectMemories } from './memory'
import { sessionService } from './sessionService'
import type { Session } from '../types'

/** slug 必须是纯文件名：越权路径（分隔符 / 上跳）一律拒绝，渲染进程传什么都不越出记忆目录 */
function isValidSlug(slug: string): boolean {
  return slug.length > 0 && !/[/\\]/.test(slug) && slug !== '.' && slug !== '..'
}

/** 记忆 md 的绝对路径（forward-slash 归一，使去重键与写入端一致） */
function memoryFilePath(projectId: string, slug: string): string {
  return join(getProjectMemoryDir(projectId), `${slug}.md`).replace(/\\/g, '/')
}

/**
 * 列出某项目的全部记忆（侧栏视图形状，不含正文）。
 * 目录不存在 / 无合法条目 → 空数组（侧栏据此不显示子文件夹）。
 */
export function listProjectMemories(projectId: string): ProjectMemoryEntry[] {
  return scanProjectMemories(projectId).map((m) => ({
    slug: m.slug,
    name: m.name,
    description: m.description,
    recall: m.recall,
    pinned: m.pinned,
    updated: m.updated,
    path: memoryFilePath(projectId, m.slug)
  }))
}

/**
 * 打开一条记忆：已有绑定该文件的笔记本会话则复用，否则创建（main 单线程 + 同步 SQLite，查建原子）。
 * slug 非法 / 文件已不在（清单过期）→ null，由调用方重扫清单。
 */
export function openMemoryNote(projectId: string, slug: string): Session | null {
  if (!isValidSlug(slug)) return null
  const path = memoryFilePath(projectId, slug)
  if (!existsSync(path)) return null

  const existing = sessionDao.findByProjectAndNotebookPath(projectId, path)
  if (existing) return existing

  // 标题取 frontmatter 的 name（人话标题），读不出/解析不出就用 slug —— 与侧栏那一行同一个名字
  let title = slug
  try {
    title = parseMemoryFile(readFileSync(path, 'utf-8'), slug)?.name || slug
  } catch {
    /* 读失败不挡开会话：笔记本里会显示读取错误，用户自己看得见 */
  }
  return sessionService.create({ projectId, notebookPath: path, memorySlug: slug, title })
}
