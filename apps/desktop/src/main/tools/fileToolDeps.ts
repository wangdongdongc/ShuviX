/**
 * 桌面文件工具 deps —— 给共享 createFileToolSuite 注入桌面端适配（Node fs / fileTime / 绝对路径 /
 * SQLite SandboxPolicy）。read/write/edit 三个工具共用同一份装配；read 额外注入内容解码器。
 *
 * 配置（workingDirectory/referenceDirs/allowList）按工具执行时机动态解析（resolveProjectConfig），
 * 故 resolvePath / policy 内部都走惰性 thunk，保证拿到最新值（对齐原 ReadTool/WriteTool 行为）。
 */
import type { FileToolDeps, ReadDecoders, FileGuards } from '@shuvix/agent-runtime'
import { nodeFileSystemPort } from '../utils/toolUtils/nodeFileSystemPort'
import { resolveReadPath, resolveToCwd } from '../utils/toolUtils/pathUtils'
import {
  getReadTime,
  assertNotModifiedSinceRead,
  recordRead,
  withFileLock
} from '../utils/toolUtils/fileTime'
import {
  resolveProjectConfig,
  makeDesktopSandboxPolicy,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import { t } from '../i18n'

const READ_DESCRIPTION =
  'Read file, directory, or web page contents. For URLs (http/https), fetches the page and converts to Markdown. For text files, returns content with line numbers (supports pagination via offset/limit). For directories, returns a sorted list of entries. Supports PDF, Word, Excel, PowerPoint, HTML, and Jupyter Notebook formats (auto-converted to Markdown). Supports PNG, JPEG, GIF, WebP, BMP images (returned as inline image content for multimodal viewing; images larger than ~1MB are auto-downscaled and re-encoded as JPEG).'
const WRITE_DESCRIPTION =
  "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories."
const EDIT_DESCRIPTION =
  'Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.'

/** 桌面 FileGuards —— 包 fileTime 的 per-session 读取时间 + 写锁 */
function desktopGuards(sessionId: string): FileGuards {
  return {
    hasReadTime: (p) => !!getReadTime(sessionId, p),
    assertNotModifiedSinceRead: (p) => assertNotModifiedSinceRead(sessionId, p),
    recordRead: (p) => recordRead(sessionId, p),
    withFileLock: (p, fn) => withFileLock(p, fn)
  }
}

export function makeDesktopFileToolDeps(ctx: ToolContext, decoders?: ReadDecoders): FileToolDeps {
  const sid = ctx.sessionId
  return {
    port: nodeFileSystemPort,
    guards: desktopGuards(sid),
    // read 用 resolveReadPath（含 macOS/NFD/弯引号变体探测）；write/edit 用 resolveToCwd
    resolvePath: (p, mode) => {
      const cwd = resolveProjectConfig(sid).workingDirectory
      return mode === 'read' ? resolveReadPath(p, cwd) : resolveToCwd(p, cwd)
    },
    policy: makeDesktopSandboxPolicy(ctx, () => resolveProjectConfig(sid)),
    decoders,
    abortError: TOOL_ABORTED,
    labels: { read: t('tool.readLabel'), write: t('tool.writeLabel'), edit: t('tool.editLabel') },
    descriptions: { read: READ_DESCRIPTION, write: WRITE_DESCRIPTION, edit: EDIT_DESCRIPTION }
  }
}
