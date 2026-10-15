/**
 * 无头实例的地址文件与「第二个实例」的裁决（docs/headless/design.md §1 Lifecycle）。
 *
 * 单实例锁只让第二个进程把 argv 交给第一个、自己退出 —— 回话的方向没有（Electron 的 ack 回调已经去掉了）。
 * 可第二个 `shuvix --headless` 该告诉敲命令的人「已经在跑了，地址是这些」。所以无头实例拿到锁之后在 userData
 * 里写一个小文件 `headless.json`（pid、端口、能打开的地址），开始监听后补上地址，退出时删掉；第二个实例拿不到锁时
 * 读它：
 *
 *  - 文件在、pid 活着（且就是锁的持有者，读得到的话）→ 跑着的是无头实例：打印它的地址，退出码 0
 *    （第二个实例带不带 `--headless` 都一样 —— 无头进程里不开窗）；
 *  - 否则跑着的是桌面应用：第二个实例要无头 → 打印一句「先退出桌面应用」，退出码 1；不要无头 → 照旧（把 argv
 *    交给桌面应用，它把主窗口带到眼前）。
 *
 * 文件不是秘密（地址本来就打印在 stdout / 设置页里），写法是临时文件 + rename，读时不合形状一律当没有。
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEADLESS_DESKTOP_RUNNING_LINE, headlessAlreadyRunningLine } from './headless'

/** userData 下的地址文件名 */
export const HEADLESS_ADDRESS_FILE = 'headless.json'

/** 地址文件的内容 */
export interface HeadlessAddress {
  /** 无头实例的 pid */
  readonly pid: number
  /** 监听的端口（还没开始监听 → 没有） */
  readonly port?: number
  /** 能打开的地址（还没开始监听 → 空） */
  readonly urls: readonly string[]
}

/** 写（覆盖）地址文件；写不进去只回 false —— 它只是给第二个实例看的 */
export function writeHeadlessAddress(dir: string, address: HeadlessAddress): boolean {
  const file = join(dir, HEADLESS_ADDRESS_FILE)
  const tmp = `${file}.${address.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(address)}\n`)
    renameSync(tmp, file)
    return true
  } catch {
    rmSync(tmp, { force: true })
    return false
  }
}

/** 读地址文件；不存在 / 读不了 / 不合形状 → null */
export function readHeadlessAddress(dir: string): HeadlessAddress | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, HEADLESS_ADDRESS_FILE), 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { pid, port, urls } = raw as { pid?: unknown; port?: unknown; urls?: unknown }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null
  if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string')) return null
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port))) return null
  return { pid, ...(port === undefined ? {} : { port }), urls: urls as string[] }
}

/** 删地址文件 —— 只删自己写的那份（pid 对得上），别的实例刚写的不碰 */
export function removeHeadlessAddress(dir: string, pid: number): void {
  if (readHeadlessAddress(dir)?.pid !== pid) return
  rmSync(join(dir, HEADLESS_ADDRESS_FILE), { force: true })
}

/** 进程是否还在（EPERM = 在，只是不归我们管） */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 第二个实例的处置：打印一行（没有 = 照旧不打印）、以什么码退出 */
export interface SecondInstanceVerdict {
  readonly line?: string
  readonly exitCode: number
}

/**
 * 拿不到单实例锁的进程该怎么办。`address`：读到的地址文件；`alive`：判活（缺省 `kill(pid, 0)`）；
 * `lockHolderPid`：锁此刻的持有者（读不出来 → undefined，只看判活）。
 */
export function secondInstanceVerdict(input: {
  readonly wantsHeadless: boolean
  readonly address: HeadlessAddress | null
  readonly lockHolderPid?: number
  readonly alive?: (pid: number) => boolean
}): SecondInstanceVerdict {
  const alive = input.alive ?? isProcessAlive
  const address = input.address
  const headlessRunning =
    address !== null &&
    alive(address.pid) &&
    (input.lockHolderPid === undefined || input.lockHolderPid === address.pid)
  if (headlessRunning) return { line: headlessAlreadyRunningLine(address.urls), exitCode: 0 }
  if (input.wantsHeadless) return { line: HEADLESS_DESKTOP_RUNNING_LINE, exitCode: 1 }
  return { exitCode: 0 }
}
