/**
 * Chrome DevTools Protocol 会话管理 —— 浏览器工具的底层传输。
 *
 * 用 chrome.debugger 接管目标标签页，发 CDP 命令（Input.dispatch* 产生 isTrusted=true 的可信输入，
 * 与 Puppeteer / chrome-devtools MCP 同一套）。接管后该页会挂「ShuviX 已开始调试此浏览器」横幅。
 *
 * per-tab attach 生命周期 / UID 映射 / network+console 缓冲统一走共享 CdpAttachManager
 * （@shuvix/agent-runtime，与桌面同一份），本文件只保留 chrome.debugger 的 transport 工厂
 * 与外部断开兜底（用户点掉横幅 / 打开 DevTools / 标签页关闭）。
 */
import { CdpAttachManager, type CdpTabTransportFactory } from '@shuvix/agent-runtime'

const PROTOCOL_VERSION = '1.3'

const factory: CdpTabTransportFactory = {
  async attach(tabKey) {
    const tabId = Number(tabKey)
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 已被「其他」调试器接管（多半是该页打开了 DevTools）→ 无法接管
      if (/already attached/i.test(msg)) {
        throw new Error(
          `无法接管标签页 ${tabId}：已有调试器占用（该标签页可能打开了开发者工具）。请关闭其 DevTools 后重试。`
        )
      }
      throw new Error(`接管标签页 ${tabId} 失败：${msg}`)
    }

    const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
    const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object): void => {
      if (source.tabId !== tabId) return
      for (const fn of listeners) fn(method, (params ?? {}) as Record<string, unknown>)
    }
    chrome.debugger.onEvent.addListener(onEvent)

    return {
      sendCommand: async <T>(method: string, params?: Record<string, unknown>) =>
        (await chrome.debugger.sendCommand({ tabId }, method, params)) as T,
      onEvent: (fn) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
          // 外部断开路径只走 disposeLocal（不调 detach），这里兜底摘除 chrome 级监听
          if (listeners.size === 0) chrome.debugger.onEvent.removeListener(onEvent)
        }
      },
      detach: async () => {
        chrome.debugger.onEvent.removeListener(onEvent)
        try {
          await chrome.debugger.detach({ tabId })
        } catch {
          /* 可能已被用户取消 / 标签页已关闭 */
        }
      }
    }
  }
}

/** 应用级单例（主会话 / 笔记本任务 / 子代理追问共享）；轮末由 tabLease 归零时 detachAll */
export const cdpManager = new CdpAttachManager(factory)

// 用户点掉横幅的「取消」/ 打开 DevTools / 标签页关闭 → onDetach，清理本地状态
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    cdpManager.handleExternalDetach(String(source.tabId))
  }
})

// 标签页关闭 → 释放（onDetach 通常也会触发，这里兜底）
chrome.tabs.onRemoved.addListener((tabId) => {
  cdpManager.handleExternalDetach(String(tabId))
})
