/**
 * 笔记编辑器与文件库之间的那一层（文件库 L1，docs/file-library-design.md §4、§5）：
 *
 * - `attachToLibrary`：编辑器交来的一项（页面里的文件或本机路径）→ `library.add` → 要插入的 Markdown。
 *   桌面能拿到真实路径就交路径（大文件不过 base64）；拿不到（web 客户端、截图）就交字节。
 * - `libraryImageMissing`：库链接解析出的图片加载失败（删了、在回收站、不存在）→ 标成“文件已删除”，不显示破图。
 */
import { ViewPlugin, EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { HostApi } from '@shuvix/chat-protocol/chatApi'
import {
  LIBRARY_LIMITS,
  pastedFileName,
  type LibraryAddInput,
  type LibraryItemSource
} from '@shuvix/chat-protocol/fileLibrary'
import { getHostApi } from '@shuvix/chat-ui'
import type { AttachItem, AttachmentsConfig, AttachOutcome, AttachSource } from './attachments'

const SOURCE: Record<AttachSource, LibraryItemSource> = {
  paste: 'note-paste',
  drop: 'note-drop',
  insert: 'note-insert'
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/tiff': 'tiff'
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result ?? '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

export interface AttachMessages {
  unavailable: string
  tooLarge: (limit: string) => string
  notAFile: string
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** 一项进库；失败回给用户看的原因 */
export async function attachToLibrary(
  host: HostApi | null,
  item: AttachItem,
  source: AttachSource,
  messages: AttachMessages,
  /** 笔记本会话：库里记一条它的 `attached` 关联，这条会话的 agent 读这件不用问 */
  sessionId?: string
): Promise<AttachOutcome> {
  const library = host?.library
  if (!library) return { ok: false, message: messages.unavailable }
  const path = item.path ?? (item.file ? (host?.app?.pathForFile?.(item.file) ?? null) : null)
  let input: LibraryAddInput
  let label: string | undefined
  if (path) {
    input = { kind: 'path', path }
  } else if (item.file) {
    const file = item.file
    if (file.size > LIBRARY_LIMITS.bytes)
      return { ok: false, message: messages.tooLarge(formatMb(LIBRARY_LIMITS.bytes)) }
    // 剪贴板位图（截图）没有名字：pasted-<时间>.<扩展名>，alt 留空
    const pastedBitmap = source === 'paste' && file.type.startsWith('image/')
    const name = pastedBitmap
      ? pastedFileName(new Date(), IMAGE_EXT[file.type] ?? 'png')
      : file.name || 'file'
    if (pastedBitmap) label = ''
    let data: string
    try {
      data = await fileToBase64(file)
    } catch {
      return { ok: false, message: messages.notAFile }
    }
    input = { kind: 'bytes', name, mimeType: file.type, dataBase64: data }
  } else {
    return { ok: false, message: messages.notAFile }
  }
  const result = await library.add({
    item: input,
    source: SOURCE[source],
    ...(label === undefined ? {} : { label }),
    ...(sessionId ? { sessionId } : {})
  })
  if (result.ok) return { ok: true, markdown: result.markdown }
  if (result.reason === 'too-large')
    return { ok: false, message: messages.tooLarge(result.message) }
  if (result.reason === 'not-a-file') return { ok: false, message: messages.notAFile }
  return { ok: false, message: result.message }
}

type Translate = (key: string, opts?: Record<string, unknown>) => string

/**
 * 编辑器的进库配置。桌面（有 pathForFile）交真实路径、用本机的选择文件对话框；web 交字节、用页面的文件选择框。
 * 文案在用到时才取（语言切换后也对）
 */
export function buildAttachConfig(
  attachable: boolean,
  t: Translate,
  sessionId?: string
): AttachmentsConfig {
  const host = getHostApi()
  const pathForFile = host?.app?.pathForFile
  const library = host?.library
  return {
    attachable,
    attach: (item, source) =>
      attachToLibrary(
        getHostApi(),
        item,
        source,
        {
          unavailable: t('notebook.attach.unavailable'),
          tooLarge: (limit) => t('notebook.attach.tooLarge', { limit }),
          notAFile: t('notebook.attach.notAFile')
        },
        sessionId
      ),
    ...(pathForFile ? { pathForFile: (file: File) => pathForFile(file) || null } : {}),
    ...(pathForFile && library ? { pickFiles: () => library.pickFiles() } : {}),
    labels: {
      adding: (name) => t('notebook.attach.adding', { name }),
      failed: (name, message) => t('notebook.attach.failed', { name, message }),
      get notAttachable() {
        return t('notebook.attach.notAttachable')
      }
    }
  }
}

/** 从库链接解析出来的图片地址（加载失败时据此认出它是库里的图） */
const LIBRARY_IMAGE_URLS = new Set<string>()

/** 记一个库图片的地址 */
export function noteLibraryImageUrl(url: string): void {
  LIBRARY_IMAGE_URLS.add(url)
}

const MISSING_CLASS = 'cm-library-missing'

/** 库图片加载失败 → 标成“文件已删除”（alt + title + 样式）；之后又加载成功（恢复了）→ 摘掉 */
export function libraryImageMissing(missingLabel: string): Extension {
  return [
    ViewPlugin.define((view) => {
      const onError = (event: Event): void => {
        const img = event.target
        if (!(img instanceof HTMLImageElement)) return
        if (!LIBRARY_IMAGE_URLS.has(img.getAttribute('src') ?? '')) return
        if (!img.classList.contains(MISSING_CLASS)) img.dataset.libraryAlt = img.alt
        img.classList.add(MISSING_CLASS)
        img.alt = missingLabel
        img.title = missingLabel
      }
      const onLoad = (event: Event): void => {
        const img = event.target
        if (img instanceof HTMLImageElement && img.classList.contains(MISSING_CLASS)) {
          img.classList.remove(MISSING_CLASS)
          img.removeAttribute('title')
          img.alt = img.dataset.libraryAlt ?? ''
          delete img.dataset.libraryAlt
        }
      }
      view.dom.addEventListener('error', onError, true)
      view.dom.addEventListener('load', onLoad, true)
      return {
        destroy() {
          view.dom.removeEventListener('error', onError, true)
          view.dom.removeEventListener('load', onLoad, true)
        }
      }
    }),
    EditorView.baseTheme({
      [`img.${MISSING_CLASS}`]: {
        display: 'inline-block',
        minWidth: '8em',
        padding: '6px 10px',
        border: '1px dashed color-mix(in srgb, currentColor 30%, transparent)',
        borderRadius: '6px',
        fontSize: '0.85em',
        opacity: '0.7'
      }
    })
  ]
}
