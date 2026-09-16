// 顺序至关重要：① process shim（先于任何 pi-* 求值）→ ② i18n 单例 → ③ Tailwind 样式
import './shim'
import './i18n'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setChatApi } from '@shuvix/chat-ui'
import { chatApiAdapter } from '../runtime/chatApiAdapter'
import { settingsStore } from '../storage/settingsStore'
import { mcpStore } from '../storage/mcpStore'
import { projectStore } from '../storage/projectStore'
import { initAppearance } from './appearanceStore'
import { initSidebar } from './sidebarStore'
import { initPanel } from './panelStore'
import { initNotifications } from './notifications'
import { App } from './App'

// ④ 注入本地 ChatApi 实现（进程内，直接 await）
setChatApi(chatApiAdapter)

// ④' 通知：旁听事件流，标签页不在前台时弹系统通知（点击回到对应会话）
initNotifications()

// ⑤ 启动前载入外观 + 模型启停状态 + MCP server 列表（让同步读取生效），再渲染
void Promise.all([
  initAppearance(),
  initSidebar(),
  initPanel(),
  settingsStore.loadState().then(() => settingsStore.syncEnabledBuiltinModels()),
  mcpStore.loadState(),
  projectStore.loadState()
]).finally(() => {
  const rootEl = document.getElementById('root')
  if (rootEl) {
    createRoot(rootEl).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  }
})
// 注：MCP server 不在启动时连 —— 惰性启动，创建 Agent 装配工具那一刻才连（见 runtime/agentHost）
