// 顺序要紧：① i18n 单例（chat-ui 依赖它已 init）→ ② 样式
import './i18n'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setSessionChannelApi } from '@shuvix/chat-ui'
import { PanelLink } from './panelLink'
import { createPanelChannelApi } from './channelApi'
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
  setSessionChannelApi(createPanelChannelApi(link))
  if (rootEl) {
    createRoot(rootEl).render(
      <StrictMode>
        <App link={link} />
      </StrictMode>
    )
  }
}
