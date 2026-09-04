/**
 * e2e 隔离实例引导（由 harness/launch.ts spawn；不要直接运行）。
 *
 * 把 userData 重定向到一次性目录后加载正式主进程产物 —— 与用户自己的运行实例
 * （真实 HOME / userData / cli.sock）完全隔离。产物路径相对本文件：apps/desktop/out/。
 *
 * 另外把 `contextMenu:popup` 换成可脚本化的桩（见下）—— 侧栏的行/组头
 * 动作如今都只在那份菜单里，而原生菜单是 e2e 唯一驱动不了的东西。
 */
const { app, ipcMain } = require('electron')
const userData = process.env.SHUVIX_VERIFY_USERDATA
if (userData) app.setPath('userData', userData)

/**
 * 原生右键菜单桩 —— 侧栏动作（新建对话 / 新建 Bot 会话 / 项目配置 / 导出 / 删除…）收进
 * ⋮ 与右键的同一份菜单后，e2e 必须能驱动它；而 `Menu.popup` 起的是 OS 级嵌套 runloop：
 * CDP 既点不到那个菜单，弹出期间连渲染端的 eval 都递不进去（整条 spec 挂死）。
 *
 * 于是隔离实例把这一个 channel 换成本桩：菜单项写进渲染端的 `window.__E2E_MENU_ITEMS`
 * 供断言，返回值取自 `window.__E2E_MENU_PICK`（用例事先钉好，取走即清；没钉就是「取消」）。
 * 桩之上的链路全是正式实现 —— 组装 items 的是产品代码，收到 actionId 后干活的也是。
 *
 * 手法是拦 `ipcMain.handle`（而不是事后 removeHandler + 重注册）：注册时机由主进程决定，
 * 拦注册这一下才与它无关。渲染端读写走 `executeJavaScript`（主世界，与 CDP 的 eval 同一个
 * window），所以 pages.ts 里钉选择与读菜单都只用 `main.eval`。
 */
const origHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => {
  if (channel !== 'contextMenu:popup') return origHandle(channel, listener)
  return origHandle(channel, async (event, request) => {
    const items = JSON.stringify((request && request.items) || [])
    const actionId = await event.sender.executeJavaScript(
      `(() => {
        window.__E2E_MENU_ITEMS = ${items}
        const pick = window.__E2E_MENU_PICK ?? null
        window.__E2E_MENU_PICK = null
        return pick
      })()`
    )
    return { actionId }
  })
}

require('../../out/main/index.js')
