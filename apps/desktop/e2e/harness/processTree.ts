/**
 * 一个 e2e 实例的进程树：它占了多少内存，它的子进程退干净了没有。
 *
 * Electron 主进程之下还有 GPU、网络、渲染这些 Chromium 子进程。主进程一退，它们要过一会儿才发现父进程没了，
 * 期间被 launchd 收养、不再是谁的后代 —— 只按主进程的 pid 等，会在它们还活着时就起下一个实例。机器内存吃紧时
 * 这段重叠会变长，两个实例的内存叠在一起（2026-10-21 的全量 e2e 因此把 12 GB 的机器跑满，后面的实例 60 秒起不来）。
 * 所以采样时顺手记下见过的每个后代 pid，收尾时等的是它们全体。
 *
 * 内存峰值记进运行记录（historyReporter 按 spec 文件读 `memRecordPath`），用来看哪些 spec 重。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SAMPLE_MS = 2000

interface ProcRow {
  pid: number
  ppid: number
  rssKb: number
}

function processTable(): ProcRow[] {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .split('\n')
      .flatMap((line) => {
        const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number)
        return Number.isFinite(pid) && Number.isFinite(ppid) ? [{ pid, ppid, rssKb: rss || 0 }] : []
      })
  } catch {
    return []
  }
}

/** root 自己与它此刻的全部后代 */
function treeOf(rootPid: number, table: readonly ProcRow[]): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>()
  for (const row of table) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row])
  const out: ProcRow[] = []
  const stack = table.filter((r) => r.pid === rootPid)
  while (stack.length) {
    const row = stack.pop()!
    out.push(row)
    stack.push(...(byParent.get(row.pid) ?? []))
  }
  return out
}

/** 只认真实的子进程 pid：0 / 负数 / 1 交给 kill 会把信号发给整个进程组、所有进程或 launchd */
function isRealPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1
}

function isAlive(pid: number): boolean {
  if (!isRealPid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 这个 pid 此刻还是 Electron 的进程（主进程或 Helper）吗 —— 补刀之前核一下，防 pid 已被别的进程复用 */
function isElectronProcess(pid: number): boolean {
  try {
    return /electron/i.test(
      execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' })
    )
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface InstanceTree {
  /** 进程树内存的峰值（MB，至今为止） */
  peakRssMb(): number
  /**
   * 等主进程与见过的每个子进程都退出（上限 `ms`，到点还活着的补 SIGKILL 再等一会儿）。
   * 交回补刀杀掉的个数（0 = 都自己退了）
   */
  waitGone(ms: number): Promise<number>
  /** 停止采样 */
  stop(): void
}

/** 从 spawn 之后开始盯这棵进程树（spawn 没拿到 pid → 什么都不盯、什么都不杀） */
export function watchInstanceTree(rootPid: number): InstanceTree {
  if (!isRealPid(rootPid)) {
    return { peakRssMb: () => 0, waitGone: async () => 0, stop: () => undefined }
  }
  const seen = new Set<number>([rootPid])
  let peakKb = 0
  const sample = (): void => {
    const tree = treeOf(rootPid, processTable())
    for (const row of tree) if (isRealPid(row.pid)) seen.add(row.pid)
    const kb = tree.reduce((sum, row) => sum + row.rssKb, 0)
    if (kb > peakKb) peakKb = kb
  }
  sample()
  const timer = setInterval(sample, SAMPLE_MS)
  timer.unref()
  return {
    peakRssMb: () => Math.round(peakKb / 1024),
    async waitGone(ms) {
      // 主进程还在时再采一次：退出前刚起的子进程也要算进来
      if (isAlive(rootPid)) sample()
      const t0 = Date.now()
      while ([...seen].some(isAlive) && Date.now() - t0 < ms) await sleep(100)
      const left = [...seen].filter((pid) => isAlive(pid) && isElectronProcess(pid))
      for (const pid of left) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* 刚好退了 */
        }
      }
      const t1 = Date.now()
      while (left.some(isAlive) && Date.now() - t1 < 2000) await sleep(50)
      return left.length
    },
    stop: () => clearInterval(timer)
  }
}

// ─── 交给运行记录的那一份（spec 文件在 worker 里跑，reporter 在主进程里读） ───

/** 某个 spec 文件的内存记录放在哪（按文件的绝对路径散列，不同 worktree 的同名文件不会撞） */
export function memRecordPath(testFile: string): string {
  const key = createHash('sha1').update(testFile).digest('hex').slice(0, 16)
  return join(tmpdir(), 'shuvix-e2e-mem', `${key}.json`)
}

export interface MemRecord {
  /** 这个文件里起过的实例里，进程树内存最高的那个峰值（MB） */
  peakRssMb: number
  /** 这个文件起过几个实例 */
  instances: number
  /** 收尾时还得补刀才退的子进程数（累计） */
  killedStragglers: number
  /** 收尾时等子进程退出花掉的毫秒数（累计） */
  teardownMs: number
}

/** 一个实例收尾时并进它所在 spec 文件的记录 */
export function recordInstanceMemory(
  testFile: string | undefined,
  peakRssMb: number,
  killedStragglers: number,
  teardownMs: number
): void {
  if (!testFile) return
  const path = memRecordPath(testFile)
  try {
    const prev = readMemRecord(testFile, false)
    const next: MemRecord = {
      peakRssMb: Math.max(prev?.peakRssMb ?? 0, peakRssMb),
      instances: (prev?.instances ?? 0) + 1,
      killedStragglers: (prev?.killedStragglers ?? 0) + killedStragglers,
      teardownMs: (prev?.teardownMs ?? 0) + teardownMs
    }
    mkdirSync(join(tmpdir(), 'shuvix-e2e-mem'), { recursive: true })
    writeFileSync(path, JSON.stringify(next))
  } catch {
    /* 记不下不影响用例 */
  }
}

/** 读一个 spec 文件的内存记录（`consume` = 读完删掉，reporter 用） */
export function readMemRecord(testFile: string, consume = true): MemRecord | undefined {
  const path = memRecordPath(testFile)
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as MemRecord
    if (consume) rmSync(path, { force: true })
    return record
  } catch {
    return undefined
  }
}
