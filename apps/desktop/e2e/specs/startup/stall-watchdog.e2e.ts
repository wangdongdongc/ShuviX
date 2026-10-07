/**
 * 主线程卡顿看门狗 —— 在真实例的启动路径上制造一次卡顿（SHUVIX_E2E_SIMULATE_STALL），
 * 看日志里那一行是否抓到、时长是否对、栈是否指向卡点。
 *
 * 注意事项：
 *  - 只按标签（`in "simulated stall (…)"`）找那一行，**从不**断言卡顿次数、序号或「没有别的卡顿」——
 *    机器上每次启动都可能有与本 spec 无关的卡顿（如 VM 上 `new BrowserWindow` 里约 15s 的那一次）。
 *  - 卡顿报告在主线程**恢复之后**才写；紧接着的无关卡顿会把它再推迟十几秒，所以等待上限给足。
 *  - 环境变量在 spawn 时被复制进实例：stubEnv → launchApp → 立刻 unstub。
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'

const LAUNCH_TIMEOUT = 120_000
const REPORT_WAIT = 40_000

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 一次卡顿的那一行：1 = 序号，2 = 时长（秒），3 / 4 = 起止（距启动 ms），5 = 栈 */
const STALL_RE = (label: string): RegExp =>
  new RegExp(
    `stall #(\\d+): main thread blocked (\\d+\\.\\d)s \\(\\+(\\d+)ms → \\+(\\d+)ms since launch\\), ` +
      `in "${escapeRe(label)}"; JS stack where it resumed: (.*)`
  )

interface StallLine {
  seq: number
  durationS: number
  fromMs: number
  toMs: number
  stack: string
}

async function waitStall(app: E2EApp, label: string): Promise<StallLine> {
  const m = await until(
    () => STALL_RE(label).exec(app.mainLog()),
    `stall line for ${label}`,
    REPORT_WAIT
  )
  return {
    seq: Number(m[1]),
    durationS: Number(m[2]),
    fromMs: Number(m[3]),
    toMs: Number(m[4]),
    stack: m[5]
  }
}

async function launchWithStall(spec: string): Promise<E2EApp> {
  vi.stubEnv('SHUVIX_E2E_SIMULATE_STALL', spec)
  vi.stubEnv('SHUVIX_STALL_WATCHDOG', '1')
  try {
    return await launchApp()
  } finally {
    vi.unstubAllEnvs()
  }
}

const LAUNCH_TIMING_RE =
  /launch timing: process created -?\d+ms before Node time origin → first JS \+(\d+)ms → app modules start \+(\d+)ms → ready \+(\d+)ms/

/** 看门狗正常工作、启动时间线完整、应用照常应答 */
async function expectHealthy(app: E2EApp): Promise<void> {
  const log = app.mainLog()
  expect(log).not.toMatch(/stall watchdog (off|not started)|renamed by the bundler/)

  const timing = LAUNCH_TIMING_RE.exec(log)
  expect(timing, 'launch timing line').not.toBeNull()
  const [firstJs, appModules, ready] = timing!.slice(1).map(Number)
  expect(firstJs).toBeLessThanOrEqual(appModules)
  expect(appModules).toBeLessThanOrEqual(ready)

  const modulesAt = log.indexOf('main: app modules start')
  const evaluatedAt = log.indexOf('main: entry evaluated, waiting for ready')
  expect(modulesAt).toBeGreaterThanOrEqual(0)
  expect(evaluatedAt).toBeGreaterThan(modulesAt)

  expect(await app.main.eval<boolean>('window.api.session.list().then(() => true)')).toBe(true)
}

describe('busy stall in createWindow', () => {
  const LABEL = 'simulated stall (busy 3000ms)'
  let app: E2EApp
  beforeAll(async () => {
    app = await launchWithStall('createWindow:3000')
  }, LAUNCH_TIMEOUT)
  afterAll(async () => {
    await app?.stop()
  })

  it('reports the stall with its duration and a stack inside the busy loop', async () => {
    const stall = await waitStall(app, LABEL)
    expect(stall.durationS).toBeGreaterThanOrEqual(2.9)
    expect(stall.durationS).toBeLessThanOrEqual(6)
    expect(Math.abs((stall.toMs - stall.fromMs) / 1000 - stall.durationS)).toBeLessThanOrEqual(0.06)

    expect(stall.stack).toContain('busyWait (')
    expect(stall.stack).toContain('simulateStartupStall (')
    expect(stall.stack).toContain('createWindow (')
    expect(stall.stack.indexOf('simulateStartupStall (')).toBeLessThan(
      stall.stack.indexOf('createWindow (')
    )

    expect(app.mainLog()).toContain(`slow step: ${LABEL} — `)
  })

  it('the watchdog and the launch timeline are healthy and the app responds', async () => {
    await expectHealthy(app)
  })
})

describe('native stall in createWindow', () => {
  const LABEL = 'simulated stall (native 3000ms)'
  let app: E2EApp
  beforeAll(async () => {
    app = await launchWithStall('createWindow:3000:native')
  }, LAUNCH_TIMEOUT)
  afterAll(async () => {
    await app?.stop()
  })

  it('reports the stall with a stack pointing at the blocking call', async () => {
    const stall = await waitStall(app, LABEL)
    expect(stall.durationS).toBeGreaterThanOrEqual(2.9)
    expect(stall.durationS).toBeLessThanOrEqual(8)
    // 卡在原生调用里：停在调用返回后的第一条语句，顶帧不确定，但调用链要对
    expect(stall.stack).toContain('simulateStartupStall (')
    expect(stall.stack).toContain('createWindow (')
    expect(stall.stack.indexOf('simulateStartupStall (')).toBeLessThan(
      stall.stack.indexOf('createWindow (')
    )
    expect(stall.stack).not.toContain('busyWait')
  })

  it('the watchdog and the launch timeline are healthy and the app responds', async () => {
    await expectHealthy(app)
  })
})

describe('busy stall before ready', () => {
  const LABEL = 'simulated stall (busy 3000ms)'
  let app: E2EApp
  beforeAll(async () => {
    app = await launchWithStall('preReady:3000')
  }, LAUNCH_TIMEOUT)
  afterAll(async () => {
    await app?.stop()
  })

  it('reports the stall from the entry module, outside createWindow', async () => {
    const stall = await waitStall(app, LABEL)
    expect(stall.stack).toContain('simulateStartupStall (')
    expect(stall.stack).not.toContain('createWindow (')
  })

  it('the watchdog and the launch timeline are healthy and the app responds', async () => {
    await expectHealthy(app)
  })
})

describe.runIf(process.platform === 'darwin')('long native stall: native sample', () => {
  const LABEL = 'simulated stall (native 6000ms)'
  let app: E2EApp
  beforeAll(async () => {
    app = await launchWithStall('createWindow:6000:native')
  }, LAUNCH_TIMEOUT)
  afterAll(async () => {
    await app?.stop()
  })

  it('samples the blocked main thread and logs its heaviest path', async () => {
    const { seq } = await waitStall(app, LABEL)
    const sampleRe = new RegExp(
      `stall #${seq}: native sample of the blocked main thread ` +
        `\\(taken (\\d+\\.\\d)s into the stall; heaviest path, leaf last\\) → (\\S+)`
    )
    const m = await until(
      () => sampleRe.exec(app.mainLog()),
      `native sample of stall #${seq}`,
      REPORT_WAIT
    )
    const taken = Number(m[1])
    expect(taken).toBeGreaterThanOrEqual(4.0)
    expect(taken).toBeLessThanOrEqual(5.9)

    const file = m[2]
    expect(dirname(file)).toBe(join(app.home, 'Library', 'Logs', 'Electron'))
    expect(basename(file)).toMatch(/^stall-sample-\d{8}-\d{6}\.txt$/)
    expect(existsSync(file)).toBe(true)

    // 报告的后续几行原样落在日志里：线程头，然后是主线程的根帧
    const lines = app.mainLog().split('\n')
    const at = lines.findIndex((l) => sampleRe.test(l))
    expect(lines[at + 1]).toMatch(/^\d+ Thread_/)
    expect(lines[at + 2]).toContain('start (in dyld)')
  })
})
