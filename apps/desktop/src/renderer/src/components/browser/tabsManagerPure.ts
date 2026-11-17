/**
 * 浏览器管理的「标签页」那一节里不画东西的部分：桌面浏览器里的管理页（BrowserTabsManager）与手机布局的浏览器页
 * （mobile/MobileBrowser*.tsx）共用同一套判断 —— 哪些动作要先问、失败的那句话怎么写、截图要多宽。
 */
import { REMOTE_URL_REFUSED_CODE } from '../../../../shared/browserRemoteUrls'

/** 一个标签页（主进程 listTabs 的一行） */
export type TabRow = Awaited<ReturnType<typeof window.api.browserView.listTabs>>[number]

/** 调用失败的那句话（网络客户端被策略拒绝时就是规则的 prompt）；地址被拒（remote_url_refused）换成本地化的说法 */
export function reasonOf(error: unknown, refusedText: string): string {
  if ((error as { code?: unknown } | null)?.code === REMOTE_URL_REFUSED_CODE) return refusedText
  return error instanceof Error ? error.message : String(error)
}

/** agent 用着的页上要先问一声的动作；换地址带上要去的地方 */
export type GuardedRequest =
  | { tabId: string; action: 'reload' | 'close' }
  | { tabId: string; action: 'navigate'; target: string }
export type GuardedAction = GuardedRequest['action']

/** 确认框里每个动作的文案 */
export const GUARD_COPY: Record<GuardedAction, { title: string; body: string; confirm: string }> = {
  close: {
    title: 'browser.manager.confirmCloseTitle',
    body: 'browser.manager.confirmCloseBody',
    confirm: 'browser.closeTab'
  },
  reload: {
    title: 'browser.manager.confirmReloadTitle',
    body: 'browser.manager.confirmReloadBody',
    confirm: 'browser.refresh'
  },
  navigate: {
    title: 'browser.manager.confirmNavigateTitle',
    body: 'browser.manager.confirmNavigateBody',
    confirm: 'browser.manager.go'
  }
}

/**
 * 这一页正被 agent 用着：行上写着「正被谁使用」的，或接着 CDP 但还没记下会话的（agent 点出来的新页，它还没动过）。
 * CDP 接入跨轮持久，所以这不等于 agent 此刻正在动作。
 */
export function usedByAgent(tab: TabRow): boolean {
  return Boolean(tab.agentSessionId) || tab.cdpAttached
}

/** 这个动作要不要先问：agent 用着才问；崩了的页刷新、换地址不问（它已经什么都做不了，这两样就是恢复），关闭照问 */
export function needsConfirm(tab: TabRow, action: GuardedAction): boolean {
  return usedByAgent(tab) && !(action !== 'close' && tab.crashed)
}

/** 行上和确认框里写的会话名：标题，没有就写 id */
export function sessionNameOf(tab: TabRow): string | undefined {
  return tab.agentSessionTitle?.trim() || tab.agentSessionId
}

/** 截图要的宽度（CSS px × 设备像素比，至多 1280 —— 主进程只缩不放） */
export function screenshotWidth(): number {
  const ratio = typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1
  return Math.min(1280, Math.round(720 * Math.max(1, ratio)))
}
