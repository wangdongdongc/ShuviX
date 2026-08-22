/**
 * 隔离实例生命周期 —— e2e 的唯一启动入口。
 *
 * 隔离设计（不干扰用户自己正在运行的 ShuviX）：
 *   - fake HOME（os.tmpdir 下一次性目录）→ ~/.shuvix/*（agents/skills/policies）全部隔离；
 *   - SHUVIX_VERIFY_USERDATA → userData（SQLite/JSONL 会话树）隔离（bootstrap.cjs 重定向）；
 *   - 独立 CDP 端口（默认 9223，可用 SHUVIX_E2E_PORT 覆盖）；启动前探测端口占用即报错。
 *
 * 前置条件：`electron-vite build` 产物已存在（test:e2e 脚本会先构建）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, isMainPage, listTargets, until, type CdpClient } from './cdp'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export interface E2EApp {
  port: number
  /** fake HOME（种子文件基于它，如 `${home}/.shuvix/agents`） */
  home: string
  /** ~/.shuvix/agents（惰性创建） */
  agentsDir: string
  /** 主窗口页面的 CDP 客户端（window.api 已就绪） */
  main: CdpClient
  /** 打开设置窗口并连接其页面（tab 缺省 'agents'） */
  openSettings(tab?: string): Promise<CdpClient>
  /** 结束实例并清理 fake HOME（afterAll 必须调用） */
  stop(): Promise<void>
}

export async function launchApp(): Promise<E2EApp> {
  const port = Number(process.env.SHUVIX_E2E_PORT || 9223)

  // 端口占用探测：残留实例/用户调试实例都会让后续目标发现连到错误的 app
  const occupied = await listTargets(port).then(
    () => true,
    () => false
  )
  if (occupied) {
    throw new Error(
      `CDP port ${port} already in use — another ShuviX debug instance? ` +
        `Kill it or set SHUVIX_E2E_PORT to a free port.`
    )
  }

  // fake HOME 用短路径优先：cliServer 的 unix socket（$HOME/.shuvix/cli.sock）受
  // macOS ~104 字节路径上限约束，os.tmpdir 的 /var/folders/... 可能超长
  const tmpBase = existsSync('/private/tmp') ? '/private/tmp' : tmpdir()
  const home = mkdtempSync(join(tmpBase, 'shuvix-e2e-'))
  const userData = join(home, 'userdata')
  mkdirSync(userData, { recursive: true })
  const agentsDir = join(home, '.shuvix', 'agents')

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHUVIX_VERIFY_USERDATA: userData }
  // 该变量会让 electron 二进制退化为纯 node（不起窗口）—— 必须剔除
  delete env.ELECTRON_RUN_AS_NODE

  const electronBin = resolve(DESKTOP_ROOT, '../../node_modules/.bin/electron')
  const child: ChildProcess = spawn(
    electronBin,
    [join(DESKTOP_ROOT, 'e2e/harness/bootstrap.cjs'), `--remote-debugging-port=${port}`],
    { cwd: DESKTOP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()))
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()))
  let exited = false
  child.on('exit', () => (exited = true))

  const fail = (why: string): Error =>
    new Error(`${why}\n--- instance output (tail) ---\n${output.slice(-2000)}`)

  try {
    await until(
      async () => {
        if (exited) throw fail('instance exited during startup')
        return (await listTargets(port).catch(() => [])).some(isMainPage)
      },
      'CDP main page target',
      60_000
    )
    const target = (await listTargets(port)).find(isMainPage)!
    const main = await connect(target.webSocketDebuggerUrl)
    await until(() => main.eval<boolean>('!!window.api'), 'window.api ready')

    const stop = async (): Promise<void> => {
      main.close()
      if (!exited) {
        child.kill('SIGTERM')
        const t0 = Date.now()
        while (!exited && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100))
        if (!exited) child.kill('SIGKILL')
      }
      rmSync(home, { recursive: true, force: true })
    }

    return {
      port,
      home,
      agentsDir,
      main,
      async openSettings(tab = 'agents') {
        await main.eval(`window.api.app.openSettings(${JSON.stringify(tab)})`)
        const st = await until(
          async () => (await listTargets(port)).find((t) => t.url.includes('#settings')),
          'settings window target'
        )
        return connect(st.webSocketDebuggerUrl)
      },
      stop
    }
  } catch (err) {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
    throw err
  }
}
