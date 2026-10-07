/**
 * 单实例锁的持有者（启动诊断）。
 *
 * `app.requestSingleInstanceLock()` 背后是 Chromium 的 ProcessSingleton：`<userData>/SingletonLock`
 * 是一个符号链接，指向 `<hostname>-<pid>`。锁若指向一个**还活着**的进程，新进程会在主线程上同步地
 * 去敲那个进程的 socket，等它回话、或等它死掉 —— 典型场景是上一次的 ShuviX 正在退出（会话收尾、
 * Chromium 原生收尾），用户又点开了应用。这段等待发生在 ready 之前，JS 栈里只看得见这一行调用。
 *
 * 所以加锁之前先看一眼：持有者活着就记一行，日志里那段卡顿的原因就不用猜。
 * 只读一个符号链接 + 一次 kill(pid, 0)，锁不存在或持有者已死时一行不写。
 */
import { readlinkSync } from 'node:fs'
import { join } from 'node:path'

export const SINGLETON_LOCK_FILE = 'SingletonLock'

export interface SingletonLockHolder {
  host: string
  pid: number
}

/** 进程是否还在（EPERM = 在，只是不归我们管） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `<userData>/SingletonLock` 指向的、仍然活着的另一个进程；没有锁 / 持有者已死 / 是自己都回 null */
export function liveSingletonLockHolder(userDataDir: string): SingletonLockHolder | null {
  let target: string
  try {
    target = readlinkSync(join(userDataDir, SINGLETON_LOCK_FILE))
  } catch {
    return null
  }
  const m = /^(.*)-(\d+)$/.exec(target)
  if (!m) return null
  const pid = Number(m[2])
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return null
  return isAlive(pid) ? { host: m[1], pid } : null
}
