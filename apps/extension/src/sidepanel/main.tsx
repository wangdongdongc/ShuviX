// 顺序要紧：① i18n 单例（chat-ui 依赖它已 init）→ ② 样式
import './i18n'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setSessionChannelApi, syncClientFor } from '@shuvix/chat-ui'
import { PanelLink } from './panelLink'
import { createPanelChannelApi } from './channelApi'
import { resetSyncOnReconnect } from './syncReset'
import { dropTab, initTabSelection } from './tabSelection'
import { applyAppearance, DEFAULT_APPEARANCE } from './appearance'
import { App } from './App'

/**
 * 侧边栏入口。每个标签页一个侧边栏实例，地址带着它挂的标签页：`sidepanel.html?tabId=<id>`
 * （SW 在打开时写进 sidePanel.setOptions 的 path）。
 */
const tabId = Number(new URLSearchParams(location.search).get('tabId'))

applyAppearance(DEFAULT_APPEARANCE)
const rootEl = document.getElementById('root')

if (!Number.isInteger(tabId) || tabId < 0) {
  if (rootEl) rootEl.textContent = 'ShuviX: this side panel is not attached to a tab.'
} else {
  initTabSelection(tabId)
  chrome.tabs.onRemoved.addListener((closed) => dropTab(closed))
  const link = new PanelLink(tabId)
  // 单会话渠道：宿主管理类界面（模型 / 项目 / 会话配置 / 设置入口）随 getHostApi() 为空自动隐藏
  const api = createPanelChannelApi(link)
  setSessionChannelApi(api)
  // 视图同步的客户端先于任何视图 hook 建好：同一条桥连接上的几个侧边栏共用一个桌面客户端
  // （`chrome:<connId>`），订阅 id 按标签页 + 本页随机数加前缀才不会撞（P3-09-12）
  const nonce = Math.random().toString(36).slice(2, 8)
  const syncClient = syncClientFor(api.sync, { idPrefix: `tab${tabId}.${nonce}` })
  // 重连（非 ready → ready）之后旧连接上的订阅都不在了：丢掉绑定、重订一份新快照（PIN-10）
  resetSyncOnReconnect(link, syncClient)
  if (rootEl) {
    createRoot(rootEl).render(
      <StrictMode>
        <App link={link} />
      </StrictMode>
    )
  }
}
