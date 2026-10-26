import { closeSync, fstatSync, openSync, readSync } from 'fs'
import log from '../logger'
import { APP_LOG_TAIL_BYTES, type AppLogCursor, type AppLogTail } from '../../shared/appLog'

/**
 * 应用日志（main.log）—— 设置 → 关于 显示它的路径，设置 → 监视器 → 应用日志 读它的尾部。
 *
 * 只读最后 APP_LOG_TAIL_BYTES：文件满 5MB 才轮转，整份读进来再整份发给页面不值得。跟随时页面带着上次的游标再来，
 * 只读新增的部分；文件换了（electron-log 把它改名成 main.old.log、另起一份）或者落后太多，就从尾部重新读。
 * 只返回完整的行：末尾还没写完的半行留到下一次（也就不会把一个多字节字符切成两半）。
 */

const NEWLINE = 0x0a

/** main.log 的绝对路径（electron-log 按平台定：macOS ~/Library/Logs/ShuviX/，Windows / Linux 在应用数据目录的 logs/ 下） */
export function appLogPath(): string {
  return log.transports.file.getFile().path
}

export function readAppLogTail(
  path: string,
  cursor?: AppLogCursor | null,
  maxBytes: number = APP_LOG_TAIL_BYTES
): AppLogTail {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return { path, fileId: '', start: 0, end: 0, text: '', reset: true, truncated: false }
  }
  try {
    const stat = fstatSync(fd)
    const fileId = `${stat.dev}:${stat.ino}`
    const size = stat.size
    const follows =
      !!cursor &&
      cursor.fileId === fileId &&
      cursor.offset <= size &&
      size - cursor.offset <= maxBytes
    const from = follows ? cursor.offset : Math.max(0, size - maxBytes)
    const buf = Buffer.allocUnsafe(size - from)
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, from + read)
      if (n <= 0) break
      read += n
    }
    const bytes = buf.subarray(0, read)
    // 从中间开始读的，第一行多半是半截：扔掉
    let head = 0
    if (!follows && from > 0) {
      const nl = bytes.indexOf(NEWLINE)
      head = nl < 0 ? bytes.length : nl + 1
    }
    const lastNl = bytes.lastIndexOf(NEWLINE)
    const tail = lastNl < head ? head : lastNl + 1
    return {
      path,
      fileId,
      start: from + head,
      end: from + tail,
      text: bytes.subarray(head, tail).toString('utf-8'),
      reset: !follows,
      truncated: !follows && from + head > 0
    }
  } finally {
    closeSync(fd)
  }
}
