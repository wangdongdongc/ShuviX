/**
 * 卡顿看门狗：主线程侧的纯逻辑 —— 步骤编码表与日志文案（单测直接测这里）。
 */
import type { PerfStepPhase } from '../../perf'
import type { NativeSampleResult, StackCapture, StackFrame } from './protocol'

/** 步骤表最多记这么多个不同的标签；之后的一律编成「（标签表已满）」 */
export const MAX_STEP_LABELS = 1024

export interface StepTable {
  /** 标签 + 相位 → 写进共享内存的编码（0 保留给「还没有任何步骤」） */
  encode(label: string, phase: PerfStepPhase): number
  /** 编码 → 人读的位置描述 */
  describe(code: number): string
}

export function createStepTable(maxLabels = MAX_STEP_LABELS): StepTable {
  const labels: string[] = []
  const index = new Map<string, number>()
  const OVERFLOW = '(step table full)'
  return {
    encode(label, phase) {
      let i = index.get(label)
      if (i === undefined) {
        const key = labels.length < maxLabels ? label : OVERFLOW
        i = index.get(key)
        if (i === undefined) {
          i = labels.length
          labels.push(key)
          index.set(key, i)
        }
      }
      return (i + 1) * 2 + (phase === 'after' ? 1 : 0)
    },
    describe(code) {
      const i = Math.floor(code / 2) - 1
      const label = labels[i]
      if (code < 2 || label === undefined) return 'before any recorded step'
      return code % 2 === 1 ? `after "${label}"` : `in "${label}"`
    }
  }
}

/**
 * 主进程里看门狗收消息的函数名（watchdog.ts 里的同名函数声明）—— 栈里只剩它与 node 内部帧，
 * 说明卡的时候根本不在 JS 里，恢复后第一段 JS 就是应答 ping
 */
export const WATCHDOG_HANDLER_NAME = 'onStallWatchdogMessage'

/** 日志里最多列几帧应用代码 */
export const MAX_APP_FRAMES = 12

function frameText(f: StackFrame): string {
  const file = f.url ? (f.url.split(/[\\/]/).pop() ?? f.url) : '<internal>'
  return `${f.functionName || '(anonymous)'} (${file}:${f.line}:${f.column})`
}

/** node / Electron 自带脚本（`node:…`、`electron/js2c/…`、没有地址的）与看门狗自己的应答函数 */
function isInternalFrame(f: StackFrame): boolean {
  return (
    f.url === '' ||
    f.url.startsWith('node:') ||
    f.url.startsWith('electron/') ||
    f.functionName === WATCHDOG_HANDLER_NAME
  )
}

/**
 * 栈的那一段文案。主线程停下的位置是「恢复后的第一条 JS 语句」：
 *  - 卡在 JS 里（死循环）：就停在那段代码里；
 *  - 卡在 JS 发起的原生调用里：停在调用返回后的第一条语句，或调用内部回调 JS 的地方（如原生构造里
 *    emit 的事件）—— 顶上几帧是内部帧，往下第一帧应用代码就是发起阻塞调用的那一行；
 *  - 栈上一帧应用代码都没有：卡的时候根本不在 JS 里（Chromium / 系统框架自己的启动），恢复后第一段 JS
 *    只是某个事件回调，比如看门狗自己应答 ping。
 */
export function describeStack(stack: StackCapture): string {
  switch (stack.state) {
    case 'captured': {
      if (stack.frames.length === 0) return 'JS stack: empty'
      const app = stack.frames.filter((f) => !isInternalFrame(f))
      if (app.length === 0) {
        return (
          'JS stack: no app code on the stack — the thread was blocked outside JavaScript ' +
          `(native code / Chromium; first JS afterwards: ${frameText(stack.frames[0])})`
        )
      }
      const top = stack.frames[0]
      const lead = isInternalFrame(top) ? `${frameText(top)} ← … ← ` : ''
      return `JS stack where it resumed: ${lead}${app.slice(0, MAX_APP_FRAMES).map(frameText).join(' ← ')}`
    }
    case 'skipped':
      return `JS stack: not captured (${stack.reason})`
    case 'unavailable':
      return `JS stack: unavailable (${stack.reason})`
    case 'missed':
      return `JS stack: missed (${stack.reason})`
  }
}

export interface StallReportInput {
  /** 本进程第几次卡顿 */
  seq: number
  durationMs: number
  /** 卡住之前最后一次动静 / 恢复：距进程时间原点的毫秒数 */
  fromSinceLaunchMs: number
  toSinceLaunchMs: number
  where: string
  stack: StackCapture
}

export function formatStallReport(r: StallReportInput): string {
  return (
    `stall #${r.seq}: main thread blocked ${(r.durationMs / 1000).toFixed(1)}s ` +
    `(+${r.fromSinceLaunchMs.toFixed(0)}ms → +${r.toSinceLaunchMs.toFixed(0)}ms since launch), ` +
    `${r.where}; ${describeStack(r.stack)}`
  )
}

export function formatSampleReport(
  seq: number,
  durationSoFarMs: number,
  result: NativeSampleResult
): string {
  const at = `taken ${(durationSoFarMs / 1000).toFixed(1)}s into the stall`
  if (!result.ok) return `stall #${seq}: native sample failed (${at}): ${result.error}`
  const graph = result.mainThread.length
    ? result.mainThread.join('\n')
    : '(main thread not found in the sample output)'
  return (
    `stall #${seq}: native sample of the blocked main thread (${at}; heaviest path, leaf last) ` +
    `→ ${result.file}\n${graph}`
  )
}
