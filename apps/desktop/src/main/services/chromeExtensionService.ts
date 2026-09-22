/**
 * Chrome 扩展的桌面侧编排 —— 装原生消息宿主、汇总连接状态给设置页。
 *
 * 桥本身（socket、协议、后端）在内聚模块 `chromeBridge`；会话层（标签页会话、侧边栏的对话接口）在
 * `frontend/chrome`。这里只是设置页要看的那一份「装好了没有、连着哪些浏览器」，以及「修复本地组件」
 * 按钮背后的重装。
 */
import { homedir } from 'os'
import type { ChromeExtensionStatus } from '@shuvix/chat-protocol/chromeBridge'
import {
  chromeBridge,
  installNativeHost,
  type HostPlatform,
  type NativeHostInstallResult
} from './chromeBridge'
import { getShuvixCliEnv } from '../utils/paths'
import { appEventBus } from '../utils/appEventBus'
import { createLogger } from '../logger'

const log = createLogger('ChromeExtension')

export type { ChromeExtensionStatus }

let lastInstall: NativeHostInstallResult | null = null

function hostPlatform(): HostPlatform {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
}

/** 装（或重装）原生消息宿主：启动时跑一次，设置页的「修复本地组件」再跑 */
export async function installChromeNativeHost(): Promise<NativeHostInstallResult> {
  const env = getShuvixCliEnv()
  const result = await installNativeHost({
    platform: hostPlatform(),
    home: homedir(),
    electron: env.SHUVIX_ELECTRON,
    cliJs: env.SHUVIX_CLI_JS
  })
  lastInstall = result
  if (result.failed.length > 0) {
    log.warn(
      `native host install: ${result.failed.map((f) => `${f.browser}: ${f.error}`).join('; ')}`
    )
  } else {
    log.info(`native host installed for: ${result.installed.join(', ') || '(no browser found)'}`)
  }
  appEventBus.publish({ type: 'chromeExtension.changed' })
  return result
}

export function chromeExtensionStatus(): ChromeExtensionStatus {
  return {
    listening: chromeBridge.listening,
    browsers: chromeBridge.statuses(),
    install: lastInstall
  }
}

// 浏览器连上 / 断开 / 协议不符 → 设置页刷新
chromeBridge.onChange(() => appEventBus.publish({ type: 'chromeExtension.changed' }))
