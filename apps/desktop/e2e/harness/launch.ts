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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  markdownWindowOf,
  setTimeoutDiagnostic,
  listTargets,
  sleep,
  until,
  type CdpClient,
  type CdpTarget
} from './cdp'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/** 本 checkout 渲染端产物的 URL 前缀 —— target 的身份判据（percent-encoding 与 CDP 一致） */
const APP_URL = pathToFileURL(join(DESKTOP_ROOT, 'out', 'renderer')).href

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
   * 浏览器独立窗口（#browser-window）的页面；窗口还没被建出来时回 null（不等待，配合 `until`）。
   * 窗口是懒创建的，而且**只有用户**能把它建出来（侧栏按钮 / `browserView.openWindow()`）——
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
}

/** 默认启动：主窗口开着（绝大多数 spec） */
export interface E2EApp extends E2EAppBase {
  /** 主窗口页面的 CDP 客户端（window.api 已就绪） */
  main: CdpClient
  /** 打开设置窗口并连接其页面（tab 缺省 'general' —— 智能体 / 技能 / 安全策略 / Hooks 四个 tab 已搬去侧栏） */
  openSettings(tab?: string): Promise<CdpClient>
}

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

/** 仓库里的 electron 二进制（git worktree 里那一层没有 node_modules 时退回 Node 自己的解析） */
function electronBinary(): string {
  // 工作区依赖装在检出根；**git worktree 里那一层没有 node_modules**（npm 只在主检出装过），
  // 于是退回 Node 自己的解析 —— electron 包的入口导出的就是二进制的绝对路径。
  const localBin = resolve(DESKTOP_ROOT, '../../node_modules/.bin/electron')
  return existsSync(localBin) ? localBin : (createRequire(import.meta.url)('electron') as string)
}

/** 隔离实例的环境：fake HOME + 重定向的 userData；剔除会让 electron 退化成纯 node 的变量 */
function instanceEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SHUVIX_VERIFY_USERDATA: join(home, 'userdata')
  }
  // 该变量会让 electron 二进制退化为纯 node（不起窗口）—— 必须剔除
  delete env.ELECTRON_RUN_AS_NODE
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

export function launchApp(opts?: LaunchOptions): Promise<E2EApp>
export function launchApp(opts: MarkdownLaunchOptions): Promise<E2EMarkdownApp>
export async function launchApp(
  opts: LaunchOptions | MarkdownLaunchOptions = {}
): Promise<E2EApp | E2EMarkdownApp> {
  const expectMain = !('expectMainWindow' in opts && opts.expectMainWindow === false)
  const expectMarkdown = expectMain ? 0 : ((opts as MarkdownLaunchOptions).markdownWindows ?? 1)
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
      ...(opts.args ?? [])
    ],
    { cwd: opts.cwd ?? DESKTOP_ROOT, env: instanceEnv(home), stdio: ['ignore', 'pipe', 'pipe'] }
  )
  track(child)
  let output = ''
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()))
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()))
  let exited = false
  child.on('exit', () => (exited = true))

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
      .filter((t) => isMarkdownWindowPage(t, APP_URL))
      .flatMap((t) => {
        const md = markdownWindowOf(t)
        return md ? [{ ...md, url: t.url, webSocketDebuggerUrl: t.webSocketDebuggerUrl }] : []
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
    for (;;) {
      if (exited) throw fail('instance exited during startup')
      seen = await listTargets(port).catch(() => [])
      if (expectMain) {
        target = seen.find((t) => isMainPage(t, APP_URL))
        if (target) break
      } else if (seen.filter((t) => isMarkdownWindowPage(t, APP_URL)).length >= expectMarkdown) {
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
              ? `\n--- page targets on that port (ours start with ${APP_URL}) ---\n${foreign.join('\n')}`
              : '')
        )
      }
      await sleep(200)
    }

    let main: CdpClient | null = null
    if (target) {
      main = await connect(target.webSocketDebuggerUrl)
      await until(() => main!.eval<boolean>('!!window.api'), 'window.api ready')
      await installForensics(main)
    } else {
      installTargetForensics(port)
    }

    const stop = async (stopOpts: { keepHome?: boolean } = {}): Promise<void> => {
      setTimeoutDiagnostic(null)
      main?.close()
      if (!exited) {
        child.kill('SIGTERM')
        if (!(await waitExit(5000))) {
          child.kill('SIGKILL')
          // 等它真的死透再往下走：端口与 userdata 的释放都跟着进程退出，
          // 抢跑会把「上一实例还没死」变成下一个 spec 文件的谜之失败
          await waitExit(5000)
        }
      }
      if (!stopOpts.keepHome) rmSync(home, { recursive: true, force: true })
    }

    const base: E2EAppBase = {
      port,
      home,
      agentsDir,
      botsDir,
      hooksDir,
      userData,
      mainLog,
      output: () => output,
      async browserWindow() {
        const bt = (await listTargets(port)).find((t) => isBrowserWindowPage(t, APP_URL))
        return bt ? connect(bt.webSocketDebuggerUrl) : null
      },
      markdownWindows,
      async connectMarkdownWindow(pathSubstr) {
        const hit = (await markdownWindows()).find((w) => w.path.includes(pathSubstr))
        return hit ? connectReady(hit.webSocketDebuggerUrl) : null
      },
      async mainWindow() {
        const mt = (await listTargets(port).catch(() => [] as CdpTarget[])).find((t) =>
          isMainPage(t, APP_URL)
        )
        return mt ? connectReady(mt.webSocketDebuggerUrl) : null
      },
      stop
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
              (t) => t.url.startsWith(APP_URL) && t.url.includes('#settings')
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

/** 第二个实例的结局 */
export interface SecondInstanceResult {
  /** 退出码（被信号杀掉时为 null） */
  code: number | null
  signal: NodeJS.Signals | null
  /** stdout + stderr */
  output: string
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
  opts: { args?: string[]; cwd?: string; timeoutMs?: number } = {}
): Promise<SecondInstanceResult> {
  const child = spawn(
    electronBinary(),
    [join(DESKTOP_ROOT, 'e2e/harness/bootstrap.cjs'), ...(opts.args ?? [])],
    { cwd: opts.cwd ?? DESKTOP_ROOT, env: instanceEnv(app.home), stdio: ['ignore', 'pipe', 'pipe'] }
  )
  track(child)
  let output = ''
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()))
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
      resolveResult({ code, signal, output })
    })
  })
}
