/**
 * e2e 隔离实例的自保：harness 没了，实例要自己走，而且走之前不能把磁盘写满。
 *
 * 由 bootstrap.cjs 在实例主进程里使用；本文件**不依赖 electron**，所以 spec 也能在普通 node 里
 * 直接 require 它测（见 specs/startup/orphan-exit.e2e.ts）。
 *
 * 事故（2026-10-09）：几个实例活过了启动它们的 vitest 进程（运行被掐断 / 变异测试 / VM 时钟跳变让
 * 等待提前结束），各自往 `e2e-uncaught.log` 里写了 ~25 GB。机理：父进程那一头的 stdout / stderr 管道
 * 没了，electron-log 的 console transport（`console.warn`）写管道得到异步的 `write EPIPE` —— Node 的
 * console 只在写调用期间挂一个临时 'error' 监听，异步到达的错误于是成了 uncaughtException；记录它的
 * handler 自己又往 stderr 写一行 → 又一个 EPIPE → 又记一条 …… 永不停止，进程也永不退出。
 *
 * 三道闸，各管一种情况：
 *   1. 管道断了（EPIPE / ERR_STREAM_DESTROYED）= harness 已经不在 —— 不再写控制台，退出（bootstrap）；
 *   2. 每个由 bootstrap 追加的文件都有上限（`createBoundedAppender`），到顶写一行截断标记后不再追加；
 *   3. 什么都不打日志时也要发现 launcher 没了（`watchLauncher`）：父进程 pid 变了（被 launchd /
 *      init / subreaper 收养），或者 harness 传进来的 launcher pid 已经不存在。
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 CommonJS，类型写在 JSDoc 里 */
const { appendFileSync, statSync } = require('fs')

/** 每个文件的缺省上限：正常运行这些文件至多几 KB，5 MB 只会是失控 */
const DEFAULT_LOG_LIMIT_BYTES = 5 * 1024 * 1024

/** 到顶时写的那一行（之后这个文件不再增长） */
const TRUNCATED_MARKER = '[e2e] log truncated: size limit reached, further entries dropped'

/** harness 用来告诉实例「是谁启动了你」的环境变量（launch.ts 的 instanceEnv 填 process.pid） */
const LAUNCHER_PID_ENV = 'SHUVIX_E2E_LAUNCHER_PID'

/**
 * 这个错误是不是「对端已经关掉的管道 / 已销毁的流」—— 写 stdout / stderr 时出现它，就是 harness 不在了。
 * @param {unknown} err
 * @returns {boolean}
 */
function isBrokenPipe(err) {
  const code =
    err && typeof err === 'object' ? /** @type {{ code?: unknown }} */ (err).code : undefined
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
}

/**
 * 带上限的追加器：每个文件一份计数（首次用到时按磁盘上的现有大小起算 —— 复用的 HOME 里可能已有内容）。
 * 下一段会越过上限时写一行 TRUNCATED_MARKER，此后对这个文件的追加一律丢弃。写失败不计数、不抛。
 * @param {number} [limitBytes]
 * @returns {(file: string, text: string) => boolean} 这段是否真的写进去了
 */
function createBoundedAppender(limitBytes = DEFAULT_LOG_LIMIT_BYTES) {
  /** @type {Map<string, number>} 已写字节数；-1 = 已截断 */
  const sizes = new Map()
  return (file, text) => {
    let size = sizes.get(file)
    if (size === undefined) {
      try {
        size = statSync(file).size
      } catch {
        size = 0
      }
      // 已经是满的（上一个实例写满、标记也已写过）：不再追加，也不重复写标记
      if (size >= limitBytes) size = -1
      sizes.set(file, size)
    }
    if (size < 0) return false
    const bytes = Buffer.byteLength(text)
    if (size + bytes > limitBytes) {
      sizes.set(file, -1)
      try {
        appendFileSync(file, `${TRUNCATED_MARKER}\n`)
      } catch {
        // 标记写不下也一样：反正不再追加了
      }
      return false
    }
    try {
      appendFileSync(file, text)
    } catch {
      return false
    }
    sizes.set(file, size + bytes)
    return true
  }
}

/**
 * launcher 还在吗？在就回 null，不在就回一句原因。
 *
 * 两个判据，任一成立即「不在」：
 *   - `process.ppid` 变了 —— 父进程死后，macOS 上实例被 launchd（1）收养，Linux 上被 init 或最近的
 *     subreaper 收养；这一条不受 pid 复用影响；
 *   - harness 传入的 launcher pid 发 0 号信号得到 ESRCH（EPERM = 进程在、只是不归我们管，算在）。
 * @param {number | undefined} launcherPid
 * @param {number} initialPpid
 * @returns {string | null}
 */
function launcherGoneReason(launcherPid, initialPpid) {
  const ppid = process.ppid
  if (ppid !== initialPpid) return `parent process changed (${initialPpid} -> ${ppid})`
  if (launcherPid) {
    try {
      process.kill(launcherPid, 0)
    } catch (err) {
      if (err && /** @type {{ code?: unknown }} */ (err).code === 'ESRCH') {
        return `launcher process ${launcherPid} is gone`
      }
    }
  }
  return null
}

/**
 * 每 `intervalMs` 看一次 launcher 还在不在；不在就停表并回调一次。定时器 unref：它自己不撑着进程。
 * @param {{ launcherPid?: number, intervalMs?: number, onGone: (reason: string) => void }} opts
 * @returns {NodeJS.Timeout}
 */
function watchLauncher({ launcherPid, intervalMs = 2000, onGone }) {
  const initialPpid = process.ppid
  const timer = setInterval(() => {
    const reason = launcherGoneReason(launcherPid, initialPpid)
    if (!reason) return
    clearInterval(timer)
    onGone(reason)
  }, intervalMs)
  timer.unref()
  return timer
}

/**
 * 从环境变量读 launcher pid；没给 / 不是正整数就是 undefined（只剩 ppid 判据）。
 * @param {NodeJS.ProcessEnv} env
 * @returns {number | undefined}
 */
function launcherPidFromEnv(env) {
  const pid = Number(env[LAUNCHER_PID_ENV])
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

module.exports = {
  DEFAULT_LOG_LIMIT_BYTES,
  TRUNCATED_MARKER,
  LAUNCHER_PID_ENV,
  isBrokenPipe,
  createBoundedAppender,
  launcherGoneReason,
  watchLauncher,
  launcherPidFromEnv
}
