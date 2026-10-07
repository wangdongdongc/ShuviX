/**
 * 看门狗 worker 的一拍（不碰线程、时钟与 inspector —— 全部注入，单测用假时钟驱动）。
 *
 * 每一拍：先 ping 主线程（主线程只是闲着、计时器被系统合并推迟时，ping 会把它叫醒、它立刻应答，
 * 不会被误判成卡住），再读共享内存里主线程最后一次动静的时刻交给判定器：
 *  - 卡顿开始：记下主线程此刻在哪一步，发出抓栈请求；
 *  - 卡顿持续到 afterMs：（macOS）开始一次原生采样；
 *  - 卡顿结束：连同步骤与栈一起报给主线程记日志。
 */
import { StallDetector } from './detector'
import type { MainThreadStackCapture } from './mainThreadStack'
import type { NativeSampleConfig, NativeSampleResult, StackCapture, WorkerToMain } from './protocol'

export interface WatchdogCoreDeps {
  thresholdMs: number
  suspendGapMs: number
  /** 当前时刻（与 readBeatAtMs 同一时钟，毫秒） */
  nowMs(): number
  /** 主线程最后一次动静的时刻 */
  readBeatAtMs(): number
  /** 主线程此刻所在步骤的编码 */
  readStepCode(): number
  post(msg: WorkerToMain): void
  /** null = 不抓栈 */
  stack: MainThreadStackCapture | null
  /** 不抓栈时报给主线程的原因 */
  stackOffReason?: string
  /** null = 不采样 */
  nativeSample: Pick<NativeSampleConfig, 'afterMs' | 'maxPerProcess'> | null
  runNativeSample?: () => Promise<NativeSampleResult>
}

export interface WatchdogCore {
  tick(): void
}

export function createWatchdogCore(deps: WatchdogCoreDeps): WatchdogCore {
  const detector = new StallDetector({
    thresholdMs: deps.thresholdMs,
    suspendGapMs: deps.suspendGapMs
  })
  let current: { seq: number; stepCode: number; sampled: boolean } | null = null
  let stalls = 0
  let samplesTaken = 0

  const takeStack = (): StackCapture =>
    deps.stack
      ? deps.stack.take()
      : { state: 'skipped', reason: deps.stackOffReason ?? 'stack capture is off' }

  return {
    tick(): void {
      deps.post({ type: 'ping' })
      const now = deps.nowMs()
      const event = detector.tick(now, deps.readBeatAtMs())

      if (event?.type === 'start') {
        current = { seq: ++stalls, stepCode: deps.readStepCode(), sampled: false }
        deps.stack?.request()
      } else if (event?.type === 'end') {
        const stall = current
        current = null
        deps.post({
          type: 'stall',
          seq: stall?.seq ?? ++stalls,
          lastBeatAtMs: event.lastBeatAtMs,
          resumedAtMs: event.resumedAtMs,
          durationMs: event.durationMs,
          stepCode: stall?.stepCode ?? 0,
          stack: takeStack()
        })
      }

      const sample = deps.nativeSample
      if (!current || current.sampled || !sample || !deps.runNativeSample) return
      if (samplesTaken >= sample.maxPerProcess) return
      const stalledFor = detector.stalledForMs(now)
      if (stalledFor === null || stalledFor < sample.afterMs) return
      current.sampled = true
      samplesTaken++
      const seq = current.seq
      deps
        .runNativeSample()
        .then((result) => deps.post({ type: 'sample', seq, durationSoFarMs: stalledFor, result }))
        .catch((err: unknown) =>
          deps.post({
            type: 'sample',
            seq,
            durationSoFarMs: stalledFor,
            result: { ok: false, error: err instanceof Error ? err.message : String(err) }
          })
        )
    }
  }
}
