/**
 * Files Watcher 服务
 * 跟随当前会话扫描工作目录文件列表（ripgrep，遵循 .gitignore）
 * 同时维护一个 chokidar watcher，文件变动时广播 files:changed 事件供渲染层重扫
 *
 * 全局至多一个 watcher，标识由 workingDirectory 决定：
 * 同项目下不同会话共享同一 watcher（不重启）；切换到不同 workingDirectory 才重建
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { BrowserWindow } from 'electron'
import { rgFilesList } from '../utils/toolUtils/ripgrep'
import { sessionService } from './sessionService'
import { createLogger } from '../logger'

const log = createLogger('FilesWatcher')

const SCAN_LIMIT = 20000
const DEBOUNCE_MS = 300

// 减少 watch 负载用的硬忽略（与 ripgrep 的 .gitignore 行为独立 —— 真正决定显示与否的是 ripgrep）
const HARD_IGNORE =
  /(^|[\\/])(\.git|node_modules|dist|build|\.next|out|target|\.venv|__pycache__|\.DS_Store)([\\/]|$)/

interface Current {
  workingDirectory: string
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
}

let current: Current | null = null

function broadcastChanged(root: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('files:changed', { root })
  }
}

function startWatcher(workingDirectory: string): void {
  const watcher = chokidar.watch(workingDirectory, {
    ignored: (p) => HARD_IGNORE.test(p),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  })
  const entry: Current = { workingDirectory, watcher, timer: null }
  current = entry

  const schedule = (): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      // 仅当此 entry 仍是当前 watcher 时才广播，避免老 watcher 关闭后的滞留事件
      if (current === entry) broadcastChanged(entry.workingDirectory)
    }, DEBOUNCE_MS)
  }

  watcher
    .on('add', schedule)
    .on('addDir', schedule)
    .on('unlink', schedule)
    .on('unlinkDir', schedule)
    .on('error', (e) => log.warn(`watcher error (${workingDirectory}): ${e}`))
}

function closeCurrent(): void {
  if (!current) return
  if (current.timer) clearTimeout(current.timer)
  void current.watcher.close()
  current = null
}

/** 若当前 watcher 监听的就是该工作目录则关闭（用于会话删除时同步清理 temp 工作目录） */
export function closeWatcherIfWorkingDirectory(workingDirectory: string): void {
  if (current?.workingDirectory === workingDirectory) closeCurrent()
}

/** 应用退出时关闭全部（目前只有一个） */
export function closeAllWatchers(): void {
  closeCurrent()
}

/**
 * 扫描指定会话工作目录下的文件列表
 * 同时确保 watcher 跟随当前 workingDirectory；
 * 同 workingDirectory 内只需复用现有 watcher，不重启
 */
export async function scanSessionFiles(
  sessionId: string
): Promise<{ paths: string[]; truncated: boolean; root: string | null }> {
  const session = sessionService.getById(sessionId)
  const workingDirectory = session?.workingDirectory
  if (!workingDirectory) {
    closeCurrent()
    return { paths: [], truncated: false, root: null }
  }

  if (!current || current.workingDirectory !== workingDirectory) {
    closeCurrent()
    startWatcher(workingDirectory)
  }

  const { files, truncated } = await rgFilesList({
    cwd: workingDirectory,
    limit: SCAN_LIMIT,
    hidden: true
  })
  return { paths: files, truncated, root: workingDirectory }
}
