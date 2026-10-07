/**
 * 卡顿看门狗 worker 入口（独立 rollup 入口 → out/main/stallWatchdogWorker.js，由 watchdog.ts 启动）。
 *
 * 只依赖 node 内置模块与本目录的纯逻辑：worker 里没有 electron，也不能写 electron-log
 * （日志由主线程在恢复后写 —— 卡顿结束才有完整的报告可写）。
 * 这里的任何异常都只能让看门狗自己失效，不能波及主线程：未捕获的异常只会结束本 worker。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { createWatchdogCore } from './core'
import { createMainThreadStackCapture } from './mainThreadStack'
import { captureNativeSample } from './nativeSample'
import {
  SLOT_BEAT_NS,
  SLOT_STEP,
  type MainToWorker,
  type WatchdogWorkerData,
  type WorkerToMain
} from './protocol'

const MAX_STACK_FRAMES = 64
const MAX_STACK_CAPTURES = 20
const MAX_SAMPLE_LINES = 80

const data = workerData as WatchdogWorkerData
const port = parentPort
if (port) {
  const slots = new BigInt64Array(data.sab)
  const post = (msg: WorkerToMain): void => port.postMessage(msg)
  const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6
  const sample = data.nativeSample

  const core = createWatchdogCore({
    thresholdMs: data.thresholdMs,
    suspendGapMs: data.suspendGapMs,
    nowMs,
    readBeatAtMs: () => Number(Atomics.load(slots, SLOT_BEAT_NS)) / 1e6,
    readStepCode: () => Number(Atomics.load(slots, SLOT_STEP)),
    post,
    stack: data.captureStack
      ? createMainThreadStackCapture({
          maxFrames: MAX_STACK_FRAMES,
          maxCaptures: MAX_STACK_CAPTURES
        })
      : null,
    stackOffReason: 'an external inspector is attached to the main process',
    nativeSample: sample,
    runNativeSample: sample
      ? () =>
          captureNativeSample({
            pid: sample.pid,
            seconds: sample.seconds,
            dir: sample.dir,
            keepFiles: sample.keepFiles,
            maxLines: MAX_SAMPLE_LINES
          })
      : undefined
  })

  const timer = setInterval(() => core.tick(), data.tickMs)
  port.on('message', (msg: MainToWorker) => {
    if (msg?.type === 'stop') {
      clearInterval(timer)
      port.close()
    }
  })
}
