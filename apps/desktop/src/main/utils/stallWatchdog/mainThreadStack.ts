/**
 * 从 worker 里抓主线程的 JS 栈（只在 worker 里用）。
 *
 * 手法与 Sentry 的 ANR 检测相同：worker 用 `inspector.Session.connectToMainThread()` 接上主线程的
 * V8 inspector，发 `Debugger.enable` + `Debugger.pause`，主线程在下一条 JS 语句上停住，worker 收到
 * `Debugger.paused` 的调用栈后立刻 `Debugger.resume`、`disable`、断开 —— 主线程停的那一下只有几毫秒。
 *
 * 时序要点：
 *  - 三条消息（连接、enable、pause）在卡顿开始时就**一口气**发出去，不等回执。它们在主线程上是
 *    排队、按序处理的：主线程在跑 JS（死循环）时会在下一个栈检查点处理掉，于是停在卡住的那段代码里；
 *    主线程卡在原生调用里时，要等它回到 JS 才处理，于是停在阻塞调用返回后的第一条语句 —— 调用方那
 *    一帧的行号仍指着阻塞点。若等 enable 的回执再发 pause，主线程早已往下跑，栈就不再指向卡点。
 *  - 平时不连：会话只在卡顿时建、抓完就断，正常运行时主线程上没有任何 inspector 会话。
 *  - 主线程停住之后**一定**要 resume（任何异常路径都走 resume），否则就是我们自己把应用挂死。
 */
import { Session } from 'node:inspector'
import type { StackCapture, StackFrame } from './protocol'

/** Debugger.CallFrame 里我们用到的字段 */
export interface CallFrameLike {
  functionName?: string
  /** V8 已不再填它（废弃字段，恒为空串）—— 地址要按 scriptId 去 scriptParsed 里查 */
  url?: string
  location?: { scriptId?: string; lineNumber?: number; columnNumber?: number }
}

/**
 * CDP 调用帧 → 我们记日志用的帧（行列号从 0 起 → 从 1 起），最多取 max 帧。
 * `scriptUrls`：本次会话 `Debugger.scriptParsed` 收集的 scriptId → url。
 */
export function toStackFrames(
  callFrames: readonly CallFrameLike[],
  max: number,
  scriptUrls: ReadonlyMap<string, string> = new Map()
): StackFrame[] {
  return callFrames.slice(0, max).map((f) => ({
    functionName: f.functionName ?? '',
    url: f.url || scriptUrls.get(f.location?.scriptId ?? '') || '',
    line: (f.location?.lineNumber ?? -1) + 1,
    column: (f.location?.columnNumber ?? -1) + 1
  }))
}

export interface MainThreadStackCapture {
  /** 卡顿开始时调用：发出抓栈请求（已有一次在途 / 达到上限 / 不可用时什么都不做） */
  request(): void
  /** 卡顿结束时调用：取走这次的结果 */
  take(): StackCapture
}

export interface StackCaptureOptions {
  maxFrames: number
  /** 每个进程最多抓几次（每次都要在主线程上 enable 一次调试器，别无限制地抓） */
  maxCaptures: number
  /** 可注入的 Session 构造（单测用）；缺省 node:inspector 的 Session */
  createSession?: () => Session
}

export function createMainThreadStackCapture(opts: StackCaptureOptions): MainThreadStackCapture {
  const createSession = opts.createSession ?? ((): Session => new Session())
  let unavailable: string | null = null
  let captures = 0
  /** 在途的会话（已请求、还没收尾） */
  let inFlight: Session | null = null
  /** 已请求、还在等主线程停下来 */
  let waiting = false
  let result: StackCapture | null = null
  let skippedReason: string | null = null

  /** resume → disable → 断开；每一步失败都继续往下走，最后一定断开 */
  const finish = (session: Session): void => {
    const disconnect = (): void => {
      try {
        session.disconnect()
      } catch {
        // 已断开
      }
      if (inFlight === session) inFlight = null
    }
    try {
      session.post('Debugger.resume', () => {
        try {
          session.post('Debugger.disable', () => disconnect())
        } catch {
          disconnect()
        }
      })
    } catch {
      disconnect()
    }
  }

  return {
    request(): void {
      skippedReason = null
      if (unavailable) return
      if (inFlight) {
        skippedReason = 'previous capture still in flight'
        return
      }
      if (captures >= opts.maxCaptures) {
        skippedReason = `capture limit (${opts.maxCaptures}) reached`
        return
      }
      captures++
      let session: Session
      try {
        session = createSession()
        session.connectToMainThread()
      } catch (err) {
        unavailable = `inspector unavailable: ${err instanceof Error ? err.message : String(err)}`
        return
      }
      inFlight = session
      waiting = true
      result = null
      // enable 时 V8 先把已有脚本逐个报一遍 scriptParsed，paused 一定在它们之后到
      const scriptUrls = new Map<string, string>()
      session.on('Debugger.scriptParsed', (msg) => {
        if (msg.params.url) scriptUrls.set(msg.params.scriptId, msg.params.url)
      })
      session.on('Debugger.paused', (msg) => {
        // 不管是谁让它停的、停在哪，先拿帧再立刻放行
        let frames: StackFrame[] = []
        try {
          frames = toStackFrames(
            msg.params.callFrames as CallFrameLike[],
            opts.maxFrames,
            scriptUrls
          )
        } catch {
          // 帧坏了也照样 resume
        }
        if (waiting) {
          waiting = false
          result = { state: 'captured', frames }
        }
        finish(session)
      })
      const onError = (err: Error | null): void => {
        if (!err || !waiting) return
        waiting = false
        result = { state: 'unavailable', reason: err.message }
        finish(session)
      }
      try {
        session.post('Debugger.enable', onError)
        session.post('Debugger.pause', onError)
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)))
      }
    },

    take(): StackCapture {
      if (unavailable) return { state: 'unavailable', reason: unavailable }
      if (result) {
        const r = result
        result = null
        return r
      }
      if (waiting) {
        // 会话留着：主线程下一次跑 JS 时仍会停下，那时 paused 回调照样放行并收尾
        waiting = false
        return { state: 'missed', reason: 'main thread did not pause after resuming' }
      }
      return { state: 'skipped', reason: skippedReason ?? 'no capture requested' }
    }
  }
}
