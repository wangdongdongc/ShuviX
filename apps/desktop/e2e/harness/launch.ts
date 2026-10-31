/**
 * 隔离实例生命周期 —— e2e 的唯一启动入口。
 *
 * 隔离设计（不干扰用户自己正在运行的 ShuviX，也不与另一份 e2e 运行串味）：
 *   - fake HOME（os.tmpdir 下一次性目录）→ ~/.shuvix/*（agents/skills/policies）全部隔离；
 *   - SHUVIX_VERIFY_USERDATA → userData（SQLite/JSONL 会话树）隔离（bootstrap.cjs 重定向）；
 *   - **每个实例现借一个空闲 CDP 端口**（SHUVIX_E2E_PORT 可钉死，调试时用）；
 *   - 目标发现只认 URL 落在**本 checkout 产物目录**下的 target。
 *
 * 后两条是一件事的两面：Chromium 的 `--remote-debugging-port` 被占用时**不报错也不换端口**，
 * 只是不监听；此时 `/json` 回的是**另一个实例**的 target，长相与自己的一模一样，连上去就是在
 * 驱动别人的 app（表现为「provider 名称已存在」「会话行找不到」这类莫名其妙的失败）。固定端口
 * 下这有两个现实触发点：上一实例还没死透、以及另一个 worktree 同时在跑 e2e。
 *
 * 前置条件：`electron-vite build` 产物已存在（test:e2e 脚本会先构建）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  connect,
  isMainPage,
  isBrowserWindowPage,
  isMarkdownWindowPage,
  isFilePreviewWindowPage,
  isPinnedChatPage,
  markdownWindowOf,
  filePreviewWindowOf,
  pinnedChatSessionOf,
  setTimeoutDiagnostic,
  listTargets,
  sleep,
  until,
  type CdpClient,
  type CdpTarget
} from './cdp'
import { connectWs } from './wsClient'
import { expect } from 'vitest'
import { recordInstanceMemory, watchInstanceTree } from './processTree'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/**
 * 本 checkout 渲染端产物的 URL 前缀 —— target 的身份判据（percent-encoding 与 CDP 一致）。
 * spec 用 `env.ELECTRON_RENDERER_URL` 让实例走开发态的 http 加载时，判据换成那个地址（见 launchApp）。
 */
const APP_URL = pathToFileURL(join(DESKTOP_ROOT, 'out', 'renderer')).href
/** bootstrap.cjs 在主进程 Node 'exit' 时写到 stderr 的一行：应用自己的退出流程已走完（见 stop()） */
const JS_EXITED_MARKER = '[e2e] main-process js exited'

/** 一个从系统打开的 md 窗口的 target（hash 里的会话 id 与**真实路径**） */
export interface MarkdownWindowTarget {
  sessionId: string
  /** 文件的真实路径（主进程按 realpath 开窗） */
  path: string
  url: string
  webSocketDebuggerUrl: string
}

/**
 * 实例的公共面 —— 与「有没有主窗口」无关的那一半。
 *
 * 从系统打开 md 启动（`launchApp({ args: [file.md], expectMainWindow: false })`）时主窗口根本
 * 不开，`main` 为 null（见 E2EMarkdownApp）；其余一切（日志、md 窗口、之后才被建出来的主窗口、
 * 第二个实例）两种启动都一样。
 */
export interface E2EAppBase {
  port: number
  /** 实例主进程（Electron 二进制本体）的 pid */
  pid: number
  /** fake HOME（种子文件基于它，如 `${home}/.shuvix/agents`） */
  home: string
  /** ~/.shuvix/agents（惰性创建） */
  agentsDir: string
  /** ~/.shuvix/bots（惰性创建） */
  botsDir: string
  /** ~/.shuvix/hooks（惰性创建） */
  hooksDir: string
  /** 重定向后的 userData（SQLite / 会话树 / temp_workspace 都在这下面） */
  userData: string
  /**
   * 主进程日志文件（electron-log file transport）此刻的全文；第一次写入之前为空串。
   * 只进主进程日志的事实（如 hook run 的起止与 skip 原因）靠它断言。
   *
   * 文件落在 fake HOME 里、实例之间不串味（macOS 实测 `~/Library/Logs/Electron/main.log`：脚本路径
   * 启动时 app.name 是 default_app 的 'Electron'；其余平台按 Electron 缺省在 userData/logs 下）。
   * 不读子进程 stdout：console transport 把 info 打到 stdout、warn/error 打到 stderr，两条管道之间
   * 没有先后保证，「栅栏行之后没有某行」只在文件这一条有序流上成立。
   */
  mainLog(): string
  /** 实例 stdout + stderr 的全文（取证用；有序断言请用 mainLog） */
  output(): string
  /**
   * 只有 stdout 的全文 —— 无头那几行（`ShuviX headless: …`）在这里。两条管道交错拼进 `output()` 时，一行可能被另一条
   * 管道的数据从中间切开；按整行断言请用它
   */
  stdout(): string
  /**
   * 浏览器独立窗口（#browser-window）的页面；窗口还没被建出来时回 null（不等待，配合 `until`）。
   * 窗口是懒创建的，而且**只有用户**能把它建出来（顶栏按钮 / `browserView.openWindow()`）——
   * agent 的 open_tab 不会（tab 住在从不显示的停放窗口里）；关窗只是隐藏，target 仍在。
   * 调用方用完自己 close()。
   */
  browserWindow(): Promise<CdpClient | null>
  /** 此刻开着的 md 窗口（不等待，配合 `until`）；顺序按 CDP /json 的顺序，不保证 */
  markdownWindows(): Promise<MarkdownWindowTarget[]>
  /**
   * 连上真实路径含 `pathSubstr` 的那个 md 窗口，等它的 `window.api` 就绪；没有这个窗口回 null
   * （不等待，配合 `until`）。调用方用完自己 close()。
   */
  connectMarkdownWindow(pathSubstr: string): Promise<CdpClient | null>
  /** 此刻开着的文件预览窗口（#file-preview；不等待，配合 `until`），形状同 md 窗口 */
  filePreviewWindows(): Promise<MarkdownWindowTarget[]>
  /**
   * 连上真实路径含 `pathSubstr` 的那个文件预览窗口，等它的 `window.api` 就绪；没有回 null
   * （不等待，配合 `until`）。调用方用完自己 close()。
   */
  connectFilePreviewWindow(pathSubstr: string): Promise<CdpClient | null>
  /**
   * 连上某条会话的悬浮聊天窗口（`window.api.pinChat.pin(sid)` 建出的 #pinned-chat?sessionId=…），等它的
   * `window.api` 就绪；还没有这个窗口回 null（不等待，配合 `until`）。调用方用完自己 close()。
   */
  connectPinnedChatWindow(sessionId: string): Promise<CdpClient | null>
  /** 此刻开着的悬浮聊天窗口的会话 id（不等待，配合 `until`） */
  pinnedChatSessions(): Promise<string[]>
  /**
   * 此刻的主窗口页面（`window.api` 已就绪）；没有主窗口回 null（不等待，配合 `until`）。
   * 从 md 启动的实例，主窗口是之后才被建出来的（第二个实例 / Dock）—— 用它发现。
   * 调用方用完自己 close()（默认启动的 `app.main` 除外，那条由 stop 收）。
   */
  mainWindow(): Promise<CdpClient | null>
  /**
   * 结束实例并清理 fake HOME（afterAll 必须调用）。
   *
   * `keepHome: true` 只停进程、留下 HOME（数据库、会话树、日志都在里面）—— 「停机 → 改库 →
   * 用同一个 HOME 再起一次」这类升级用例靠它（配合 `launchApp({ home })`）。留下的 HOME 由
   * 调用方最后用一次不带参数的 `stop()` 收走。
   */
  stop(opts?: { keepHome?: boolean }): Promise<void>
  /**
   * 像用户按 Cmd+Q 那样退出，**等进程自己退出**（不补刀）；回这次退出的结局。之后照常 `stop()`
   * （进程已退就只清理 HOME；要接着用同一个 HOME 再起就 `stop({ keepHome: true })`）。
   *
   * 手段是 SIGTERM：Electron 主进程把它变成一个**原生任务**里的 `Browser::Quit()` —— 与菜单「退出」
   * （Cmd+Q 的 `terminate:`）、Dock 的「退出」同一个入口，调用栈上没有一行 JS。要害就在这里：从 JS 里调
   * `app.quit()` 或 `Menu.sendActionToFirstResponder('terminate:')` 都嵌在一个外层 JS 回调里，
   * `before-quit` 排下的 microtask 要等外层回调结束才清空 —— 「在 before-quit 的 microtask 清空里重入
   * `Browser::Quit()`」这类问题（v0.2.0 的退出 bug：第一次 Cmd+Q 只关了窗口）就测不出来了。
   *
   * Electron 的 SIGTERM 处理只有一次（再来一次走系统缺省，直接杀掉），所以每个实例只调一次。
   */
  quit(opts?: { timeoutMs?: number }): Promise<QuitOutcome>
}

/** `quit()` 的结局 */
export interface QuitOutcome {
  /** 进程在上限内自己退出了 */
  exited: boolean
  /** 主进程的 JS 退出流程走完了（Node 'exit'：before-quit / 关窗 / will-quit 都跑完之后，见 bootstrap.cjs） */
  jsExited: boolean
  /** 从投递 SIGTERM 到进程退出（没退出 = 等到上限）的毫秒数 */
  ms: number
  /** 进程的退出码（没退出 / 被信号杀掉 → null） */
  code: number | null
}

/** 默认启动：主窗口开着（绝大多数 spec） */
export interface E2EApp extends E2EAppBase {
  /** 主窗口页面的 CDP 客户端（window.api 已就绪） */
  main: CdpClient
  /** 打开设置窗口并连接其页面（tab 缺省 'general' —— 智能体 / 技能 / 安全策略 / Hooks 四个 tab 已搬去侧栏） */
  openSettings(tab?: string): Promise<CdpClient>
}

/** 无头启动（`headless: true`）：没有任何窗口 */
export interface E2EHeadlessApp extends E2EAppBase {
  main: null
  /** 网络访问的端口 */
  networkPort: number
  /** stdout 上的就绪那一行（原样） */
  readyLine: string
  /** 就绪那一行列出的地址（`http://…:<port>/`，按出现顺序） */
  urls: string[]
}

/** stdout 上就绪那一行的前缀（与 src/main/utils/headless.ts 的措辞一致；e2e 按值钉住） */
export const HEADLESS_READY_PREFIX = 'ShuviX headless: ready — open one of: '

/** 带着 md 文件启动、不等主窗口（`expectMainWindow: false`）：启动时没有主窗口 */
export interface E2EMarkdownApp extends E2EAppBase {
  main: null
}

export interface LaunchOptions {
  /**
   * 复用一个已有的 fake HOME（上一个实例 `stop({ keepHome: true })` 留下的），而不是新建。
   * 数据库照常走迁移 —— 这正是「老库升级」要测的那一步。复用的 HOME 在启动失败时**不删**：
   * 它不是这次启动建的。
   */
  home?: string
  /**
   * 追加在引导脚本与开关之后的命令行参数 —— Windows / Linux 上「用 ShuviX 打开」一个 md，
   * 文件就是这样到的（`process.argv`）。相对路径按 `cwd` 解析。
   */
  args?: string[]
  /** 实例进程的工作目录（缺省 apps/desktop）；相对的 md 参数按它解析 */
  cwd?: string
  /**
   * 询问点的自动审查。**缺省 false**：实例就绪后用产品自己的停用开关（md 扩展元数据，
   * `mdMeta.setEnabled({ objectId: 'hook:builtin:auto-review', enabled })`，侧栏行菜单 / 卡片开关背后的同一条
   * IPC）把内置 `auto-review` 停掉。
   *
   * 产品缺省是开：策略判出 ask、弹卡片之前，先派一个审查 agent（`permission-reviewer`）在会话当前
   * 模型上跑一次 —— 在 e2e 里那就是**又一个发往假提供商的请求**，会吃掉脚本队列里下一个 turn，
   * 把既有 spec 的 FIFO 脚本整个错位。所以隔离实例缺省关掉它，既有用例的询问照旧直接到卡片。
   *
   * 传 `true` = 显式开着（复用的 HOME 上上一个实例停掉过也一样）：测审查本身的 spec，以及要求
   * 「没有一行是停用的」的 hooks 侧栏 spec。开关每次启动都按这里写一遍，所以不随复用的 HOME 漂移。
   * `~/.shuvix/hooks` 不再被 harness 写任何文件。
   */
  autoReview?: boolean
  /**
   * 随应用提供的 bot（日记 bot，产品第一次启动时写进 `~/.shuvix/bots/daily.md`）。**缺省 false**：启动前在 fake HOME
   * 的 bots 目录里放一份「已经写过」的记录（`.builtin-seeded`），产品就不写它 —— 既有 bots / 侧栏 spec 按「bots 目录
   * 里只有 spec 自己放的文件」写；每分钟一次的内置 timer 到了 18:00 也不会替它叫起一条会话、往假提供商发请求。
   * 测它的 spec 传 `true`。复用的 HOME 上记录已经在了就不动。
   */
  builtinBots?: boolean
  /**
   * 追加给实例进程的环境变量（只这一个实例，不动 vitest 进程自己的 `process.env`）—— 例如把 pi 的
   * Kimi 授权地址 `KIMI_CODE_OAUTH_HOST` 指到 spec 起的假服务器。盖不掉 HOME / userData 的隔离。
   *
   * `ELECTRON_RENDERER_URL` 让实例像 `electron-vite dev` 那样从这个 http 地址加载渲染端（e2e 实例不是
   * 打包产物，is.dev 为真）；target 的身份判据随之换成这个地址，所以它的路径里要带 `out/renderer`
   * （`isMainPage` 认的是它）—— 见 rendererServer.ts。不给就读本 checkout 的产物文件。
   */
  env?: Record<string, string>
}

/**
 * 无头启动（`shuvix --headless`，docs/headless/design.md）：一扇窗都不开，所以不等任何页面 target，等的是 stdout 上的
 * 就绪那一行（`ShuviX headless: ready — open one of: …`）。网络访问端口缺省现借一个空闲端口（`--port <n>`），
 * 永远不落在 7766 上 —— 开发者自己的 ShuviX 可能正开着网络访问。自动审查经网络访问（Node 侧 WebSocket）关掉。
 */
export interface HeadlessLaunchOptions extends LaunchOptions {
  headless: true
  /**
   * 网络访问端口（缺省现借一个空闲端口）。`'setting'` = 命令行上**不带** `--port`：实例取设置里存的端口（再没有就是 7766
   * —— 调用方得先存一个空闲端口，e2e 从不在 7766 上监听）；`networkPort` 则从就绪那一行的地址里读出来
   */
  networkPort?: number | 'setting'
  /** 用环境变量 `SHUVIX_HEADLESS=1` 打开，命令行上不带 `--headless`（端口照样经 `--port`） */
  viaEnv?: boolean
  /**
   * 带弃用的 `--lan`（2026-10-19 起谁能连由安全策略 network-admission 定，实例一律监听 0.0.0.0）：启动时若还没有
   * 同名用户策略，按它写一份「任何私有地址都能连」的 `~/.shuvix/policies/network-admission.md`，stdout 多一行弃用说明
   */
  lan?: boolean
  /**
   * 带弃用的 `--bind <网卡名或本机地址>`（隐含 --lan）：同上，写的策略只放这台电脑与那块网卡的网段。这台电脑（127.0.0.1）
   * 总在放行之列，所以 harness 自己（关自动审查那一下）照旧连 127.0.0.1
   */
  bind?: string
}

export interface MarkdownLaunchOptions extends LaunchOptions {
  /** 不等主窗口：等 md 窗口（带着能开的 md 启动时主窗口根本不开） */
  expectMainWindow: false
  /** 至少等到这么多个 md 窗口（缺省 1） */
  markdownWindows?: number
}

/**
 * 借一个空闲回环端口：listen(0) 拿到号后立刻归还。
 * 归还到 Electron 真正 bind 之间有个极小窗口，真被别人抢走也不会静默驱动错实例
 * —— 那种情况下本实例没监听，目标发现会一直找不到「自己的」target 并超时报错。
 */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer()
    srv.on('error', rejectPort)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolvePort(port) : rejectPort(new Error('no free port'))))
    })
  })
}

/**
 * 进程级兜底回收：beforeAll 中途抛错时 spec 往往来不及 `app.stop()`（afterAll 里
 * `app` 还是 undefined），实例就会活到 worker 退出之后 —— 端口与 SQLite 都还占着。
 */
const alive = new Set<ChildProcess>()
let reaperInstalled = false
function track(child: ChildProcess): void {
  alive.add(child)
  child.on('exit', () => alive.delete(child))
  if (reaperInstalled) return
  reaperInstalled = true
  process.on('exit', () => {
    for (const c of alive) {
      try {
        c.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  })
}

/**
 * 页内取证：装一个错误收集器 + 注册 until 的超时 dump。
 *
 * 收集器用页内监听而不是 CDP 的 Runtime/Log 域 —— 本仓的 CDP 客户端只处理
 * `Runtime.evaluate` 的应答、丢弃所有事件帧，为取证去补事件订阅不划算。
 * 装得晚（renderer 就绪之后）会漏掉启动期的报错，但这里要查的超时都发生在用例中途。
 */
async function installForensics(main: CdpClient): Promise<void> {
  try {
    await main.eval(`(() => {
      if (window.__e2e) return
      const buf = []
      window.__e2e = buf
      const push = (kind, text) => { buf.push(kind + ': ' + String(text).slice(0, 300)); if (buf.length > 20) buf.shift() }
      window.addEventListener('error', (e) => push('error', e.message))
      window.addEventListener('unhandledrejection', (e) => push('rejection', e.reason && e.reason.message ? e.reason.message : e.reason))
      const orig = console.error
      console.error = (...a) => { push('console.error', a.map(String).join(' ')); orig.apply(console, a) }
    })()`)
  } catch {
    /* 取证装不上不影响用例 */
  }
  setTimeoutDiagnostic(() =>
    main.eval<string>(`(() => {
      const els = [...document.querySelectorAll('[data-msg-id]')]
      const rows = els.map(
        (e) => (e.dataset.msgId || '?') + '[' + (e.dataset.msgRole || '') + '/' + (e.dataset.msgType || '') + ']'
      )
      const lines = [
        'readyState=' + document.readyState + ' visible=' + !document.hidden,
        'msg rows (' + els.length + '): ' + (rows.join(', ') || '(none)'),
        'streaming-live: ' + (els.some((e) => e.dataset.msgId === 'streaming-live') ? 'present' : 'absent'),
        'composer: ' + (document.querySelector('textarea') ? 'present' : 'absent'),
        'page errors: ' + ((window.__e2e || []).slice(-5).join(' | ') || '(none)')
      ]
      // rAF 判别器：隐藏 / 被遮挡的窗口里 requestAnimationFrame 不触发，而 chat-ui 的流式
      // delta 合并正挂在它上面（useAgentEvents 的 scheduleFlush）。这一行把「页面不可见」
      // 与「渲染真的停摆」分开
      return new Promise((resolve) => {
        let fired = false
        requestAnimationFrame(() => { fired = true })
        setTimeout(() => {
          lines.push('raf within 250ms: ' + (fired ? 'fires' : 'STALLED'))
          resolve(lines.join('\\n'))
        }, 250)
      })
    })()`)
  )
}

/**
 * Electron 二进制本体的绝对路径（electron 包的入口导出的就是它；Node 的解析会一路往上找，
 * git worktree 里那一层没有 node_modules 时也找得到主检出的）。
 *
 * **不能用 `node_modules/.bin/electron`**：那是 electron 包的 cli.js —— 一个再 spawn 真二进制、
 * 只转发 SIGINT / SIGTERM 的 Node 包装进程。stop() 的 SIGKILL 落在包装上，真正的主进程就成了
 * 孤儿（父进程变成 launchd），在后台把自己的退出流程跑完，一路往 userData 里写 Preferences 之类的
 * 文件 —— 与 stop() 之后的 rmSync 抢跑，也让快速连跑的 spec 文件在后台叠着好几个将死的实例。
 */
function electronBinary(): string {
  return createRequire(import.meta.url)('electron') as string
}

/** 这个实例属于哪个 spec 文件（运行记录按文件记内存峰值）；不在 vitest 的用例里 → undefined */
function currentTestFile(): string | undefined {
  try {
    return expect.getState().testPath
  } catch {
    return undefined
  }
}

/** launcher（本进程）的 pid 交给实例的环境变量名 —— 与 instanceGuards.cjs 的 LAUNCHER_PID_ENV 一致 */
export const LAUNCHER_PID_ENV = 'SHUVIX_E2E_LAUNCHER_PID'

/**
 * 隔离实例的环境：fake HOME + 重定向的 userData；剔除会让 electron 退化成纯 node 的变量。
 * `extra` 是 spec 追加的变量（`LaunchOptions.env`）—— 排在 HOME / userData / launcher pid 之前，盖不掉。
 */
/** e2e 实例的 CLI 会话密钥（每个 harness 进程一个；产品自己每次启动随机生成） */
const E2E_CLI_SESSION_SECRET = randomBytes(16).toString('hex')

/**
 * 「会话里的命令」带的 SHUVIX_SESSION_KEY —— 产品在 bash 工具里注入的那一个（services/cliSession.ts 的
 * HMAC），这里按实例同一个密钥算出来
 */
export function cliSessionKeyFor(sessionId: string): string {
  return createHmac('sha256', Buffer.from(E2E_CLI_SESSION_SECRET)).update(sessionId).digest('hex')
}

export function instanceEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    // 实例据此发现 launcher 没了就自己退出（bootstrap.cjs / instanceGuards.cjs 的 watchLauncher）——
    // vitest 被掐断时 track() 的 'exit' 兜底根本来不及跑，孤儿实例曾把磁盘写满
    [LAUNCHER_PID_ENV]: String(process.pid),
    HOME: home,
    SHUVIX_VERIFY_USERDATA: join(home, 'userdata'),
    // CLI 认会话的密钥（services/cliSession.ts）：runCli 按它替「会话里的命令」算出 SHUVIX_SESSION_KEY
    SHUVIX_E2E_CLI_SESSION_SECRET: E2E_CLI_SESSION_SECRET,
    // 本地密文只用 v1（utils/crypto.ts）：钥匙串属于登录用户、不随假 HOME 隔离 —— v2 会读写真实 app 的
    // 钥匙串条目，还可能被授权框卡住
    SHUVIX_ENCRYPTION: 'v1'
  }
  // 该变量会让 electron 二进制退化为纯 node（不起窗口）—— 必须剔除
  delete env.ELECTRON_RUN_AS_NODE
  // 开发者 shell 里导出的 dev server 地址不许继承：实例会去那台 dev server（也许是另一个 checkout 的）
  // 加载渲染端，target 也对不上本 checkout 的产物。要它就由 spec 经 `extra` 明说
  // （electron-vite 的类型把它声明成只读，delete 过不了类型检查）
  if (!('ELECTRON_RENDERER_URL' in extra)) Reflect.deleteProperty(env, 'ELECTRON_RENDERER_URL')
  return env
}

/** 超时取证（没有主窗口时）：列出本实例的页面 target —— 至少看得出此刻开着哪些窗口 */
function installTargetForensics(port: number): void {
  setTimeoutDiagnostic(async () => {
    const pages = (await listTargets(port).catch(() => [])).filter((t) => t.type === 'page')
    const urls = pages.map((t) => {
      const md = markdownWindowOf(t)
      return md ? `#markdown-window session=${md.sessionId} path=${md.path}` : t.url.slice(-120)
    })
    return `page targets (${pages.length}):\n${urls.join('\n') || '(none)'}`
  })
}

/** 内置 auto-review 的对象 id —— 停用开关挂在它上面（chat-protocol mdMeta.ts 的 builtinObjectId） */
export const AUTO_REVIEW_OBJECT_ID = 'hook:builtin:auto-review'

/** 按 LaunchOptions.autoReview 拨内置 auto-review 的停用开关；写不进去就让启动失败（否则会话会多出审查请求） */
async function applyAutoReview(client: CdpClient, on: boolean): Promise<void> {
  const result = await client.eval<{ success: boolean; reason?: string; message?: string }>(
    `window.api.mdMeta.setEnabled({ objectId: ${JSON.stringify(AUTO_REVIEW_OBJECT_ID)}, enabled: ${on} })`
  )
  if (!result?.success) {
    throw new Error(
      `could not ${on ? 'enable' : 'disable'} the builtin auto-review hook: ${result?.message ?? result?.reason}`
    )
  }
}

export function launchApp(opts?: LaunchOptions): Promise<E2EApp>
export function launchApp(opts: MarkdownLaunchOptions): Promise<E2EMarkdownApp>
export function launchApp(opts: HeadlessLaunchOptions): Promise<E2EHeadlessApp>
export async function launchApp(
  opts: LaunchOptions | MarkdownLaunchOptions | HeadlessLaunchOptions = {}
): Promise<E2EApp | E2EMarkdownApp | E2EHeadlessApp> {
  const headless = 'headless' in opts && opts.headless === true
  const expectMain = !headless && !('expectMainWindow' in opts && opts.expectMainWindow === false)
  const expectMarkdown =
    expectMain || headless ? 0 : ((opts as MarkdownLaunchOptions).markdownWindows ?? 1)
  const headlessOpts = headless ? (opts as HeadlessLaunchOptions) : undefined
  const fromSetting = headlessOpts?.networkPort === 'setting'
  let networkPort =
    headlessOpts && !fromSetting
      ? ((headlessOpts.networkPort as number | undefined) ?? (await freePort()))
      : 0
  const headlessArgs = headlessOpts
    ? [
        ...(headlessOpts.viaEnv ? [] : ['--headless']),
        ...(fromSetting ? [] : ['--port', String(networkPort)]),
        ...(headlessOpts.lan ? ['--lan'] : []),
        ...(headlessOpts.bind !== undefined ? ['--bind', headlessOpts.bind] : [])
      ]
    : []
  const extraEnv = headlessOpts?.viaEnv ? { ...opts.env, SHUVIX_HEADLESS: '1' } : opts.env
  /** 本实例渲染端的地址前缀：缺省是产物目录；spec 给了 dev server 地址就是它（见 LaunchOptions.env） */
  const appUrl = opts.env?.ELECTRON_RENDERER_URL ?? APP_URL
  const pinned = process.env.SHUVIX_E2E_PORT
  const port = pinned ? Number(pinned) : await freePort()

  // 端口占用探测：钉死端口时才可能撞上（残留实例/用户的调试实例）
  const occupied = await listTargets(port).then(
    () => true,
    () => false
  )
  if (occupied) {
    throw new Error(
      `CDP port ${port} already in use — another ShuviX debug instance? ` +
        `Kill it${pinned ? ', or unset SHUVIX_E2E_PORT to let each instance borrow a free port' : ''}.`
    )
  }

  // fake HOME 用短路径优先：cliServer 的 unix socket（$HOME/.shuvix/cli.sock）受
  // macOS ~104 字节路径上限约束，os.tmpdir 的 /var/folders/... 可能超长
  const tmpBase = existsSync('/private/tmp') ? '/private/tmp' : tmpdir()
  // 复用的 HOME 不归这次启动所有：失败时不删，stop 也只在调用方要求时才删
  const ownsHome = !opts.home
  const home = opts.home ?? mkdtempSync(join(tmpBase, 'shuvix-e2e-'))
  const userData = join(home, 'userdata')
  mkdirSync(userData, { recursive: true })
  const agentsDir = join(home, '.shuvix', 'agents')
  const botsDir = join(home, '.shuvix', 'bots')
  const hooksDir = join(home, '.shuvix', 'hooks')
  if (!opts.builtinBots && !existsSync(join(botsDir, '.builtin-seeded'))) {
    mkdirSync(botsDir, { recursive: true })
    writeFileSync(join(botsDir, '.builtin-seeded'), 'daily\n')
  }
  // 主进程日志文件的候选位置（见 E2EApp.mainLog）：macOS 走 ~/Library/Logs/<app.name>，其余平台 userData/logs
  const logFiles = [
    join(home, 'Library', 'Logs', 'Electron', 'main.log'),
    join(userData, 'logs', 'main.log')
  ]
  const mainLog = (): string => {
    const file = logFiles.find((f) => existsSync(f))
    return file ? readFileSync(file, 'utf8') : ''
  }

  const child: ChildProcess = spawn(
    electronBinary(),
    [
      join(DESKTOP_ROOT, 'e2e/harness/bootstrap.cjs'),
      `--remote-debugging-port=${port}`,
      // 被别的窗口盖住时 Chromium 会把页面判成不可见并**停掉 requestAnimationFrame**，
      // 而 chat-ui 的流式 delta 合并正挂在 rAF 上（useAgentEvents 的 scheduleFlush）——
      // 于是对话一行都不渲染，所有等 DOM 的 until 一起超时（现场：visible=false + msg rows (0)，
      // 而轮询 63 次、每次几毫秒，渲染进程其实活得好好的）。
      // 这两个开关让实例不理会遮挡与后台化，e2e 结果于是与「屏幕上还有什么窗口」无关。
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      ...headlessArgs,
      ...(opts.args ?? [])
    ],
    {
      cwd: opts.cwd ?? DESKTOP_ROOT,
      env: instanceEnv(home, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  track(child)
  // 进程树：内存峰值进运行记录；收尾时等全部子进程退干净（见 processTree.ts）
  const tree = watchInstanceTree(child.pid ?? -1)
  let treeRecorded = false
  let output = ''
  let stdout = ''
  child.stdout?.on('data', (c: Buffer) => {
    output += c.toString()
    stdout += c.toString()
  })
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()))
  let exited = false
  let exitCode: number | null = null
  child.on('exit', (code) => {
    exited = true
    exitCode = code
  })

  const fail = (why: string): Error =>
    new Error(`${why}\n--- instance output (tail) ---\n${output.slice(-2000)}`)

  /** 等子进程真的退出（kill 只是投递信号）；返回是否已退出 */
  const waitExit = async (ms: number): Promise<boolean> => {
    const t0 = Date.now()
    while (!exited && Date.now() - t0 < ms) await sleep(50)
    return exited
  }

  const markdownWindows = async (): Promise<MarkdownWindowTarget[]> =>
    (await listTargets(port).catch(() => [] as CdpTarget[]))
      .filter((t) => isMarkdownWindowPage(t, appUrl))
      .flatMap((t) => {
        const md = markdownWindowOf(t)
        return md ? [{ ...md, url: t.url, webSocketDebuggerUrl: t.webSocketDebuggerUrl }] : []
      })

  const filePreviewWindows = async (): Promise<MarkdownWindowTarget[]> =>
    (await listTargets(port).catch(() => [] as CdpTarget[]))
      .filter((t) => isFilePreviewWindowPage(t, appUrl))
      .flatMap((t) => {
        const fp = filePreviewWindowOf(t)
        return fp ? [{ ...fp, url: t.url, webSocketDebuggerUrl: t.webSocketDebuggerUrl }] : []
      })

  /** 连一个页面并等它的 window.api（preload 跑完）；连不上 / 等不到都回 null（配合 until） */
  const connectReady = async (wsUrl: string): Promise<CdpClient | null> => {
    const client = await connect(wsUrl).catch(() => null)
    if (!client) return null
    try {
      await until(() => client.eval<boolean>('!!window.api'), 'window.api ready', 15_000)
      return client
    } catch {
      client.close()
      return null
    }
  }

  try {
    // 目标发现自己轮询（不走 until）：until 把 fn 抛的错一律当「未就绪」，
    // 实例启动即崩时会白等满 60s 才报一个与真因无关的超时
    const deadline = Date.now() + 60_000
    let seen: CdpTarget[] = []
    let target: CdpTarget | undefined
    let readyLine = ''
    for (;;) {
      if (exited) throw fail('instance exited during startup')
      if (headless) {
        // 无头：没有页面可等，等 stdout 上的就绪那一行（监听失败那一行 → 进程随后以非零码退出）。
        // 只认整行（行尾已经到了）：取设置里的端口时要从这一行里读端口，读到半行就错了
        readyLine =
          stdout
            .split('\n')
            .slice(0, -1)
            .find((line) => line.startsWith(HEADLESS_READY_PREFIX)) ?? ''
        if (readyLine) break
        if (Date.now() > deadline) throw fail('timeout waiting: the headless ready line on stdout')
        await sleep(50)
        continue
      }
      seen = await listTargets(port).catch(() => [])
      if (expectMain) {
        target = seen.find((t) => isMainPage(t, appUrl))
        if (target) break
      } else if (seen.filter((t) => isMarkdownWindowPage(t, appUrl)).length >= expectMarkdown) {
        break
      }
      if (Date.now() > deadline) {
        const foreign = seen.filter((t) => t.type === 'page').map((t) => t.url)
        const what = expectMain
          ? 'CDP main page target'
          : `${expectMarkdown} #markdown-window target(s)`
        throw fail(
          `timeout waiting: ${what} on port ${port}` +
            (foreign.length
              ? `\n--- page targets on that port (ours start with ${appUrl}) ---\n${foreign.join('\n')}`
              : '')
        )
      }
      await sleep(50)
    }

    let main: CdpClient | null = null
    if (headless && fromSetting) {
      // 端口取自设置：从就绪那一行的最后一个地址里读（127.0.0.1 那一条总在最后）
      const last = readyLine.slice(HEADLESS_READY_PREFIX.length).trim().split(/\s+/).at(-1) ?? ''
      networkPort = Number(/:(\d+)\/?$/.exec(last)?.[1] ?? NaN)
      if (!Number.isInteger(networkPort)) throw fail(`no port in the ready line: ${readyLine}`)
    }
    if (headless) {
      installTargetForensics(port)
      // 没有窗口：自动审查的停用开关经网络访问写（与窗口里那条是同一条 IPC 通道）。实例监听 0.0.0.0，这台电脑
      // （127.0.0.1）不论准入策略怎么写都放行（内置的只放它；--lan / --bind 迁移出的也放它）
      const ws = await connectWs(networkPort)
      try {
        const result = await ws.invoke<{ success: boolean; reason?: string; message?: string }>(
          'mdMeta:setEnabled',
          { objectId: AUTO_REVIEW_OBJECT_ID, enabled: opts.autoReview === true }
        )
        if (!result?.success) {
          throw new Error(
            `could not set the builtin auto-review hook: ${result?.message ?? result?.reason}`
          )
        }
      } finally {
        ws.close()
      }
    } else if (target) {
      main = await connect(target.webSocketDebuggerUrl)
      await until(() => main!.eval<boolean>('!!window.api'), 'window.api ready')
      await installForensics(main)
      await applyAutoReview(main, opts.autoReview === true)
    } else {
      installTargetForensics(port)
      // 没有主窗口（带着 md 启动）：等到任意一个 md 窗口的 window.api 就绪再交出实例
      const md = (await listTargets(port)).find((t) => isMarkdownWindowPage(t, appUrl))
      const client = md ? await connectReady(md.webSocketDebuggerUrl) : null
      if (!client) throw fail('no #markdown-window with window.api')
      try {
        await applyAutoReview(client, opts.autoReview === true)
      } finally {
        client.close()
      }
    }

    const stop = async (stopOpts: { keepHome?: boolean } = {}): Promise<void> => {
      setTimeoutDiagnostic(null)
      main?.close()
      if (!exited) {
        const markerFrom = output.length
        child.kill('SIGTERM')
        // 应用的 JS 退出流程走完（bootstrap.cjs 在 Node 'exit' 时写这一行）就不再等：之后只剩 Chromium
        // 的原生收尾，而窗口上屏后 ~15 秒内那段收尾要等 GPU —— 以前每个 spec 文件都在这里白等满 5 秒
        const t0 = Date.now()
        while (
          !exited &&
          Date.now() - t0 < 5000 &&
          !output.includes(JS_EXITED_MARKER, markerFrom)
        ) {
          await sleep(20)
        }
        if (!exited) {
          child.kill('SIGKILL')
          // 等它真的死透再往下走：端口与 userdata 的释放都跟着进程退出，
          // 抢跑会把「上一实例还没死」变成下一个 spec 文件的谜之失败
          await waitExit(5000)
        }
      }
      // 主进程死了，它的 GPU / 网络 / 渲染子进程还要一小会儿才发现父进程没了：等它们退干净再往下走 ——
      // 否则下一个实例起来时两份内存叠在一起，机器吃紧时后面的实例就起不来；期间也可能再往 HOME 里落文件
      const teardownFrom = Date.now()
      const killed = await tree.waitGone(10_000)
      tree.stop()
      if (!treeRecorded) {
        treeRecorded = true
        recordInstanceMemory(currentTestFile(), tree.peakRssMb(), killed, Date.now() - teardownFrom)
      }
      if (!stopOpts.keepHome) {
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }

    const quit = async (quitOpts: { timeoutMs?: number } = {}): Promise<QuitOutcome> => {
      const markerFrom = output.length
      const t0 = Date.now()
      if (!exited) child.kill('SIGTERM')
      // 上限要盖过 Chromium 的原生收尾（窗口上屏后 ~15 秒内要等 GPU，见 stop()）
      const done = await waitExit(quitOpts.timeoutMs ?? 20_000)
      return {
        exited: done,
        jsExited: output.includes(JS_EXITED_MARKER, markerFrom),
        ms: Date.now() - t0,
        code: done ? exitCode : null
      }
    }

    const base: E2EAppBase = {
      port,
      pid: child.pid!,
      home,
      agentsDir,
      botsDir,
      hooksDir,
      userData,
      mainLog,
      output: () => output,
      stdout: () => stdout,
      async browserWindow() {
        const bt = (await listTargets(port)).find((t) => isBrowserWindowPage(t, appUrl))
        return bt ? connect(bt.webSocketDebuggerUrl) : null
      },
      markdownWindows,
      async connectMarkdownWindow(pathSubstr) {
        const hit = (await markdownWindows()).find((w) => w.path.includes(pathSubstr))
        return hit ? connectReady(hit.webSocketDebuggerUrl) : null
      },
      filePreviewWindows,
      async connectFilePreviewWindow(pathSubstr) {
        const hit = (await filePreviewWindows()).find((w) => w.path.includes(pathSubstr))
        return hit ? connectReady(hit.webSocketDebuggerUrl) : null
      },
      async connectPinnedChatWindow(sessionId) {
        const hit = (await listTargets(port).catch(() => [] as CdpTarget[])).find(
          (t) => isPinnedChatPage(t, appUrl) && pinnedChatSessionOf(t) === sessionId
        )
        return hit ? connectReady(hit.webSocketDebuggerUrl) : null
      },
      async pinnedChatSessions() {
        return (await listTargets(port).catch(() => [] as CdpTarget[]))
          .filter((t) => isPinnedChatPage(t, appUrl))
          .map((t) => pinnedChatSessionOf(t))
          .filter((sid): sid is string => sid !== null)
      },
      async mainWindow() {
        const mt = (await listTargets(port).catch(() => [] as CdpTarget[])).find((t) =>
          isMainPage(t, appUrl)
        )
        return mt ? connectReady(mt.webSocketDebuggerUrl) : null
      },
      stop,
      quit
    }

    if (headless) {
      const urls = readyLine.slice(HEADLESS_READY_PREFIX.length).trim().split(/\s+/)
      return { ...base, main: null, networkPort, readyLine: readyLine.trimEnd(), urls }
    }
    if (!main) return { ...base, main: null }
    const mainClient = main
    return {
      ...base,
      main: mainClient,
      async openSettings(tab = 'general') {
        await mainClient.eval(`window.api.app.openSettings(${JSON.stringify(tab)})`)
        const st = await until(
          async () =>
            (await listTargets(port)).find(
              (t) => t.url.startsWith(appUrl) && t.url.includes('#settings')
            ),
          'settings window target'
        )
        return connect(st.webSocketDebuggerUrl)
      }
    }
  } catch (err) {
    child.kill('SIGKILL')
    await waitExit(5000)
    if (ownsHome) rmSync(home, { recursive: true, force: true })
    throw err
  }
}

/**
 * 主进程未捕获的异常：bootstrap.cjs 把它们记进 `<userData>/e2e-uncaught.log`（每条一段 stack），
 * 而不是弹原生框。一条都没有时回空串 —— spec 断 `toBe('')`。
 */
export function uncaughtExceptions(app: Pick<E2EAppBase, 'userData'>): string {
  const file = join(app.userData, 'e2e-uncaught.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** bootstrap.cjs 记的一条窗口事件（`<userData>/e2e-windows.log`） */
export interface WindowEvent {
  /** BrowserWindow 的 id */
  id: number
  event: 'created' | 'show' | 'focus' | 'closed' | 'navigate'
  /** created：那一刻的 isVisible() */
  visible?: boolean | null
  /** created：那一刻的 isFocusable() */
  focusable?: boolean | null
  /** navigate：顶层导航到的地址 */
  url?: string
}

/** 实例里每扇窗的事件（按发生顺序）；一条都没有时回空数组。之前的记录用 `.slice(n)` 跳过 */
export function windowEvents(app: Pick<E2EAppBase, 'userData'>): WindowEvent[] {
  const file = join(app.userData, 'e2e-windows.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WindowEvent)
}

/** 一扇窗的事件归拢（`windowsOf`） */
export interface WindowHistory {
  id: number
  /** created 那一条（窗口建在记录范围之前时没有） */
  created?: WindowEvent
  /** 顶层导航过的地址（按顺序） */
  urls: string[]
  shown: boolean
  focused: boolean
  closed: boolean
}

/** 把事件按窗口归拢（按每扇窗第一次出现的顺序） */
export function windowsOf(events: WindowEvent[]): WindowHistory[] {
  const byId = new Map<number, WindowHistory>()
  for (const e of events) {
    let w = byId.get(e.id)
    if (!w) {
      w = { id: e.id, urls: [], shown: false, focused: false, closed: false }
      byId.set(e.id, w)
    }
    if (e.event === 'created') w.created = e
    else if (e.event === 'navigate' && e.url) w.urls.push(e.url)
    else if (e.event === 'show') w.shown = true
    else if (e.event === 'focus') w.focused = true
    else if (e.event === 'closed') w.closed = true
  }
  return [...byId.values()]
}

/** 第二个实例的结局 */
export interface SecondInstanceResult {
  /** 退出码（被信号杀掉时为 null） */
  code: number | null
  signal: NodeJS.Signals | null
  /** stdout + stderr */
  output: string
  /** 只有 stdout（无头那几行在这里） */
  stdout: string
}

/**
 * 起一个**第二个实例**：同一个 electron + 引导脚本、同一个 HOME / userData（所以拿不到单实例锁），
 * **不带**调试端口。它把自己的 argv 与 cwd 交给第一个实例（`second-instance` 事件）然后退出 ——
 * Windows / Linux 上「用 ShuviX 打开」一个 md、或者再点一次应用图标，走的就是这条路。
 *
 * 等它退出才 resolve；上界内没退出就杀掉并抛（它不该活着：活着说明它以为自己是第一个实例）。
 */
export async function spawnSecondInstance(
  app: E2EAppBase,
  opts: { args?: string[]; cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<SecondInstanceResult> {
  const child = spawn(
    electronBinary(),
    [join(DESKTOP_ROOT, 'e2e/harness/bootstrap.cjs'), ...(opts.args ?? [])],
    {
      cwd: opts.cwd ?? DESKTOP_ROOT,
      env: instanceEnv(app.home, opts.env),
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  track(child)
  let output = ''
  let stdout = ''
  child.stdout?.on('data', (c: Buffer) => {
    output += c.toString()
    stdout += c.toString()
  })
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()))
  const timeoutMs = opts.timeoutMs ?? 30_000
  return new Promise<SecondInstanceResult>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectResult(
        new Error(
          `second instance did not exit within ${timeoutMs}ms (did it get the single-instance lock?)` +
            `\n--- its output (tail) ---\n${output.slice(-2000)}`
        )
      )
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      rejectResult(err)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolveResult({ code, signal, output, stdout })
    })
  })
}

/** 一次跑到底的启动的结局（`runToExit`） */
export interface RunToExitResult {
  /** 退出码（被信号杀掉时为 null） */
  code: number | null
  signal: NodeJS.Signals | null
  /** stdout + stderr */
  output: string
  /** 只有 stdout（无头那几行在这里） */
  stdout: string
}

/**
 * 起一个**自己会退出**的实例（`--help`、参数不对、无头启动时端口被占 …）：同一个 electron + 引导脚本，fresh HOME
 * （或给定的 `home`，不删），**不带**调试端口；等它退出才 resolve。上界内没退出就杀掉并抛。
 */
export async function runToExit(
  opts: { args?: string[]; env?: Record<string, string>; home?: string; timeoutMs?: number } = {}
): Promise<RunToExitResult> {
  const tmpBase = existsSync('/private/tmp') ? '/private/tmp' : tmpdir()
  const ownsHome = !opts.home
  const home = opts.home ?? mkdtempSync(join(tmpBase, 'shuvix-e2e-'))
  mkdirSync(join(home, 'userdata'), { recursive: true })
  const child = spawn(
    electronBinary(),
    [join(DESKTOP_ROOT, 'e2e/harness/bootstrap.cjs'), ...(opts.args ?? [])],
    { cwd: DESKTOP_ROOT, env: instanceEnv(home, opts.env), stdio: ['ignore', 'pipe', 'pipe'] }
  )
  track(child)
  let output = ''
  let stdout = ''
  child.stdout?.on('data', (c: Buffer) => {
    output += c.toString()
    stdout += c.toString()
  })
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()))
  const timeoutMs = opts.timeoutMs ?? 60_000
  try {
    return await new Promise<RunToExitResult>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectResult(
          new Error(
            `instance did not exit within ${timeoutMs}ms` +
              `\n--- its output (tail) ---\n${output.slice(-2000)}`
          )
        )
      }, timeoutMs)
      child.on('error', (err) => {
        clearTimeout(timer)
        rejectResult(err)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        resolveResult({ code, signal, output, stdout })
      })
    })
  } finally {
    if (ownsHome) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** `runCli` 的结局 */
export interface CliResult {
  /** 退出码（被信号杀掉时为 null） */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * 像命令工具里的 `shuvix …` 那样跑一次 CLI（resources/cli 的 shim 做的事：`ELECTRON_RUN_AS_NODE=1` 的 Electron 跑
 * `out/main/cli.js`）。HOME 是实例的 fake HOME —— CLI 据此找到这个实例的 `~/.shuvix/cli.sock` 与 cli-token。
 * 等它退出才 resolve；上界内没退出就杀掉并抛。
 */
export async function runCli(
  app: Pick<E2EAppBase, 'home'>,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {}
): Promise<CliResult> {
  // instanceEnv 剔除了 ELECTRON_RUN_AS_NODE（实例要的是 Electron）；CLI 正好相反，之后补上。
  // 给了会话 id 没给 key：扮成那条会话里的命令（产品的 bash 工具两样一起注入，见 services/cliSession.ts）；
  // 要测「只报 id 不算数」就显式给一个 SHUVIX_SESSION_KEY
  const sid = opts.env?.SHUVIX_SESSION_ID
  const withKey =
    sid && opts.env && !('SHUVIX_SESSION_KEY' in opts.env)
      ? { ...opts.env, SHUVIX_SESSION_KEY: cliSessionKeyFor(sid) }
      : opts.env
  const env = { ...instanceEnv(app.home, withKey), ELECTRON_RUN_AS_NODE: '1' }
  const child = spawn(electronBinary(), [join(DESKTOP_ROOT, 'out', 'main', 'cli.js'), ...args], {
    cwd: DESKTOP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  track(child)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()))
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
  const timeoutMs = opts.timeoutMs ?? 30_000
  return new Promise<CliResult>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectResult(
        new Error(
          `shuvix ${args.join(' ')} did not exit within ${timeoutMs}ms` +
            `\n--- stdout ---\n${stdout.slice(-1000)}\n--- stderr ---\n${stderr.slice(-1000)}`
        )
      )
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      rejectResult(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveResult({ code, stdout, stderr })
    })
  })
}
