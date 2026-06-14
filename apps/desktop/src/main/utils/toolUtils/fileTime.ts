/**
 * 文件读取时间追踪（FileTime）
 * 防止 AI 基于过期内容覆盖用户手动编辑的文件
 * - read 工具成功读取文件后调用 recordRead 记录时间戳
 * - edit/write 工具执行前调用 assertNotModifiedSinceRead 校验文件是否被外部修改
 * - withFileLock 对同一文件的并发写操作串行化
 */

import { statSync } from 'node:fs'

/** per-session 文件读取时间戳：Map<sessionId, Map<filePath, Date>> */
const readTimes = new Map<string, Map<string, Date>>()

/** per-file 写锁（Promise 链式锁，串行化并发写操作） */
const fileLocks = new Map<string, Promise<void>>()

/** 记录文件读取时间（read 工具成功读取后调用） */
export function recordRead(sessionId: string, filePath: string): void {
  let session = readTimes.get(sessionId)
  if (!session) {
    session = new Map()
    readTimes.set(sessionId, session)
  }
  session.set(filePath, new Date())
}

/** 获取文件上次读取时间 */
export function getReadTime(sessionId: string, filePath: string): Date | undefined {
  return readTimes.get(sessionId)?.get(filePath)
}

/**
 * 校验文件自上次读取后是否被外部修改
 * - 如果该 session 从未读取过此文件 → 抛错
 * - 如果文件 mtime > 记录的读取时间（允许 50ms 容差）→ 抛错
 */
export function assertNotModifiedSinceRead(sessionId: string, filePath: string): void {
  const time = getReadTime(sessionId, filePath)
  if (!time) {
    throw new Error(
      `You must read file ${filePath} before overwriting it. Use the read tool first.`
    )
  }

  let mtime: Date | undefined
  try {
    mtime = statSync(filePath).mtime
  } catch {
    // 文件不存在（可能已被删除），允许写入
    return
  }

  // 允许 50ms 容差（Windows NTFS 时间戳精度 / 异步刷盘）
  if (mtime && mtime.getTime() > time.getTime() + 50) {
    throw new Error(
      `File ${filePath} has been modified since it was last read.\n` +
        `Last modification: ${mtime.toISOString()}\n` +
        `Last read: ${time.toISOString()}\n\n` +
        `Please read the file again before modifying it.`
    )
  }
}

/**
 * 文件写锁：对同一文件的并发写操作串行化
 * 确保多个工具同时写同一文件时按顺序执行
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = fileLocks.get(filePath) ?? Promise.resolve()
  let release: () => void = () => {}
  const nextLock = new Promise<void>((resolve) => {
    release = resolve
  })
  const chained = currentLock.then(() => nextLock)
  fileLocks.set(filePath, chained)

  await currentLock
  try {
    return await fn()
  } finally {
    release()
    if (fileLocks.get(filePath) === chained) {
      fileLocks.delete(filePath)
    }
  }
}

/** 清理指定 session 的所有记录（Agent 销毁时调用） */
export function clearSession(sessionId: string): void {
  readTimes.delete(sessionId)
}

/** 清理所有状态（仅用于测试） */
export function _resetAll(): void {
  readTimes.clear()
  fileLocks.clear()
}
