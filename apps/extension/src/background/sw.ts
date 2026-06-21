/**
 * MV3 Service Worker —— 点击工具栏图标时打开（或聚焦）整页 App。
 *
 * Agent 循环与 chat-ui 都跑在整页 App（常驻 tab，有完整 DOM/fetch/IndexedDB），
 * SW 不承载长任务（MV3 SW ~30s idle 会被回收）。
 *
 * 另：维护 declarativeNetRequest 动态规则，为 LLM 请求注入自定义请求头
 * （kimi User-Agent + 自定义 provider headers，详见 headerRules.ts）。
 */
import { syncHeaderRules } from './headerRules'

// 安装/启动时重建一次；provider 配置变更时（settingsStore 写 chrome.storage）增量重建
chrome.runtime.onInstalled.addListener(() => void syncHeaderRules())
chrome.runtime.onStartup.addListener(() => void syncHeaderRules())
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('providerOverrides' in changes || 'customProviderIds' in changes)) {
    void syncHeaderRules()
  }
})

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html')
  try {
    const existing = await chrome.tabs.query({ url })
    const tab = existing[0]
    if (tab?.id != null) {
      await chrome.tabs.update(tab.id, { active: true })
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true })
    } else {
      await chrome.tabs.create({ url })
    }
  } catch (err) {
    console.error('[shuvix-sw] open app tab failed', err)
    await chrome.tabs.create({ url })
  }
})
