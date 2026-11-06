/**
 * 没人在看的页面用：每个文档开头把弹框和打印换成空操作。macOS 上窗口藏着时 alert 是整个应用的模态框，
 * 会弹到用户面前、还把页面挂住。
 */
export const SILENCE_DIALOGS = `(() => {
  const noop = () => undefined
  window.alert = noop
  window.confirm = () => false
  window.prompt = () => null
  window.print = noop
})()`
