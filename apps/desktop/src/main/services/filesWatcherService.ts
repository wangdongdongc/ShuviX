/**
 * Files 服务
 *  1. scanSessionFiles —— 跟随当前会话扫描工作目录文件列表（ripgrep，遵循 .gitignore）。
 *     纯扫描，不再附带起 watcher（旧实现对整棵树做 chokidar 监听，在大仓上会为每个文件占用
 *     一个 fd，撑爆进程 fd 上限 → 后续 spawn 全部 EBADF）。文件列表的新鲜度改由按需重扫维持：
 *     agent write/edit 事件（见 fileToolDeps.onFileChange）+ 前端在面板打开 / 窗口聚焦时重扫。
 *
 *  2. watchSessionFile / unwatchSessionFile —— 只监听「当前打开的那 1~2 个文件」（笔记本绑定 md、
 *     文件预览），供 NotebookView / FilePreview 做内容级自动刷新。监听的是文件的**父目录**（非递归）
 *     并按 basename 过滤：这样能覆盖编辑器「写临时文件 + rename」的原子保存（直接 fs.watch(file)
 *     会盯着旧 inode 丢事件），且每个目录只占 1 个 fd。按解析后的绝对路径引用计数。
 */

import { watch, existsSync, type FSWatcher } from 'fs'
import { dirname, basename } from 'path'
import { rgFilesList } from '../utils/toolUtils/ripgrep'
import { sessionService } from './sessionService'
import { resolveReadPath } from '../utils/toolUtils/pathUtils'
import { appEventBus } from '../utils/appEventBus'
import { createLogger } from '../logger'

const log = createLogger('FilesWatcher')

const SCAN_LIMIT = 20000
const DEBOUNCE_MS = 200

/**
 * 扫描指定会话工作目录下的文件列表（纯 ripgrep，遵循 .gitignore）。
 */
export async function scanSessionFiles(
  sessionId: string
): Promise<{ paths: string[]; truncated: boolean; root: string | null }> {
  const session = sessionService.getById(sessionId)
  const workingDirectory = session?.workingDirectory
  if (!workingDirectory) {
    return { paths: [], truncated: false, root: null }
  }

  const { files, truncated } = await rgFilesList({
    cwd: workingDirectory,
    limit: SCAN_LIMIT,
    hidden: true
  })
  return { paths: files, truncated, root: workingDirectory }
}

// ─────────────────────────── 单文件内容监听 ───────────────────────────

interface FileEntry {
  /** 该文件归属的工作目录（= 事件里的 root，与 chatStore.projectPath 同一路径空间） */
  root: string
  /** 解析后的绝对路径 —— 防抖结束发事件前 stat 一次，区分内容变更(edit)与删除/改名(delete) */
  abs: string
  /** 各注册方传入的原始 path 字符串（绝对 / 相对皆可）—— 变更时原样回显到事件 paths，
   *  确保 FilePreview（绝对路径 includes）与 NotebookView（相对路径 endsWith）都能命中自己 */
  clientPaths: Set<string>
  /** 引用计数：同一文件被多处（预览 + 笔记本）监听时共享一个 kqueue */
  refs: number
  timer: NodeJS.Timeout | null
}

interface DirWatch {
  watcher: FSWatcher
  /** basename → 该文件的监听条目 */
  entries: Map<string, FileEntry>
}

/** 目录绝对路径 → 目录级 watcher（父目录非递归监听，按 basename 分发） */
const dirWatches = new Map<string, DirWatch>()

function nfc(s: string): string {
  return s.normalize('NFC')
}

/** 解析 & 准入校验，返回 { abs, root } 或 null（无工作目录 / 越权 / 空路径） */
function resolveWatchTarget(sessionId: string, path: string): { abs: string; root: string } | null {
  const session = sessionService.getById(sessionId)
  const workingDirectory = session?.workingDirectory
  if (!workingDirectory) return null
  const abs = resolveReadPath(path, workingDirectory)
  // 不做准入判定：与预览面板同口径 —— 用户看自己机器上的文件不设限，
  // 否则工作目录外的预览打得开却不会随文件变更自动刷新。
  return { abs, root: workingDirectory }
}

function scheduleEntry(entry: FileEntry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    // fs.watch 分不清内容改写 / 原子保存 rename / 删除，这里 stat 一次给出可信 kind：
    // 文件还在 → edit（纯内容变更，消费者可据此跳过文件列表重扫）；不在 → delete。
    // 防抖已吃掉原子保存「临时消失」的抖动窗口，此刻的存在性可信。
    appEventBus.publish({
      type: 'files.changed',
      root: entry.root,
      paths: [...entry.clientPaths],
      kind: existsSync(entry.abs) ? 'edit' : 'delete'
    })
  }, DEBOUNCE_MS)
}

function ensureDirWatch(dir: string): DirWatch | null {
  const existing = dirWatches.get(dir)
  if (existing) return existing

  let watcher: FSWatcher
  try {
    watcher = watch(dir, { persistent: true })
  } catch (e) {
    log.warn(`watch dir 失败 (${dir}): ${e}`)
    return null
  }

  const dw: DirWatch = { watcher, entries: new Map() }
  watcher.on('change', (_event, filename) => {
    // filename 可能为 null（部分平台批量事件）→ 保守通知本目录下所有条目
    if (filename == null) {
      for (const entry of dw.entries.values()) scheduleEntry(entry)
      return
    }
    const name = nfc(filename.toString())
    // 优先精确命中；未命中再按 NFC 归一比较（macOS 文件名可能为 NFD）
    const entry = dw.entries.get(filename.toString()) ?? findByNfc(dw, name)
    if (entry) scheduleEntry(entry)
  })
  watcher.on('error', (e) => {
    log.warn(`watcher error (${dir}): ${e}`)
    closeDirWatch(dir)
  })

  dirWatches.set(dir, dw)
  return dw
}

function findByNfc(dw: DirWatch, nfcName: string): FileEntry | undefined {
  for (const [base, entry] of dw.entries) {
    if (nfc(base) === nfcName) return entry
  }
  return undefined
}

function closeDirWatch(dir: string): void {
  const dw = dirWatches.get(dir)
  if (!dw) return
  for (const entry of dw.entries.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  try {
    dw.watcher.close()
  } catch {
    /* 已关闭 */
  }
  dirWatches.delete(dir)
}

/** 开始监听某文件内容变更（用于笔记本 / 预览自动刷新）。幂等：同一路径多次调用累加引用计数 */
export function watchSessionFile(sessionId: string, path: string): void {
  const target = resolveWatchTarget(sessionId, path)
  if (!target) return
  const dir = dirname(target.abs)
  const base = basename(target.abs)
  const dw = ensureDirWatch(dir)
  if (!dw) return

  let entry = dw.entries.get(base)
  if (!entry) {
    entry = { root: target.root, abs: target.abs, clientPaths: new Set(), refs: 0, timer: null }
    dw.entries.set(base, entry)
  }
  entry.clientPaths.add(path)
  entry.refs++
}

/** 停止监听某文件（引用计数归零时释放该目录/条目的 fd） */
export function unwatchSessionFile(sessionId: string, path: string): void {
  const target = resolveWatchTarget(sessionId, path)
  if (!target) return
  const dir = dirname(target.abs)
  const base = basename(target.abs)
  const dw = dirWatches.get(dir)
  const entry = dw?.entries.get(base)
  if (!dw || !entry) return

  entry.refs--
  if (entry.refs <= 0) {
    if (entry.timer) clearTimeout(entry.timer)
    dw.entries.delete(base)
    if (dw.entries.size === 0) closeDirWatch(dir)
  }
}

/** 会话删除时清理：关闭其工作目录下的全部文件监听（temp 工作目录随会话销毁） */
export function closeWatcherIfWorkingDirectory(workingDirectory: string): void {
  for (const [dir, dw] of [...dirWatches]) {
    for (const [base, entry] of [...dw.entries]) {
      if (entry.root === workingDirectory) {
        if (entry.timer) clearTimeout(entry.timer)
        dw.entries.delete(base)
      }
    }
    if (dw.entries.size === 0) closeDirWatch(dir)
  }
}

/** 应用退出时关闭全部 watcher */
export function closeAllWatchers(): void {
  for (const dir of [...dirWatches.keys()]) closeDirWatch(dir)
}
