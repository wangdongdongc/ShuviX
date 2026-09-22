/**
 * Chrome 桥 —— 桌面与 ShuviX Chrome 扩展之间的一切（内聚模块）。
 *
 *  - server：桥服务（本地组件连进来的 socket、鉴权、握手、双向请求与事件、分片）；
 *  - hostInstaller：原生消息宿主的启动脚本与各浏览器的宿主清单；
 *  - browserState / backend：按浏览器的 CDP 状态与标签组，及内置能力服务器 `chrome` 的后端。
 *
 * 会话层面的事（标签页会话的开与关、侧边栏的对话接口、事件推送）在 Chrome 前端
 * （`frontend/chrome`），它是这里的上层：本模块不认识会话服务。
 */
export {
  chromeBridge,
  BridgeConnection,
  ChromeBridgeServer,
  CHROME_DISCONNECTED_ERROR,
  type ChromeBridgeHandlers,
  type ChromeBrowserInfo,
  type ChromeConnectionStatus
} from './server'
export {
  installNativeHost,
  nativeHostTargets,
  launcherContent,
  launcherPath,
  manifestContent,
  type HostPlatform,
  type NativeHostInstallResult
} from './hostInstaller'
export {
  chromeBrowserState,
  existingChromeBrowserState,
  requireConnection,
  CHROME_NOT_CONNECTED,
  type ChromeBrowserState
} from './browserState'
export {
  createChromeBrowserBackend,
  ChromeBridgeBackend,
  CHROME_BROWSER_CAPS,
  formatTabList,
  groupColorFor,
  groupTitleFor
} from './backend'
