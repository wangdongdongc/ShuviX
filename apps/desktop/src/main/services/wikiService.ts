/**
 * Wiki 服务 —— 侧栏 Wiki 视图的后端。
 * Wiki 是一个隐藏项目(固定 id = WIKI_PROJECT_ID,path = ~/.shuvix/wikis),
 * 不出现在项目列表(projectService.list 过滤),仅承载 md 文件树与笔记本会话:
 * 每个 md 文件至多一个笔记本会话,重复打开复用已有会话。
 */

import { existsSync, mkdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, join } from 'path'
import { WIKI_PROJECT_ID } from '@shuvix/chat-protocol/wiki'
import { parseWikiEntryHead } from '@shuvix/chat-protocol/wikiFileContract'
import { projectDao } from '../dao/projectDao'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from './sessionService'
import { getDefaultWikisDir } from '../utils/paths'
import { rgFilesList } from '../utils/toolUtils/ripgrep'
import type { Project, Session } from '../types'

const MD_EXT_RE = /\.(md|mdx|markdown)$/i
const SCAN_LIMIT = 20000
/** 显示名解析上限：只为前若干文件读 frontmatter,超出部分回退文件名(防超大库全量读文件拖慢扫描) */
const NAME_PARSE_LIMIT = 2000

/** 面向用户的功能名叫"知识库"(wiki 仅作内部标识,不对用户露出) */
const WIKI_PROJECT_NAME = '知识库'

/**
 * 确保隐藏 wiki 项目存在并返回。wiki 根目录懒创建:首次打开 Wiki 视图即用户意图,
 * 区别于 Wiki Curator 子代理"不自动建根"的政策。不发 project.changed —— 该项目对列表不可见。
 */
export function ensureWikiProject(): Project {
  const root = getDefaultWikisDir()
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  const existing = projectDao.findById(WIKI_PROJECT_ID)
  if (existing) {
    // 容错:历史行 path/name 与当前值不一致时纠正(如 home 目录迁移、'Wiki'→'知识库' 改名)
    const patch: Partial<Pick<Project, 'name' | 'path'>> = {}
    if (existing.path !== root) patch.path = root
    if (existing.name !== WIKI_PROJECT_NAME) patch.name = WIKI_PROJECT_NAME
    if (Object.keys(patch).length > 0) {
      projectDao.update(WIKI_PROJECT_ID, patch)
      return { ...existing, ...patch }
    }
    return existing
  }
  const now = Date.now()
  const project: Project = {
    id: WIKI_PROJECT_ID,
    name: WIKI_PROJECT_NAME,
    path: root,
    systemPrompt: '',
    settings: {},
    archivedAt: 0,
    createdAt: now,
    updatedAt: now
  }
  projectDao.insert(project)
  return project
}

export interface WikiFileEntry {
  /** wiki 根下相对路径 */
  path: string
  /** frontmatter `name`(非条目文件/解析失败/超出解析上限为 null,调用方回退文件名 stem) */
  name: string | null
}

/** 扫描 wiki 根下全部 markdown 文件(相对路径,遵循 .gitignore),并解析条目显示名 */
export async function listWikiFiles(): Promise<{
  files: WikiFileEntry[]
  truncated: boolean
  root: string
}> {
  const { path: root } = ensureWikiProject()
  const { files, truncated } = await rgFilesList({
    cwd: root,
    glob: ['*.md', '*.mdx', '*.markdown'],
    limit: SCAN_LIMIT
  })
  const entries = await Promise.all(
    files.sort().map(async (rel, i): Promise<WikiFileEntry> => {
      if (i >= NAME_PARSE_LIMIT) return { path: rel, name: null }
      try {
        const text = await readFile(join(root, rel), 'utf-8')
        return { path: rel, name: parseWikiEntryHead(text)?.name ?? null }
      } catch {
        return { path: rel, name: null }
      }
    })
  )
  return { files: entries, truncated, root }
}

/** 打开 wiki 笔记:同文件已有笔记本会话则复用,否则创建(main 单线程 + 同步 SQLite,查建原子) */
export function openWikiNote(relPath: string): Session {
  const project = ensureWikiProject()
  const normalized = relPath.replace(/\\/g, '/')
  const existing = sessionDao.findByProjectAndNotebookPath(project.id, normalized)
  if (existing) return existing
  return sessionService.create({
    projectId: project.id,
    notebookPath: normalized,
    title: basename(normalized).replace(MD_EXT_RE, '')
  })
}
