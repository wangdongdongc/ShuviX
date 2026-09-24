/**
 * e2e 隔离实例引导（由 harness/launch.ts spawn；不要直接运行）。
 *
 * 把 userData 重定向到一次性目录后加载正式主进程产物 —— 与用户自己的运行实例
 * （真实 HOME / userData / cli.sock）完全隔离。产物路径相对本文件：apps/desktop/out/。
 *
 * 另外把两个 **OS 级模态** 换成可脚本化的桩（见下）：`contextMenu:popup`（侧栏的行/组头
 * 动作如今都只在那份菜单里）与 `skill:pickExternalDir`（添加外部技能目录的第一步）。
 * 两者都起 OS 级嵌套 runloop，是 e2e 唯一驱动不了的东西。
 *
 * 再加一道保险：`dialog.showOpenDialog` / `showOpenDialogSync` 一律回「取消」，并把每次请求记进
 * `<userData>/e2e-native-dialogs.log`（见 NATIVE_DIALOG_LOG）—— e2e 永远不该在开发者的屏幕上弹出
 * 原生「打开文件」框（它同样起 OS 级模态，CDP 关不掉），spec 可以断这个文件是空的。
 * 这只挡得住**主进程 JS** 发起的框；页面里 `<input type=file>` 自己弹的框走 Chromium 的 C++ 路径，
 * 由产品的 agentGuards 与 spec 自己的 `interceptFileChoosers`（browserFixtures.ts）挡。
 */
const { app, dialog, ipcMain } = require('electron')
const { appendFileSync } = require('fs')
const { join } = require('path')
const userData = process.env.SHUVIX_VERIFY_USERDATA
if (userData) app.setPath('userData', userData)

/** 原生「打开文件」框请求的记录文件名（在 userData 下；每行一个请求：方法名 + 选项 JSON） */
const NATIVE_DIALOG_LOG = 'e2e-native-dialogs.log'

/** 记下一次原生框请求（选项里可能挂着窗口对象，序列化失败就只记方法名） */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 纯 CommonJS，写不了类型标注
function recordNativeDialog(method, args) {
  if (!userData) return
  const opts = args.find((a) => a && typeof a === 'object' && !a.webContents)
  let detail = ''
  try {
    detail = JSON.stringify(opts ?? null)
  } catch {
    detail = '(unserializable options)'
  }
  try {
    appendFileSync(join(userData, NATIVE_DIALOG_LOG), `${method} ${detail}\n`)
  } catch {
    // 记不下来也不能让调用方失败
  }
}

/**
 * 主进程未捕获的异常：Electron 缺省弹「A JavaScript error occurred in the main process」原生框 ——
 * 又一个 OS 级模态（spec 挂在那，框留在开发者屏幕上，而失败原因只在框里）。隔离实例改为把它记进
 * `<userData>/e2e-uncaught.log`（每条一段 stack）并打到 stderr，spec 可以断这个文件不存在 / 为空。
 * 挂上这个监听器 Electron 就不再弹框：它的缺省处理只在没有别的监听器时才弹。
 */
const UNCAUGHT_LOG = 'e2e-uncaught.log'
process.on('uncaughtException', (err) => {
  const stack = (err && err.stack) || String(err)
  process.stderr.write(`[e2e] uncaught exception in main: ${stack}\n`)
  if (!userData) return
  try {
    appendFileSync(join(userData, UNCAUGHT_LOG), `${stack}\n\n`)
  } catch {
    // 记不下来也只能这样了：stderr 那一行还在实例输出里
  }
})

dialog.showOpenDialog = async (...args) => {
  recordNativeDialog('showOpenDialog', args)
  return { canceled: true, filePaths: [] }
}
dialog.showOpenDialogSync = (...args) => {
  recordNativeDialog('showOpenDialogSync', args)
  return undefined
}

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

/**
 * 主进程的 JS 退出流程走完的信号（launch.ts 的 stop() 认这一行）。
 *
 * 为什么需要：窗口首次上屏后约 15 秒内，Chromium 的收尾要等 GPU 那边的活干完才让进程退出 ——
 * 与 ShuviX 的代码无关（一个只开一个可见窗口的空 Electron 应用同样要等 ~14 秒；`--disable-gpu`
 * 则立刻退出）。真实用户不会在启动后十几秒内退出，e2e 实例却几乎都是：stop() 以前每次都白等满
 * 5 秒超时再 SIGKILL。Node 的 'exit' 事件在 before-quit / 关窗 / will-quit 全部跑完之后才来，
 * 应用自己的清理此时都已做完，剩下的只是 Chromium 的原生收尾 —— stop() 看到这一行就可以直接收走进程。
 *
 * 用 writeSync 而不是 process.stderr.write：macOS 上管道写是异步的，'exit' 回调里排进队列的写
 * 不保证能冲出去。
 */
const JS_EXITED_MARKER = '[e2e] main-process js exited\n'
process.on('exit', () => {
  try {
    require('fs').writeSync(2, JS_EXITED_MARKER)
  } catch {
    /* stderr 已关：stop() 退回到等进程自己退出 / 超时 SIGKILL */
  }
})

require('../../out/main/index.js')
