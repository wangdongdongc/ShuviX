/**
 * 浏览器文件工具 —— read / write / edit，绑定到某会话的工作目录根句柄。
 *
 * 整条执行流程(路径解析→沙箱审批→分派→内核)已下沉 @shuvix/agent-runtime 的 createFileToolSuite，
 * 与桌面共用一份。本文件只负责注入浏览器端适配:FSA FileSystemPort/FileGuards、扩展 SandboxPolicy、
 * 内容解码器(url=turndown / image=Canvas;富文档/.doc 缺省)、以及 FSA 权限校验(临时 OPFS 跳过)。
 *
 * 不提供 ls:桌面 ls/grep/glob 基于 ripgrep(遵循 .gitignore),浏览器无法等价实现 → 仅桌面可用;
 * 列目录改用 read(对目录返回排序条目)。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { createFileToolSuite } from '@shuvix/agent-runtime'
import { createFsaPort, createFsaGuards, ensureRwPermission } from './fsaPort'
import { isUrl, readUrl, readImage, IMAGE_MIME_BY_EXT } from './richReaders'
import { createExtensionSandboxPolicy } from './sandboxPolicy'
import { appEventBus } from './appEventBus'

export const READ_DESCRIPTION =
  'Read file, directory, or web page contents. For URLs (http/https), fetches the page and converts to Markdown. For text files in the working directory, returns content with line numbers (supports pagination via offset/limit). For directories, returns a sorted list of entries. For images (PNG, JPEG, GIF, WebP, BMP), returns inline image content for multimodal viewing (images larger than ~1MB are auto-downscaled and re-encoded as JPEG).'
export const WRITE_DESCRIPTION =
  "Write content to a file in the working directory. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories."
export const EDIT_DESCRIPTION =
  'Edit a file in the working directory by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.'

export interface CreateFileToolsOptions {
  /** 是否在每次操作前校验 FSA 读写权限。项目(用户 FSA 文件夹)需要;OPFS 临时目录始终可用,传 false */
  requiresPermission?: boolean
  /** 统一审批挂起原语(当前扩展夹内不弹,仅为将来越界能力预留) */
  requestUserInput?: (req: InputRequest) => Promise<InputResponse>
}

/**
 * 为某根句柄构建一套文件工具。项目会话根=用户 FSA 文件夹(需校验权限);
 * 临时会话根=OPFS 目录(始终可用,requiresPermission=false)。
 */
export function createFileTools(
  root: FileSystemDirectoryHandle,
  opts: CreateFileToolsOptions = {}
): AgentTool[] {
  const { requiresPermission = true, requestUserInput } = opts
  const port = createFsaPort(root)
  const guards = createFsaGuards(port)

  let permissionOk = false
  async function ensureAccess(): Promise<void> {
    if (!requiresPermission || permissionOk) return
    if (await ensureRwPermission(root)) {
      permissionOk = true
      return
    }
    throw new Error(
      `无法访问项目文件夹「${root.name}」：权限已失效。请在左侧栏重新「打开文件夹」以重新授权。`
    )
  }

  const suite = createFileToolSuite({
    port,
    guards,
    resolvePath: (p) => p, // 扩展端口是 rooted，路径即相对工作目录
    policy: createExtensionSandboxPolicy(requestUserInput),
    ensureAccess,
    abortError: 'TOOL_ABORTED',
    // write/edit 成功 → 发布 files.changed。portPath 是 root 相对，归一成 `root.name/rel`（UI 路径空间）
    onFileChange: ({ portPath, kind }) =>
      appEventBus.publish({
        type: 'files.changed',
        root: root.name,
        paths: [`${root.name}/${portPath.replace(/^[/\\]+/, '')}`],
        kind
      }),
    labels: { read: 'Read', write: 'Write', edit: 'Edit' },
    descriptions: { read: READ_DESCRIPTION, write: WRITE_DESCRIPTION, edit: EDIT_DESCRIPTION },
    decoders: {
      isUrl,
      readUrl,
      imageMimeByExt: IMAGE_MIME_BY_EXT,
      readImage: (portPath, _displayPath, ext) => readImage(root, portPath, ext)
      // 富文档(PDF/Word/Excel)/.doc/二进制嗅探:浏览器暂不支持，缺省
    }
  })

  return [suite.read, suite.write, suite.edit] as AgentTool[]
}
