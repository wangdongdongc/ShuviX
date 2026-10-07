/**
 * 卡顿中的主进程原生采样（仅 macOS，只在 worker 里用）。
 *
 * JS 栈只看得见 JS：主线程若卡在原生代码里（Chromium 的启动、第一次建窗、某个系统框架的同步调用），
 * 恢复后抓到的 JS 栈最多告诉我们「哪一行调用没返回」，说不出它在等什么。系统自带的 `/usr/bin/sample`
 * 能在卡顿进行中给出每个线程的原生调用栈 —— 主线程那一段就是答案。
 *
 * 只在卡顿已经持续了一阵（`afterMs`）之后才采，每个进程有次数上限，目录里只留最近几份；
 * 正常运行时这里什么都不发生。
 */
import { spawn } from 'node:child_process'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeSampleResult } from './protocol'

export const SAMPLE_BINARY = '/usr/bin/sample'
const SAMPLE_FILE_RE = /^stall-sample-.*\.txt$/
/** 日志里每帧最多这么长（C++ 签名可以很长；完整的在采样文件里） */
const MAX_FRAME_CHARS = 200

/** 采样文件名：stall-sample-20261007-045841.txt（本地时间，按名字排序即按时间排序） */
export function sampleFileName(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `stall-sample-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.txt`
  )
}

/** 调用图里的一行：`<树形前缀><样本数> <帧>`；前缀长度即深度 */
interface GraphLine {
  depth: number
  count: number
  frame: string
}

const THREAD_HEADER_RE = /^\s*\d+\s+Thread_\S+/

function parseGraphLine(line: string): GraphLine | null {
  const m = /^([\s+!:|]*?)(\d+) (.*)$/.exec(line)
  if (!m) return null
  const frame = m[3]
    .replace(/\s+\[0x[0-9a-f]+\]\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return { depth: m[1].length, count: Number(m[2]), frame }
}

/**
 * 从 `sample` 输出的 "Call graph:" 里找主线程的线程块（各行原样，不含线程头）。
 *
 * 主线程的标签是它**此刻正在执行的**派发队列：平时是 `com.apple.main-thread`，同步跑别的队列时就换成
 * 那个队列的名字（实测卡在 Metal 设备注册时是 `com.Metal.DeviceDispatch`）。所以按栈底认：主线程的
 * 根帧是 `start (in dyld)`，其余线程是 `thread_start`。两样都认不出就取第一个线程块。
 */
function mainThreadBlock(text: string): { header: string; lines: string[] } | null {
  const all = text.split(/\r?\n/)
  const graphAt = all.findIndex((l) => l.startsWith('Call graph:'))
  if (graphAt < 0) return null
  const blocks: { header: string; lines: string[] }[] = []
  for (let i = graphAt + 1; i < all.length; i++) {
    const line = all[i]
    if (line.trim() === '') break
    if (THREAD_HEADER_RE.test(line)) blocks.push({ header: line.trim(), lines: [] })
    else blocks.at(-1)?.lines.push(line)
  }
  return (
    blocks.find((b) => b.header.includes('com.apple.main-thread')) ??
    blocks.find((b) => /\bstart\s+\(in dyld\)/.test(b.lines[0] ?? '')) ??
    blocks[0] ??
    null
  )
}

/**
 * 主线程的最重路径：从根帧起每层取样本数最多的子帧，叶子在最后。卡住的线程所有样本都一样，
 * 这条路径就是它卡住时的完整调用链。返回的第一行是线程头，之后每行 `<样本数> <帧>`，最多 maxLines 行。
 */
export function extractMainThreadCallGraph(text: string, maxLines: number): string[] {
  const block = mainThreadBlock(text)
  if (!block) return []
  const nodes = block.lines.map(parseGraphLine).filter((n): n is GraphLine => n !== null)
  const path: GraphLine[] = []
  let i = 0
  while (i < nodes.length) {
    const node = nodes[i]
    path.push(node)
    // 子帧：紧随其后、深度更深的行里，深度最浅的那一层
    let best = -1
    let childDepth = Number.POSITIVE_INFINITY
    for (let j = i + 1; j < nodes.length && nodes[j].depth > node.depth; j++) {
      if (nodes[j].depth < childDepth) {
        childDepth = nodes[j].depth
        best = -1
      }
      if (nodes[j].depth === childDepth && (best < 0 || nodes[j].count > nodes[best].count)) {
        best = j
      }
    }
    if (best < 0) break
    i = best
  }
  const out = [block.header, ...path.map((n) => `${n.count} ${n.frame}`.slice(0, MAX_FRAME_CHARS))]
  if (out.length <= maxLines) return out
  // 太长时留头（线程头 + 根）和尾（叶子才是卡住的地方）；行数给得太少就只留线程头与叶子那一端
  if (maxLines < 5) return [out[0], ...out.slice(out.length - Math.max(0, maxLines - 1))]
  const head = 3
  const tail = maxLines - head - 1
  return [...out.slice(0, head), `… ${out.length - head - tail} frames …`, ...out.slice(-tail)]
}

/** 目录里的采样文件只留最新的 keep 份 */
export async function pruneSampleFiles(dir: string, keep: number): Promise<void> {
  const names = (await readdir(dir)).filter((n) => SAMPLE_FILE_RE.test(n)).sort()
  const stale = names.slice(0, Math.max(0, names.length - keep))
  await Promise.all(stale.map((n) => unlink(join(dir, n)).catch(() => undefined)))
}

export interface NativeSampleOptions {
  pid: number
  seconds: number
  dir: string
  keepFiles: number
  /** 主线程调用链在日志里最多几行 */
  maxLines: number
  now?: Date
  /** 可注入（单测用） */
  binary?: string
}

/** 跑一次 `sample <pid> <seconds> -file <dir>/stall-sample-*.txt`，返回文件路径与主线程调用链 */
export function captureNativeSample(opts: NativeSampleOptions): Promise<NativeSampleResult> {
  const file = join(opts.dir, sampleFileName(opts.now ?? new Date()))
  return new Promise<NativeSampleResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        opts.binary ?? SAMPLE_BINARY,
        [String(opts.pid), String(opts.seconds), '-file', file],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      return
    }
    let stderr = ''
    let settled = false
    // sample 自己若也被同一个系统问题卡住，别让它一直挂着
    const killTimer = setTimeout(
      () => {
        child.kill('SIGKILL')
        done({ ok: false, error: `${opts.binary ?? SAMPLE_BINARY} did not finish in time` })
      },
      (opts.seconds + 20) * 1000
    )
    function done(r: NativeSampleResult): void {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve(r)
    }
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 4096) stderr += c.toString()
    })
    child.on('error', (err) => done({ ok: false, error: err.message }))
    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) {
        const why = stderr.trim().split('\n')[0] || `exit code ${code}`
        done({ ok: false, error: why })
        return
      }
      readFile(file, 'utf8')
        .then(async (text) => {
          await pruneSampleFiles(opts.dir, opts.keepFiles).catch(() => undefined)
          done({ ok: true, file, mainThread: extractMainThreadCallGraph(text, opts.maxLines) })
        })
        .catch((err: Error) => done({ ok: false, error: `cannot read ${file}: ${err.message}` }))
    })
  })
}
