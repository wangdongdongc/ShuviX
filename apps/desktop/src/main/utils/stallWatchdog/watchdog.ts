/**
 * 主线程卡顿看门狗（主进程侧）。
 *
 * 一个 worker 线程每 TICK_MS 看一眼主线程：主线程最后一次动静（应答 ping、进出 Perf 步骤）写在
 * SharedArrayBuffer 里，连续 THRESHOLD_MS 没动静就是卡住了。卡住时 worker 记下主线程停在哪一步、
 * 经 inspector 请求主线程的 JS 栈，卡得久（macOS）再用 /usr/bin/sample 抓一份原生栈；主线程恢复后
 * 报告回到这里写日志。正常运行时它一行日志都不写。
 *
 * 开销：主线程每秒处理两条 ping 消息、每个 Perf 步骤多一次原子写；worker 线程每秒醒两次。
 * 关掉它：环境变量 SHUVIX_STALL_WATCHDOG=0。
 */
import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import * as inspector from 'node:inspector'
import { app } from 'electron'
import log, { createLogger } from '../../logger'
import { onPerfStep } from '../../perf'
import {
  SLOT_BEAT_NS,
  SLOT_COUNT,
  SLOT_STEP,
  type MainToWorker,
  type NativeSampleConfig,
  type WatchdogWorkerData,
  type WorkerToMain
} from './protocol'
import {
  WATCHDOG_HANDLER_NAME,
  createStepTable,
  formatSampleReport,
  formatStallReport
} from './report'

const wlog = createLogger('StallWatchdog')

export const TICK_MS = 500
export const THRESHOLD_MS = 2000
/** worker 自己的一拍迟到这么多：整个进程停过（睡眠 / App Nap），不算主线程卡 */
const SUSPEND_GAP_MS = 1500
/** 卡顿持续多久后做原生采样（macOS） */
const SAMPLE_AFTER_MS = 4000
const SAMPLE_SECONDS = 3
/** 每个进程最多记多少次卡顿（之后只记一行「不再记录」） */
const MAX_REPORTS = 100
/** 主线程两次动静之间的空档超过它就记下来（报告卡顿时长用；比判定阈值低一个 tick，免得漏记） */
const GAP_RECORD_NS = BigInt((THRESHOLD_MS - TICK_MS) * 1_000_000)
/** 记住最近几道空档：报告要等主线程闲下来才处理，背靠背的两次卡顿时第一份报告到达前第二道空档已经记下了 */
const MAX_RECENT_GAPS = 8

let started = false

/** worker 产物的位置：打包后在 app.asar.unpacked（与 sqlWorker 同策），开发 / e2e 在 out/main 下 */
function workerPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'stallWatchdogWorker.js')
  }
  return join(__dirname, 'stallWatchdogWorker.js')
}

/** 主进程日志所在目录（原生采样文件放它旁边）；拿不到就不采样 */
function logsDir(): string | null {
  try {
    const file = log.transports.file.getFile().path
    if (file) return dirname(file)
  } catch {
    // 落到下面
  }
  try {
    return app.getPath('logs')
  } catch {
    return null
  }
}

/** 主进程是否连着外部 inspector（--inspect / 开发者调试）：此时抓栈会 resume 掉别人的断点 */
function externalInspectorAttached(): boolean {
  try {
    if (inspector.url()) return true
  } catch {
    // 没有 inspector
  }
  return process.execArgv.some((a) => a.startsWith('--inspect'))
}

/**
 * 启动看门狗（幂等）。必须尽早调用 —— 由 main 入口的第一条 import（./boot）在模块求值期调用，
 * 这样连 ready 之前的卡顿也看得见。任何失败都只是让看门狗关掉，不影响启动。
 */
export function startStallWatchdog(): void {
  if (started) return
  started = true
  if (process.env.SHUVIX_STALL_WATCHDOG === '0') return
  try {
    const sab = new SharedArrayBuffer(SLOT_COUNT * BigInt64Array.BYTES_PER_ELEMENT)
    const slots = new BigInt64Array(sab)
    // 主线程自己最清楚卡了多久：卡住前最后一次动静与恢复后第一次动静之间的空档（起点 → 终点）。
    // worker 只按 tick 粒度看得到（且读到的是恢复后**最新**的动静），所以报告的时长用这里量的
    const recentGaps = new Map<number, number>()
    const beat = (): void => {
      const now = process.hrtime.bigint()
      const prev = Atomics.load(slots, SLOT_BEAT_NS)
      if (prev > 0n && now - prev >= GAP_RECORD_NS) {
        recentGaps.set(Number(prev) / 1e6, Number(now) / 1e6)
        if (recentGaps.size > MAX_RECENT_GAPS) {
          recentGaps.delete(recentGaps.keys().next().value as number)
        }
      }
      Atomics.store(slots, SLOT_BEAT_NS, now)
    }
    beat()

    // hrtime 毫秒 → 距进程时间原点的毫秒（报告里与 Perf 的 since launch 同一把尺子）
    const hrAtOriginMs = Number(process.hrtime.bigint()) / 1e6 - performance.now()
    const sinceLaunch = (hrMs: number): number => hrMs - hrAtOriginMs

    const steps = createStepTable()
    onPerfStep((label, phase) => {
      Atomics.store(slots, SLOT_STEP, BigInt(steps.encode(label, phase)))
      beat()
    })

    const dir = process.platform === 'darwin' ? logsDir() : null
    const nativeSample: NativeSampleConfig | null = dir
      ? {
          afterMs: SAMPLE_AFTER_MS,
          seconds: SAMPLE_SECONDS,
          dir,
          pid: process.pid,
          maxPerProcess: 2,
          keepFiles: 5
        }
      : null
    const workerData: WatchdogWorkerData = {
      sab,
      tickMs: TICK_MS,
      thresholdMs: THRESHOLD_MS,
      suspendGapMs: SUSPEND_GAP_MS,
      captureStack: !externalInspectorAttached(),
      nativeSample
    }

    const worker = new Worker(workerPath(), {
      workerData,
      name: 'stall-watchdog',
      resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8 }
    })
    worker.unref()

    let reports = 0
    // 函数名必须等于 WATCHDOG_HANDLER_NAME：抓到的栈里只剩它（与 node 内部帧）时，
    // 报告据此判定「卡的时候根本不在 JS 里」
    function onStallWatchdogMessage(msg: WorkerToMain): void {
      if (msg.type === 'ping') {
        beat()
        return
      }
      if (reports >= MAX_REPORTS) return
      if (++reports === MAX_REPORTS) {
        wlog.warn(`stall report limit (${MAX_REPORTS}) reached; further stalls are not logged`)
      }
      if (msg.type === 'stall') {
        // worker 判定卡顿时读到的「最后一次动静」就是这道空档的起点 —— 对得上就用主线程量的终点
        const fromMs = msg.lastBeatAtMs
        const toMs = recentGaps.get(fromMs) ?? msg.resumedAtMs
        recentGaps.delete(fromMs)
        wlog.warn(
          formatStallReport({
            seq: msg.seq,
            durationMs: toMs - fromMs,
            fromSinceLaunchMs: sinceLaunch(fromMs),
            toSinceLaunchMs: sinceLaunch(toMs),
            where: steps.describe(msg.stepCode),
            stack: msg.stack
          })
        )
      } else if (msg.type === 'sample') {
        wlog.warn(formatSampleReport(msg.seq, msg.durationSoFarMs, msg.result))
      }
    }
    if (onStallWatchdogMessage.name !== WATCHDOG_HANDLER_NAME) {
      wlog.warn('stall watchdog handler was renamed by the bundler; outside-JS detection is off')
    }
    worker.on('message', onStallWatchdogMessage)

    const off = (why: string): void => {
      onPerfStep(null)
      wlog.warn(`stall watchdog off: ${why}`)
    }
    worker.on('error', (err) => off(`worker failed: ${err.message}`))

    // 退出流程里 Chromium 的原生收尾可能卡上几秒 —— 那不是要查的卡顿，也别在那时去采样
    app.once('will-quit', () => {
      onPerfStep(null)
      // 退出途中 worker 再出错也只是吞掉（不能留成没人接的 'error' 事件）
      worker.removeAllListeners('error')
      worker.on('error', () => undefined)
      try {
        worker.postMessage({ type: 'stop' } satisfies MainToWorker)
      } catch {
        // worker 已经不在
      }
      void worker.terminate().catch(() => undefined)
    })
  } catch (err) {
    onPerfStep(null)
    wlog.warn(`stall watchdog not started: ${err instanceof Error ? err.message : String(err)}`)
  }
}
