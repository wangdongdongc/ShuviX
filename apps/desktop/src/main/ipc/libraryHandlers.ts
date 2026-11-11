import { dialog } from 'electron'
import { defineHandler } from './registry'
import { windowOf } from './ipcAdapter'
import { addToLibrary, recordSessionAttached } from '../services/fileLibrary'
import { isSafeSessionId } from '../utils/paths'
import type {
  LibraryAddParams,
  LibraryAddResult,
  LibraryItemSource
} from '@shuvix/chat-protocol/fileLibrary'

/** 客户端能报的来源（编辑器的三种进库方式）；别的一律按 `import` 记 */
const CLIENT_SOURCES: ReadonlySet<LibraryItemSource> = new Set([
  'note-paste',
  'note-drop',
  'note-insert'
])

/** 回给失败结果的文件名：形状不对的入参（网络客户端交来的任意 JSON）一律回空串，不抛 */
function nameOf(params: LibraryAddParams | undefined): string {
  const item = params?.item as { kind?: unknown; path?: unknown; name?: unknown } | undefined
  if (item?.kind === 'path' && typeof item.path === 'string') {
    return item.path.split(/[/\\]/).pop() ?? ''
  }
  if (item?.kind === 'bytes' && typeof item.name === 'string') return item.name
  return ''
}

export function registerLibraryHandlers(): void {
  // 一个文件进库（docs/file-library-design.md §5）。网络客户端只能交字节：交本机路径就等于让任何远程客户端
  // 把本机文件复制进库、绕过读权限（同附件稿 §9）
  defineHandler('library:add', (ctx, params: LibraryAddParams): Promise<LibraryAddResult> => {
    const item = params?.item
    const valid =
      (item?.kind === 'path' && typeof item.path === 'string' && item.path !== '') ||
      (item?.kind === 'bytes' &&
        typeof item.name === 'string' &&
        typeof item.mimeType === 'string' &&
        typeof item.dataBase64 === 'string')
    if (!valid) {
      return Promise.resolve({
        ok: false,
        name: nameOf(params),
        reason: 'refused',
        message: 'Invalid file.'
      })
    }
    if (item.kind === 'path' && ctx.transport !== 'ipc') {
      return Promise.resolve({
        ok: false,
        name: nameOf(params),
        reason: 'refused',
        message: 'Only file contents can be added from this client.'
      })
    }
    const source = CLIENT_SOURCES.has(params.source) ? params.source : 'import'
    const sessionId =
      typeof params.sessionId === 'string' && isSafeSessionId(params.sessionId)
        ? params.sessionId
        : undefined
    return addToLibrary({
      item,
      source,
      ...(typeof params.label === 'string' ? { label: params.label } : {})
    }).then((result) => {
      // 用户把它放进了这条会话的笔记：这条会话的 agent 读它不用问（ask-on-library-access）
      if (result.ok && sessionId) recordSessionAttached(sessionId, result.item.id, source)
      return result
    })
  })
  // 笔记右键「插入图片或文件…」：本机的选择文件对话框（挂在调用方窗口上；取消、没有窗口 → null）。
  // 不用页面里的 input.click()：原生菜单的点击回到页面时已经没有用户激活，Chromium 不让开文件选择框
  defineHandler('library:pickFiles', async (ctx): Promise<string[] | null> => {
    const win = windowOf(ctx)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })
}
