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
import { listSessionArtifacts } from '../services/artifacts/listing'
import {
  readArtifactForRef,
  readCurrentArtifact,
  type PinSession
} from '../services/artifacts/pins'
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
  // 名字→路径的解析是本会话目录的事，归 artifacts 模块。带上围栏所在回复的 `messageId` 时，取的是那条
  // 回复写下时钉住的那一版（artifacts/pins.ts）；没钉过就是当前内容。会话不在（存储没有）也照样按名字取。
  defineHandler(
    'artifact:read',
    (_ctx, params: { sessionId: string; name: string; messageId?: string }) => {
      if (params.messageId === undefined) return readCurrentArtifact(params.sessionId, params.name)
      return (async () => {
        // 按需加载会话宿主：它带着整套运行时依赖，只按名字取内容的调用不该为它付加载成本
        let session: PinSession | undefined
        try {
          const { getSessionHost } = await import('../services/sessionHost')
          session = await getSessionHost().peek(params.sessionId)
        } catch {
          session = undefined
        }
        return readArtifactForRef(session, params.sessionId, params.name, params.messageId)
      })()
    }
  )
  // 会话面板「产物」页的清单：本会话的，再加直接子会话的（与上面读内容同一个往下找一层）
  defineHandler('artifact:list', (_ctx, params: { sessionId: string }) =>
    listSessionArtifacts([
      { sessionId: params.sessionId },
      ...sessionRecords
        .findChildren(params.sessionId)
        .map((c) => ({ sessionId: c.id, subSessionTitle: c.title }))
    ])
  )
}
