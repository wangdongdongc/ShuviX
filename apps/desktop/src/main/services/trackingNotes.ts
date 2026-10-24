/**
 * 跟踪项（实验）的主进程一侧 —— `~/.shuvix/tracking/<名字>.md`，一项一个文件，由 bot 全权维护（格式见
 * chat-protocol `trackingNotes.ts`）。这里管四件事：
 *  - 隐藏载体项目 `__tracking__`（path = 目录本身）与每份文件的笔记本会话（打开 / 复用），同日报；
 *  - 侧栏「跟踪项」分组的清单（标题取正文第一个一级标题，按修改时间倒序）；
 *  - 打开目录；
 *  - **宿主提交**：目录是一个 git 仓库，bot 的每次触发运行结束后宿主把整棵树提交一次（同 widget 的「构建成功
 *    即提交」）—— bot 全权改这些文件，回退只能靠历史。版本控制是增益能力，失败只记日志。
 */
import * as nodeFs from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import {
  initOp,
  addOp,
  commitOp,
  type GitCache,
  type GitEnv,
  type GitFsClient,
  type GitOpOutput
} from '@shuvix/agent-runtime'
import {
  TRACKING_PROJECT_ID,
  isTrackingFileName,
  trackingTitle,
  type TrackingItem
} from '@shuvix/chat-protocol/trackingNotes'
import { projectDao } from '../dao/projectDao'
import { appEventBus } from '../utils/appEventBus'
import { getDefaultTrackingDir } from '../utils/paths'
import { createLogger } from '../logger'
import { sessionRecords } from './sessionRecords'
import { sessionService } from './sessionService'
import type { Project, SessionInfo } from '../types'

const log = createLogger('Tracking')

/** 宿主提交的署名：提交的是 bot 的整理（与人手改的区分开） */
const COMMIT_AUTHOR = { authorName: 'ShuviX Tracking', authorEmail: 'tracking@shuvix.local' }

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 确保跟踪项目录的隐藏项目存在并返回（目录在第一次写入时才建）。不发 project.changed —— 列表不可见 */
export function ensureTrackingProject(): Project {
  const root = getDefaultTrackingDir()
  const existing = projectDao.findById(TRACKING_PROJECT_ID)
  if (existing) {
    if (existing.path === root) return existing
    projectDao.update(TRACKING_PROJECT_ID, { path: root })
    return { ...existing, path: root }
  }
  const now = Date.now()
  const project: Project = {
    id: TRACKING_PROJECT_ID,
    name: 'Tracking',
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

/** 侧栏清单：目录里的每份跟踪项，按修改时间倒序。目录还没有就是空的 */
export function listTrackingItems(): TrackingItem[] {
  const dir = getDefaultTrackingDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const items: TrackingItem[] = []
  for (const fileName of names) {
    if (!isTrackingFileName(fileName)) continue
    const path = join(dir, fileName)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      items.push({
        fileName,
        title: trackingTitle(readFileSync(path, 'utf8'), fileName),
        updatedAt: stat.mtimeMs
      })
    } catch {
      // 读不到的跳过（刚被删、权限问题）
    }
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 打开 / 复用一份跟踪项的笔记本会话；入参按不可信处理：只认目录里真实存在的文件 */
export function openTrackingNote(fileName: string, title?: string): SessionInfo {
  if (!isTrackingFileName(fileName)) throw new Error(`Not a tracking file: ${fileName}`)
  if (!isRegularFile(join(getDefaultTrackingDir(), fileName))) {
    throw new Error(`Tracking file not found: ${fileName}`)
  }
  const project = ensureTrackingProject()
  const session =
    sessionRecords.findByProjectAndNotebookPath(project.id, fileName) ??
    sessionService.create({
      projectId: project.id,
      notebookPath: fileName,
      title: title?.trim() || fileName.replace(/\.md$/i, '')
    })
  return { ...session, workingDirectory: project.path }
}

/** 打开跟踪项目录（OS 文件管理器）；还没有就先建出来，免得打开一个不存在的目录 */
export async function openTrackingFolder(): Promise<void> {
  const dir = getDefaultTrackingDir()
  nodeFs.mkdirSync(dir, { recursive: true })
  await shell.openPath(dir)
}

function failureOf(out: GitOpOutput): string | undefined {
  const err = out.details?.error
  return typeof err === 'string' ? err : undefined
}

/**
 * 把跟踪项目录整棵树提交一次（bot 的一次触发运行结束后调）：目录不在 = 这次没写任何跟踪项，什么都不做；
 * 还不是仓库就先 init。「没有可提交的变更」是正常状态。失败只记日志，最后广播 `tracking.changed` 让侧栏重扫。
 */
export async function commitTrackingChanges(message: string): Promise<void> {
  const dir = getDefaultTrackingDir()
  if (!existsSync(dir)) return
  const env: GitEnv = { fs: nodeFs as unknown as GitFsClient, dir }
  const cache: GitCache = {}
  try {
    if (!existsSync(join(dir, '.git'))) {
      const initialized = await initOp(env, cache, {})
      const initError = failureOf(initialized)
      if (initError) {
        log.warn(`git init failed in ${dir}: ${initError}`)
        return
      }
    }
    const added = await addOp(env, cache, { paths: ['.'] })
    const addError = failureOf(added)
    if (addError) {
      log.warn(`git add failed in ${dir}: ${addError}`)
      return
    }
    const committed = await commitOp(env, cache, { message, ...COMMIT_AUTHOR })
    const commitError = failureOf(committed)
    if (commitError && !/nothing to commit/i.test(commitError)) {
      log.warn(`git commit failed in ${dir}: ${commitError}`)
    }
  } catch (err) {
    log.warn(`tracking commit failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    appEventBus.publish({ type: 'tracking.changed' })
  }
}
