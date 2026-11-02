import { app, autoUpdater as electronAutoUpdater } from 'electron'
import { autoUpdater, DebUpdater } from 'electron-updater'
import { createLogger } from '../logger'
import { broadcastToClients } from '../ipc/registry'
import type { UpdateEvent } from '../types'
import { headlessUpdateCommand, headlessUpdateError, isHeadless } from '../utils/headless'
import { hasNoNewPrivs, relaunchAfterExit } from '../utils/linuxRelaunch'

const log = createLogger('Updater')

/** 界面按 `code: 'restart-required'` 显示本地化的说明；这句进日志，也是没有那条文案时的回退 */
const RESTART_REQUIRED_MESSAGE =
  'ShuviX cannot get administrator rights in this run. Quit it, open it again from the app menu, then install the update.'

/**
 * 这次运行装不了 deb：`dpkg -i` 要经 pkexec 提权，而进程带着 NoNewPrivs 时 setuid 不生效（见 utils/linuxRelaunch.ts，
 * 旧版的自动重启把这个标记带进来）。root 不用提权，不受影响
 */
function cannotInstallDeb(): boolean {
  return autoUpdater instanceof DebUpdater && process.getuid?.() !== 0 && hasNoNewPrivs()
}

/**
 * 自动更新服务 — 封装 electron-updater。
 * autoDownload 禁用，用户需主动点击下载和安装。
 *
 * 无头运行时只检查不安装：electron-updater 在 Linux 上装 deb 要么走 sudo（服务进程没有地方输密码 → 失败），
 * 要么以 root 直接 `dpkg -i` 后正常退出再自己拉起 —— systemd 的 `Restart=on-failure` 不管正常退出，还会把拉起
 * 的进程一起杀掉，服务就停了。所以 `available` 带上 `manual`（Linux 上是重跑安装脚本的命令），下载 / 安装
 * 一律拒绝，退出时也不顺手装（`autoInstallOnAppQuit`：`systemctl stop` 时装到一半会被杀）。
 *
 * 桌面上的 deb 更新装完由这里重启，不用 electron-updater 自带的 `app.relaunch()` —— 那样重启出来的进程带着
 * NoNewPrivs，下一次更新的 pkexec 必败（见 utils/linuxRelaunch.ts）。已经带着它的进程（从旧版更新过来的那一次运行）
 * 不去试：安装时直接说要退出重开，退出时也不顺手装。
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
    autoUpdater.autoInstallOnAppQuit = !isHeadless() && !cannotInstallDeb()

    if (autoUpdater instanceof DebUpdater && !isHeadless()) {
      autoUpdater.autoRunAppAfterInstall = false
      // Linux 上这个事件只有 quitAndInstall 装成功之后才发，紧接着就是 app.quit()；装失败不发，也就不会重启
      electronAutoUpdater.on('before-quit-for-update', () => {
        log.info('Update installed; relaunching after exit')
        relaunchAfterExit()
      })
    }

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
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
        ...(isHeadless() ? { manual: { command: headlessUpdateCommand(info.version) } } : {})
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
    if (isHeadless()) throw headlessUpdateError()
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      log.error(`downloadUpdate threw: ${err}`)
      this.broadcast({ type: 'error', message: (err as Error).message })
    }
  }

  quitAndInstall(): void {
    if (isHeadless()) throw headlessUpdateError()
    if (cannotInstallDeb()) {
      log.warn(`Not installing: ${RESTART_REQUIRED_MESSAGE}`)
      this.broadcast({ type: 'error', message: RESTART_REQUIRED_MESSAGE, code: 'restart-required' })
      return
    }
    autoUpdater.quitAndInstall(false, true)
  }

  getLastEvent(): UpdateEvent | null {
    return this.lastEvent
  }

  private broadcast(event: UpdateEvent): void {
    this.lastEvent = event
    broadcastToClients('update:event', event)
  }
}

export const updateService = new UpdateService()
