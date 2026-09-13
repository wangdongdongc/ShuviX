/**
 * 注册表笔记 —— bot / agent / 安全策略 / 工作流 md 的打开路径，与知识库条目（knowledgeNotes）同一套
 * 做法：每个注册表目录一个隐藏项目（固定 id 见 chat-protocol `registryNotes`，path = 该目录），一份
 * 文件至多一个笔记本会话，重复打开复用。编辑、自动保存、外部改动重载全归笔记本会话 —— 这里只回答
 * 「这份文件是哪条会话」，外加把经笔记本落盘的写入交还给需要知道的注册表。
 *
 * 身份是**文件名**而不是 frontmatter `name`：名字随编辑随时在变（改名、写到一半解析不过），文件名
 * 不变，所以同一份文件改名、写坏、修好，打开的始终是同一条会话。
 */
import { existsSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  type RegistryNoteKind
} from '@shuvix/chat-protocol/registryNotes'
import { projectDao } from '../dao/projectDao'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from './sessionService'
import { botService } from './botService'
import {
  getDefaultAgentsDir,
  getDefaultBotsDir,
  getDefaultPoliciesDir,
  getDefaultWorkflowsDir
} from '../utils/paths'
import type { Project, SessionInfo } from '../types'

/** 隐藏项目的名字不对用户露出（项目列表过滤掉了），只在日志与调试里认得出是谁 */
const REGISTRIES: Record<RegistryNoteKind, { name: string; dir: () => string }> = {
  bot: { name: 'Bots', dir: getDefaultBotsDir },
  agent: { name: 'Agents', dir: getDefaultAgentsDir },
  policy: { name: 'Policies', dir: getDefaultPoliciesDir },
  workflow: { name: 'Workflows', dir: getDefaultWorkflowsDir }
}

/** 确保该注册表的隐藏项目存在并返回（目录由新建文件时懒建）。不发 project.changed —— 列表不可见 */
export function ensureRegistryNoteProject(kind: RegistryNoteKind): Project {
  const { name, dir } = REGISTRIES[kind]
  const id = REGISTRY_NOTE_PROJECT_IDS[kind]
  const root = dir()
  const existing = projectDao.findById(id)
  if (existing) {
    // 容错：历史行 path / name 与当前值不一致时纠正（如 home 目录迁移）
    const patch: Partial<Pick<Project, 'name' | 'path'>> = {}
    if (existing.path !== root) patch.path = root
    if (existing.name !== name) patch.name = name
    if (Object.keys(patch).length > 0) {
      projectDao.update(id, patch)
      return { ...existing, ...patch }
    }
    return existing
  }
  const now = Date.now()
  const project: Project = {
    id,
    name,
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

/**
 * 打开一份注册表文件的笔记本：同文件已有会话则复用，否则创建（main 单线程 + 同步 SQLite，查建原子）。
 *
 * `fileName` 来自渲染进程，按不可信入参处理：只接受该目录下已存在的单个 `.md`，否则抛错。`title`
 * 只在新建会话时用（缺省文件名去后缀）。回带工作目录 —— 设置页据此认出「这条笔记的文件变了」。
 */
export function openRegistryNote(
  kind: RegistryNoteKind,
  fileName: string,
  title?: string
): SessionInfo {
  const valid =
    /^[^/\\]+\.md$/i.test(fileName) &&
    !fileName.startsWith('.') &&
    existsSync(join(REGISTRIES[kind].dir(), fileName))
  if (!valid) throw new Error(`Invalid ${kind} file: ${fileName}`)
  const project = ensureRegistryNoteProject(kind)
  const session =
    sessionDao.findByProjectAndNotebookPath(project.id, fileName) ??
    sessionService.create({
      projectId: project.id,
      notebookPath: fileName,
      title: title?.trim() || fileName.slice(0, -3)
    })
  return { ...session, workingDirectory: project.path }
}

/**
 * 包住一次经笔记本（writeSessionFile）的落盘，让它所属的注册表看见这次写入。
 *
 * 只有 bot 注册表需要：改名要迁会话绑定，侧栏与身份胶囊要重查（见 botService.noteWriting /
 * noteWritten）。agent / policy / workflow 每次用到都现扫目录，写完即生效，不需要通知。
 */
export async function observeRegistryWrite<T>(
  absPath: string,
  write: () => Promise<T>
): Promise<T> {
  const botsDir = getDefaultBotsDir()
  if (!/\.md$/i.test(absPath) || dirname(resolve(absPath)) !== resolve(botsDir)) return write()
  const filePath = join(botsDir, basename(absPath))
  botService.noteWriting(filePath)
  try {
    return await write()
  } finally {
    botService.noteWritten()
  }
}
