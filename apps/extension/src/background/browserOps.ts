/**
 * 浏览器操作的执行者 —— 桌面要什么就做什么（chat-protocol `BrowserOpMap`）。
 *
 * 扩展在这里**不做决定**：开哪个页、要不要问用户、用哪份配方，全在桌面（`chrome` 内置能力服务器）。
 * 这里只把几样 chrome.* 调用摆出来，外加两条执行层面的规矩：
 *  - 新开的页在**后台**（不抢用户正在看的页）；
 *  - `debugger.attach` 幂等：同一个页扩展已经接管着就直接成功（桌面重连后会重新要）。
 */
import { extractPage } from '@shuvix/agent-runtime/browser/extractPage'
import type { BrowserOpMap, BrowserOpName, ChromeTabInfo } from '@shuvix/chat-protocol/chromeBridge'

const PROTOCOL_VERSION = '1.3'

/** 扩展此刻接管着（chrome.debugger）的标签页 */
const attached = new Set<number>()

export function tabInfo(tab: chrome.tabs.Tab): ChromeTabInfo | null {
  if (tab.id == null || tab.id < 0) return null
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
    pendingUrl: tab.pendingUrl || undefined,
    favIconUrl: tab.favIconUrl || undefined,
    active: tab.active,
    groupId: tab.groupId ?? -1,
    status: tab.status as ChromeTabInfo['status'],
    audible: tab.audible || undefined
  }
}

/** 等标签页加载完（status=complete）；超时回 false。用 tabs 事件而不是 CDP：不必为等加载挂横幅 */
function waitForComplete(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve(ok)
    }
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === 'complete') finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    chrome.tabs.onUpdated.addListener(onUpdated)
    // 注册监听之前可能已经加载完
    chrome.tabs.get(tabId).then(
      (t) => {
        if (t.status === 'complete' && !t.pendingUrl) finish(true)
      },
      () => finish(false)
    )
  })
}

type Handler<M extends BrowserOpName> = (
  params: BrowserOpMap[M]['params']
) => Promise<BrowserOpMap[M]['result']>

const handlers: { [M in BrowserOpName]: Handler<M> } = {
  'tabs.list': async () =>
    (await chrome.tabs.query({})).map(tabInfo).filter((t): t is ChromeTabInfo => !!t),

  'tabs.get': async ({ tabId }) => {
    try {
      return tabInfo(await chrome.tabs.get(tabId))
    } catch {
      return null
    }
  },

  'tabs.create': async ({ url, groupId, windowId }) => {
    const tab = await chrome.tabs.create({ url, active: false, windowId })
    if (groupId != null && groupId >= 0 && tab.id != null) {
      await chrome.tabs.group({ groupId, tabIds: [tab.id] }).catch(() => {})
    }
    const info = tabInfo(tab)
    if (!info) throw new Error('Chrome did not open the tab.')
    return info
  },

  'tabs.remove': async ({ tabId }) => {
    await chrome.tabs.remove(tabId)
    return null
  },

  'tabs.waitLoad': async ({ tabId, timeoutMs }) => ({
    loaded: await waitForComplete(tabId, timeoutMs)
  }),

  'page.extract': async ({ tabId }) => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPage
    })
    if (!injected?.result) throw new Error('the page returned nothing')
    return injected.result
  },

  'group.ensure': async ({ groupId, tabIds, title, color }) => {
    let target: number | undefined
    if (groupId != null && groupId >= 0) {
      try {
        await chrome.tabGroups.get(groupId)
        target = groupId
      } catch {
        target = undefined // 组没了（浏览器重启 / 用户解散）→ 新建
      }
    }
    const ids = tabIds as [number, ...number[]]
    const finalId =
      target != null
        ? await chrome.tabs.group({ groupId: target, tabIds: ids })
        : await chrome.tabs.group({ tabIds: ids })
    await chrome.tabGroups.update(finalId, { title, color, collapsed: false })
    return { groupId: finalId }
  },

  // 探活：桌面在顶替一条连接之前问的，只回一句「我还在」，不碰浏览器
  'bridge.ping': async () => ({ ok: true }) as { ok: true },

  'debugger.attach': async ({ tabId }) => {
    if (attached.has(tabId)) return null
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/already attached/i.test(msg)) {
        throw new Error(
          `Cannot operate tab ${tabId}: another debugger is attached to it (probably its DevTools). Close DevTools on that tab and try again.`
        )
      }
      throw new Error(`Cannot operate tab ${tabId}: ${msg}`)
    }
    attached.add(tabId)
    return null
  },

  'debugger.detach': async ({ tabId }) => {
    attached.delete(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => {})
    return null
  },

  'debugger.send': async ({ tabId, method, params }) =>
    chrome.debugger.sendCommand({ tabId }, method, params)
}

/** 执行一条桌面发来的浏览器操作 */
export function runBrowserOp(method: string, params: unknown): Promise<unknown> {
  const handler = (handlers as Record<string, Handler<BrowserOpName> | undefined>)[method]
  if (!handler) return Promise.reject(new Error(`Unknown browser operation "${method}".`))
  return handler(params as never)
}

/** 扩展接管着这个页吗（只转发自己接管的页的 CDP 事件） */
export function isAttached(tabId: number): boolean {
  return attached.has(tabId)
}

/** 调试被外部断开（用户点掉横幅、打开 DevTools、页关了） */
export function forgetDebugger(tabId: number): void {
  attached.delete(tabId)
}

/** 与桌面的连接断了：桌面那边的记账已作废，横幅也不该留着 */
export async function detachAllDebuggers(): Promise<void> {
  const tabs = [...attached]
  attached.clear()
  await Promise.all(tabs.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})))
}
