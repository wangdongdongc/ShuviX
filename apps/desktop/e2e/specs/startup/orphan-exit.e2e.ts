/**
 * 隔离实例不能活过 harness —— harness/instanceGuards.cjs + bootstrap.cjs 的三道闸。
 *
 * 事故（2026-10-09）：几个实例活过了启动它们的 vitest 进程，管道那头没人了，console 写出的 EPIPE
 * 变成未捕获异常、记录它又写 stderr 又是 EPIPE……每个实例往 `e2e-uncaught.log` 写了 ~25 GB。
 *
 *  - O-1 launcher 被 SIGKILL（与 vitest 被掐断一样：launch.ts 的 'exit' 兜底来不及跑）→ 实例连同
 *    GPU / 渲染子进程在几秒内自己走掉，`e2e-uncaught.log` 里没有 EPIPE。launcher 是一个中间 node 进程，
 *    按 launchApp 的方式 spawn 实例（同一份 `instanceEnv`，只把 launcher pid 换成它自己的）。
 *  - O-2 launcher 还活着、只是关掉了自己那头的 stdout / stderr → 实例在下一次写控制台时发现并退出
 *    （这条与看门狗无关：launcher 一直在）。
 *  - O-3 追加器封顶：到上限写一行截断标记，之后不再增长；复用一个已满的文件也不再写。
 *  - O-4 launchApp 给实例的环境里带着本进程的 pid。
 *
 * 注意事项：
 *  - 实例不经 launchApp 起（launchApp 不交出子进程，也没法让它的 launcher 去死）；它们自己的 HOME /
 *    子进程在 afterAll 里一律收走，失败也不留孤儿。
 *  - 子进程按命令行里含 HOME 路径来认（Chromium 的 helper 带 `--user-data-dir=<userData>` 之类）。
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { connect, isMainPage, listTargets, sleep, until } from '../../harness/cdp'
import { freePort, instanceEnv, LAUNCHER_PID_ENV } from '../../harness/launch'

const req = createRequire(import.meta.url)
const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const BOOTSTRAP = join(DESKTOP_ROOT, 'e2e/harness/bootstrap.cjs')
const ELECTRON = req('electron') as string
const guards = req('../../harness/instanceGuards.cjs') as {
  TRUNCATED_MARKER: string
  LAUNCHER_PID_ENV: string
  createBoundedAppender: (limitBytes?: number) => (file: string, text: string) => boolean
}

const STARTUP_TIMEOUT = 90_000
/** 看门狗 2 秒一轮 + 退出最多 5 秒自杀；给足余量 */
const EXIT_WITHIN_MS = 20_000
/** 正常的 e2e-uncaught.log 至多几 KB；事故里是 GB 级 */
const SMALL_LOG_BYTES = 64 * 1024

const homes: string[] = []
const pids = new Set<number>()

function newHome(): string {
  const home = mkdtempSync('/private/tmp/shuvix-e2e-')
  mkdirSync(join(home, 'userdata'), { recursive: true })
  homes.push(home)
  return home
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 命令行里含 `needle` 的进程（实例的 helper 都带着 HOME 下的路径） */
function processesMentioning(needle: string): Array<{ pid: number; command: string }> {
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m && m[2].includes(needle))
    .map((m) => ({ pid: Number(m[1]), command: m[2] }))
    .filter((p) => p.pid !== process.pid)
}

function readIfExists(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** 等端口上出现实例的主窗口页面：实例已完整起来（窗口、GPU / 渲染子进程都在） */
async function waitMainPage(port: number, what: string, isDead: () => boolean): Promise<void> {
  await until(
    async () => {
      if (isDead()) throw new Error(`${what}: instance died during startup`)
      return (await listTargets(port).catch(() => [])).some((t) => isMainPage(t))
    },
    `${what}: main page target`,
    STARTUP_TIMEOUT
  )
}

/** 实例与它的所有 helper 都走了 */
async function waitAllGone(pid: number, home: string, what: string): Promise<void> {
  await until(() => !alive(pid), `${what}: main process ${pid} exits`, EXIT_WITHIN_MS)
  await until(
    () => processesMentioning(home).length === 0,
    `${what}: no helper process left`,
    EXIT_WITHIN_MS
  )
}

/** launchApp 同款的命令行（缺了 launch.ts 里的取证用开关不影响这里要看的东西） */
function instanceArgs(port: number): string[] {
  return [
    BOOTSTRAP,
    `--remote-debugging-port=${port}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ]
}

/**
 * 中间 launcher：一个 node 进程，按收到的命令行与环境 spawn 实例（launcher pid 换成它自己的），
 * 把实例 pid 打一行到 stdout，然后挂着、读掉实例的输出 —— 直到被杀。
 */
const LAUNCHER_SRC = `
const { spawn } = require('child_process')
const spec = JSON.parse(process.env.ORPHAN_SPEC)
const env = { ...spec.env, [spec.pidEnv]: String(process.pid) }
const child = spawn(spec.bin, spec.args, { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})
process.stdout.write(String(child.pid) + '\\n')
setInterval(() => {}, 60000)
`

afterAll(async () => {
  for (const home of homes) {
    for (const p of processesMentioning(home)) pids.add(p.pid)
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
  await sleep(500)
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

describe('isolated instances do not outlive the harness', () => {
  it(
    'O-1: the launcher is SIGKILLed → the instance and its helpers exit on their own, no EPIPE flood',
    async () => {
      const home = newHome()
      const userData = join(home, 'userdata')
      const port = await freePort()
      const launcher: ChildProcess = spawn(process.execPath, ['-e', LAUNCHER_SRC], {
        cwd: DESKTOP_ROOT,
        env: {
          ...process.env,
          ORPHAN_SPEC: JSON.stringify({
            bin: ELECTRON,
            args: instanceArgs(port),
            cwd: DESKTOP_ROOT,
            env: instanceEnv(home),
            pidEnv: guards.LAUNCHER_PID_ENV
          })
        },
        stdio: ['ignore', 'pipe', 'inherit']
      })
      pids.add(launcher.pid!)
      let launcherDead = false
      launcher.on('exit', () => (launcherDead = true))
      let firstLine = ''
      launcher.stdout!.on('data', (c: Buffer) => (firstLine += c.toString()))
      const pid = await until(
        () => {
          if (launcherDead) throw new Error('launcher exited early')
          const m = /^(\d+)\n/.exec(firstLine)
          return m ? Number(m[1]) : null
        },
        'instance pid from the launcher',
        10_000
      )
      pids.add(pid)
      await waitMainPage(port, 'O-1', () => !alive(pid))
      expect(processesMentioning(home).length, 'helpers carry the HOME path').toBeGreaterThan(0)

      launcher.kill('SIGKILL')
      await until(() => launcherDead, 'launcher dies', 5_000)
      await waitAllGone(pid, home, 'O-1')

      expect(readIfExists(join(userData, 'e2e-harness-gone.log'))).toMatch(
        /launcher process \d+ is gone|parent process changed|pipe closed/
      )
      const uncaught = readIfExists(join(userData, 'e2e-uncaught.log'))
      expect(uncaught).not.toMatch(/EPIPE|ERR_STREAM_DESTROYED/)
      expect(Buffer.byteLength(uncaught)).toBeLessThan(SMALL_LOG_BYTES)
    },
    STARTUP_TIMEOUT + 3 * EXIT_WITHIN_MS
  )

  it(
    'O-2: the launcher lives on but closes its end of stdout / stderr → the instance exits at its next console write',
    async () => {
      const home = newHome()
      const userData = join(home, 'userdata')
      const port = await freePort()
      const child = spawn(ELECTRON, instanceArgs(port), {
        cwd: DESKTOP_ROOT,
        env: instanceEnv(home),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      pids.add(child.pid!)
      let exited = false
      child.on('exit', () => (exited = true))
      child.stdout!.on('data', () => {})
      child.stderr!.on('data', () => {})
      await waitMainPage(port, 'O-2', () => exited)

      // 本进程（launcher）还在 —— 看门狗不会动；只把管道这头关掉
      child.stdout!.destroy()
      child.stderr!.destroy()
      // 让主进程写点控制台：开设置窗口一路有日志（主进程 console transport → 已断的管道）
      const page = (await listTargets(port)).find((t) => isMainPage(t))!
      const main = await connect(page.webSocketDebuggerUrl)
      try {
        await main.eval(`window.api.app.openSettings('general')`).catch(() => undefined)
      } finally {
        main.close()
      }

      await until(() => exited, 'O-2: instance exits', EXIT_WITHIN_MS)
      await until(
        () => processesMentioning(home).length === 0,
        'O-2: no helper process left',
        EXIT_WITHIN_MS
      )
      expect(readIfExists(join(userData, 'e2e-harness-gone.log'))).toMatch(/pipe closed/)
      const uncaught = readIfExists(join(userData, 'e2e-uncaught.log'))
      expect(uncaught).not.toMatch(/EPIPE|ERR_STREAM_DESTROYED/)
      expect(Buffer.byteLength(uncaught)).toBeLessThan(SMALL_LOG_BYTES)
    },
    STARTUP_TIMEOUT + 2 * EXIT_WITHIN_MS
  )

  it('O-3: every appended log is capped — one truncation marker, then no growth', () => {
    const dir = newHome()
    const file = join(dir, 'capped.log')
    const append = guards.createBoundedAppender(1000)
    const line = `${'x'.repeat(99)}\n`
    const written = Array.from({ length: 50 }, () => append(file, line))
    expect(written.filter(Boolean)).toHaveLength(10)
    expect(written.slice(10).every((w) => !w)).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text.split(guards.TRUNCATED_MARKER)).toHaveLength(2)
    expect(text.endsWith(`${guards.TRUNCATED_MARKER}\n`)).toBe(true)
    const capped = statSync(file).size
    expect(capped).toBeLessThanOrEqual(1000 + guards.TRUNCATED_MARKER.length + 1)

    // 一个新的追加器（复用的 HOME）遇到已满的文件：不追加，也不重复写标记
    expect(guards.createBoundedAppender(1000)(file, line)).toBe(false)
    expect(statSync(file).size).toBe(capped)

    // 没满的旧文件按现有大小起算
    const partial = join(dir, 'partial.log')
    writeFileSync(partial, 'y'.repeat(950))
    const again = guards.createBoundedAppender(1000)
    expect(again(partial, 'z'.repeat(40))).toBe(true)
    expect(again(partial, 'z'.repeat(40))).toBe(false)
    expect(readFileSync(partial, 'utf8').endsWith(`${guards.TRUNCATED_MARKER}\n`)).toBe(true)
  })

  it('O-4: launchApp hands the instance this process as its launcher', () => {
    expect(LAUNCHER_PID_ENV).toBe(guards.LAUNCHER_PID_ENV)
    expect(instanceEnv('/private/tmp/x')[LAUNCHER_PID_ENV]).toBe(String(process.pid))
    // spec 追加的环境盖不掉它
    expect(instanceEnv('/private/tmp/x', { [LAUNCHER_PID_ENV]: '1' })[LAUNCHER_PID_ENV]).toBe(
      String(process.pid)
    )
  })
})
