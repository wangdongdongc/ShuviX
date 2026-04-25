/**
 * Browser 模块入口 —— 主进程持有的浏览器面板（WebContentsView）与 CDP 自动化能力。
 *
 * 公共 API：
 * - `createBrowserView` / `destroyBrowserView` / `getBrowserView` / `getBrowserHostWindow`
 *     —— 在主窗口里嵌入/销毁 WebContentsView
 * - `browserCdpService` —— CDP 会话、A11y UID 映射、网络/控制台事件收集
 * - devtools actions —— snapshot / click / type / screenshot 等具体自动化操作
 *
 * 消费方：
 * - src/main/index.ts —— 创建/销毁面板
 * - src/main/ipc/browserViewHandlers.ts —— 向 renderer 暴露 browserView:* IPC
 * - src/main/tools/browser.ts —— browser 工具（open/close/devtools/help）
 */

export {
  createBrowserView,
  destroyBrowserView,
  getBrowserView,
  getBrowserHostWindow
} from './browserViewService'
export { browserCdpService } from './browserCdpService'
export {
  DEVTOOLS_HELP,
  snapshotAction,
  screenshotAction,
  printToPdfAction,
  clickAction,
  fillAction,
  typeAction,
  pressKeyAction,
  scrollAction,
  evaluateAction,
  waitForAction,
  navigateAction,
  getNetworkRequestsAction,
  getConsoleMessagesAction
} from './browserCdpActions'
