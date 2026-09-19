/**
 * e2e 隔离实例引导（由 harness/launch.ts spawn；不要直接运行）。
 *
 * 把 userData 重定向到一次性目录后加载正式主进程产物 —— 与用户自己的运行实例
 * （真实 HOME / userData / cli.sock）完全隔离。产物路径相对本文件：apps/desktop/out/。
 *
 * 另外把两个 **OS 级模态** 换成可脚本化的桩（见下）：`contextMenu:popup`（侧栏的行/组头
 * 动作如今都只在那份菜单里）与 `skill:pickExternalDir`（添加外部技能目录的第一步）。
 * 两者都起 OS 级嵌套 runloop，是 e2e 唯一驱动不了的东西。
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

/** 桩的实现表：channel → 收下正式入参、回一个正式形状的应答 */
const STUBS = {
  'contextMenu:popup': async (event, request) => {
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
  },

  /**
   * 目录选择器桩（`dialog.showOpenDialog`）—— 「添加外部技能目录」的第一步。
   *
   * 同样是 OS 级模态：CDP 关不掉它，整条 spec 会挂死。用例事先把要「选」的绝对路径钉在
   * `window.__E2E_SKILL_DIR_PICK` 上（取走即清），没钉就等价于用户按了取消。
   *
   * **刻意保留这一步**而不是在 e2e 里直接调 `skill.addExternalDir` 绕过 UI：这个 IPC 之上
   * 还有「选完再取名」的第二步（SkillDirDialog），而重名被拒之后对话框要停在原地 ——
   * 绕过去就把那一整段流程测没了。
   */
  'skill:pickExternalDir': async (event) => {
    const path = await event.sender.executeJavaScript(
      `(() => {
        const picked = window.__E2E_SKILL_DIR_PICK ?? null
        window.__E2E_SKILL_DIR_PICK = null
        return picked
      })()`
    )
    return path ? { success: true, path } : { success: false, reason: 'canceled' }
  }
}

ipcMain.handle = (channel, listener) => {
  const stub = STUBS[channel]
  return stub ? origHandle(channel, stub) : origHandle(channel, listener)
}

require('../../out/main/index.js')
