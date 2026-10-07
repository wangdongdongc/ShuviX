import { describe, expect, it } from 'vitest'
import type { StackCapture, StackFrame } from '../protocol'
import {
  MAX_APP_FRAMES,
  WATCHDOG_HANDLER_NAME,
  createStepTable,
  describeStack,
  formatSampleReport,
  formatStallReport
} from '../report'

const APP = 'file:///x/out/main/index.js'
const frame = (functionName: string, url: string, line = 1, column = 1): StackFrame => ({
  functionName,
  url,
  line,
  column
})
const captured = (frames: StackFrame[]): StackCapture => ({ state: 'captured', frames })

describe('createStepTable', () => {
  it('encodes label + phase stably and describes the codes back', () => {
    const t = createStepTable()
    expect(t.encode('a', 'in')).toBe(2)
    expect(t.encode('a', 'after')).toBe(3)
    expect(t.encode('b', 'in')).toBe(4)
    expect(t.encode('a', 'in')).toBe(2)
    expect(t.encode('b', 'after')).toBe(5)
    expect(t.describe(2)).toBe('in "a"')
    expect(t.describe(3)).toBe('after "a"')
    expect(t.describe(5)).toBe('after "b"')
    for (const code of [0, 1, 100]) expect(t.describe(code)).toBe('before any recorded step')
  })

  it('collapses labels beyond the table size into one overflow entry', () => {
    const t = createStepTable(2)
    expect(t.encode('a', 'in')).toBe(2)
    expect(t.encode('b', 'in')).toBe(4)
    expect(t.encode('c', 'in')).toBe(6)
    expect(t.describe(6)).toBe('in "(step table full)"')
    expect(t.encode('d', 'after')).toBe(7)
    expect(t.describe(7)).toBe('after "(step table full)"')
    expect([t.encode('a', 'in'), t.encode('a', 'after')]).toEqual([2, 3])
    expect([t.encode('b', 'in'), t.encode('b', 'after')]).toEqual([4, 5])
  })
})

describe('describeStack', () => {
  it('describes every non-captured state with its reason', () => {
    expect(describeStack(captured([]))).toBe('JS stack: empty')
    expect(describeStack({ state: 'skipped', reason: 'r' })).toBe('JS stack: not captured (r)')
    expect(describeStack({ state: 'unavailable', reason: 'r' })).toBe('JS stack: unavailable (r)')
    expect(describeStack({ state: 'missed', reason: 'r' })).toBe('JS stack: missed (r)')
  })

  it('says the thread was blocked outside JS when no app frame is on the stack', () => {
    const frames = [
      frame(WATCHDOG_HANDLER_NAME, APP, 10, 5),
      frame('emit', 'node:events', 467, 17),
      frame('', '', 0, 0),
      frame('init', 'electron/js2c/browser_init', 2, 3)
    ]
    expect(describeStack(captured(frames))).toBe(
      'JS stack: no app code on the stack — the thread was blocked outside JavaScript ' +
        '(native code / Chromium; first JS afterwards: onStallWatchdogMessage (index.js:10:5))'
    )
    expect(describeStack(captured([frame('tick', '', 4, 2)]))).toBe(
      'JS stack: no app code on the stack — the thread was blocked outside JavaScript ' +
        '(native code / Chromium; first JS afterwards: tick (<internal>:4:2))'
    )
  })

  it('lists app frames from the top when the top frame is app code', () => {
    const frames = [frame('busyWait', APP, 93927, 3), frame('simulateStartupStall', APP, 1, 2)]
    expect(describeStack(captured(frames))).toBe(
      'JS stack where it resumed: busyWait (index.js:93927:3) ← simulateStartupStall (index.js:1:2)'
    )
  })

  it('shows an internal top frame, then elides to the first app frames', () => {
    const frames = [
      frame('emit', 'node:events', 467, 17),
      frame('', '', 0, 0),
      frame('newMainWindow', APP, 500, 9)
    ]
    expect(describeStack(captured(frames))).toBe(
      'JS stack where it resumed: emit (node:events:467:17) ← … ← newMainWindow (index.js:500:9)'
    )
  })

  it('drops internal frames between app frames without a marker', () => {
    const frames = [
      frame('a', APP, 1, 1),
      frame('emit', 'node:events', 2, 2),
      frame('', '', 0, 0),
      frame('b', APP, 3, 3)
    ]
    expect(describeStack(captured(frames))).toBe(
      'JS stack where it resumed: a (index.js:1:1) ← b (index.js:3:3)'
    )
  })

  it('caps the app frames, names anonymous frames and keeps only the file name', () => {
    const many = Array.from({ length: MAX_APP_FRAMES + 3 }, (_, i) => frame(`f${i}`, APP, i, 1))
    const text = describeStack(captured(many))
    expect(text.split(' ← ')).toHaveLength(MAX_APP_FRAMES)
    expect(text).toContain(`f${MAX_APP_FRAMES - 1} (`)
    expect(text).not.toContain(`f${MAX_APP_FRAMES} (`)

    expect(describeStack(captured([frame('', 'C:\\a\\out\\main\\index.js', 7, 8)]))).toBe(
      'JS stack where it resumed: (anonymous) (index.js:7:8)'
    )
  })
})

describe('formatStallReport', () => {
  it('formats one stall line', () => {
    expect(
      formatStallReport({
        seq: 3,
        durationMs: 3049,
        fromSinceLaunchMs: 2713.4,
        toSinceLaunchMs: 5714.6,
        where: 'in "s"',
        stack: { state: 'skipped', reason: 'x' }
      })
    ).toBe(
      'stall #3: main thread blocked 3.0s (+2713ms → +5715ms since launch), in "s"; JS stack: not captured (x)'
    )
  })
})

describe('formatSampleReport', () => {
  it('formats a sample with its heaviest path', () => {
    expect(
      formatSampleReport(2, 4210, { ok: true, file: '/l/f.txt', mainThread: ['h', '1 a'] })
    ).toBe(
      'stall #2: native sample of the blocked main thread (taken 4.2s into the stall; heaviest path, leaf last) → /l/f.txt\nh\n1 a'
    )
  })

  it('says so when the main thread was not found', () => {
    const text = formatSampleReport(2, 4210, { ok: true, file: '/l/f.txt', mainThread: [] })
    expect(text.split('\n').at(-1)).toBe('(main thread not found in the sample output)')
  })

  it('formats a failed sample', () => {
    expect(formatSampleReport(2, 4210, { ok: false, error: 'boom' })).toBe(
      'stall #2: native sample failed (taken 4.2s into the stall): boom'
    )
  })
})
