import { app, autoUpdater as electronAutoUpdater, session } from 'electron'
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
 * 一次检查最多等这么久。electron-updater 的请求走 Electron 的 `net`，它的 ClientRequest 不发 `socket` 事件，
 * builder-util-runtime 挂在那上面的 60 秒超时因此从不生效：连接卡住（换网、VPN 断开后池里留下的死连接）时
 * 检查永远不结束，而 electron-updater 还把这个没结束的 promise 记在 `checkForUpdatesPromise` 上，之后每次检查都
 * 只是「already in progress」地拿回它 —— 用户再怎么点也恢复不了，只能重启 ShuviX
 */
export const UPDATE_CHECK_TIMEOUT_MS = 30_000

/** 界面上的错误说明最长这么多字；完整的进日志 */
const ERROR_MESSAGE_MAX = 300

/**
 * electron-updater 的 HttpError 把整段响应头（以及有时整个 HTML 响应体）拼进 message，在界面上能铺满整页。
 * 只留第一段：遇到空行或 `Headers:` 截断，合并空白，再按长度截。
 */
export function summarizeUpdateError(message: string): string {
  let text = message.split(/\n\s*\n|\bHeaders:/)[0] ?? ''
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) text = message.replace(/\s+/g, ' ').trim()
  return text.length > ERROR_MESSAGE_MAX ? `${text.slice(0, ERROR_MESSAGE_MAX - 1)}…` : text
}

/** electron-updater 发请求用的会话（electronHttpExecutor.getNetSession 的同一个分区） */
function dropUpdaterConnections(): void {
  try {
    void session.fromPartition('electron-updater', { cache: false }).closeAllConnections()
  } catch (err) {
    log.warn(`Cannot reset updater connections: ${err}`)
  }
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
  /** 正在进行的检查（含超时）；再点一次就并进它，不另发请求 */
  private checking: Promise<void> | null = null
  /** 上一次检查失败或超时：下次检查前先断掉更新会话里的连接，别再复用可能已死的那条 */
  private lastCheckFailed = false

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
      this.broadcast({ type: 'error', message: summarizeUpdateError(err.message) })
    })
  }

  /**
   * 检查更新。已有一次在跑就并进它（重发 `checking`，界面点了之后不会一片空白）；
   * 超过 {@link UPDATE_CHECK_TIMEOUT_MS} 没结果就报超时，并清掉 electron-updater 记着的那个卡住的 promise，
   * 下一次检查才会真的重新发请求。
   */
  checkForUpdates(): Promise<void> {
    if (this.checking) {
      this.broadcast({ type: 'checking' })
      return this.checking
    }
    const run = this.runCheck().finally(() => {
      if (this.checking === run) this.checking = null
    })
    this.checking = run
    return run
  }

  private async runCheck(): Promise<void> {
    if (this.lastCheckFailed) dropUpdaterConnections()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), UPDATE_CHECK_TIMEOUT_MS)
    })
    try {
      const outcome = await Promise.race([autoUpdater.checkForUpdates(), timedOut])
      if (outcome === 'timeout') {
        log.warn(`checkForUpdates timed out after ${UPDATE_CHECK_TIMEOUT_MS}ms`)
        // 私有字段：不清掉它，之后的 checkForUpdates() 都只会拿回这个永远不结束的 promise
        ;(autoUpdater as unknown as { checkForUpdatesPromise: unknown }).checkForUpdatesPromise =
          null
        this.lastCheckFailed = true
        // 卡住的那个请求跟着断掉，它晚到的 error 落在这次超时之后，而不是落在用户下一次检查的中间
        dropUpdaterConnections()
        this.broadcast({ type: 'error', message: 'Timed out', code: 'timeout' })
        return
      }
      this.lastCheckFailed = false
    } catch (err) {
      log.error(`checkForUpdates threw: ${err}`)
      this.lastCheckFailed = true
      this.broadcast({ type: 'error', message: summarizeUpdateError((err as Error).message) })
    } finally {
      clearTimeout(timer)
    }
  }

  async downloadUpdate(): Promise<void> {
    if (isHeadless()) throw headlessUpdateError()
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      log.error(`downloadUpdate threw: ${err}`)
      this.broadcast({ type: 'error', message: summarizeUpdateError((err as Error).message) })
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
