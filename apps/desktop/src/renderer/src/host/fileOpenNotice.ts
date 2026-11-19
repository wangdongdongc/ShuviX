/**
 * 「这个文件打不开」的轻提示（2026-11-19 用户裁定：点开一个不支持的文件，不再毫无反应）。
 *
 * useFilePreviewBridge 把 `files.open` 的拒绝交到这里；FileOpenNoticeLayer 在窗口底部浮出一句
 * 「文件名 · 原因」，几秒后自己收起。每个窗口（主窗、悬浮窗、md 窗口、预览窗口）各有一份，
 * 只显示自己发起的那次。新的一条顶掉旧的。
 */
import type { TFunction } from 'i18next'
import type { FileOpenRefusal } from '@shuvix/chat-protocol/types/filePreview'

export interface FileOpenNotice {
  /** 递增：同一个文件连点两次也算两条（各自计时） */
  id: number
  /** 文件名（不含目录） */
  name: string
  refusal: FileOpenRefusal
}

let current: FileOpenNotice | null = null
let nextId = 1
const listeners = new Set<() => void>()

export function showFileOpenNotice(path: string, refusal: FileOpenRefusal): void {
  current = { id: nextId++, name: fileNameOf(path), refusal }
  for (const l of listeners) l()
}

/** 只收起这一条（计时到了；期间又来了新的就不动） */
export function dismissFileOpenNotice(id: number): void {
  if (current?.id !== id) return
  current = null
  for (const l of listeners) l()
}

export function currentFileOpenNotice(): FileOpenNotice | null {
  return current
}

export function subscribeFileOpenNotice(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 路径或引用（`library:` / `shown:`）的最后一段 */
export function fileNameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 原因那半句 */
export function fileOpenReasonText(t: TFunction, refusal: FileOpenRefusal): string {
  switch (refusal.reason) {
    case 'unsupported':
      return refusal.ext
        ? t('fileOpen.unsupportedExt', { ext: refusal.ext })
        : t('fileOpen.unsupported')
    case 'too-large':
      return t('fileOpen.tooLarge', {
        size: formatBytes(refusal.size),
        cap: formatBytes(refusal.cap)
      })
    case 'missing':
      return t('fileOpen.missing')
    case 'directory':
      return t('fileOpen.directory')
    case 'unreadable':
      return t('fileOpen.unreadable')
  }
}
