/**
 * File preview 服务 —— 为 FilesPanel 的预览覆盖层提供文件内容读取
 *
 * 与 ReadTool 的关键差异：
 *  - 沙箱判定走 isPathInSandboxRead（不弹审批）—— 被动 UI 不应在每次点击时打扰用户
 *  - 返回 FileReadResult discriminated union，二进制/超大/越权状态走专门分支而非抛异常
 *  - 不做 LLM 化处理：无行号 header、无 byte-cap 截断、无 tool_results 持久化、不压缩图片
 *
 * 分类 / 大小门控 / hex-magic 逻辑全在 @shuvix/agent-runtime 的 previewFile 共享内核里
 * （与扩展 FSA 后端共用一份）；本文件只做「桌面沙箱准入 + 注入 Node fs port」。
 */

import { writeFile } from 'fs/promises'
import { previewFile } from '@shuvix/agent-runtime'
import { sessionService } from './sessionService'
import { isPathInSandboxRead, isPathInSandboxWrite, resolveProjectConfig } from './toolContext'
import { resolveReadPath } from '../utils/toolUtils/pathUtils'
import { nodeFileSystemPort } from '../utils/toolUtils/nodeFileSystemPort'
import type { FileReadResult } from '@shuvix/chat-protocol/types/filePreview'

export async function previewSessionFile(sessionId: string, path: string): Promise<FileReadResult> {
  const session = sessionService.getById(sessionId)
  const workingDirectory = session?.workingDirectory
  if (!workingDirectory) {
    return { kind: 'not-allowed', path, reason: 'No active workspace for this session' }
  }

  const absolutePath = resolveReadPath(path, workingDirectory)
  const config = resolveProjectConfig(sessionId)

  if (!isPathInSandboxRead(config, absolutePath)) {
    return {
      kind: 'not-allowed',
      path,
      reason: 'Path is outside the workspace and reference directories'
    }
  }

  // 桌面 port 操作绝对路径；结果里的 path 也用绝对路径 —— 渲染端媒体/PDF 拼
  // shuvix-preview://...&path=<abs> 交给 customProtocols 流式播放（需要绝对路径）。
  return previewFile(nodeFileSystemPort, absolutePath)
}

/**
 * 回写文件内容 —— 给中间区的 Markdown live-preview 编辑器自动保存用。
 *
 * 与 WriteTool 的差异同 previewSessionFile：走 isPathInSandboxWrite 的同步准入判定，
 * 不弹审批（被动 UI 不应每次自动保存都打断用户）。落在 workspace / 可读写参考目录之外
 * 一律拒绝（文件树只扫描 workspace，正常路径都在准入范围内）。
 */
export async function writeSessionFile(
  sessionId: string,
  path: string,
  content: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = sessionService.getById(sessionId)
  const workingDirectory = session?.workingDirectory
  if (!workingDirectory) return { ok: false, error: 'No active workspace for this session' }

  const absolutePath = resolveReadPath(path, workingDirectory)
  const config = resolveProjectConfig(sessionId)
  if (!isPathInSandboxWrite(config, absolutePath)) {
    return { ok: false, error: 'Path is not writable (outside workspace)' }
  }

  try {
    await writeFile(absolutePath, content, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
