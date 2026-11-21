/**
 * 看图层（chat-ui ImageViewer）在桌面上的「复制」与「下载」：页面拿不到 `shuvix-preview://` 的字节（跨源，fetch 被拒），
 * 所以交给主进程 —— 复制进系统剪贴板，下载弹系统的另存为对话框。路径与引用的解析与打开文件同一份（resolveOpenTarget）。
 * web 客户端的图走同源 HTTP 路由，页面自己 fetch，不用这里。
 */
import { BrowserWindow, app, clipboard, dialog, nativeImage, type WebContents } from 'electron'
import { copyFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { resolveOpenTarget } from './previewWindowService'
import { createLogger } from '../logger'

const log = createLogger('ImageFileActions')

export interface ImageFileParams {
  sessionId: string
  /** 绝对路径，或 `library:` / `shown:` 引用，或相对该会话工作目录的路径 */
  path: string
  /** 另存为的默认文件名（快照、库里的文件名可能是哈希） */
  name?: string
}

/** 把图复制进系统剪贴板；读不了、不是系统能解的图 → false */
export async function copyImageFile(params: ImageFileParams): Promise<boolean> {
  const target = resolveOpenTarget(params)
  if (!target) return false
  try {
    const image = nativeImage.createFromBuffer(await readFile(target.absolute))
    if (image.isEmpty()) {
      log.info(`复制图片：系统解不了这张图 ${target.absolute}`)
      return false
    }
    clipboard.writeImage(image)
    return true
  } catch (err) {
    log.warn(`复制图片失败 ${target.absolute}: ${(err as Error).message}`)
    return false
  }
}

/** 文件名里不该有的字符换掉；空了就用原文件名 */
export function saveNameOf(name: string | undefined, fallback: string): string {
  const safe = Array.from(name ?? '')
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
  const cleaned = basename(safe).trim()
  // 全是点（`..`）会让默认位置跑到下载目录的上一级
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : fallback
}

/** 弹另存为对话框把图存出去 */
export async function saveImageFile(
  params: ImageFileParams,
  sender?: WebContents
): Promise<'saved' | 'cancelled' | 'failed'> {
  const target = resolveOpenTarget(params)
  // 先确认还在，别等用户选好位置才说存不了（回收站里的库文件解出来是一个不存在的路径）
  if (!target || !existsSync(target.absolute)) return 'failed'
  const defaultPath = join(
    app.getPath('downloads'),
    saveNameOf(params.name, basename(target.absolute))
  )
  const win = sender ? BrowserWindow.fromWebContents(sender) : null
  const result = win
    ? await dialog.showSaveDialog(win, { defaultPath })
    : await dialog.showSaveDialog({ defaultPath })
  if (result.canceled || !result.filePath) return 'cancelled'
  try {
    await copyFile(target.absolute, result.filePath)
    return 'saved'
  } catch (err) {
    log.warn(`另存图片失败 ${target.absolute}: ${(err as Error).message}`)
    return 'failed'
  }
}
