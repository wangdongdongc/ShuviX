/**
 * Browser 模块入口 —— 主进程持有的浏览器面板（WebContentsView）与统一浏览器自动化能力。
 *
 * 公共 API：
 * - 独立窗口 —— `initBrowserWindowService` / `openBrowserWindow` /
 *     `closeBrowserWindowWithMain` / `destroyBrowserWindow`（宿主窗口懒创建，关窗只隐藏）
 * - tab 生命周期 —— `setHostWindow` / `createTab` / `closeTab` / `activateTab` /
 *     `destroyAllTabs`；查询 `getActiveView` / `getTabView` / `listTabs`；
 *     布局 `setLayout` / `setPanelVisible`
 * - `createDesktopBrowserBackend` —— 内置 browser MCP server（@shuvix/agent-runtime）
 *     的桌面 BrowserBackend 实现；`browserCdpManager` 是其 per-tab CDP 会话管理
 *
 * 消费方：
 * - src/main/index.ts —— 登记独立窗口服务 / 退出时销毁
 * - src/main/ipc/browserViewHandlers.ts —— 向 renderer 暴露 browserView:* IPC
 * - src/main/services/builtinMcp/browserServer.ts —— 内置能力服务器 `browser` 的桌面接线
 *     （agent 的唯一自动化入口：会话勾选 `mcp:browser` 才有，无 CLI）
 */

export {
  BROWSER_PARTITION,
  setHostWindow,
  isHostWebContents,
  createTab,
  closeTab,
  activateTab,
  getActiveView,
  getTabView,
  listTabs,
  setLayout,
  captureTab,
  setPanelVisible,
  destroyAllTabs,
  getBrowserHostWindow,
  initBrowserSession
} from './browserViewService'
export {
  initBrowserWindowService,
  openBrowserWindow,
  closeBrowserWindowWithMain,
  destroyBrowserWindow,
  isBrowserWindowOpen
} from './browserWindowService'
export { browserCdpManager } from './browserCdpService'
export { createDesktopBrowserBackend, DESKTOP_BROWSER_CAPS } from './browserBackend'
