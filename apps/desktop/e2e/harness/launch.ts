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

export interface E2EApp {
  port: number
  /** fake HOME（种子文件基于它，如 `${home}/.shuvix/agents`） */
  home: string
  /** ~/.shuvix/agents（惰性创建） */
  agentsDir: string
  /** ~/.shuvix/bots（惰性创建） */
  botsDir: string
  /** ~/.shuvix/hooks（惰性创建） */
  hooksDir: string
  /** 主窗口页面的 CDP 客户端（window.api 已就绪） */
  main: CdpClient
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
  /** 打开设置窗口并连接其页面（tab 缺省 'hooks' —— 智能体 / 技能 / 安全策略三个 tab 已搬去侧栏） */
  openSettings(tab?: string): Promise<CdpClient>
  /** 结束实例并清理 fake HOME（afterAll 必须调用） */
  stop(): Promise<void>
}

/**
 * 借一个空闲回环端口：listen(0) 拿到号后立刻归还。
 * 归还到 Electron 真正 bind 之间有个极小窗口，真被别人抢走也不会静默驱动错实例
 * —— 那种情况下本实例没监听，目标发现会一直找不到「自己的」target 并超时报错。
 */
function freePort(): Promise<number> {
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

export async function launchApp(): Promise<E2EApp> {
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
  const home = mkdtempSync(join(tmpBase, 'shuvix-e2e-'))
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

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHUVIX_VERIFY_USERDATA: userData }
  // 该变量会让 electron 二进制退化为纯 node（不起窗口）—— 必须剔除
  delete env.ELECTRON_RUN_AS_NODE

  // 工作区依赖装在检出根；**git worktree 里那一层没有 node_modules**（npm 只在主检出装过），
  // 于是退回 Node 自己的解析 —— electron 包的入口导出的就是二进制的绝对路径。
  const localBin = resolve(DESKTOP_ROOT, '../../node_modules/.bin/electron')
  const electronBin = existsSync(localBin)
    ? localBin
    : (createRequire(import.meta.url)('electron') as string)
  const child: ChildProcess = spawn(
    electronBin,
    [
      join(DESKTOP_ROOT, 'e2e/harness/bootstrap.cjs'),
      `--remote-debugging-port=${port}`,
      // 被别的窗口盖住时 Chromium 会把页面判成不可见并**停掉 requestAnimationFrame**，
      // 而 chat-ui 的流式 delta 合并正挂在 rAF 上（useAgentEvents 的 scheduleFlush）——
      // 于是对话一行都不渲染，所有等 DOM 的 until 一起超时（现场：visible=false + msg rows (0)，
      // 而轮询 63 次、每次几毫秒，渲染进程其实活得好好的）。
      // 这两个开关让实例不理会遮挡与后台化，e2e 结果于是与「屏幕上还有什么窗口」无关。
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ],
    { cwd: DESKTOP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
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

  try {
    // 目标发现自己轮询（不走 until）：until 把 fn 抛的错一律当「未就绪」，
    // 实例启动即崩时会白等满 60s 才报一个与真因无关的超时
    const deadline = Date.now() + 60_000
    let seen: CdpTarget[] = []
    let target: CdpTarget | undefined
    for (;;) {
      if (exited) throw fail('instance exited during startup')
      seen = await listTargets(port).catch(() => [])
      target = seen.find((t) => isMainPage(t, APP_URL))
      if (target) break
      if (Date.now() > deadline) {
        const foreign = seen.filter((t) => t.type === 'page').map((t) => t.url)
        throw fail(
          `timeout waiting: CDP main page target on port ${port}` +
            (foreign.length
              ? `\n--- targets on that port, none of them ours (ours start with ${APP_URL}) ---\n${foreign.join('\n')}`
              : '')
        )
      }
      await sleep(200)
    }
    const main = await connect(target.webSocketDebuggerUrl)
    await until(() => main.eval<boolean>('!!window.api'), 'window.api ready')
    await installForensics(main)

    const stop = async (): Promise<void> => {
      setTimeoutDiagnostic(null)
      main.close()
      if (!exited) {
        child.kill('SIGTERM')
        if (!(await waitExit(5000))) {
          child.kill('SIGKILL')
          // 等它真的死透再往下走：端口与 userdata 的释放都跟着进程退出，
          // 抢跑会把「上一实例还没死」变成下一个 spec 文件的谜之失败
          await waitExit(5000)
        }
      }
      rmSync(home, { recursive: true, force: true })
    }

    return {
      port,
      home,
      agentsDir,
      botsDir,
      hooksDir,
      main,
      mainLog,
      async openSettings(tab = 'hooks') {
        await main.eval(`window.api.app.openSettings(${JSON.stringify(tab)})`)
        const st = await until(
          async () =>
            (await listTargets(port)).find(
              (t) => t.url.startsWith(APP_URL) && t.url.includes('#settings')
            ),
          'settings window target'
        )
        return connect(st.webSocketDebuggerUrl)
      },
      stop
    }
  } catch (err) {
    child.kill('SIGKILL')
    await waitExit(5000)
    rmSync(home, { recursive: true, force: true })
    throw err
  }
}
