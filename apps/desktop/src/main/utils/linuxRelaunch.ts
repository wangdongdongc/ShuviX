/**
 * Linux 上不经 `app.relaunch()` 重启 ShuviX（deb 更新装完之后用）。
 *
 * `app.relaunch()` 在 Linux 上让新进程永远带着 NoNewPrivs=1：Electron 的 RelaunchAppWithHelper 用缺省的
 * `base::LaunchOptions` 起 helper，而 Chromium 的缺省就是给子进程设 PR_SET_NO_NEW_PRIVS；这个标记设上就清不掉，
 * helper 之后拉起的应用连同它启动的所有命令都继承。于是重启出来的这次运行里 setuid 全部失效：下一次更新的 pkexec
 * 退出码 127（「pkexec must be setuid root」），agent 命令里的 sudo 也用不了；真正走 SUID 沙箱的系统上新进程干脆
 * 起不来（chrome-sandbox 不是 root）。用户看到的就是「第一次更新成功，第二次失败」，与 chrome-sandbox 的权限无关。
 * 手动退出、再从应用菜单打开就恢复（2026-11-02 在 Ubuntu 24.04 + Electron 39.8.2 上实测）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createLogger } from '../logger'

const log = createLogger('LinuxRelaunch')

/**
 * helper（bash，deb 系统上一定有，electron-updater 装包也用它）：
 *  1. 先关掉继承来的 fd（只留 0/1/2）。Chromium 自己起进程时会关光，libuv 的 spawn 不管，而 Chromium 的 fd 大多没有
 *     CLOEXEC，不关就全漏进新实例（实测主进程 fd 从 93 个涨到 147 个）：旧的监听 socket 占着端口、没人 accept，新实例
 *     自己绑不上；旧实例的数据文件和 socket 也一直被占着。开头就关，等待期间也不占。
 *  2. 等父进程退出：stdin 是通向主进程的管道，它一退出内核就关掉那一端，`read` 读到 EOF。不轮询 pid：退出后还没被回收的
 *     僵尸进程 `kill -0` 也算活着，而主进程的父进程是谁我们管不了。
 *  3. 把自己换成要启动的程序，它的 stdin 换成 /dev/null，不留着这条管道。
 */
export const WAIT_FOR_PARENT_EXIT_SCRIPT = [
  'for f in /dev/fd/*; do n=${f##*/}; case $n in 0|1|2|\\*) ;; *) eval "exec $n>&-" ;; esac; done',
  'read -r x',
  'exec "$@" </dev/null'
].join('; ')

/** 这个进程是否带着 NoNewPrivs（读不到 —— 比如没有 /proc —— 当作没有，照旧走安装） */
export function hasNoNewPrivs(
  readStatus: () => string = () => readFileSync('/proc/self/status', 'utf8')
): boolean {
  try {
    return /^NoNewPrivs:\s*1\s*$/m.test(readStatus())
  } catch {
    return false
  }
}

/**
 * 当前进程退出后，用同样的命令行再启动一次 ShuviX（与 `app.relaunch()` 的缺省一样：同一条命令行、环境与工作目录）。
 * 普通的 `spawn` 不碰 NoNewPrivs。还没退出时这里什么都不发生，退出不了（比如被拦下）也就不会多出一个实例。
 */
export function relaunchAfterExit(
  execPath: string = process.execPath,
  args: readonly string[] = process.argv.slice(1)
): ChildProcess {
  const child = spawn('/bin/bash', ['-c', WAIT_FOR_PARENT_EXIT_SCRIPT, 'bash', execPath, ...args], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore']
  })
  child.on('error', (err) => log.error(`relaunch failed: ${err.message}`))
  child.unref()
  return child
}
