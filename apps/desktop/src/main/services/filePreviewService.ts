/**
 * File preview 服务 —— 为 FilesPanel 的预览覆盖层提供文件内容读取
 *
 * 与 ReadTool 的关键差异：
 *  - 准入判定走 isPathReadAllowed（不弹询问）—— 被动 UI 不应在每次点击时打扰用户
 *  - 返回 FileReadResult discriminated union，二进制/超大/越权状态走专门分支而非抛异常
 *  - 不做 LLM 化处理：无行号 header、无 byte-cap 截断、无 tool_results 持久化、不压缩图片
 *
 * 分类 / 大小门控 / hex-magic 逻辑全在 @shuvix/agent-runtime 的 previewFile 共享内核里
 * （与扩展 FSA 后端共用一份）；本文件只做「桌面准入 + 注入 Node fs port」。
 */

import { chmod, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { BrowserWindow, dialog } from 'electron'
import { previewFile } from '@shuvix/agent-runtime'
import { sessionService } from './sessionService'
import { isPathWriteAllowed, resolveProjectConfig } from './toolContext'
import { resolveReadPath } from '../utils/toolUtils/pathUtils'
import { nodeFileSystemPort } from '../utils/toolUtils/nodeFileSystemPort'
import type { FileReadResult } from '@shuvix/chat-protocol/types/filePreview'

/**
 * 读取预览内容 —— **不做工作目录准入判定**：预览只呈现给用户、不进模型上下文，
 * 而用户对本机文件本来就有完全访问权，拦下工作目录外的文件（~/.shuvix 里的
 * wiki/widget 产物等）只会挡路。
 *
 * 曾经按调用方分档（本地渲染进程放行、WebUI 的 HTTP 路由保留判定），WebUI 下线后
 * 只剩本地一种调用方，分档随之取消。
 */
export async function previewSessionFile(sessionId: string, path: string): Promise<FileReadResult> {
  const session = sessionService.getById(sessionId)
  const workingDirectory = session?.workingDirectory
  if (!workingDirectory) {
    return { kind: 'not-allowed', path, reason: 'No active workspace for this session' }
  }

  const absolutePath = resolveReadPath(path, workingDirectory)

  // 桌面 port 操作绝对路径；结果里的 path 也用绝对路径 —— 渲染端媒体/PDF 拼
  // shuvix-preview://...&path=<abs> 交给 customProtocols 流式播放（需要绝对路径）。
  return previewFile(nodeFileSystemPort, absolutePath)
}

/**
 * 回写文件内容 —— 给中间区的 Markdown live-preview 编辑器自动保存用。
 *
 * 与 WriteTool 的差异同 previewSessionFile：走 isPathWriteAllowed 的同步准入判定，
 * 不弹询问（被动 UI 不应每次自动保存都打断用户）。该判定以 **user 主体**求值 ——
 * 内置防护只作用于 agent，故这里默认放行，想约束就写 subject.kind: [user] 的策略
 * （安全模块迁移前这里是 workspace 硬边界；用户主权原则下已放宽）。
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
  if (!isPathWriteAllowed(config, absolutePath)) {
    return { ok: false, error: 'Path is not writable (outside workspace)' }
  }

  // 原子写：同目录临时文件 + rename。直接 writeFile 是「先截断后写」，并发读取方
  // （agent 的 read 工具、files.changed 触发的自读）存在读到空/半截文件的窗口 ——
  // 笔记本每 200ms 防抖自动保存，这个窗口是常态而非极端情况。同目录保证同一文件系统
  // （跨设备 rename 不是原子的），watcher 监听父目录按 basename 过滤，本就为原子保存
  // 而设计（见 filesWatcherService 头注释）。
  const tmpPath = join(dirname(absolutePath), `.${basename(absolutePath)}.${process.pid}.tmp`)
  try {
    await writeFile(tmpPath, content, 'utf8')
    // 保住原文件权限（rename 会把 tmp 的默认权限一并带过去）
    const mode = await stat(absolutePath).then(
      (st) => st.mode,
      () => null
    )
    if (mode !== null) await chmod(tmpPath, mode)
    await rename(tmpPath, absolutePath)
    return { ok: true }
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 二进制另存为 —— 弹系统保存对话框（defaultPath 预填），用户确认后落盘。
 *
 * 落点由用户在对话框里当场指定，因此**不做工作目录准入**（与 widget 导出 zip 同一模型：
 * 用户亲自选的路径即授权）。目前的调用方是图表预览的 PNG / SVG 导出。
 */
export async function saveBinaryAs(
  params: { defaultPath: string; dataBase64: string },
  win?: BrowserWindow
): Promise<
  { ok: true; path: string } | { ok: false; canceled: true } | { ok: false; error: string }
> {
  const ext = extname(params.defaultPath).replace(/^\./, '').toLowerCase()
  const options = {
    defaultPath: params.defaultPath,
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined
  }
  const result = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options))
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  try {
    await writeFile(result.filePath, Buffer.from(params.dataBase64, 'base64'))
    return { ok: true, path: result.filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
