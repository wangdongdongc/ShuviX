import { defineHandler } from './registry'
import {
  deleteTrackingItem,
  listTrackingItems,
  openTrackingFolder,
  openTrackingNote,
  setTrackingStatus
} from '../services/trackingNotes'
import type { TrackingStatus } from '@shuvix/chat-protocol/trackingNotes'

/**
 * 跟踪项 IPC（实验）—— 收件箱的「跟踪中」一节（手机仍是资料库的「跟踪项」分组）：清单、打开一份的笔记本、打开目录、
 * 删掉一项（行菜单）、改状态（归档 / 恢复 / 等待中）。
 * 跟踪项由 bot 维护，这里没有新建（让 bot 记，或在目录里自己建一份 md）。
 */
export function registerTrackingHandlers(): void {
  defineHandler('tracking:list', () => listTrackingItems())
  defineHandler('tracking:openNote', (_ctx, params: { fileName: string; title?: string }) =>
    openTrackingNote(params.fileName, params.title)
  )
  defineHandler('tracking:openFolder', () => openTrackingFolder())
  defineHandler('tracking:deleteItem', (_ctx, params: { fileName: string }) =>
    deleteTrackingItem(params?.fileName)
  )
  defineHandler(
    'tracking:setStatus',
    (_ctx, params: { fileName: string; status: TrackingStatus }) =>
      setTrackingStatus(params?.fileName, params?.status)
  )
}
