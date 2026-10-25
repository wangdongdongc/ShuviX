/**
 * 跟踪项（实验）的主进程一侧 —— `~/.shuvix/tracking/<名字>.md`，一项一个文件，由 bot 全权维护（格式见
 * chat-protocol `trackingNotes.ts`）。这里管四件事：
 *  - 隐藏载体项目 `__tracking__`（path = 目录本身）与每份文件的笔记本会话（打开 / 复用），同日报；
 *  - 侧栏「跟踪项」分组的清单（标题取正文第一个一级标题，按修改时间倒序）；
 *  - 打开目录；删掉一项（侧栏行菜单）；
 *  - **宿主提交**：目录是一个 git 仓库，bot 的每次触发运行结束后宿主把整棵树提交一次（同 widget 的「构建成功
 *    即提交」）—— bot 全权改这些文件，回退只能靠历史。版本控制是增益能力，失败只记日志。
 */
import * as nodeFs from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
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
        updatedAt: stat.mtimeMs,
        path
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

/**
 * 删掉一份跟踪项（侧栏行菜单，用户确认过）：先删它的笔记本会话（开着的笔记本随之关掉，不会再把文件存回去），再删文件。
 * 删之前把目录此刻的样子提交一次（多半是「没有可提交的」），删之后再提交一次 —— 删掉的那一版因此一定留在目录的 git
 * 历史里，哪怕它从没被 bot 的运行提交过；删之前那一次提交失败（仓库坏了之类）就不删、抛错。入参按不可信处理：只认目录里真实存在的跟踪项文件名。
 * `deleted: false` = 文件本来就不在；`sessionId` = 删掉的笔记本会话（没有为 null），界面据此把它从列表里拿掉
 */
export async function deleteTrackingItem(
  fileName: string
): Promise<{ deleted: boolean; sessionId: string | null }> {
  if (!isTrackingFileName(fileName)) throw new Error(`Not a tracking file: ${fileName}`)
  const session = sessionRecords.findByProjectAndNotebookPath(TRACKING_PROJECT_ID, fileName)
  if (session) await sessionService.delete(session.id)
  const path = join(getDefaultTrackingDir(), fileName)
  if (!isRegularFile(path)) {
    // 文件本来就不在（清单过期）：照样让侧栏重扫，把那一行拿掉
    appEventBus.publish({ type: 'tracking.changed' })
    return { deleted: false, sessionId: session?.id ?? null }
  }
  // 记不进历史就不删：确认框说过「删除前的那一版仍留在 git 历史里」，这句话得是真的
  if (!(await commitTrackingChanges(`Before deleting ${fileName}`))) {
    throw new Error(`Could not record ${fileName} in the tracked items history; it was not deleted`)
  }
  unlinkSync(path)
  await commitTrackingChanges(`Deleted ${fileName} (by the user)`)
  return { deleted: true, sessionId: session?.id ?? null }
}

/**
 * 跟踪项目录还没有就建出来（bot 的每次触发运行之前调）。目录不在时 bot 的 `ls` 只得到「路径不存在」，模型就会去翻上一层的
 * `~/.shuvix` —— 那里不在 daily-bot-access 的放行范围里，傍晚没人回答的询问就把这次运行卡住了（2026-10-25）。
 * 失败只记日志：bot 第一次 `write` 照样会把目录建出来
 */
export function ensureTrackingDir(): void {
  try {
    nodeFs.mkdirSync(getDefaultTrackingDir(), { recursive: true })
  } catch (err) {
    log.warn(`could not create the tracking folder: ${err instanceof Error ? err.message : err}`)
  }
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
 * 把跟踪项目录整棵树提交一次（bot 的一次触发运行结束后调）：目录不在就什么都不做（运行前 `ensureTrackingDir` 建过，
 * 不在多半是用户刚删了）；还不是仓库就先 init。「没有可提交的变更」是正常状态。失败只记日志，最后广播 `tracking.changed` 让侧栏重扫。
 * 交回这一次有没有记进历史（提交了 / 本来就没有可提交的 = true，init / add / commit 出错 = false）—— 删一项之前靠它
 * 确认删掉的那一版已经在历史里。
 */
export async function commitTrackingChanges(message: string): Promise<boolean> {
  const dir = getDefaultTrackingDir()
  if (!existsSync(dir)) return true
  const env: GitEnv = { fs: nodeFs as unknown as GitFsClient, dir }
  const cache: GitCache = {}
  try {
    if (!existsSync(join(dir, '.git'))) {
      const initialized = await initOp(env, cache, {})
      const initError = failureOf(initialized)
      if (initError) {
        log.warn(`git init failed in ${dir}: ${initError}`)
        return false
      }
    }
    const added = await addOp(env, cache, { paths: ['.'] })
    const addError = failureOf(added)
    if (addError) {
      log.warn(`git add failed in ${dir}: ${addError}`)
      return false
    }
    const committed = await commitOp(env, cache, { message, ...COMMIT_AUTHOR })
    const commitError = failureOf(committed)
    if (commitError && !/nothing to commit/i.test(commitError)) {
      log.warn(`git commit failed in ${dir}: ${commitError}`)
      return false
    }
    return true
  } catch (err) {
    log.warn(`tracking commit failed: ${err instanceof Error ? err.message : err}`)
    return false
  } finally {
    appEventBus.publish({ type: 'tracking.changed' })
  }
}
