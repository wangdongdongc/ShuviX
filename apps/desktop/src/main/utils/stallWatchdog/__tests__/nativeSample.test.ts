import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureNativeSample,
  extractMainThreadCallGraph,
  pruneSampleFiles,
  sampleFileName,
  type NativeSampleOptions
} from '../nativeSample'

/*
 * 夹具按 /usr/bin/sample 的真实版式写：线程头 `    <n> Thread_<id>[: 标签]`，帧 `    + <n> <符号>  (in <镜像>) + <偏移>  [0x…]`；
 * 兄弟帧同缩进，子帧多两格，分叉处用 `!` / `:` / `|` 前缀；调用图在一个空行处结束，后面是
 * 「Total number in stack」「Sort by top of stack」两段（数字很大，不能被当成帧）。
 */
const TAIL = [
  '',
  'Total number in stack (recursive counted multiple, when >=5):',
  '        99999       start  (in dyld) + 6992  [0x18e903e00]',
  '        88888       hugeTotalsFrame  (in Electron Framework) + 1  [0x1]',
  '',
  'Sort by top of stack, same collapsed (when >= 5):',
  '        mach_msg2_trap  (in libsystem_kernel.dylib)        43820',
  '        __psynch_cvwait  (in libsystem_kernel.dylib)        26292',
  '',
  'Binary Images:',
  '       0x100000000 -        0x100003fff +Electron (41.0.0) <UUID> /x/Electron'
]

function sampleText(...blocks: string[][]): string {
  return [
    'Analysis of sampling Electron (pid 4242) every 1 millisecond',
    'Process:         Electron [4242]',
    '',
    'Call graph:',
    ...blocks.flat(),
    ...TAIL
  ].join('\n')
}

const WORKER_BLOCK = [
  '    1843 Thread_5359030',
  '    + 1843 thread_start  (in libsystem_pthread.dylib) + 8  [0x18ecbcc1c]',
  '    +   1843 _pthread_start  (in libsystem_pthread.dylib) + 136  [0x18ecc1c58]',
  '    +     1843 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x18ec81504]'
]
const METAL_HEADER =
  '    1843 Thread_5359037   DispatchQueue_263: com.Metal.DeviceDispatch  (serial)'
const METAL_BLOCK = [
  METAL_HEADER,
  '    + 1843 start  (in dyld) + 6992  [0x18e903e00]',
  '    +   1843 ElectronMain  (in Electron Framework) + 124  [0x111af70c0]',
  '    +     1843 MTLCreateSystemDefaultDevice  (in Metal) + 64  [0x1a0000040]'
]
const EVENT_THREAD_BLOCK = [
  '    1843 Thread_5359058: com.apple.NSEventThread',
  '    + 1843 thread_start  (in libsystem_pthread.dylib) + 8  [0x18ecbcc1c]',
  '    +   1843 _NSEventThread  (in AppKit) + 184  [0x1932cdc7c]'
]

describe('sampleFileName', () => {
  it('formats local time as stall-sample-YYYYMMDD-HHMMSS.txt', () => {
    expect(sampleFileName(new Date(2026, 9, 7, 4, 58, 41))).toBe('stall-sample-20261007-045841.txt')
    expect(sampleFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('stall-sample-20260102-030405.txt')
  })
})

describe('extractMainThreadCallGraph', () => {
  it('picks the thread rooted at start (in dyld), whatever its queue label', () => {
    const out = extractMainThreadCallGraph(
      sampleText(WORKER_BLOCK, METAL_BLOCK, EVENT_THREAD_BLOCK),
      80
    )
    expect(out).toEqual([
      METAL_HEADER.trim(),
      '1843 start (in dyld) + 6992',
      '1843 ElectronMain (in Electron Framework) + 124',
      '1843 MTLCreateSystemDefaultDevice (in Metal) + 64'
    ])
    // 线程头只去掉首尾空白，内部的空格原样保留
    expect(out[0]).toBe(
      '1843 Thread_5359037   DispatchQueue_263: com.Metal.DeviceDispatch  (serial)'
    )
  })

  it('a block labelled com.apple.main-thread wins even when it is not first', () => {
    const labelled = [
      '    1843 Thread_5359001   DispatchQueue_1: com.apple.main-thread  (serial)',
      '    + 1843 weirdRoot  (in dyld) + 1  [0x1]',
      '    +   1843 mainLeaf  (in AppKit) + 2  [0x2]'
    ]
    const out = extractMainThreadCallGraph(sampleText(WORKER_BLOCK, METAL_BLOCK, labelled), 80)
    expect(out).toEqual([
      '1843 Thread_5359001   DispatchQueue_1: com.apple.main-thread  (serial)',
      '1843 weirdRoot (in dyld) + 1',
      '1843 mainLeaf (in AppKit) + 2'
    ])
  })

  it('falls back to the first block when no marker is found', () => {
    const other = [
      '    1843 Thread_5359099',
      '    + 1843 start_wqthread  (in libsystem_pthread.dylib) + 8  [0x18ecbcc10]'
    ]
    const out = extractMainThreadCallGraph(sampleText(WORKER_BLOCK, other), 80)
    expect(out[0]).toBe('1843 Thread_5359030')
    expect(out.at(-1)).toBe('1843 __psynch_cvwait (in libsystem_kernel.dylib) + 8')
  })

  it('returns nothing without a call graph', () => {
    expect(extractMainThreadCallGraph('Process: Electron\nno graph here\n', 80)).toEqual([])
    expect(extractMainThreadCallGraph('Call graph:\n\n    1843 Thread_1\n', 80)).toEqual([])
  })

  it('follows the heaviest child at each level; grandchildren never compete; ties go first', () => {
    const branchy = [
      '    1843 Thread_5359037   DispatchQueue_1: com.apple.main-thread  (serial)',
      '    + 1843 start  (in dyld) + 6992  [0x18e903e00]',
      '    +   1843 ElectronMain  (in Electron Framework) + 124  [0x111af70c0]',
      '    +     600 lightBranch  (in Electron Framework) + 1  [0x1]',
      // 孙帧的样本数再大也不和子帧比（真实输出里不会出现，这里专门造出来）
      '    +     ! 1500 bogusGrandchild  (in Electron Framework) + 2  [0x2]',
      '    +     ! : 600 lightLeaf  (in Electron Framework) + 3  [0x3]',
      '    +     1243 heavyBranch  (in Electron Framework) + 4  [0x4]',
      '    +       700 tieFirst  (in Electron Framework) + 5  [0x5]',
      '    +       ! 700 heavyLeaf  (in Electron Framework) + 6  [0x6]',
      '    +       700 tieSecond  (in Electron Framework) + 7  [0x7]',
      '    +       | 700 otherLeaf  (in Electron Framework) + 8  [0x8]'
    ]
    expect(extractMainThreadCallGraph(sampleText(WORKER_BLOCK, branchy), 80)).toEqual([
      '1843 Thread_5359037   DispatchQueue_1: com.apple.main-thread  (serial)',
      '1843 start (in dyld) + 6992',
      '1843 ElectronMain (in Electron Framework) + 124',
      '1243 heavyBranch (in Electron Framework) + 4',
      '700 tieFirst (in Electron Framework) + 5',
      '700 heavyLeaf (in Electron Framework) + 6'
    ])
  })

  it('ignores everything after the blank line that ends the graph', () => {
    const text = sampleText(METAL_BLOCK) + '\n    9999 Thread_9: com.apple.main-thread\n'
    const out = extractMainThreadCallGraph(text, 80)
    expect(out).toHaveLength(4)
    expect(out.join('\n')).not.toMatch(/99999|88888|hugeTotalsFrame|mach_msg2_trap|Thread_9/)
  })

  it('truncates long frames to 200 chars but never the thread header', () => {
    const header = `    1843 Thread_1: com.apple.main-thread ${'q'.repeat(250)}`
    const longFrame = `v8::internal::${'Templated<'.repeat(30)}x`
    expect(longFrame.length).toBeGreaterThan(300)
    const out = extractMainThreadCallGraph(
      sampleText([
        header,
        '    + 1843 start  (in dyld) + 6992  [0x18e903e00]',
        `    +   1843 ${longFrame}  (in Electron Framework) + 1  [0x1]`
      ]),
      80
    )
    expect(out[0]).toBe(header.trim())
    expect(out[0].length).toBeGreaterThan(200)
    expect(out[2]).toHaveLength(200)
    expect(out[2].startsWith('1843 v8::internal::Templated<')).toBe(true)
  })

  describe('line budget', () => {
    // 101 行：线程头 + 100 层帧（f0 是根，f99 是叶子）
    const chain = [
      '    1843 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)',
      ...Array.from(
        { length: 100 },
        (_, i) => `    + ${'  '.repeat(i)}1843 f${i}  (in Electron Framework) + ${i}  [0x${i}]`
      )
    ]
    const text = sampleText(chain)
    const header = chain[0].trim()
    const frame = (i: number): string => `1843 f${i} (in Electron Framework) + ${i}`

    it('keeps the header, the root end and the leaf end with an elision marker', () => {
      expect(extractMainThreadCallGraph(text, 10)).toEqual([
        header,
        frame(0),
        frame(1),
        '… 92 frames …',
        frame(94),
        frame(95),
        frame(96),
        frame(97),
        frame(98),
        frame(99)
      ])
    })

    it('leaves the path untouched when it fits exactly', () => {
      const out = extractMainThreadCallGraph(text, 101)
      expect(out).toHaveLength(101)
      expect(out[0]).toBe(header)
      expect(out.at(-1)).toBe(frame(99))
      expect(out.some((l) => l.startsWith('…'))).toBe(false)
    })

    it('tiny budgets keep the header and the leaf end only', () => {
      expect(extractMainThreadCallGraph(text, 3)).toEqual([header, frame(98), frame(99)])
      expect(extractMainThreadCallGraph(text, 1)).toEqual([header])
      for (let n = 1; n <= 12; n++) {
        expect(extractMainThreadCallGraph(text, n).length).toBeLessThanOrEqual(n)
      }
    })
  })
})

describe('sample files on disk', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shuvix-native-sample-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const sampleFiles = (d: string): string[] =>
    readdirSync(d)
      .filter((n) => /^stall-sample-.*\.txt$/.test(n))
      .sort()

  describe('pruneSampleFiles', () => {
    const seven = Array.from({ length: 7 }, (_, i) => `stall-sample-2026100${i + 1}-120000.txt`)

    beforeEach(() => {
      // 故意乱序写入：按名字排序才是按时间排序
      for (const n of [...seven].reverse()) writeFileSync(join(dir, n), 'x')
      writeFileSync(join(dir, 'main.log'), 'log')
      writeFileSync(join(dir, 'stall-sample-x.log'), 'not a sample')
    })

    it('keeps the newest files by name and leaves other files alone', async () => {
      await pruneSampleFiles(dir, 5)
      expect(sampleFiles(dir)).toEqual(seven.slice(2))
      expect(existsSync(join(dir, 'main.log'))).toBe(true)
      expect(existsSync(join(dir, 'stall-sample-x.log'))).toBe(true)
    })

    it('keep 0 deletes every sample file', async () => {
      await pruneSampleFiles(dir, 0)
      expect(sampleFiles(dir)).toEqual([])
      expect(readdirSync(dir).sort()).toEqual(['main.log', 'stall-sample-x.log'])
    })

    it('rejects for a missing directory', async () => {
      await expect(pruneSampleFiles(join(dir, 'missing'), 5)).rejects.toThrow(/ENOENT/)
    })
  })

  describe.skipIf(process.platform === 'win32')('captureNativeSample', () => {
    let bin: string
    beforeEach(() => {
      bin = join(dir, 'bin')
      mkdirSync(bin)
    })

    /** 写一个假的 sample 可执行脚本 */
    function script(name: string, body: string): string {
      const file = join(bin, name)
      writeFileSync(file, `#!/bin/sh\n${body}\n`)
      chmodSync(file, 0o755)
      return file
    }

    const NOW = new Date(2026, 9, 7, 4, 58, 41)
    const opts = (
      binary: string,
      extra: Partial<NativeSampleOptions> = {}
    ): NativeSampleOptions => ({
      pid: 4242,
      seconds: 3,
      dir,
      keepFiles: 2,
      maxLines: 80,
      now: NOW,
      binary,
      ...extra
    })

    it('runs `sample <pid> <seconds> -file <file>`, parses the file and prunes old ones', async () => {
      const fixture = join(bin, 'fixture.txt')
      const text = sampleText(WORKER_BLOCK, METAL_BLOCK)
      writeFileSync(fixture, text)
      for (const n of [
        'stall-sample-20261001-010101.txt',
        'stall-sample-20261002-010101.txt',
        'stall-sample-20261003-010101.txt'
      ]) {
        writeFileSync(join(dir, n), 'old')
      }
      const binary = script('sample', `echo "$@" > "${bin}/args.txt"\ncp "${fixture}" "$4"`)
      const file = join(dir, sampleFileName(NOW))

      const result = await captureNativeSample(opts(binary))

      expect(result).toEqual({
        ok: true,
        file,
        mainThread: extractMainThreadCallGraph(text, 80)
      })
      expect(readFileSync(join(bin, 'args.txt'), 'utf8').trim()).toBe(`4242 3 -file ${file}`)
      expect(sampleFiles(dir)).toEqual([
        'stall-sample-20261003-010101.txt',
        'stall-sample-20261007-045841.txt'
      ])
    })

    it('a non-zero exit reports the first stderr line, or the exit code', async () => {
      const noisy = script('noisy', `echo 'sample: no such process' >&2\necho second >&2\nexit 1`)
      expect(await captureNativeSample(opts(noisy))).toEqual({
        ok: false,
        error: 'sample: no such process'
      })
      const quiet = script('quiet', 'exit 3')
      expect(await captureNativeSample(opts(quiet))).toEqual({ ok: false, error: 'exit code 3' })
    })

    it('exit 0 without writing the file is a read failure', async () => {
      const lazy = script('lazy', 'exit 0')
      const result = await captureNativeSample(opts(lazy))
      expect(result.ok).toBe(false)
      const file = join(dir, sampleFileName(NOW))
      expect(!result.ok && result.error.startsWith(`cannot read ${file}:`)).toBe(true)
    })

    it('a missing binary is reported, not thrown', async () => {
      const result = await captureNativeSample(opts(join(bin, 'does-not-exist')))
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toMatch(/ENOENT/)
    })

    it('kills a sampler that does not finish in time', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const hang = script('hang', `echo $$ > "${bin}/pid.txt"\nexec sleep 60`)
      const pending = captureNativeSample(opts(hang, { seconds: 3 }))
      // 等脚本把自己的 pid 写下来（真实 I/O，不经假计时器）
      const pidFile = join(bin, 'pid.txt')
      const t0 = Date.now()
      while (
        !(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()) &&
        Date.now() - t0 < 5000
      ) {
        await new Promise((r) => setImmediate(r))
      }
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(pid).toBeGreaterThan(0)

      vi.advanceTimersByTime((3 + 20) * 1000)
      expect(await pending).toEqual({ ok: false, error: `${hang} did not finish in time` })

      vi.useRealTimers()
      // SIGKILL 之后、node 回收之前它还是个僵尸（kill 0 仍成功）：最多等 1 秒
      const t1 = Date.now()
      let gone = false
      while (!gone && Date.now() - t1 < 1000) {
        try {
          process.kill(pid, 0)
          await new Promise((r) => setTimeout(r, 20))
        } catch (err) {
          gone = (err as NodeJS.ErrnoException).code === 'ESRCH'
        }
      }
      expect(gone).toBe(true)
    })
  })
})
