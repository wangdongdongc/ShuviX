import { defineHandler } from './registry'
import {
  scanSessionFiles,
  scanSessionDir,
  watchSessionFile,
  unwatchSessionFile
} from '../services/filesWatcherService'
import {
  previewSessionFile,
  resolveSessionFilePath,
  writeSessionFile
} from '../services/filePreviewService'
import { openFileInWindow, type OpenFileParams } from '../services/previewWindowService'
import { findArtifact, readArtifact } from '../services/artifacts/store'
import { sessionRecords } from '../services/sessionRecords'
import { networkPathVerdict } from '../frontend/network/pathGate'

export function registerFilesHandlers(): void {
  defineHandler('files:scan', (_ctx, params: { sessionId: string }) =>
    scanSessionFiles(params.sessionId)
  )
  // 按目录浅扫描（文件树懒加载）：dir 相对工作目录，空串 = 根
  defineHandler('files:scanDir', (_ctx, params: { sessionId: string; dir: string }) =>
    scanSessionDir(params.sessionId, params.dir)
  )
  // 监听 / 取消监听单个已打开文件的内容变更（笔记本 / 预览自动刷新）
  defineHandler('files:watch', (_ctx, params: { sessionId: string; path: string }) => {
    watchSessionFile(params.sessionId, params.path)
  })
  defineHandler('files:unwatch', (_ctx, params: { sessionId: string; path: string }) => {
    unwatchSessionFile(params.sessionId, params.path)
  })
  // 网络客户端读的位置另过安全策略的 path 点位（宿主本身不限路径；桌面窗口不判）
  defineHandler('files:read', (ctx, params: { sessionId: string; path: string }) => {
    const verdict = networkPathVerdict(
      ctx,
      'read',
      () => resolveSessionFilePath(params.sessionId, params.path),
      { name: 'files', operation: 'read' }
    )
    if (verdict && !verdict.allowed) {
      return { kind: 'not-allowed' as const, path: params.path, reason: verdict.message ?? '' }
    }
    return previewSessionFile(params.sessionId, params.path)
  })
  // 在独立窗口里打开文件（md → 协作编辑窗口；其余可预览的 → 预览窗口；不支持预览的不响应）
  defineHandler('files:open', (_ctx, params: OpenFileParams) => openFileInWindow(params))
  defineHandler(
    'files:write',
    (ctx, params: { sessionId: string; path: string; content: string }) => {
      const verdict = networkPathVerdict(
        ctx,
        'write',
        () => resolveSessionFilePath(params.sessionId, params.path),
        { name: 'files', operation: 'write' }
      )
      if (verdict && !verdict.allowed) {
        return { ok: false as const, error: verdict.message ?? 'Refused by a security policy.' }
      }
      return writeSessionFile(params.sessionId, params.path, params.content)
    }
  )
  // 会话 Artifact 按**名字**取内容 —— ```artifact 引用围栏的数据通道。
  // 刻意不走 files:read：那条要绝对路径，而围栏里只该有名字（路径不进转写），
  // 名字→路径的解析是本会话目录的事，归 artifacts 模块。
  defineHandler('artifact:read', (_ctx, params: { sessionId: string; name: string }) => {
    // 先本会话，再往下找一层子会话：产物的目录跟着**产出它的那场会话**走（见 artifacts/store
    // 的说明），而 `work` 基座的分工正是把具体活交给 `coding` 子会话 —— 子代理画的图，
    // 父会话终答里的引用必须展示得出来。嵌套只有一层，所以不递归。
    const candidates = [
      params.sessionId,
      ...sessionRecords.findChildren(params.sessionId).map((c) => c.id)
    ]
    for (const sid of candidates) {
      const found = findArtifact(sid, params.name)
      if (!found) continue
      const content = readArtifact(sid, params.name)
      if (content !== null) return { name: found.name, title: found.title, content }
    }
    return null
  })
}
