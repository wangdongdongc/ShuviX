/**
 * 桌面 CDP 传输工厂 + per-tab attach 管理。
 *
 * per-tab 生命周期 / UID 映射 / network+console 缓冲统一走共享 CdpAttachManager
 * （@shuvix/agent-runtime，与扩展同一份）；本文件只保留 Electron webContents.debugger
 * 的 transport 工厂与外部断开兜底。tabId 即 browserViewService 的 UUID。
 *
 * 与旧实现的行为差异（刻意）：不再"只 attach 激活 view、切 tab 即断开"——
 * 操作以显式 tabId 为准，切 tab 不丢 network/console 缓冲。
 */

import { CdpAttachManager, type CdpTabTransportFactory } from '@shuvix/agent-runtime'
import { getTabView } from './browserViewService'
import { createLogger } from '../../logger'

const log = createLogger('BrowserCDP')

// 再导出兼容既有引用
export type { AXNode, NetworkEntry, ConsoleEntry } from '@shuvix/agent-runtime'

const CDP_VERSION = '1.3'

const factory: CdpTabTransportFactory = {
  async attach(tabId) {
    const view = getTabView(tabId)
    if (!view) {
      throw new Error(`No browser tab "${tabId}". Use open_tab first, or list_tabs to find one.`)
    }
    const wc = view.webContents

    try {
      wc.debugger.attach(CDP_VERSION)
    } catch (err) {
      // 可能已 attach（其他地方先调用了），忽略 "Already attached"
      if (!(err instanceof Error) || !err.message.includes('Already attached')) {
        throw new Error(`Failed to attach CDP debugger: ${(err as Error).message}`)
      }
    }

    const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>): void => {
      for (const fn of listeners) fn(method, params)
    }
    wc.debugger.on('message', onMessage)

    // 页面崩溃 / 手动 detach 等外部断开 → 清理本地状态
    const onDetach = (): void => {
      log.info(`CDP debugger detached externally (tab ${tabId})`)
      browserCdpManager.handleExternalDetach(tabId)
    }
    wc.debugger.once('detach', onDetach)

    log.info(`CDP debugger attached (tab ${tabId})`)
    return {
      sendCommand: <T>(method: string, params?: Record<string, unknown>) =>
        wc.debugger.sendCommand(method, params) as Promise<T>,
      onEvent: (fn) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
          // 外部断开路径只走 disposeLocal（不调 detach），这里兜底摘除 debugger 监听
          if (listeners.size === 0) wc.debugger.off('message', onMessage)
        }
      },
      detach: async () => {
        wc.debugger.off('message', onMessage)
        wc.debugger.off('detach', onDetach)
        try {
          wc.debugger.detach()
        } catch {
          // 可能已 detach，忽略
        }
        log.info(`CDP debugger detached (tab ${tabId})`)
      }
    }
  }
}

/** 应用级单例；tab 关闭 / app 退出时由 browserViewService 调 detach/detachAll */
export const browserCdpManager = new CdpAttachManager(factory)
