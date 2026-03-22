import { BrowserWindow, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { createLogger } from '../logger'
import type { UpdateEvent } from '../types'

const log = createLogger('Updater')

/**
 * 自动更新服务 — 封装 electron-updater。
 * autoDownload 禁用，用户需主动点击下载和安装。
 */
class UpdateService {
  private initialized = false
  /** 最后收到的更新事件（供新打开的窗口拉取当前状态） */
  private lastEvent: UpdateEvent | null = null

  init(): void {
    if (this.initialized) return
    this.initialized = true

    // 将 electron-updater 内部日志路由到同一日志文件
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    autoUpdater.logger = log as any

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    // 开发模式下需要 dev-app-update.yml 才能测试更新流程
    if (!app.isPackaged) {
      autoUpdater.forceDevUpdateConfig = true
    }

    autoUpdater.on('checking-for-update', () => {
      log.info('Checking for update…')
      this.broadcast({ type: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
      log.info(`Update available: ${info.version}`)
      this.broadcast({
        type: 'available',
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null
      })
    })

    autoUpdater.on('update-not-available', (info) => {
      log.info(`Up to date: ${info.version}`)
      this.broadcast({ type: 'up-to-date', version: info.version })
    })

    autoUpdater.on('download-progress', (progress) => {
      this.broadcast({
        type: 'downloading',
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      log.info(`Update downloaded: ${info.version}`)
      this.broadcast({ type: 'ready', version: info.version })
    })

    autoUpdater.on('error', (err) => {
      log.error(`Updater error: ${err.message}`)
      this.broadcast({ type: 'error', message: err.message })
    })
  }

  async checkForUpdates(): Promise<void> {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      log.error(`checkForUpdates threw: ${err}`)
      this.broadcast({ type: 'error', message: (err as Error).message })
    }
  }

  async downloadUpdate(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      log.error(`downloadUpdate threw: ${err}`)
      this.broadcast({ type: 'error', message: (err as Error).message })
    }
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall(false, true)
  }

  getLastEvent(): UpdateEvent | null {
    return this.lastEvent
  }

  private broadcast(event: UpdateEvent): void {
    this.lastEvent = event
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('update:event', event)
      }
    }
  }
}

export const updateService = new UpdateService()
