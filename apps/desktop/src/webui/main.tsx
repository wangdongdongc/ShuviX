/**
 * WebUI 入口
 * 注入「单会话渠道」后端适配器（仅 SessionChannelApi），然后挂载 React 应用。
 * 不再伪装成完整 window.api —— 宿主管理能力（getHostApi）为 null，相关 UI 自动隐藏。
 */

// i18n 必须在 React 组件之前初始化
import '../renderer/src/i18n'
import './assets/webui.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setSessionChannelApi } from '@shuvix/chat-ui'
import { createWebSessionChannelApi } from './api'
import App from './App'

// 注入渠道后端（替代 Electron preload 的 window.api）
setSessionChannelApi(createWebSessionChannelApi())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
