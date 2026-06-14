/** 自动更新事件判别联合 — 通过 'update:event' IPC 通道推送到渲染进程 */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'up-to-date'; version: string }
  | {
      type: 'available'
      version: string
      releaseDate: string
      releaseNotes?: string | null
    }
  | {
      type: 'downloading'
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }
  | { type: 'ready'; version: string }
  | { type: 'error'; message: string }
