/**
 * 卡顿看门狗：主线程 ⇄ worker 的共享约定（只有常量与类型 —— worker 产物不能带进 electron / 日志模块）。
 *
 * 心跳走 SharedArrayBuffer 而不是消息：主线程被同步卡住时发不出消息，但它卡住**之前**写进共享内存的
 * 「最后一次应答时刻」与「此刻在哪一步」worker 随时读得到。
 */

/** BigInt64Array 下标：主线程最后一次有动静的 process.hrtime（ns）—— 应答 ping、进出步骤都会刷新 */
export const SLOT_BEAT_NS = 0
/** BigInt64Array 下标：主线程此刻所在步骤的编码（主线程侧的步骤表编出、也由它解码） */
export const SLOT_STEP = 1
export const SLOT_COUNT = 2

export interface NativeSampleConfig {
  /** 卡住多久之后开始采样（ms） */
  afterMs: number
  /** 采样时长（秒，交给 /usr/bin/sample） */
  seconds: number
  /** 采样文件写到哪个目录（主进程日志目录） */
  dir: string
  /** 被采样的进程（主进程自己） */
  pid: number
  /** 每个进程最多采几次 */
  maxPerProcess: number
  /** 目录里最多留几份采样文件（旧的删掉） */
  keepFiles: number
}

export interface WatchdogWorkerData {
  sab: SharedArrayBuffer
  /** worker 多久看一次心跳（同时给主线程发一次 ping） */
  tickMs: number
  /** 主线程连续多久没动静算卡住 */
  thresholdMs: number
  /** worker 自己两次 tick 间隔超过它 = 整个进程 / 系统停过（睡眠、App Nap），那段沉默不算 */
  suspendGapMs: number
  /** 是否经 inspector 抓主线程的 JS 栈（外部调试器连着时必须关：我们会 resume 它的断点） */
  captureStack: boolean
  /** 原生采样（仅 macOS）；null = 不采 */
  nativeSample: NativeSampleConfig | null
}

/** 一帧 JS 栈（行列号从 1 起） */
export interface StackFrame {
  functionName: string
  url: string
  line: number
  column: number
}

export type StackCapture =
  | { state: 'captured'; frames: StackFrame[] }
  /** 这次没抓：功能关着 / 达到次数上限 / 上一次还没收尾 */
  | { state: 'skipped'; reason: string }
  /** inspector 用不了（连不上主线程、domain 报错） */
  | { state: 'unavailable'; reason: string }
  /** 请求发出去了，主线程却没在恢复后停下来 */
  | { state: 'missed'; reason: string }

export type NativeSampleResult =
  | { ok: true; file: string; mainThread: string[] }
  | { ok: false; error: string }

export type WorkerToMain =
  /** 叫主线程应答一下（主线程收到就刷新 SLOT_BEAT_NS） */
  | { type: 'ping' }
  /** 一次卡顿已经结束（时刻都是 process.hrtime 的毫秒数） */
  | {
      type: 'stall'
      /** 本进程第几次卡顿（从 1 起；同一次卡顿的采样消息带同一个号） */
      seq: number
      /** 卡住之前主线程最后一次有动静的时刻 */
      lastBeatAtMs: number
      /** 恢复后主线程第一次有动静的时刻 */
      resumedAtMs: number
      durationMs: number
      /** 卡住那一刻 SLOT_STEP 里的编码 */
      stepCode: number
      stack: StackCapture
    }
  | { type: 'sample'; seq: number; durationSoFarMs: number; result: NativeSampleResult }

/** 主线程 → worker */
export type MainToWorker = { type: 'stop' }
