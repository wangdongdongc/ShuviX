/** 自动更新事件判别联合 — 通过 'update:event' IPC 通道推送到渲染进程 */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'up-to-date'; version: string }
  | {
      type: 'available'
      version: string
      releaseDate: string
      releaseNotes?: string | null
      /**
       * 这台 ShuviX 不能自己装更新（无头运行：服务进程没有地方确认安装，装完退出也不会被 systemd 拉起），
       * 要到运行它的电脑上手动更新 —— `command` 是 Linux 上要执行的那条命令（重跑安装脚本），别的平台 null
       */
      manual?: { command: string | null }
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
