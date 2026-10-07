/**
 * 启动时间线里 JS 之前与 JS 早期的几段：操作系统建进程 → Node 时间原点 → 主入口第一行 JS（外部依赖
 * require 之前）→ 应用自己的模块开始求值（外部依赖都 require 完）→ ready。
 *
 * 「第一行 JS」由构建注入：electron.vite.config.ts 给 main 入口 chunk 加了 rollup `intro`，
 * 在所有被提升的 require 之前写下 `globalThis.__SHUVIX_MAIN_T0__ = performance.now()`。
 */
import { app } from 'electron'
import { createLogger } from '../../logger'

const log = createLogger('Perf')

/** 构建注入的全局（见文件头）；单测 / 未注入时不存在 */
const MAIN_T0_GLOBAL = '__SHUVIX_MAIN_T0__'

let appModulesStartMs: number | null = null

/** 应用自己的第一个模块（boot）开始求值的时刻 —— 由 boot 调用 */
export function recordAppModulesStart(): void {
  appModulesStartMs ??= performance.now()
}

export interface LaunchTiming {
  /** 操作系统创建主进程的时刻（epoch ms；app.getAppMetrics 的 Browser 进程 creationTime） */
  processCreatedAt?: number
  /** Node 的 performance.timeOrigin（epoch ms） */
  timeOrigin: number
  /** 以下都是距 timeOrigin 的毫秒数 */
  firstJsMs?: number
  appModulesMs?: number
  readyMs: number
}

export function formatLaunchTiming(t: LaunchTiming): string {
  const ms = (n: number): string => `${n.toFixed(0)}ms`
  const parts: string[] = []
  parts.push(
    t.processCreatedAt !== undefined
      ? `process created ${ms(t.timeOrigin - t.processCreatedAt)} before Node time origin`
      : 'process creation time unknown'
  )
  parts.push(t.firstJsMs !== undefined ? `first JS +${ms(t.firstJsMs)}` : 'first JS ?')
  parts.push(
    t.appModulesMs !== undefined ? `app modules start +${ms(t.appModulesMs)}` : 'app modules ?'
  )
  parts.push(`ready +${ms(t.readyMs)}`)
  return `launch timing: ${parts.join(' → ')}`
}

/** ready 时调用一次：把 JS 之前的那段也记下来（排除 macOS 启动 / Gatekeeper / dyld 之类的 JS 前延迟） */
export function logLaunchTiming(): void {
  try {
    let processCreatedAt: number | undefined
    try {
      const browser = app.getAppMetrics().find((m) => m.type === 'Browser')
      if (browser && Number.isFinite(browser.creationTime)) processCreatedAt = browser.creationTime
    } catch {
      // 拿不到就不写这一段
    }
    const t0 = (globalThis as Record<string, unknown>)[MAIN_T0_GLOBAL]
    log.info(
      formatLaunchTiming({
        processCreatedAt,
        timeOrigin: performance.timeOrigin,
        firstJsMs: typeof t0 === 'number' ? t0 : undefined,
        appModulesMs: appModulesStartMs ?? undefined,
        readyMs: performance.now()
      })
    )
  } catch {
    // 诊断不能影响启动
  }
}
