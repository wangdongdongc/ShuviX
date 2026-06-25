/**
 * 浏览器「文件面板」后端 —— 为 ChatApi.files 提供 scan / read / write 实现。
 *
 * 与桌面 filePreviewService 对齐 kind 决策（pdf/media/image/hex/binary/too-large/text），
 * 但底座是 File System Access：路径相对项目根句柄，无原生文件监听（onChanged 由 adapter 置空操作）。
 *
 * 路径约定：上层（共享 FilesPanel）把 root(=工作目录名) 与相对路径拼成「绝对路径」传入，
 * 这里 stripRoot 还原成相对句柄路径。scan 返回的 root 与 agent.init 的 workingDirectory 一致，
 * 从而 chatStore.projectPath === scan.root，FilesPanel 的新鲜度校验成立。
 */
import type { FileReadResult } from '@shuvix/chat-protocol/types/filePreview'
import { sessionStore } from '../storage/sessionStore'
import { projectStore } from '../storage/projectStore'
import { createFsaPort, getFile, ensureRwPermission } from './fsaPort'
import { getTempWorkspaceHandle } from '../storage/opfsWorkspace'
import { IMAGE_MIME_BY_EXT, extOf } from './richReaders'

const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024
const PREVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const PREVIEW_HEX_MAX_BYTES = 1024 * 1024
/** 单次扫描最多收集的文件数；超过则截断（与桌面 watcher 的上限语义一致） */
const SCAN_FILE_CAP = 5000

/** 扫描时跳过的目录名（无 .gitignore，取常见噪声目录） */
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode'
])

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg'
}
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus'
}
/** 已知二进制扩展名 → 走 hex view（内容是字节，文本渲染会乱码） */
const KNOWN_BINARY_EXTS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.class',
  '.wasm',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.ico'
])
/** Office/PDF/归档等富二进制 → binary 占位（hex 也无意义） */
const RICH_BINARY_EXTS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar'
])

/**
 * session → 工作目录根句柄。与 agentRuntime 一致：项目会话=用户 FSA 文件夹；
 * 临时会话=隔离的 OPFS 目录（getTempWorkspaceHandle，镜像桌面 temp_workspace）。
 * 故扩展每个会话都有工作目录，文件树/预览对两类一视同仁。
 */
async function handleForSession(sessionId: string): Promise<FileSystemDirectoryHandle | undefined> {
  const s = await sessionStore.getById(sessionId)
  if (s?.projectId) return projectStore.getHandle(s.projectId)
  return getTempWorkspaceHandle(sessionId)
}

/** 取某会话工作目录的展示名（= scan.root = agent.init 的 workingDirectory） */
export async function workingDirNameForSession(sessionId: string): Promise<string> {
  const handle = await handleForSession(sessionId)
  return handle?.name ?? ''
}

/**
 * 查询某会话工作目录的读写权限（不弹窗，供面板权限门控判断是否需要授权）。
 * - none：会话无工作目录；
 * - granted/prompt/denied：FSA 用户文件夹的权限态（OPFS 临时目录恒 granted）。
 */
export async function workingDirPermission(
  sessionId: string
): Promise<{ name: string; status: PermissionState | 'none' }> {
  const handle = await handleForSession(sessionId)
  if (!handle) return { name: '', status: 'none' }
  // OPFS 句柄无需授权；queryPermission 不存在/异常时按 granted 处理
  if (typeof handle.queryPermission !== 'function') return { name: handle.name, status: 'granted' }
  try {
    const status = await handle.queryPermission({ mode: 'readwrite' })
    return { name: handle.name, status }
  } catch {
    return { name: handle.name, status: 'granted' }
  }
}

/** 在用户手势内请求某会话工作目录的读写权限（FSA 文件夹重新授权）。返回是否已授权。 */
export async function requestWorkingDirPermission(sessionId: string): Promise<boolean> {
  const handle = await handleForSession(sessionId)
  if (!handle) return false
  return ensureRwPermission(handle)
}

/**
 * 媒体/PDF 预览 URL —— 浏览器无 shuvix-preview:// 协议，改读字节生成 blob: object URL。
 * 供共享 FilePreview/AudioDock/VideoDock 经 MediaUrlProvider 注入；用完 revoke 释放。
 */
export async function resolveMediaObjectUrl(
  sessionId: string,
  path: string
): Promise<{ url: string; revoke?: () => void }> {
  const handle = await handleForSession(sessionId)
  if (!handle) return { url: '' }
  const file = await getFile(handle, stripRoot(path, handle.name))
  const url = URL.createObjectURL(file)
  return { url, revoke: () => URL.revokeObjectURL(url) }
}

/** 把上层传入的「绝对路径」(root/rel) 还原为相对句柄路径 */
function stripRoot(path: string, root: string): string {
  const p = path.replace(/\\/g, '/')
  const prefix = `${root}/`
  if (p === root) return ''
  return p.startsWith(prefix) ? p.slice(prefix.length) : p
}

/** 递归收集工作目录下所有文件相对路径（'/' 分隔，跳过忽略目录），命中上限即截断 */
async function scanHandle(
  root: FileSystemDirectoryHandle
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = []
  let truncated = false

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    if (truncated) return
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        if (IGNORED_DIRS.has(name)) continue
        await walk(handle as FileSystemDirectoryHandle, prefix ? `${prefix}/${name}` : name)
        if (truncated) return
      } else {
        if (paths.length >= SCAN_FILE_CAP) {
          truncated = true
          return
        }
        paths.push(prefix ? `${prefix}/${name}` : name)
      }
    }
  }

  await walk(root, '')
  paths.sort((a, b) => a.localeCompare(b))
  return { paths, truncated }
}

/** Uint8Array → base64（分块，避免 fromCharCode 爆栈） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** 前 8KB NULL 字节嗅探（与桌面 isBinaryFile 同启发式） */
function sniffBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, 8192)
  for (let i = 0; i < n; i++) if (head[i] === 0) return true
  return false
}

export const filesRuntime = {
  async scan(
    sessionId: string
  ): Promise<{ paths: string[]; truncated: boolean; root: string | null }> {
    const handle = await handleForSession(sessionId)
    if (!handle) return { paths: [], truncated: false, root: null }
    try {
      const { paths, truncated } = await scanHandle(handle)
      return { paths, truncated, root: handle.name }
    } catch {
      return { paths: [], truncated: false, root: handle.name }
    }
  },

  async read(sessionId: string, path: string): Promise<FileReadResult> {
    const handle = await handleForSession(sessionId)
    if (!handle)
      return { kind: 'not-allowed', path, reason: 'No working directory for this session' }
    const rel = stripRoot(path, handle.name)
    const ext = extOf(path)

    let file: File
    try {
      file = await getFile(handle, rel)
    } catch (err) {
      return { kind: 'error', path, message: err instanceof Error ? err.message : String(err) }
    }
    const size = file.size

    if (ext === '.pdf') return { kind: 'pdf', path, size, ext }
    if (ext in VIDEO_MIME_BY_EXT)
      return {
        kind: 'media',
        mediaType: 'video',
        path,
        mimeType: VIDEO_MIME_BY_EXT[ext],
        size,
        ext
      }
    if (ext in AUDIO_MIME_BY_EXT)
      return {
        kind: 'media',
        mediaType: 'audio',
        path,
        mimeType: AUDIO_MIME_BY_EXT[ext],
        size,
        ext
      }

    if (ext === '.svg' || ext in IMAGE_MIME_BY_EXT) {
      if (size > PREVIEW_IMAGE_MAX_BYTES)
        return { kind: 'too-large', path, size, cap: PREVIEW_IMAGE_MAX_BYTES }
      const mimeType = ext === '.svg' ? 'image/svg+xml' : IMAGE_MIME_BY_EXT[ext]
      const bytes = new Uint8Array(await file.arrayBuffer())
      return { kind: 'image', path, mimeType, dataBase64: bytesToBase64(bytes), size, ext }
    }

    if (RICH_BINARY_EXTS.has(ext)) return { kind: 'binary', path, size, ext }

    const fullBytes = new Uint8Array(await file.arrayBuffer())
    const isBinary = KNOWN_BINARY_EXTS.has(ext) || sniffBinary(fullBytes)
    if (isBinary) {
      const shown = Math.min(size, PREVIEW_HEX_MAX_BYTES)
      return {
        kind: 'hex',
        path,
        size,
        ext,
        data: fullBytes.subarray(0, shown),
        bytesShown: shown,
        truncated: size > shown
      }
    }

    if (size > PREVIEW_TEXT_MAX_BYTES)
      return { kind: 'too-large', path, size, cap: PREVIEW_TEXT_MAX_BYTES }
    const content = new TextDecoder().decode(fullBytes)
    const lines = content.length === 0 ? 0 : content.split('\n').length
    return { kind: 'text', path, content, size, lines, ext }
  },

  async write(
    sessionId: string,
    path: string,
    content: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const handle = await handleForSession(sessionId)
    if (!handle) return { ok: false, error: 'No working directory for this session' }
    try {
      await createFsaPort(handle).writeFile(stripRoot(path, handle.name), content)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
