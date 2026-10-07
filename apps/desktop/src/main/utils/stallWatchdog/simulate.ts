/**
 * e2e 专用：在启动路径上制造一次同步卡顿，验证看门狗能抓到、并指对位置。
 *
 * 只认环境变量 SHUVIX_E2E_SIMULATE_STALL=<where>:<ms>[:native]（如 `createWindow:3000`）：
 *  - where：preReady（主入口求值完、等 ready 时）或 createWindow（建主窗口之前）
 *  - 缺省是 JS 死循环（卡在 JS 里，抓栈应停在这个函数里）；
 *    `native` 是同步子进程 sleep（卡在原生调用里，抓栈应停在调用返回后的第一条语句）
 * 没设这个变量时什么都不做。
 */
import { spawnSync } from 'node:child_process'
import { step } from '../../perf'

export type StallSite = 'preReady' | 'createWindow'

export interface StallSpec {
  where: StallSite
  ms: number
  native: boolean
}

export function parseStallSpec(spec: string | undefined): StallSpec | null {
  if (!spec) return null
  const parts = spec.split(':')
  if (parts.length > 3) return null
  const [where, msText, kind] = parts
  if (where !== 'preReady' && where !== 'createWindow') return null
  const ms = Number(msText)
  if (!Number.isFinite(ms) || ms <= 0 || ms > 60_000) return null
  if (kind !== undefined && kind !== 'native') return null
  return { where, ms, native: kind === 'native' }
}

function busyWait(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // 故意空转
  }
}

export function simulateStartupStall(where: StallSite): void {
  const spec = parseStallSpec(process.env.SHUVIX_E2E_SIMULATE_STALL)
  if (!spec || spec.where !== where) return
  step(`simulated stall (${spec.native ? 'native' : 'busy'} ${spec.ms}ms)`, () => {
    if (spec.native) spawnSync('/bin/sleep', [String(spec.ms / 1000)])
    else busyWait(spec.ms)
  })
}
