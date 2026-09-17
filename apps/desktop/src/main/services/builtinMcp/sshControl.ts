/**
 * ssh 的连接复用层 —— **ControlMaster 就是连接池**。
 *
 * 不自己维护连接对象：每条命令都带上同一个 control socket，第一条顺手成为 master，
 * 后续的复用它的 TCP 与那一次认证，第二条起几乎没有握手开销。于是「一个会话同时连多台」
 * 不需要任何连接管理代码 —— 参数里换个别名而已。
 *
 * **Windows 没有 ControlMaster**（Win32-OpenSSH 至今不支持 Unix socket 多路复用），而且更阴的是：
 * 用户配置里若全局设了 ControlMaster，`ssh.exe` 会直接以 `getsockname failed` 失败，**省略参数
 * 救不了**。所以那边显式传 `-o ControlMaster=no -o ControlPath=none` 把它按掉，降级成每条命令
 * 各自建连 —— 功能一致，只是慢。
 *
 * 一律 `-o BatchMode=yes`：任何交互提示（密码、passphrase、主机指纹）在这里都只会挂死。
 * 代价是首次连一台陌生主机会直接失败，这被刻意转成一条可操作的说明（见 classifySshFailure）。
 */
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { userInfo } from 'os'
import { buildSpawnEnv } from '../../utils/paths'
import { createLogger } from '../../logger'

const log = createLogger('ssh:control')

/** master 在最后一条命令之后还活多久 */
const CONTROL_PERSIST = '10m'
/** 建连超时（秒） */
const CONNECT_TIMEOUT_SEC = 15

const isWindows = process.platform === 'win32'

export interface SshExecResult {
  stdout: string
  stderr: string
  /** 命令的退出码；超时为 124；ssh 自身失败（连不上等）为 255 */
  exitCode: number
  timedOut: boolean
}

/**
 * control socket 的根目录。
 *
 * 放 `/tmp` 而不是 `~/.shuvix`：Unix domain socket 的路径有 104 字节上限，而 macOS 的
 * `os.tmpdir()` 本身就有五十来字符，套上会话 id 很容易越界。固定短前缀 + 16 位哈希稳稳在限内。
 */
function controlRoot(): string {
  const uid = typeof userInfo().uid === 'number' ? userInfo().uid : 0
  return `/tmp/shuvix-ssh-${uid}`
}

/** 某条会话某台主机的 control socket 路径（Windows 无此概念） */
function controlPath(sessionId: string, alias: string): string | undefined {
  if (isWindows) return undefined
  // sessionId 是 uuidv7，不含冒号，所以这个分隔符不会让两组不同输入撞成同一串
  const hash = createHash('sha256').update(sessionId).update(':').update(alias).digest('hex')
  return join(controlRoot(), hash.slice(0, 16))
}

function ensureControlRoot(): void {
  if (isWindows) return
  // 0700：socket 目录里躺着的是活的、已认证的连接，别人能连上就等于借用了你的身份
  mkdirSync(controlRoot(), { recursive: true, mode: 0o700 })
}

/**
 * `-F` 覆写配置文件。
 *
 * 不是测试专用的口子：`configPath` 覆写若只作用于枚举（listSshHosts）而 `ssh` 仍读用户真实配置，
 * 两边看到的就是两份不同的文件 —— 别名对得上纯属巧合。要覆写就两边一起覆写。
 * 注意 OpenSSH 的 `~` 展开走 getpwuid()，改 `$HOME` 是没用的，只有 `-F` 算数。
 */
function configArgs(configPath: string | undefined): string[] {
  return configPath ? ['-F', configPath] : []
}

/** 复用/多路复用相关的固定参数 */
function multiplexArgs(sock: string | undefined): string[] {
  if (!sock) {
    // Windows：显式按掉，否则用户配置里的全局 ControlMaster 会让 ssh.exe 直接报错
    return ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']
  }
  return [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${sock}`,
    '-o',
    `ControlPersist=${CONTROL_PERSIST}`
  ]
}

/** 跑一个 ssh 子进程，收集输出 */
function runSsh(
  args: string[],
  opts: { timeoutSec: number; signal?: AbortSignal }
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const child = spawn('ssh', args, {
      env: buildSpawnEnv() as NodeJS.ProcessEnv,
      // stdin 直接关掉：BatchMode 下没有交互，留着只会让读 stdin 的远端命令等到超时
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const kill = (): void => {
      child.kill('SIGTERM')
      // 远端还在跑时 SIGTERM 未必收得住本地进程，给一小段宽限后强杀
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 2000).unref()
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutSec * 1000)

    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    function onAbort(): void {
      kill()
      done(() => reject(new Error('Aborted')))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8')
    })
    child.on('error', (err) => {
      done(() =>
        reject(
          new Error(
            err.message.includes('ENOENT')
              ? 'The `ssh` command was not found on this machine. Install OpenSSH and try again.'
              : `Failed to run ssh: ${err.message}`
          )
        )
      )
    })
    child.on('close', (code) => {
      done(() => resolve({ stdout, stderr, exitCode: timedOut ? 124 : (code ?? 1), timedOut }))
    })
  })
}

/**
 * 在远端跑一条命令。`alias` 必须是调用方已经核对过的 `~/.ssh/config` 别名 ——
 * 这里不做核对，核对在 server 那一层（见 sshServer 的 resolveAlias）。
 */
export async function sshExec(opts: {
  sessionId: string
  alias: string
  command: string
  timeoutSec: number
  signal?: AbortSignal
  /** 配置文件覆写；必须与枚举用的是同一份 */
  configPath?: string
}): Promise<SshExecResult> {
  ensureControlRoot()
  const sock = controlPath(opts.sessionId, opts.alias)
  const args = [
    ...configArgs(opts.configPath),
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${CONNECT_TIMEOUT_SEC}`,
    ...multiplexArgs(sock),
    opts.alias,
    opts.command
  ]
  log.info(`exec ${opts.alias}: ${opts.command.slice(0, 80)}`)
  return runSsh(args, { timeoutSec: opts.timeoutSec, signal: opts.signal })
}

/** 关掉某台主机的 master（`ssh -O exit`）。返回「本来是否连着」 */
export async function sshDisconnect(
  sessionId: string,
  alias: string,
  configPath?: string
): Promise<boolean> {
  const sock = controlPath(sessionId, alias)
  if (!sock || !existsSync(sock)) return false
  try {
    await runSsh([...configArgs(configPath), '-o', `ControlPath=${sock}`, '-O', 'exit', alias], {
      timeoutSec: 10
    })
  } catch (err: unknown) {
    log.warn(`disconnect ${alias}: ${err instanceof Error ? err.message : String(err)}`)
  }
  // `-O exit` 正常会自己删掉 socket；残留的清掉，免得下次 ControlMaster=auto 撞上死 socket
  rmSync(sock, { force: true })
  return true
}

/** 这条会话当前连着哪些主机（按 socket 是否存在判断） */
export function sshConnectedAliases(sessionId: string, aliases: string[]): string[] {
  if (isWindows) return []
  return aliases.filter((a) => {
    const sock = controlPath(sessionId, a)
    return !!sock && existsSync(sock)
  })
}

/**
 * 关掉这条会话名下所有 master（会话销毁时）。
 *
 * 不知道会话连过哪些别名，所以按 socket 目录反查：路径是由 sessionId 与别名一起哈希出来的，
 * 拿候选别名重算一遍就能认出自己的那些。认不出的一律不碰 —— 那是别的会话的连接。
 */
export async function sshCloseSession(
  sessionId: string,
  aliases: string[],
  configPath?: string
): Promise<number> {
  if (isWindows || !existsSync(controlRoot())) return 0
  const mine = new Map(aliases.map((a) => [controlPath(sessionId, a) ?? '', a]))
  let closed = 0
  for (const name of readdirSync(controlRoot())) {
    const alias = mine.get(join(controlRoot(), name))
    if (!alias) continue
    if (await sshDisconnect(sessionId, alias, configPath)) closed++
  }
  return closed
}

/**
 * 把 ssh 自身的失败翻译成对 agent 可操作的说明。
 *
 * 首连一台陌生主机在 BatchMode 下必然失败 —— 这是刻意的：ShuviX **不**替用户往
 * `~/.ssh/known_hosts` 写条目。一次「是否信任这台机器」的弹窗，用户在那一刻根本无从核对指纹，
 * 点下去只是安慰；而被提示注入的 agent 正好可以借它把一台中间人机器变成「已信任」。
 * 让用户在自己的终端里连一次，ssh 会把指纹打出来，他能拿别的渠道对照 —— 信任决定留在那里。
 */
export function classifySshFailure(alias: string, stderr: string): string | undefined {
  const s = stderr.toLowerCase()
  if (s.includes('host key verification failed') || s.includes('no matching host key')) {
    return `The host key for "${alias}" is not in the user's known_hosts, so ssh refused to connect. ShuviX will not add it — ask the user to run "ssh ${alias}" once in their own terminal, check the fingerprint it prints, and accept it there. Then retry.`
  }
  if (s.includes('remote host identification has changed')) {
    return `The host key for "${alias}" has CHANGED since it was recorded in known_hosts. That can mean the server was rebuilt — or that the connection is being intercepted. Do not work around it: tell the user and let them resolve it in their own terminal.`
  }
  if (s.includes('permission denied')) {
    return `Authentication to "${alias}" was refused (permission denied). ShuviX holds no credentials — ssh uses the user's own keys and agent. Ask the user to check that the right key is loaded ("ssh-add -l") and that "ssh ${alias}" works in their terminal.`
  }
  if (s.includes('could not resolve hostname') || s.includes('name or service not known')) {
    return `The hostname configured for "${alias}" could not be resolved.`
  }
  if (s.includes('connection timed out') || s.includes('operation timed out')) {
    return `Connecting to "${alias}" timed out after ${CONNECT_TIMEOUT_SEC}s.`
  }
  if (s.includes('connection refused')) {
    return `The SSH port on "${alias}" refused the connection.`
  }
  return undefined
}
