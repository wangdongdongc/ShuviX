/**
 * Chrome DevTools Protocol 会话管理 —— 浏览器操控工具（Tier 2）的底层传输。
 *
 * 用 chrome.debugger 接管目标标签页，发 CDP 命令（Input.dispatch* 产生 isTrusted=true 的可信输入，
 * 与 Puppeteer / chrome-devtools MCP 同一套）。接管后该页会挂「ShuviX 已开始调试此浏览器」横幅。
 *
 * 仅在 agent 真正「操作」页面时才 attach（读取走 chrome.scripting，无横幅）。
 * A11y 快照 / UID / 坐标解析等内核走共享 CdpController（与桌面同一份）。
 */
import { CdpController, type CdpTransport } from '@shuvix/agent-runtime'

const PROTOCOL_VERSION = '1.3'

/** 已接管的标签页集合 */
const attached = new Set<number>()

/** 每个标签页一个共享 CdpController（持有该页的 UID 映射） */
const controllers = new Map<number, CdpController>()

/** 确保已接管目标标签页（幂等） */
export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return
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
  attached.add(tabId)
}

/** 发送一条 CDP 命令（自动 attach） */
export async function send<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>
): Promise<T> {
  await ensureAttached(tabId)
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T
}

/** 取（或惰性创建）某标签页的共享 CdpController（注入 chrome.debugger 传输） */
export function getController(tabId: number): CdpController {
  let controller = controllers.get(tabId)
  if (!controller) {
    const transport: CdpTransport = { sendCommand: (method, params) => send(tabId, method, params) }
    controller = new CdpController(transport)
    controllers.set(tabId, controller)
  }
  return controller
}

/** 清掉某标签页的 controller UID 状态（导航后调用，避免引用旧 backendNodeId） */
export function resetController(tabId: number): void {
  controllers.get(tabId)?.reset()
}

/** 主动释放某标签页（结束操控） */
export async function detach(tabId: number): Promise<void> {
  dropController(tabId)
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    /* 可能已被用户取消 / 标签页已关闭 */
  }
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId)
}

function dropController(tabId: number): void {
  controllers.get(tabId)?.reset()
  controllers.delete(tabId)
}

// 用户点掉横幅的「取消」/ 打开 DevTools / 标签页关闭 → onDetach，清理本地状态
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attached.delete(source.tabId)
    dropController(source.tabId)
  }
})

// 标签页关闭 → 释放（onDetach 通常也会触发，这里兜底）
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId)
  dropController(tabId)
})
