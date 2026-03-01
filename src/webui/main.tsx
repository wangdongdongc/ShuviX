/**
 * WebUI 入口
 * 注入 window.api polyfill，然后挂载 React 应用
 */

// i18n 必须在 React 组件之前初始化
import '../renderer/src/i18n'
import './assets/webui.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createWebApi } from './api'
import App from './App'

// 注入 window.api polyfill（替代 Electron preload）
window.api = createWebApi()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
