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
import { previewFile } from '@shuvix/agent-runtime'
import { sessionStore } from '../storage/sessionStore'
import { projectStore } from '../storage/projectStore'
import { createFsaPort, getFile, ensureRwPermission } from './fsaPort'
import { getTempWorkspaceHandle } from '../storage/opfsWorkspace'

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

/**
 * session → 工作目录根句柄。与 agentRuntime 一致：项目会话=用户 FSA 文件夹；
 * 临时会话=隔离的 OPFS 目录（getTempWorkspaceHandle，镜像桌面 temp_workspace）。
 * 故扩展每个会话都有工作目录，文件树/预览对两类一视同仁。
 */
export async function handleForSession(
  sessionId: string
): Promise<FileSystemDirectoryHandle | undefined> {
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
    // 分类/大小门控/hex-magic 全走共享内核（与桌面共用）。FSA port 只按范围读字节 ——
    // 大二进制文件不再整读进内存（旧实现的 file.arrayBuffer 全载 bug 一并消除）。
    // port 操作相对句柄根路径（rel）；结果里回填上层传入的 path（root/rel），供
    // resolveMediaObjectUrl 再 stripRoot 还原、以及面板 previewRelPath 匹配。
    return previewFile(createFsaPort(handle), stripRoot(path, handle.name), path)
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
