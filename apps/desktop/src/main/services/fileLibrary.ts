/**
 * 文件库（文件库 L1，docs/file-library-design.md）—— ShuviX 里的文件统一存进 `~/.shuvix/library/files/`，
 * 笔记和对话写 `shuvix://file/<id>/<文件名>` 指向它。这里管：
 *
 * - **进库**（§3）：按 sha256 去重，同样的内容只存一份（D2）；写入用同目录临时文件加 rename；文件名清洗后保留原名。
 * - **按 id 定位**：`library:<id>` 引用 → 当前版本的文件（预览协议、web 路由、`files.open`、agent `read` 共用）。
 *   回收站里的、不存在的一律当作找不到，显示端画“文件已删除”。
 * - **回收站**（§10）：删除只打 `deletedAt`，清空回收站才删目录；同样的内容再进库时从回收站里拿回来。
 * - **派生关联**（§6）：笔记保存时按正文重算 `embedded`，发送图片写 `sent`，删会话删它的关联，分支复制关联。
 *
 * 库目录**不在会话权限表里**（同 show_image 的快照）：agent 读库只走 `library` 客体与 `ask-on-library-access`。
 */
import { createHash } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { copyFile, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { v7 as uuidv7 } from 'uuid'
import { parseImagePixelSize } from '@shuvix/agent-runtime'
import {
  extractLibraryItemIds,
  isLibraryImageName,
  isLibraryItemId,
  LIBRARY_LIMITS,
  libraryItemIdOfRef,
  libraryKindOf,
  libraryMarkdown,
  sanitizeLibraryFileName,
  timestampedFileName,
  type LibraryAddInput,
  type LibraryAddResult,
  type LibraryItemInfo,
  type LibraryItemSource
} from '@shuvix/chat-protocol/fileLibrary'
import type { LibraryDao } from '../dao/libraryDao'
import type { LibraryItemRow } from '../dao/types/library'
import { getLibraryFilesDir } from '../utils/paths'
import { previewMimeOf } from '../utils/fileResponse'
import { resolveRealPath } from '../utils/toolUtils/realPath'
import { formatSize } from '../../shared/node/truncate'
import { createLogger } from '../logger'

const log = createLogger('FileLibrary')

/**
 * 库的元数据表（宿主启动时注入 libraryDao）。不在模块顶上 import：DAO 一 import 就开数据库单例，而预览协议、
 * 会话服务、文件工具都 import 这里 —— 它们的测试不该因此去碰数据库。没注入 = 库是空的（找不到任何一件，进库失败，
 * 关联不记）
 */
type LibraryTable = Pick<
  LibraryDao,
  | 'findItem'
  | 'findManagedBySha'
  | 'insertItem'
  | 'setDeletedAt'
  | 'purgeItem'
  | 'listDeletedIds'
  | 'addLink'
  | 'replaceDerivedLinks'
  | 'isLinked'
  | 'deleteLinksOfTarget'
  | 'copyLinksOfTarget'
>
let table: LibraryTable | null = null
export function setLibraryTable(dao: LibraryTable | null): void {
  table = dao
}

/** 量图片尺寸时读文件头的字节数（`path` 进库时不整个读进内存） */
const SIZE_SNIFF_BYTES = 256 * 1024

/** 一件文件的目录：`<根>/<id 前两位>/<id>`；id 形状不对 → undefined */
export function libraryItemDir(id: string): string | undefined {
  if (!isLibraryItemId(id)) return undefined
  return join(getLibraryFilesDir(), id.slice(0, 2), id)
}

/** 一件文件当前版本的绝对路径（托管：库目录里；引用外部文件：原路径） */
function filePathOf(row: LibraryItemRow): string | undefined {
  if (row.storage === 'linked') return row.externalPath ?? undefined
  const dir = libraryItemDir(row.id)
  return dir ? join(dir, row.fileName) : undefined
}

export function toLibraryItemInfo(row: LibraryItemRow): LibraryItemInfo {
  return {
    id: row.id,
    name: row.name,
    fileName: row.fileName,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
    storage: row.storage,
    source: row.source,
    createdAt: row.createdAt,
    ...(row.deletedAt ? { deletedAt: row.deletedAt } : {})
  }
}

/** 一件可用的文件：在库里、不在回收站、文件还在 → 记录与绝对路径；否则 null（显示端当作“文件已删除”） */
export function libraryFileOf(id: string): { item: LibraryItemRow; path: string } | null {
  if (!isLibraryItemId(id)) return null
  const item = table?.findItem(id) ?? null
  if (!item || item.deletedAt) return null
  const path = filePathOf(item)
  if (!path || !existsSync(path)) return null
  return { item, path }
}

/**
 * `library:<id>` 引用 → 绝对路径；不是这种引用 → undefined（调用方照普通路径解析）。
 * 是这种引用但找不到 → 库目录下一个不存在的路径：调用方照常回 404，不会落回工作目录去解析 `library:…` 这个相对名
 */
export function libraryPathOfRef(ref: string): string | undefined {
  const id = libraryItemIdOfRef(ref)
  if (id === undefined) return undefined
  return libraryFileOf(id)?.path ?? join(getLibraryFilesDir(), '.missing')
}

/** 进库串行：两次同样的内容同时进来，第二次要看到第一次写下的那件（去重） */
let addChain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = addChain.then(fn, fn)
  addChain = run.catch(() => undefined)
  return run
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function headOfFile(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function failure(
  name: string,
  reason: 'not-a-file' | 'too-large' | 'refused' | 'io',
  message: string
): LibraryAddResult {
  return { ok: false, name, reason, message }
}

/** 写进 `<dir>/<fileName>`：同目录临时文件加 rename。成功回 undefined，失败回错误消息 */
async function storeFile(
  dir: string,
  fileName: string,
  from: Buffer | string
): Promise<string | undefined> {
  const tmp = join(dir, `.${fileName}.${process.pid}.tmp`)
  try {
    await mkdir(dir, { recursive: true })
    if (typeof from === 'string') await copyFile(from, tmp)
    else await writeFile(tmp, from)
    await rename(tmp, join(dir, fileName))
    return undefined
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    return err instanceof Error ? err.message : String(err)
  }
}

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

export interface AddToLibraryParams {
  item: LibraryAddInput
  source: LibraryItemSource
  /**
   * 写进笔记的链接文字 / 图片 alt 用的原名；缺省取文件名。粘贴的位图传 ''（alt 留空）
   */
  label?: string
  /** 测试用 */
  now?: number
}

/**
 * 一个文件进库：同样的内容已在库里（含回收站，会被拿回来）就不新建，交回那件（`reused`）。
 * 失败回 `{ ok: false }`，消息是给用户看的（编辑器的占位里显示；`too-large` 的消息是上限本身）。
 */
export function addToLibrary(params: AddToLibraryParams): Promise<LibraryAddResult> {
  return serialized(() => addToLibraryNow(params))
}

async function addToLibraryNow(params: AddToLibraryParams): Promise<LibraryAddResult> {
  const { item, source } = params
  const t = table
  if (!t) {
    return failure(
      item.kind === 'path' ? baseName(item.path) : item.name,
      'io',
      'The file library is not available.'
    )
  }
  const now = params.now ?? Date.now()
  const displayName = item.kind === 'path' ? baseName(item.path) : item.name
  let bytes: Buffer | undefined
  let sha256: string
  let size: number
  let mime: string
  let head: Buffer
  try {
    if (item.kind === 'bytes') {
      bytes = Buffer.from(item.dataBase64, 'base64')
      if (bytes.length > LIBRARY_LIMITS.bytes) {
        return failure(displayName, 'too-large', formatSize(LIBRARY_LIMITS.bytes))
      }
      size = bytes.length
      sha256 = createHash('sha256').update(bytes).digest('hex')
      mime = item.mimeType || previewMimeOf(item.name)
      head = bytes.subarray(0, SIZE_SNIFF_BYTES)
    } else {
      const st = await stat(item.path).catch(() => null)
      if (!st || !st.isFile()) return failure(displayName, 'not-a-file', 'not a file')
      if (st.size > LIBRARY_LIMITS.path) {
        return failure(displayName, 'too-large', formatSize(LIBRARY_LIMITS.path))
      }
      size = st.size
      sha256 = await sha256OfFile(item.path)
      mime = previewMimeOf(item.path)
      head = await headOfFile(item.path, SIZE_SNIFF_BYTES)
    }
  } catch (err) {
    log.warn(`add: read failed (${displayName}): ${String(err)}`)
    return failure(displayName, 'io', err instanceof Error ? err.message : String(err))
  }

  const label = params.label ?? displayName

  const existing = t.findManagedBySha(sha256)
  if (existing) {
    // 同样的内容已在库里：文件被人从库目录里删了就补回去，从回收站里拿回来
    const existingDir = libraryItemDir(existing.id)
    if (existingDir && !existsSync(join(existingDir, existing.fileName))) {
      const healed = await storeFile(
        existingDir,
        existing.fileName,
        bytes ?? (item as { path: string }).path
      )
      if (healed) {
        log.warn(`add: rewrite missing file of ${existing.id}: ${healed}`)
        return failure(displayName, 'io', healed)
      }
    }
    if (existing.deletedAt) t.setDeletedAt(existing.id, null, now)
    const row = t.findItem(existing.id) ?? existing
    return {
      ok: true,
      reused: true,
      item: toLibraryItemInfo(row),
      markdown: libraryMarkdown({
        itemId: row.id,
        fileName: row.fileName,
        originalName: label,
        image: isLibraryImageName(row.fileName)
      })
    }
  }

  const id = uuidv7()
  const fileName = sanitizeLibraryFileName(displayName)
  const dir = libraryItemDir(id)!
  const written = await storeFile(dir, fileName, bytes ?? (item as { path: string }).path)
  if (written) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    log.warn(`add: write failed (${displayName}): ${written}`)
    return failure(displayName, 'io', written)
  }

  const kind = libraryKindOf(mime, fileName)
  const px = kind === 'image' ? parseImagePixelSize(head) : null
  try {
    t.insertItem({
      id,
      name: displayName,
      storage: 'managed',
      kind,
      source,
      sha256,
      size,
      mime,
      fileName,
      ...(px ? { width: px.width, height: px.height } : {}),
      createdAt: now
    })
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    log.warn(`add: record failed (${displayName}): ${String(err)}`)
    return failure(displayName, 'io', err instanceof Error ? err.message : String(err))
  }
  const row = t.findItem(id)!
  log.info(`added ${id} (${kind}, ${formatSize(size)}, source=${source})`)
  return {
    ok: true,
    reused: false,
    item: toLibraryItemInfo(row),
    markdown: libraryMarkdown({
      itemId: id,
      fileName,
      originalName: label,
      image: isLibraryImageName(fileName)
    })
  }
}

/** 进回收站；回是否有这件 */
export function trashLibraryItem(id: string, now = Date.now()): boolean {
  return isLibraryItemId(id) && !!table && table.setDeletedAt(id, now, now) > 0
}

/** 从回收站拿回来；回是否有这件 */
export function restoreLibraryItem(id: string, now = Date.now()): boolean {
  return isLibraryItemId(id) && !!table && table.setDeletedAt(id, null, now) > 0
}

/** 清空回收站：删元数据与托管文件的目录（引用外部文件的从不删原文件）；回清掉的件数 */
export async function emptyLibraryTrash(): Promise<number> {
  const t = table
  if (!t) return 0
  const ids = t.listDeletedIds()
  for (const id of ids) {
    const row = t.findItem(id)
    t.purgeItem(id)
    if (row?.storage === 'managed') {
      const dir = libraryItemDir(id)
      if (dir)
        await rm(dir, { recursive: true, force: true }).catch((err) =>
          log.warn(`purge ${id}: ${String(err)}`)
        )
    }
  }
  return ids.length
}

/** 笔记在关联表里的 id：跟过链接的绝对路径（同一篇笔记从不同写法进来要落到同一行） */
export function noteTargetId(absPath: string): string {
  return resolveRealPath(absPath)
}

/**
 * 笔记写盘后按正文重算它的 `embedded` 关联（只看 `.md`）。从不抛：关联是索引，失败不该让保存失败。
 * `content` 缺省时自己读文件。
 */
export async function recordNoteLinks(absPath: string, content?: string): Promise<void> {
  if (!/\.md$/i.test(absPath)) return
  try {
    const text = content ?? (await readFile(absPath, 'utf8'))
    if (!table) return
    table.replaceDerivedLinks(
      'note',
      noteTargetId(absPath),
      'embedded',
      extractLibraryItemIds(text),
      Date.now()
    )
  } catch (err) {
    log.warn(`note links (${absPath}): ${String(err)}`)
  }
}

/** 笔记删掉了：清掉它的派生关联 */
export function forgetNoteLinks(absPath: string): void {
  if (!/\.md$/i.test(absPath)) return
  try {
    table?.replaceDerivedLinks('note', noteTargetId(absPath), 'embedded', [], Date.now())
  } catch (err) {
    log.warn(`forget note links (${absPath}): ${String(err)}`)
  }
}

/** 会话里发送了这些库文件（`entryId` 是那条用户消息） */
export function recordSessionSent(sessionId: string, itemIds: string[], entryId?: number): void {
  const t = table
  if (!t) return
  const now = Date.now()
  for (const itemId of itemIds) {
    t.addLink({
      itemId,
      targetType: 'session',
      targetId: sessionId,
      relation: 'sent',
      origin: 'derived',
      context: entryId === undefined ? null : JSON.stringify({ entryId }),
      createdAt: now
    })
  }
}

const IMAGE_EXT_OF_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}

/**
 * 输入框发送的图片进库，关联到那条用户消息（`sent`，context 里记 entryId）。图片在消息里仍是 base64，模型照常看图；
 * 库里存的是同一份字节（输入框压缩后的那份）。名字没有原名可用：`image-<时间>[-序号].<扩展名>`。
 */
export async function keepSentImages(
  sessionId: string,
  entryId: number,
  images: ReadonlyArray<{ data: string; mimeType: string }>
): Promise<string[]> {
  const now = new Date()
  const ids: string[] = []
  for (const [i, img] of images.entries()) {
    const ext = IMAGE_EXT_OF_MIME[img.mimeType] ?? 'png'
    const base = timestampedFileName('image', now, ext)
    const name = images.length > 1 ? base.replace(/(\.[^.]+)$/, `-${i + 1}$1`) : base
    const result = await addToLibrary({
      item: { kind: 'bytes', name, mimeType: img.mimeType, dataBase64: img.data },
      source: 'chat-image',
      label: ''
    })
    if (result.ok) ids.push(result.item.id)
    else log.warn(`sent image ${i + 1} not kept (session=${sessionId}): ${result.message}`)
  }
  if (ids.length > 0) recordSessionSent(sessionId, ids, entryId)
  return ids
}

/** 删会话：删掉它的关联，文件留在库里（§10）。从不抛 */
export function removeSessionLibraryLinks(sessionId: string): void {
  try {
    table?.deleteLinksOfTarget('session', sessionId)
  } catch (err) {
    log.warn(`remove session links (${sessionId}): ${String(err)}`)
  }
}

/** 分支会话：复制源会话的关联，不复制文件。从不抛 */
export function copySessionLibraryLinks(fromId: string, toId: string): void {
  try {
    table?.copyLinksOfTarget('session', fromId, toId)
  } catch (err) {
    log.warn(`copy session links (${fromId} → ${toId}): ${String(err)}`)
  }
}

/**
 * 用户在这条会话里把这件放了进来（笔记里粘贴、拖入、插入）：关联 `attached`。agent 读它不用问（D4）。
 * 只由用户的进库动作写，不由笔记正文派生 —— 否则 agent 把在别处看到的库链接写进自己的笔记，就绕过了询问
 */
export function recordSessionAttached(
  sessionId: string,
  itemId: string,
  source: LibraryItemSource
): void {
  try {
    table?.addLink({
      itemId,
      targetType: 'session',
      targetId: sessionId,
      relation: 'attached',
      origin: 'derived',
      context: JSON.stringify({ source }),
      createdAt: Date.now()
    })
  } catch (err) {
    log.warn(`attached link (${sessionId}): ${String(err)}`)
  }
}

/**
 * agent `read` 一件库文件之前给安全模块的事实：显示名与是否与本会话有关联；库里没有这件、在回收站里 → null
 * （不为一次读不到的访问弹卡）
 */
export function describeLibraryItem(
  itemId: string,
  sessionId: string
): { name: string; linked: boolean } | null {
  if (!isLibraryItemId(itemId)) return null
  const row = table?.findItem(itemId) ?? null
  if (!row || row.deletedAt) return null
  return { name: row.name, linked: isLibraryItemLinkedToSession(itemId, sessionId) }
}

/**
 * 这件文件与会话有没有关联（`ask-on-library-access` 的 `linked`，D4）：用户在这条会话里发送过它（`sent`），或在
 * 这条会话的笔记里放进了它（`attached`）。笔记正文里的链接（`embedded`）**不算**：正文 agent 也能写，算了就等于
 * agent 能自己给自己开门。项目绑定等 L3
 */
export function isLibraryItemLinkedToSession(itemId: string, sessionId: string): boolean {
  return !!table && table.isLinked(itemId, 'session', sessionId)
}
