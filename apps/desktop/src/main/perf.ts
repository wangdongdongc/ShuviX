/**
 * 轻量启动性能埋点工具
 * 用法：
 *   mark('app ready')                          — 记录里程碑（距进程启动的绝对时间），总是记日志
 *   measure('initTables', () => fn())           — 包裹同步调用，总是记耗时
 *   await measureAsync('mcp', () => asyncFn())  — 包裹异步调用，总是记耗时
 *   step('createWindow › bounds', () => fn())   — 细粒度同步步骤：只在慢（≥ SLOW_STEP_MS）时记日志
 *
 * 「since launch」的原点是进程的 `performance.timeOrigin`（Node 环境起来的那一刻），不是本模块被
 * 求值的时刻 —— 主入口在本模块之前还要 require 一长串外部依赖、求值一批模块，那段时间也得看得见。
 *
 * 每个 mark / 步骤的进出都会报给 `onPerfStep` 的订阅者（卡顿看门狗）：主线程一旦被同步卡住，
 * 看门狗从另一个线程读到的「最后一步」就是卡住的位置。
 */
import { createLogger } from './logger'

const log = createLogger('Perf')

/** 细粒度步骤超过这个耗时才记日志（正常启动时它们一行都不出） */
export const SLOW_STEP_MS = 200

/** 步骤相位：in = 正在这一步里；after = 这一步（或这个里程碑）刚过，下一步还没开始 */
export type PerfStepPhase = 'in' | 'after'
export type PerfStepListener = (label: string, phase: PerfStepPhase) => void

let stepListener: PerfStepListener | null = null

/** 订阅「主线程此刻走到哪一步」（只有一个订阅者：卡顿看门狗）；传 null 退订 */
export function onPerfStep(listener: PerfStepListener | null): void {
  stepListener = listener
}

function report(label: string, phase: PerfStepPhase): void {
  if (!stepListener) return
  try {
    stepListener(label, phase)
  } catch {
    // 诊断设施永远不能让业务代码失败
  }
}

/** 距进程时间原点的毫秒数 */
export function sinceLaunchMs(): number {
  return performance.now()
}

/** 记录里程碑（距进程启动的绝对偏移） */
export function mark(label: string): void {
  report(label, 'after')
  log.info(`${label} — +${sinceLaunchMs().toFixed(0)}ms since launch`)
}

/** 测量同步代码块耗时 */
export function measure<T>(label: string, fn: () => T): T {
  report(label, 'in')
  const start = performance.now()
  try {
    return fn()
  } finally {
    log.info(`${label} — ${(performance.now() - start).toFixed(0)}ms`)
    report(label, 'after')
  }
}

/** 测量异步代码块耗时 */
export async function measureAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  report(label, 'in')
  const start = performance.now()
  try {
    return await fn()
  } finally {
    log.info(`${label} — ${(performance.now() - start).toFixed(0)}ms`)
    report(label, 'after')
  }
}

/**
 * 细粒度同步步骤：进出都报给看门狗（卡住时知道卡在哪一步），日志只在慢时才写 ——
 * 正常启动一行不出，某一步被环境卡住时那一行就是答案。
 */
export function step<T>(label: string, fn: () => T): T {
  report(label, 'in')
  const start = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - start
    if (ms >= SLOW_STEP_MS) {
      log.warn(`slow step: ${label} — ${ms.toFixed(0)}ms (at +${sinceLaunchMs().toFixed(0)}ms)`)
    }
    report(label, 'after')
  }
}
