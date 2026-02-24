/**
 * 轻量启动性能埋点工具
 * 用法：
 *   mark('app ready')                          — 记录里程碑（距进程启动的绝对时间）
 *   measure('initTables', () => fn())           — 包裹同步调用，输出耗时
 *   await measureAsync('mcp', () => asyncFn())  — 包裹异步调用，输出耗时
 */
import { createLogger } from './logger'

const log = createLogger('Perf')
const t0 = performance.now()

/** 记录里程碑（距进程启动的绝对偏移） */
export function mark(label: string): void {
  log.info(`${label} — +${(performance.now() - t0).toFixed(0)}ms since launch`)
}

/** 测量同步代码块耗时 */
export function measure<T>(label: string, fn: () => T): T {
  const start = performance.now()
  const result = fn()
  log.info(`${label} — ${(performance.now() - start).toFixed(0)}ms`)
  return result
}

/** 测量异步代码块耗时 */
export async function measureAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  const result = await fn()
  log.info(`${label} — ${(performance.now() - start).toFixed(0)}ms`)
  return result
}
