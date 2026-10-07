/**
 * 卡顿判定（纯逻辑，不碰线程与时钟）：worker 每个 tick 把「此刻」与「主线程最后一次有动静的时刻」
 * 喂进来（同一时钟、毫秒），这里决定一次卡顿何时开始、何时结束。
 *
 * 两个时刻都取自 process.hrtime —— 进程内各线程共用的单调时钟；macOS / Linux 上它在系统睡眠时不走，
 * 合盖不会被当成卡顿。再加一道保险：worker 自己的 tick 也迟到了（App Nap、调度饥饿、调试器停住整个
 * 进程），说明停的是整个进程而不是主线程，那段沉默一笔勾销。
 */

export interface StallDetectorOptions {
  /** 主线程连续这么久没动静才算卡住 */
  thresholdMs: number
  /** worker 自己两次 tick 的间隔超过它：整个进程 / 系统停过，此前的沉默不算 */
  suspendGapMs: number
}

export type StallEvent =
  | {
      type: 'start'
      /**
       * 这次卡顿从哪一刻算起：主线程最后一次动静；若其后整个进程停过，则从停顿结束那一拍算起 ——
       * 停掉的那段不是主线程卡的，不计进时长
       */
      lastBeatAtMs: number
      /** 判定时已经沉默了多久 */
      silentMs: number
    }
  | {
      type: 'end'
      lastBeatAtMs: number
      /** 恢复后主线程第一次有动静的时刻 */
      resumedAtMs: number
      durationMs: number
    }

export class StallDetector {
  private lastTickAtMs: number | null = null
  /** 这之前的沉默不作数（worker 自己停过之后重置） */
  private ignoreBeforeMs = Number.NEGATIVE_INFINITY
  /** 卡顿中：卡住之前最后一次动静的时刻；没卡 = null */
  private stalledFromMs: number | null = null

  constructor(private readonly opts: StallDetectorOptions) {}

  /** worker 每个 tick 调一次。返回这一 tick 上发生的事（大多数 tick 什么都没有） */
  tick(nowMs: number, lastBeatAtMs: number): StallEvent | null {
    const prevTick = this.lastTickAtMs
    this.lastTickAtMs = nowMs
    if (prevTick !== null && nowMs - prevTick > this.opts.suspendGapMs) {
      this.ignoreBeforeMs = nowMs
    }

    if (this.stalledFromMs !== null) {
      if (lastBeatAtMs <= this.stalledFromMs) return null
      const from = this.stalledFromMs
      this.stalledFromMs = null
      return {
        type: 'end',
        lastBeatAtMs: from,
        resumedAtMs: lastBeatAtMs,
        durationMs: lastBeatAtMs - from
      }
    }

    const fromMs = Math.max(lastBeatAtMs, this.ignoreBeforeMs)
    const silentMs = nowMs - fromMs
    if (silentMs < this.opts.thresholdMs) return null
    this.stalledFromMs = fromMs
    return { type: 'start', lastBeatAtMs: fromMs, silentMs }
  }

  /** 正在卡的话，自最后一次动静起已经过了多久；没卡回 null */
  stalledForMs(nowMs: number): number | null {
    return this.stalledFromMs === null ? null : nowMs - this.stalledFromMs
  }
}
