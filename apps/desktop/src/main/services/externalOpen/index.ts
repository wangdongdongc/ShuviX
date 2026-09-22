/**
 * externalOpen —— 交给操作系统之前的那道闸。
 *
 * `decision.ts` 是纯裁决（哪些地址可以直接交、哪些先问、哪些一律不交），`gate.ts` 把它接到
 * electron 上（询问框 / shell.openExternal / 窗口守卫 / 权限处理器）。
 *
 * 消费方：src/main/index.ts（主窗口、设置窗口、`app:open-external`、默认会话的权限处理器）、
 * services/pinnedChatService、services/widgetWindowService、services/browser/browserViewService、
 * ipc/providerHandlers。
 */
export {
  externalOpenDecision,
  clipUrl,
  createExternalOpenAsk,
  DECLINE_QUIET_MS,
  type ExternalOpenDecision
} from './decision'
export {
  approveExternalUrl,
  approveOpenExternalPermission,
  guardAppWindow,
  routeExternalUrl,
  type ExternalOpenOptions,
  type ExternalOpenSource
} from './gate'
