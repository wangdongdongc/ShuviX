/**
 * 文件库（2026-11-11，设计稿 docs/file-library-design.md）—— ShuviX 里的文件统一存进库，笔记和对话写
 * `shuvix://file/<id>/<文件名>` 指向库里的一件。文件名部分只为让原文可读、让按扩展名认类型的渲染器认得出，解析时不用它。
 *
 * 这里是两端共用的那一半：链接与 `library:` 引用的拼与拆、文件名清洗、按 MIME 归类、从正文里取出引用的 id、
 * 写进笔记的那一段 Markdown。存储、去重、关联在宿主 `services/fileLibrary.ts`。
 */

/** 笔记与对话里的链接前缀 */
export const LIBRARY_LINK_PREFIX = 'shuvix://file/'

/** mediaUrl seam / `files.open` 收到这个前缀就到库里按 id 找当前版本，不按工作目录解析（同 `shown:`） */
export const LIBRARY_REF_PREFIX = 'library:'

/** 进库的上限：`bytes` 走 IPC / WebSocket（base64 后约 43 MB，低于单消息 64 MB）；`path` 防误拖超大文件 */
export const LIBRARY_LIMITS = {
  bytes: 32 * 1024 * 1024,
  path: 500 * 1024 * 1024
} as const

/** 一件文件的类型（按 MIME 归类，筛选用） */
export const LIBRARY_ITEM_KINDS = [
  'image',
  'video',
  'audio',
  'pdf',
  'document',
  'archive',
  'other'
] as const
export type LibraryItemKind = (typeof LIBRARY_ITEM_KINDS)[number]

/** 文件从哪里进的库（开放：以后的来源直接加） */
export type LibraryItemSource =
  | 'note-paste'
  | 'note-drop'
  | 'note-insert'
  | 'chat-image'
  | 'chat-file'
  | 'shown'
  | 'artifact'
  | 'import'

/** 关联的目标类型（开放：新类型加一项，并在显示端注册怎么显示、怎么打开） */
export type LibraryLinkTarget = 'session' | 'note' | 'project'

/** 关联的关系 */
export type LibraryLinkRelation = 'sent' | 'attached' | 'shown' | 'embedded' | 'produced' | 'bound'

const ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 是不是一个库 id 的形状（UUID，小写） */
export function isLibraryItemId(value: unknown): value is string {
  return typeof value === 'string' && ITEM_ID_RE.test(value)
}

/** 大小写不敏感地认 id，统一成小写；形状不对 → undefined */
function normalizeItemId(raw: string): string | undefined {
  const id = raw.toLowerCase()
  return isLibraryItemId(id) ? id : undefined
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const LINK_RE = /^shuvix:\/\/file\/([0-9a-f-]{36})(?:\/([^/?#]+))?\/?$/i

/** `shuvix://file/<id>[/<文件名>]` → id 与文件名；别的链接 → null */
export function parseLibraryLink(url: string): { itemId: string; fileName?: string } | null {
  const m = LINK_RE.exec(url.trim())
  if (!m) return null
  const itemId = normalizeItemId(m[1])
  if (!itemId) return null
  return m[2] ? { itemId, fileName: decodeName(m[2]) } : { itemId }
}

/** 文件名里写进链接要转义的字符：保留字母、数字、`-_.~`，其余按 UTF-8 百分号转义 */
function encodeLinkName(name: string): string {
  return Array.from(name)
    .map((ch) =>
      /^[\p{L}\p{N}\p{M}\-_.~]$/u.test(ch)
        ? ch
        : // encodeURIComponent 不转义 `!'()*`：括号写进 Markdown 链接会把链接截断
          encodeURIComponent(ch).replace(
            /[!'()*]/g,
            (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
          )
    )
    .join('')
}

/** id（+ 文件名）→ 链接 */
export function libraryLink(itemId: string, fileName?: string): string {
  const name = fileName?.trim()
  return name
    ? `${LIBRARY_LINK_PREFIX}${itemId}/${encodeLinkName(name)}`
    : `${LIBRARY_LINK_PREFIX}${itemId}`
}

/** id → 交给 mediaUrl seam / `requestFilePreview` 的引用 */
export function libraryRef(itemId: string): string {
  return `${LIBRARY_REF_PREFIX}${itemId}`
}

/** 引用 → id；不是 `library:` 引用或 id 形状不对 → undefined（调用方照普通路径处理） */
export function libraryItemIdOfRef(path: string): string | undefined {
  if (!path.startsWith(LIBRARY_REF_PREFIX)) return undefined
  return normalizeItemId(path.slice(LIBRARY_REF_PREFIX.length))
}

const LINK_SCAN_RE = /shuvix:\/\/file\/([0-9a-f-]{36})(?![0-9a-f-])/gi

/** 正文里引用的库 id（去重，按首次出现的顺序）—— 派生关联按它维护 */
export function extractLibraryItemIds(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(LINK_SCAN_RE)) {
    const id = normalizeItemId(m[1])
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i

/** 按扩展名是不是图片（与笔记的 `isImagePath` 同一张表） */
export function isLibraryImageName(name: string): boolean {
  return IMAGE_EXT_RE.test(name)
}

const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/x-bzip2',
  'application/x-xz'
])

const DOCUMENT_MIME_RE =
  /^(text\/|application\/(json|xml|rtf|msword|vnd\.ms-|vnd\.openxmlformats-officedocument\.|vnd\.oasis\.opendocument\.|vnd\.apple\.(pages|numbers|keynote)|x-yaml|yaml|toml|epub\+zip))/

const EXT_KIND: Record<string, LibraryItemKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  avif: 'image',
  ico: 'image',
  heic: 'image',
  tif: 'image',
  tiff: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  ogg: 'audio',
  opus: 'audio',
  pdf: 'pdf',
  md: 'document',
  txt: 'document',
  csv: 'document',
  json: 'document',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',
  pages: 'document',
  numbers: 'document',
  key: 'document',
  rtf: 'document',
  epub: 'document',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  '7z': 'archive',
  rar: 'archive',
  bz2: 'archive',
  xz: 'archive'
}

/** 按 MIME 归类，MIME 说不清（空、`application/octet-stream`）时看扩展名 */
export function libraryKindOf(mime: string, fileName: string): LibraryItemKind {
  const m = mime.toLowerCase().split(';')[0].trim()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf') return 'pdf'
  if (ARCHIVE_MIMES.has(m)) return 'archive'
  if (DOCUMENT_MIME_RE.test(m)) return 'document'
  const ext = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase()
  return (ext && EXT_KIND[ext]) || 'other'
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const NAME_MAX_BYTES = 120

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * 写进库目录与链接的文件名：写进标准 Markdown 不需要转义，在各平台都能建出来。
 * - Unicode NFC（macOS 给的文件名常是 NFD），只取最后一段。
 * - 保留字母、数字（含中日文）、`-`、`_`、`.`，其余换成 `-`，连续的 `-` 合并；去掉开头的 `.` 与首尾的 `-`。
 * - 避开 Windows 保留名；UTF-8 至多 120 字节，保留扩展名。清洗后为空用 `file`。
 */
export function sanitizeLibraryFileName(raw: string): string {
  const base = (raw.normalize('NFC').split(/[/\\]/).pop() ?? '').trim()
  const cleaned = base
    .replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
  const dot = cleaned.lastIndexOf('.')
  const hasExt = dot > 0 && /^[\p{L}\p{N}]{1,10}$/u.test(cleaned.slice(dot + 1))
  let stem = (hasExt ? cleaned.slice(0, dot) : cleaned).replace(/^[-.]+|[-.]+$/g, '')
  const ext = hasExt ? cleaned.slice(dot) : ''
  if (!stem) stem = 'file'
  if (WINDOWS_RESERVED.test(stem)) stem = `${stem}_`
  const budget = NAME_MAX_BYTES - utf8Length(ext)
  if (utf8Length(stem) > budget) {
    const chars = Array.from(stem)
    while (chars.length > 1 && utf8Length(chars.join('')) > budget) chars.pop()
    stem = chars.join('').replace(/[-.]+$/, '') || 'file'
  }
  return `${stem}${ext}`
}

/** 没有原名的文件：`<前缀>-20261110-153012.<扩展名>`（本地时间） */
export function timestampedFileName(prefix: string, now: Date, ext: string): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `${prefix}-${date}-${time}.${ext.replace(/^\./, '')}`
}

/** 剪贴板位图没有名字：`pasted-20261110-153012.png`（本地时间） */
export function pastedFileName(now: Date, ext: string): string {
  return timestampedFileName('pasted', now, ext)
}

/** 链接文字里要转义的：方括号与反斜杠；换行压成空格 */
function linkLabel(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[[\]\\]/g, '\\$&')
}

/**
 * 写进笔记的那一段 Markdown。
 * - 图片：`![alt](shuvix://file/<id>/<文件名>)`，alt 取原名去扩展名与方括号，帮 agent 只读文本时理解内容；粘贴的位图 alt 留空。
 * - 其他：`[原名](shuvix://file/<id>/<文件名>)`。
 */
export function libraryMarkdown(params: {
  itemId: string
  fileName: string
  /** 原文件名（显示用）；粘贴的位图不给 */
  originalName?: string
  image: boolean
}): string {
  const link = libraryLink(params.itemId, params.fileName)
  if (params.image) {
    const alt = (params.originalName ?? '').replace(/\.[^.]*$/, '').replace(/[[\]]/g, '')
    return `![${linkLabel(alt)}](${link})`
  }
  return `[${linkLabel(params.originalName || params.fileName)}](${link})`
}

/** 库里一件文件给界面看的样子 */
export interface LibraryItemInfo {
  id: string
  /** 显示名，可改 */
  name: string
  /** 存储时的文件名（已清洗） */
  fileName: string
  kind: LibraryItemKind
  mime: string
  size: number
  width?: number
  height?: number
  storage: 'managed' | 'linked'
  source: LibraryItemSource
  createdAt: number
  /** 在回收站里 */
  deletedAt?: number
}

/** 交给 `library.add` 的内容：桌面窗口可以交本机路径，网络客户端只能交字节 */
export type LibraryAddInput =
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; name: string; mimeType: string; dataBase64: string }

/** `library.add` 的参数 */
export interface LibraryAddParams {
  item: LibraryAddInput
  /** 从哪里进的库（客户端只能交 `note-*`，其余按 `import` 记） */
  source: LibraryItemSource
  /** 写进笔记的链接文字 / 图片 alt 用的原名；缺省取文件名。粘贴的位图传 ''（alt 留空） */
  label?: string
  /** 放进哪条会话的笔记（笔记本会话）：记一条 `attached` 关联，这条会话的 agent 读它不用问 */
  sessionId?: string
}

export type LibraryAddFailure = 'not-a-file' | 'too-large' | 'refused' | 'io'

export type LibraryAddResult =
  | { ok: true; item: LibraryItemInfo; reused: boolean; markdown: string }
  | { ok: false; name: string; reason: LibraryAddFailure; message: string }
