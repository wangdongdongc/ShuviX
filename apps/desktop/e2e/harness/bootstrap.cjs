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
 *
 * 同理 `shell.openExternal` 换成记录器（见 EXTERNAL_OPEN_LOG）：e2e 永远不该在开发者的机器上打开
 * 系统浏览器（订阅登录会自动打开验证页 / 授权页），spec 读这个文件断言「打开了哪个地址」。
 *
 * 最后，实例**不能活过 harness**（instanceGuards.cjs 记着那次把磁盘写满的事故）：stdout / stderr 管道
 * 断了、或 launcher 进程没了，就不再写控制台、直接退出；本文件追加的每个文件都有上限。
 */
const electron = require('electron')
const { app, dialog, ipcMain } = electron
const { join } = require('path')
const {
  createBoundedAppender,
  isBrokenPipe,
  launcherPidFromEnv,
  watchLauncher
} = require('./instanceGuards.cjs')
const userData = process.env.SHUVIX_VERIFY_USERDATA
if (userData) app.setPath('userData', userData)

/** 本文件往 userData 里追加的所有记录都走它：每个文件到 5 MB 封顶（见 instanceGuards.cjs） */
const appendBounded = createBoundedAppender()

/** harness 已经不在的判定落地后写的记录（在 userData 下；一行：时间 + 原因）—— 取证与 spec 用 */
const HARNESS_GONE_LOG = 'e2e-harness-gone.log'

/** 已判定 harness 不在、正在退出：此后不再写控制台，也不再记录任何东西 */
let harnessGone = false

/** 把 stdout / stderr 的 write 换成空操作（照样回调，免得有人等回调）：管道那头已经没人了 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 纯 CommonJS，写不了类型标注
function silenceStdio() {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 同上
  const swallow = (_chunk, encoding, cb) => {
    const done = typeof encoding === 'function' ? encoding : cb
    if (typeof done === 'function') process.nextTick(done)
    return true
  }
  for (const stream of [process.stdout, process.stderr]) {
    try {
      stream.write = swallow
    } catch {
      /* 换不上也照样退出 */
    }
  }
}

/**
 * harness 不在了（管道断了 / launcher 没了）：静音控制台、记一行原因、立刻退出。
 *
 * `app.exit` 不走 before-quit —— 没人等这个实例的数据。Chromium 的原生收尾在窗口上屏后 ~15 秒内
 * 可能要等 GPU（见下面 JS_EXITED_MARKER），所以 5 秒后还没走完就 SIGKILL 自己：GPU / 渲染子进程
 * 会随主进程的 IPC 通道断开而退出。
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 纯 CommonJS，写不了类型标注
function leaveBecauseHarnessGone(reason) {
  if (harnessGone) return
  harnessGone = true
  silenceStdio()
  if (userData)
    appendBounded(join(userData, HARNESS_GONE_LOG), `${new Date().toISOString()} ${reason}\n`)
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGKILL')
    } catch {
      /* 已经在退 */
    }
  }, 5000).unref()
  try {
    app.exit(0)
  } catch {
    process.exit(0)
  }
}

/** stdout / stderr 是否已经坏了（对端关闭后流被销毁） */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 纯 CommonJS，写不了类型标注
function stdioBroken() {
  return [process.stdout, process.stderr].some((s) => s.destroyed || s.writable === false)
}

/**
 * 常驻的 stdio 'error' 监听 —— 事故的第一环就断在这里。Node 的 console 只在写调用期间挂一个临时
 * 'error' 监听，异步到达的 EPIPE 没人接就成了 uncaughtException；有了这个监听它就到不了那一步。
 * 管道断了 = harness 不在；别的 stdio 错误记一条（有上限）就算了，不能让它变成未捕获异常。
 */
for (const [name, stream] of [
  ['stdout', process.stdout],
  ['stderr', process.stderr]
]) {
  stream.on('error', (err) => {
    if (isBrokenPipe(err)) {
      leaveBecauseHarnessGone(`${name} pipe closed (${err.code})`)
    } else if (userData && !harnessGone) {
      appendBounded(
        join(userData, 'e2e-uncaught.log'),
        `[e2e] ${name} error: ${(err && err.stack) || err}\n\n`
      )
    }
  })
}

// 什么都不打日志时也要发现 launcher 没了：父进程 pid 变了，或 harness 传进来的 launcher pid 不在了
watchLauncher({
  launcherPid: launcherPidFromEnv(process.env),
  onGone: (reason) => leaveBecauseHarnessGone(reason)
})

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
  // 记不下来（或到了上限）也不能让调用方失败：appendBounded 从不抛
  appendBounded(join(userData, NATIVE_DIALOG_LOG), `${method} ${detail}\n`)
}

/**
 * 主进程未捕获的异常：Electron 缺省弹「A JavaScript error occurred in the main process」原生框 ——
 * 又一个 OS 级模态（spec 挂在那，框留在开发者屏幕上，而失败原因只在框里）。隔离实例改为把它记进
 * `<userData>/e2e-uncaught.log`（每条一段 stack）并打到 stderr，spec 可以断这个文件不存在 / 为空。
 * 挂上这个监听器 Electron 就不再弹框：它的缺省处理只在没有别的监听器时才弹。
 *
 * 记录器自己绝不能成环：harness 已不在就什么都不做；一个写坏掉的 stdio 得到的 EPIPE（上面的常驻监听
 * 本该先接住，这里兜底）不算异常而是 harness 不在了；正在记录时又来一条（记录途中的写触发的）直接丢掉；
 * 文件本身有上限。
 */
const UNCAUGHT_LOG = 'e2e-uncaught.log'
let recordingUncaught = false
process.on('uncaughtException', (err) => {
  if (harnessGone) return
  if (isBrokenPipe(err) && stdioBroken()) {
    leaveBecauseHarnessGone(`stdio pipe closed (${err.code}, surfaced as an uncaught exception)`)
    return
  }
  if (recordingUncaught) return
  recordingUncaught = true
  try {
    const stack = (err && err.stack) || String(err)
    if (!stdioBroken()) process.stderr.write(`[e2e] uncaught exception in main: ${stack}\n`)
    // 记不下来也只能这样了：stderr 那一行还在实例输出里
    if (userData) appendBounded(join(userData, UNCAUGHT_LOG), `${stack}\n\n`)
  } finally {
    recordingUncaught = false
  }
})

/**
 * 交给系统打开的地址的记录文件名（在 userData 下；每行一个地址）。
 *
 * 主进程里通往系统浏览器的只有 `shell.openExternal`（externalOpen/gate.ts 的 openExternally，调用时才
 * 取 `electron.shell.openExternal`，所以在加载产物之前换掉就够了）。换成记录器：地址照样过产品自己的
 * 闸（routeExternalUrl 的裁决都还在），只是最后那一步不真的交给系统 —— 订阅登录会自动打开验证页 /
 * 授权页，跑一次 e2e 不该在开发者屏幕上弹出浏览器，更不该打开真的 auth.openai.com。
 */
const EXTERNAL_OPEN_LOG = 'e2e-external-open.log'
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 纯 CommonJS，写不了类型标注
async function recordExternalOpen(url) {
  if (!userData) return
  // 记不下来（或到了上限）也不能让调用方失败：appendBounded 从不抛
  appendBounded(join(userData, EXTERNAL_OPEN_LOG), `${String(url)}\n`)
}
electron.shell.openExternal = recordExternalOpen
// 换不上（某个 Electron 版本把 shell 冻住了）就别往下跑：宁可实例起不来，也不能真的打开浏览器
if (electron.shell.openExternal !== recordExternalOpen) {
  process.stderr.write('[e2e] could not stub shell.openExternal; refusing to start\n')
  process.exit(1)
}

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
