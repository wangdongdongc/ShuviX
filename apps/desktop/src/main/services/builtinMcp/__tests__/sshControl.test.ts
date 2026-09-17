/**
 * sshControl —— 拿**真的 `ssh` / `scp` 二进制**去连一个**进程内真 sshd**（ssh2.Server，
 * exec 通道 + SFTP 子系统）。
 *
 * 这条路比 mock 掉 spawn 值钱得多：握手、认证、exec 通道、SFTP、ControlMaster 多路复用
 * 全是真的，而 ControlMaster 恰恰是客户端侧的特性 —— 对面是不是 OpenSSH 无所谓。
 * 零外部依赖，CI 照跑，不需要 Docker。
 *
 * 复用是否成立的判据不是「跑通了」，而是**服务端数到几次认证**：两条命令一次认证才叫复用；
 * 一次 exec 之后再传文件，那个数一次都不该涨（SSHCTL-U-20 就是这句话的全部内容）。
 *
 * 分组（SSHCTL-U-*）：
 *   1…2    control socket 那个目录 —— 权限收紧与属主复核（路径完全可预测，里面是活的凭据）；
 *   3…6    会话隔离 —— 两条会话两份连接、释放只收自己的、从没连过的不起进程、残留清理；
 *   7…8    中止与超时 —— 子进程真被杀掉（不只是 promise reject），124 是本地编的；
 *   9…11   exec 的 argv —— `-F` / `--` / `-O exit`，以及 Windows 上按掉多路复用后的三处退化；
 *   12…17  ssh 自身失败的翻译表，含「远端有输出就不是 ssh 的错」这两道守卫；
 *   18…26  **文件传输** —— 双向逐字节对得上、复用不再认证、单独一次传输不留 master、
 *          远端路径原样抵达 SFTP（不经任何 shell）、`--` 为何是载荷、scp 自己的失败与挂起、
 *          以及「上传到一个已存在的远端目录」落在哪；
 *   30…35  传输类 argv —— scp 的 `-s` 与 `--`、rsync 的 `-e` 整串、`-e` 被空白切开的已知限制、
 *          Windows 退化、rsync 探测只探一次、起进程失败时报的是**哪个**二进制。
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
  closeSync
} from 'fs'
import { randomBytes } from 'crypto'
// 这条 `spawn` 是下面那层记账包装（见 child_process 的 mock）——「抽掉 `--` 会怎样」
// 的对照组要自己起一次 scp，走同一个出口好让它也落进 spawns.calls
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { Server, utils, type SFTPWrapper } from 'ssh2'

/**
 * 起 ssh 子进程 = 记一笔，然后照常起。
 *
 * 不是假件：`-F`、`--`、`-O exit`、`ControlPath` 这些参数**只在 argv 里看得见**，
 * 而它们每一条都是一次失手就很贵的东西（`--` 少了就是本地任意命令执行，`-F` 少了就是
 * 枚举与建连读着两份不同的配置）。所以透传真 spawn，只在旁边抄一份实参。
 */
const spawns = vi.hoisted(() => ({
  calls: [] as string[][],
  /** 起出来的子进程本体 —— 「中止把它杀了」只有在这里看得见 */
  children: [] as Array<{ killed: boolean; exitCode: number | null; signalCode: string | null }>
}))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const spawn = ((cmd: string, args: string[], opts: unknown) => {
    spawns.calls.push([cmd, ...args])
    const child = (actual.spawn as (...a: unknown[]) => unknown)(cmd, args, opts)
    spawns.children.push(child as (typeof spawns.children)[number])
    return child
  }) as typeof actual.spawn
  return { ...actual, default: { ...actual, spawn }, spawn }
})

/**
 * statSync 的属主可按用例伪装 —— 「这个目录是别的用户建的」在自己的机器上造不出来，
 * 而那恰恰是 ensureControlRoot 唯一真正要挡的场景（共享机器上有人抢先建了 /tmp 的
 * 那个可预测路径）。只在显式置位的那一瞬间生效，其余时间是纯透传。
 */
const fsHook = vi.hoisted(() => ({ fakeUid: undefined as number | undefined }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const statSync = ((p: never, o: never) => {
    const st = actual.statSync(p, o)
    if (fsHook.fakeUid === undefined || !st) return st
    // 保住原型：Stats 的 isFile() 这些方法别的调用方还要用
    return Object.create(
      Object.getPrototypeOf(st),
      Object.getOwnPropertyDescriptors({ ...st, uid: fsHook.fakeUid })
    ) as typeof st
  }) as typeof actual.statSync
  return { ...actual, default: { ...actual, statSync }, statSync }
})

const dir = mkdtempSync(join(tmpdir(), 'shuvix-sshd-'))
const CONFIG = join(dir, '.ssh', 'config')

/**
 * control socket 根目录换成本文件私有的一份。
 *
 * 生产缺省是 `/tmp/shuvix-ssh-<uid>` —— 与真在跑的那个 ShuviX 同一个目录，而下面有用例
 * 会真的去改那个目录的权限、去数里面有几个文件。路径刻意留短：Unix domain socket 的
 * 路径有 104 字节上限，套上 16 位哈希后必须还在限内（`os.tmpdir()` 在 macOS 上就有五十来字符）。
 */
const CONTROL_ROOT = mkdtempSync('/tmp/shuvix-ctl-')
process.env.SHUVIX_SSH_CONTROL_ROOT = CONTROL_ROOT

/**
 * 子进程环境可按用例伪装。
 *
 * libuv 在 exec 之前把 `environ` 换成 `options.env`，于是 `execvp` 找可执行文件时用的是
 * **子进程的** PATH —— 把 PATH 指到一个空目录，就能在不 mock spawn 的前提下真的造出
 * 一次 ENOENT / EACCES 起进程失败（SSHCTL-U-35）。缺省是纯透传。
 */
const envHook = vi.hoisted(() => ({ override: undefined as Record<string, string> | undefined }))
// ssh 按 $HOME 找 ~/.ssh/config —— 把 HOME 指到临时目录，走的就是真实那条解析路径
vi.mock('../../../utils/paths', () => ({
  buildSpawnEnv: () => envHook.override ?? { ...process.env }
}))
const {
  sshExec,
  sshCopy,
  sshSync,
  sshDisconnect,
  sshConnectedAliases,
  sshCloseSession,
  classifySshFailure,
  rsyncAvailable
} = await import('../sshControl')
const hostKey = utils.generateKeyPairSync('ed25519')
const clientKey = utils.generateKeyPairSync('ed25519')
const clientPub = utils.parseKey(clientKey.public)

let authCount = 0
let execCount = 0
/** 让下一条 exec 以非零码退出（验证远端退出码不被混成 ssh 自身的失败） */
let failNext = false
const lastCommands: string[] = []

// ─── SFTP 子系统（scp 的对面）──────────────────────────────────────────────
//
// 现代 OpenSSH 的 scp 走 SFTP 子系统（`-s` 把它钉死在这条路上），所以「真 scp ←→ 进程内
// 服务端」只需要在 session 上多接一个 `sftp` 事件。四十来行，换来的是握手、认证、
// **ControlMaster 复用**、路径原样抵达全都是真的 —— 而复用恰恰是客户端侧的特性。

/** SFTP 的 OPEN 看到的远端路径原文（「路径不经任何 shell」就靠它作证） */
const sftpOpens: string[] = []
/** OPEN 一律回 PERMISSION_DENIED —— 造一次 scp 自己的失败 */
let denyOpen = false
/** READ 永不作答 —— 造一次「远端还在传」的挂起（超时与中止两组要的就是这一刻） */
let hangRead = false

const { OPEN_MODE, STATUS_CODE } = utils.sftp

/**
 * 接一台 SFTP 服务端到这条 session 上。
 *
 * 四条**踩过的**不变量写在各自所在处 —— 每一条错起来都长得像别的毛病：
 * 句柄是自己铸的不透明 Buffer（这里用 4 字节大端序的 Map 下标），而**注册了却不作答的
 * handler 比不注册更糟**：客户端会永远等下去，而不是收到一个 OP_UNSUPPORTED。
 */
function serveSftp(accept: () => SFTPWrapper): void {
  // `_protocol` / `outgoing` 是 ssh2 的私有字段，类型里没有 —— 见下面 exitStatus 那处的注
  const sftp = accept() as SFTPWrapper & {
    _protocol: { exitStatus(id: number, status: number): void }
    outgoing: { id: number }
  }
  const handles = new Map<number, { fd: number; path: string }>()
  let next = 0
  const mint = (rec: { fd: number; path: string }): Buffer => {
    const id = next++
    handles.set(id, rec)
    const b = Buffer.alloc(4)
    b.writeUInt32BE(id, 0)
    return b
  }
  const get = (h: Buffer): { fd: number; path: string } | undefined =>
    h.length === 4 ? handles.get(h.readUInt32BE(0)) : undefined

  sftp.on('OPEN', (reqid, filename, flags) => {
    sftpOpens.push(filename)
    if (denyOpen) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED)
    // **不能用 `utils.sftp.flagsToString()`**：scp 上传时的 flags 是 WRITE|CREAT（10），
    // 那张表里没有这个组合，它回的是 `null` —— 于是 `openSync(path, null)` 抛，
    // 而现象是「scp 报 permission denied」，看着像权限问题。按位判就没有这个坑。
    const write = (flags & OPEN_MODE.WRITE) !== 0
    try {
      sftp.handle(reqid, mint({ fd: openSync(filename, write ? 'w' : 'r'), path: filename }))
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    }
  })
  sftp.on('READ', (reqid, handle, offset, len) => {
    if (hangRead) return // 故意不作答：客户端就此挂住
    const rec = get(handle)
    if (!rec) return sftp.status(reqid, STATUS_CODE.FAILURE)
    const buf = Buffer.alloc(len)
    const n = readSync(rec.fd, buf, 0, len, offset)
    // **EOF 是一条 status，不是一个零长 data()**：回零长 data 客户端会一直再要下一段
    if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF)
    sftp.data(reqid, buf.subarray(0, n))
  })
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const rec = get(handle)
    if (!rec) return sftp.status(reqid, STATUS_CODE.FAILURE)
    writeSync(rec.fd, data, 0, data.length, offset)
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('CLOSE', (reqid, handle) => {
    const rec = get(handle)
    if (rec) {
      closeSync(rec.fd)
      handles.delete(handle.readUInt32BE(0))
    }
    sftp.status(reqid, STATUS_CODE.OK)
  })
  const stat = (reqid: number, path: string): void => {
    try {
      const st = statSync(path)
      // **mode 必须带着 S_IFREG / S_IFDIR 那几位类型位**（所以原样把 statSync 的 mode 递过去）：
      // 那是 scp 判断「目标是目录还是文件」的唯一依据 —— 丢了类型位，一次
      // `scp f host:dir/` 就会把目录本身当文件覆盖掉
      sftp.attrs(reqid, {
        mode: st.mode,
        size: st.size,
        uid: st.uid,
        gid: st.gid,
        atime: Math.floor(st.atimeMs / 1000),
        mtime: Math.floor(st.mtimeMs / 1000)
      })
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    }
  }
  sftp.on('STAT', stat)
  sftp.on('LSTAT', stat)
  // scp 传完会设一次权限/时间戳；不作答它就卡在这里
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
  sftp.on('end', () => {
    // **收尾必须给一个 exit status，否则 scp 以 1 退出 —— 而每一个字节都已经传对了，
    // 且 stderr 全空**（实测：去掉这一行 3/3 都是 exit 1 + stdout/stderr 皆为 ""）。
    // 于是现象是「文件内容完全正确，命令却静默失败」，一个字的线索都没有。
    // `SFTP` 继承的是 EventEmitter 而不是 Channel，所以既没有 `sftp.exit()`
    // （`'exit' in sftp === false`），`sftp.close()` 在服务端模式下也会当场抛
    // `Client-only method called in server mode` —— 只剩这条私有路。
    // ssh2 一升级这里就该响，故意不做容错。
    sftp._protocol.exitStatus(sftp.outgoing.id, 0)
    sftp.end()
  })
}

const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
  client
    .on('authentication', (ctx) => {
      if (ctx.method === 'publickey' && 'key' in ctx) {
        const k = clientPub as { getPublicSSH(): Buffer; type: string }
        if (ctx.key.algo === k.type && ctx.key.data.equals(k.getPublicSSH())) {
          if (ctx.signature) authCount++
          return ctx.accept()
        }
      }
      if (ctx.method === 'none') return ctx.reject(['publickey'])
      return ctx.reject()
    })
    .on('ready', () => {
      client.on('session', (accept) => {
        accept()
          .on('exec', (acc, _rej, info) => {
            execCount++
            lastCommands.push(info.command)
            const stream = acc()
            // `hang` 永不 exit —— 中止与超时两组要的就是「远端还在跑」的那一刻
            if (info.command === 'hang') return
            stream.write(`ran: ${info.command}\n`)
            stream.exit(failNext ? 3 : 0)
            stream.end()
          })
          .on('shell', (acc) => acc().end())
          .on('sftp', (acc) => serveSftp(acc))
      })
    })
    .on('error', () => {})
})

const port = await new Promise<number>((res) => {
  server.listen(0, '127.0.0.1', () => res((server.address() as { port: number }).port))
})

mkdirSync(join(dir, '.ssh'), { recursive: true })
writeFileSync(join(dir, '.ssh', 'id'), clientKey.private, { mode: 0o600 })
chmodSync(join(dir, '.ssh', 'id'), 0o600)
writeFileSync(
  join(dir, '.ssh', 'config'),
  [
    'Host testbox alt-name',
    '  HostName 127.0.0.1',
    `  Port ${port}`,
    '  User tester',
    `  IdentityFile ${join(dir, '.ssh', 'id')}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking no',
    '  UserKnownHostsFile /dev/null',
    '  LogLevel ERROR',
    ''
  ].join('\n')
)

const SID = 'probe-session'

afterAll(async () => {
  await sshDisconnect(SID, 'testbox', CONFIG)
  await sshDisconnect(SID, 'alt-name', CONFIG)
  server.close()
  rmSync(CONTROL_ROOT, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  spawns.calls.length = 0
  spawns.children.length = 0
  sftpOpens.length = 0
  // 上一条用例可能把它留在 true 上，于是下一条命令莫名以 3 退出
  failNext = false
  denyOpen = false
  hangRead = false
  envHook.override = undefined
})

/** 传输用的素材目录（「远端」和「本地」都落在这里，同一台机器两条路径） */
const XFER = join(dir, 'xfer')
mkdirSync(XFER, { recursive: true })

/** 写一份随机字节的素材，返回路径与内容 */
function fixture(name: string, bytes = 1024): { path: string; data: Buffer } {
  const path = join(XFER, name)
  const data = randomBytes(bytes)
  writeFileSync(path, data)
  return { path, data }
}

/** 一次 scp 的固定实参 */
const copy = (opts: {
  sessionId: string
  direction: 'up' | 'down'
  localPath: string
  remotePath: string
  timeoutSec?: number
  signal?: AbortSignal
}): ReturnType<typeof sshCopy> =>
  sshCopy({
    sessionId: opts.sessionId,
    alias: 'testbox',
    direction: opts.direction,
    localPath: opts.localPath,
    remotePath: opts.remotePath,
    timeoutSec: opts.timeoutSec ?? 30,
    signal: opts.signal,
    configPath: CONFIG
  })

/** 一次 exec 的固定实参（用例只覆写自己关心的那几个） */
const run = (opts: {
  sessionId: string
  alias: string
  command?: string
  timeoutSec?: number
  signal?: AbortSignal
}): ReturnType<typeof sshExec> =>
  sshExec({
    sessionId: opts.sessionId,
    alias: opts.alias,
    command: opts.command ?? 'uptime',
    timeoutSec: opts.timeoutSec ?? 30,
    signal: opts.signal,
    configPath: CONFIG
  })

/** control socket 根目录里现在有哪些文件 */
const lsRoot = (): string[] => (existsSync(CONTROL_ROOT) ? readdirSync(CONTROL_ROOT).sort() : [])

/** 轮询等一个条件成立（真进程的收尾不是同步的） */
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 这一批 spawn 里第 i 条 ssh 的 argv */
const argvOf = (i: number): string[] => spawns.calls[i] ?? []

describe('真 ssh 二进制 ←→ 进程内 sshd', () => {
  it('跑得通，且 ControlMaster 只认证一次', async () => {
    const a = await sshExec({
      sessionId: SID,
      alias: 'testbox',
      command: 'uptime',
      timeoutSec: 30,
      configPath: CONFIG
    })
    if (a.exitCode !== 0) throw new Error('SSH STDERR >>> ' + a.stderr)
    expect(a.exitCode).toBe(0)
    expect(a.stdout).toContain('ran: uptime')

    const b = await sshExec({
      sessionId: SID,
      alias: 'testbox',
      command: 'whoami',
      timeoutSec: 30,
      configPath: CONFIG
    })
    expect(b.exitCode).toBe(0)
    expect(b.stdout).toContain('ran: whoami')

    expect(execCount).toBe(2)
    // 复用成立的判据：两条命令、一次认证
    expect(authCount).toBe(1)

    // 第二个别名 = 第二个 control socket = 另一条独立连接（「一个会话同时连多台」）
    const c = await sshExec({
      sessionId: SID,
      alias: 'alt-name',
      command: 'hostname',
      timeoutSec: 30,
      configPath: CONFIG
    })
    expect(c.exitCode).toBe(0)
    expect(authCount).toBe(2)

    // 两台都在，且互不影响
    expect(sshConnectedAliases(SID, ['testbox', 'alt-name']).sort()).toEqual([
      'alt-name',
      'testbox'
    ])
    expect(await sshDisconnect(SID, 'testbox', CONFIG)).toBe(true)
    expect(sshConnectedAliases(SID, ['testbox', 'alt-name'])).toEqual(['alt-name'])

    // 远端非零退出码原样带回，不被当成 ssh 自身的失败
    failNext = true
    const d = await sshExec({
      sessionId: SID,
      alias: 'alt-name',
      command: 'false',
      timeoutSec: 30,
      configPath: CONFIG
    })
    expect(d.exitCode).toBe(3)
  }, 60000)

  it('陌生主机在 BatchMode 下失败，并被翻译成可操作的说明', async () => {
    const strict = join(dir, '.ssh', 'strict')
    writeFileSync(
      strict,
      [
        'Host strictbox',
        '  HostName 127.0.0.1',
        `  Port ${port}`,
        '  User tester',
        `  IdentityFile ${join(dir, '.ssh', 'id')}`,
        '  IdentitiesOnly yes',
        `  UserKnownHostsFile ${join(dir, '.ssh', 'known_hosts_empty')}`,
        '  LogLevel ERROR',
        ''
      ].join('\n')
    )
    const r = await sshExec({
      sessionId: 'strict-session',
      alias: 'strictbox',
      command: 'true',
      timeoutSec: 30,
      configPath: strict
    })
    expect(r.exitCode).toBe(255)
    const explained = classifySshFailure('strictbox', r.stderr)
    expect(explained).toContain('known_hosts')
    expect(explained).toContain('ShuviX will not add it')
  }, 60000)
})

// ─── control socket 的那个目录 ───────────────────────────────────────────
//
// 路径完全可预测（`/tmp/shuvix-ssh-<uid>`），而里面放的是**活的、已认证的**多路复用
// socket。共享机器上别人抢先把它建成 0777，之后 ShuviX 就等于把身份借了出去。
// 所以建完还要复核：权限松了收紧，属主不对就拒绝。

describe('sshControl 的 control socket 目录', () => {
  it('SSHCTL-U-1: 目录已存在且权限过松 → 收紧到 0700', async () => {
    const loose = mkdtempSync('/tmp/shuvix-ctl-loose-')
    chmodSync(loose, 0o777)
    process.env.SHUVIX_SSH_CONTROL_ROOT = loose
    try {
      expect(statSync(loose).mode & 0o777).toBe(0o777)

      // mkdirSync 的 mode 只在**创建那一刻**生效，目录已存在时 recursive 是静默空操作 ——
      // 少了这道复核，「建的时候是 0700」就成了一句关于别人机器的空话
      expect((await run({ sessionId: 'perm-session', alias: 'testbox' })).exitCode).toBe(0)
      expect(statSync(loose).mode & 0o777).toBe(0o700)

      await sshDisconnect('perm-session', 'testbox', CONFIG)
    } finally {
      process.env.SHUVIX_SSH_CONTROL_ROOT = CONTROL_ROOT
      rmSync(loose, { recursive: true, force: true })
    }
  }, 60000)

  it('SSHCTL-U-2: 目录属主不是自己 → 拒绝使用，一个 ssh 都不起', async () => {
    // 「这个目录是别的用户建的」在自己机器上造不出来，只能把 statSync 的属主伪装一下
    fsHook.fakeUid = (process.getuid?.() ?? 0) + 1
    try {
      await expect(run({ sessionId: 'alien-session', alias: 'testbox' })).rejects.toThrow(
        /owned by another user; refusing to use it/
      )
    } finally {
      fsHook.fakeUid = undefined
    }
    expect(spawns.calls).toEqual([])
  })
})

// ─── 一个会话一份连接 ────────────────────────────────────────────────────
//
// socket 路径是 sessionId 与别名**一起**哈希出来的，这一行就是「寿命绑会话」的全部实现。
// 串台的代价不是多一次连接，而是 A 会话关掉了 B 的连接、或者 A 的命令跑在 B 认证出来的
// 通道上 —— 两者在 UI 上都完全看不出来。

describe('sshControl 的会话隔离', () => {
  it('SSHCTL-U-3: 两条会话连同一台 = 两个 socket、两次认证，断一条不碰另一条', async () => {
    const before = authCount
    await run({ sessionId: 'sess-a', alias: 'testbox' })
    await run({ sessionId: 'sess-b', alias: 'testbox' })

    // 复用是按「会话×别名」成立的，不是按别名 —— 所以这里是两次认证而不是一次
    expect(authCount).toBe(before + 2)
    expect(sshConnectedAliases('sess-a', ['testbox'])).toEqual(['testbox'])
    expect(sshConnectedAliases('sess-b', ['testbox'])).toEqual(['testbox'])

    expect(await sshDisconnect('sess-a', 'testbox', CONFIG)).toBe(true)
    expect(sshConnectedAliases('sess-a', ['testbox'])).toEqual([])
    expect(sshConnectedAliases('sess-b', ['testbox'])).toEqual(['testbox'])

    await sshDisconnect('sess-b', 'testbox', CONFIG)
  }, 60000)

  it('SSHCTL-U-4: 会话释放只收自己那几个 socket，认不出的文件一律不碰', async () => {
    await run({ sessionId: 'close-a', alias: 'testbox' })
    await run({ sessionId: 'close-a', alias: 'alt-name' })
    await run({ sessionId: 'close-b', alias: 'testbox' })
    const stray = join(CONTROL_ROOT, 'not-ours')
    writeFileSync(stray, 'someone else')

    expect(await sshCloseSession('close-a', ['testbox', 'alt-name'], CONFIG)).toBe(2)

    expect(sshConnectedAliases('close-a', ['testbox', 'alt-name'])).toEqual([])
    expect(sshConnectedAliases('close-b', ['testbox'])).toEqual(['testbox'])
    // 认不出的就是别人的：目录是按 uid 共享的，扫的时候只认自己算得回来的那些路径
    expect(existsSync(stray)).toBe(true)

    rmSync(stray, { force: true })
    await sshCloseSession('close-b', ['testbox'], CONFIG)
  }, 60000)

  it('SSHCTL-U-5: 从没连过的别名 —— 回 false，且一个 ssh 都不起', async () => {
    expect(await sshDisconnect('never-connected-session', 'testbox', CONFIG)).toBe(false)
    expect(spawns.calls).toEqual([])
  })

  it('SSHCTL-U-6: 哈希路径上残留的**普通文件**会被清掉', async () => {
    const sid = 'stale-session'
    const before = new Set(lsRoot())
    await run({ sessionId: sid, alias: 'testbox' })
    // 路径不导出，所以从目录里认出这一次新增的那个
    const name = lsRoot().find((n) => !before.has(n))
    expect(name).toBeDefined()
    const sock = join(CONTROL_ROOT, name!)

    await sshDisconnect(sid, 'testbox', CONFIG)
    expect(existsSync(sock)).toBe(false)

    // 机器断电 / `-O exit` 崩掉之后的典型残留：路径还在，但已经不是一个活 socket
    writeFileSync(sock, 'stale')
    spawns.calls.length = 0
    expect(await sshDisconnect(sid, 'testbox', CONFIG)).toBe(true)
    // `-O exit` 对着死路径必然失败，那条失败被咽掉；关键是路径要清干净，
    // 否则下一次 ControlMaster=auto 会一头撞上它
    expect(spawns.calls).toHaveLength(1)
    expect(existsSync(sock)).toBe(false)
  }, 60000)
})

// ─── 中止与超时 ──────────────────────────────────────────────────────────

describe('sshControl 的中止与超时', () => {
  it('SSHCTL-U-7: 命令跑到一半中止 → 杀掉子进程并以 Aborted 落定', async () => {
    const sid = 'abort-session'
    const ac = new AbortController()
    const startedBefore = execCount

    const pending = run({ sessionId: sid, alias: 'testbox', command: 'hang', signal: ac.signal })
    await until(() => execCount > startedBefore) // 远端确实已经在跑了

    ac.abort()
    await expect(pending).rejects.toThrow('Aborted')

    // 光 reject 不算：留着的 ssh 会一直挂在那条远端命令上，直到 ControlPersist 到期
    const child = spawns.children[0]
    expect(child.killed).toBe(true)
    await until(() => child.exitCode !== null || child.signalCode !== null)

    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)

  it('SSHCTL-U-8: 超时 = timedOut，退出码记 124（远端从没回过这个码）', async () => {
    const sid = 'timeout-session'
    const r = await run({ sessionId: sid, alias: 'testbox', command: 'hang', timeoutSec: 1 })

    expect(r).toMatchObject({ timedOut: true, exitCode: 124 })
    // 124 是本地这一侧编出来的，所以上层必须靠 timedOut 而不是靠这个数字讲话
    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)
})

// ─── argv ────────────────────────────────────────────────────────────────
//
// 这几个参数只在 argv 里看得见，而每一条失手一次都很贵：`--` 少了就是本地任意命令执行，
// `-F` 少了就是枚举与建连读着两份不同的配置（别名对得上纯属巧合）。

describe('sshControl 交给 ssh 的 argv', () => {
  it('SSHCTL-U-9: exec 带 -F 与 BatchMode，`--` 恒在别名之前', async () => {
    const sid = 'argv-session'
    await run({ sessionId: sid, alias: 'testbox', command: 'echo hi' })

    const argv = argvOf(0)
    expect(argv[0]).toBe('ssh')
    expect(argv[argv.indexOf('-F') + 1]).toBe(CONFIG)
    // 任何交互提示（密码、passphrase、指纹）在这里都只会挂死
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('ControlMaster=auto')
    expect(argv.slice(-3)).toEqual(['--', 'testbox', 'echo hi'])

    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)

  it('SSHCTL-U-10: 断开走 `-O exit`，会话释放走的是同一条路', async () => {
    const sid = 'argv-exit-session'
    await run({ sessionId: sid, alias: 'testbox' })

    spawns.calls.length = 0
    await sshDisconnect(sid, 'testbox', CONFIG)
    const exit = argvOf(0)
    expect(exit[exit.indexOf('-O') + 1]).toBe('exit')
    expect(exit[exit.indexOf('-F') + 1]).toBe(CONFIG)
    expect(exit.slice(-2)).toEqual(['--', 'testbox'])

    await run({ sessionId: sid, alias: 'testbox' })
    spawns.calls.length = 0
    expect(await sshCloseSession(sid, ['testbox'], CONFIG)).toBe(1)
    expect(argvOf(0)).toContain('-O')
  }, 60000)

  it('SSHCTL-U-11: Windows 上显式按掉多路复用，三处记账一并退化', async () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // isWindows 是模块载入那一刻算出来的，所以必须重新载入一份
    vi.resetModules()
    try {
      const win = await import('../sshControl')
      spawns.calls.length = 0

      const r = await win.sshExec({
        sessionId: 'win-session',
        alias: 'testbox',
        command: 'uptime',
        timeoutSec: 30,
        configPath: CONFIG
      })
      expect(r.exitCode).toBe(0)

      // 用户配置里若全局设了 ControlMaster，ssh.exe 会直接 `getsockname failed` ——
      // 省略参数救不了，只有显式按掉才行
      const argv = argvOf(0)
      expect(argv).toContain('ControlMaster=no')
      expect(argv).toContain('ControlPath=none')
      expect(argv).not.toContain('ControlMaster=auto')

      // 没有 socket 这回事：连接状态、断开、会话释放三处一起退化成「什么都没有」
      expect(win.sshConnectedAliases('win-session', ['testbox'])).toEqual([])
      expect(await win.sshDisconnect('win-session', 'testbox', CONFIG)).toBe(false)
      expect(await win.sshCloseSession('win-session', ['testbox'], CONFIG)).toBe(0)
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
      vi.resetModules()
    }
  }, 60000)
})

// ─── 文件传输（真 scp ←→ 进程内 SFTP 服务端）─────────────────────────────
//
// 这一组的头条是**复用**：一次 exec 之后再传文件，服务端数到的认证次数**一次都不涨**。
// 那才是「文件传输白拿了连接池」这句话的全部内容 —— 传得通只是前提。
// 其余几条问的是 scp 这条路上那些只有真二进制才答得出来的事：路径原样抵达（走的是
// SFTP 的协议字段，不经任何 shell）、`--` 挡住以 `-` 开头的本地路径、失败与挂起怎么冒上来。

describe('真 scp ←→ 进程内 SFTP 服务端', () => {
  it('SSHCTL-U-18: 上传逐字节对得上', async () => {
    const sid = 'scp-up'
    const src = fixture('up.bin')
    const dst = join(XFER, 'up-landed.bin')

    const r = await copy({ sessionId: sid, direction: 'up', localPath: src.path, remotePath: dst })
    if (r.exitCode !== 0) throw new Error('SCP STDERR >>> ' + r.stderr)
    expect(r.exitCode).toBe(0)
    expect(readFileSync(dst).equals(src.data)).toBe(true)

    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)

  it('SSHCTL-U-19: 下载逐字节对得上', async () => {
    const sid = 'scp-down'
    const remote = fixture('down.bin')
    const local = join(XFER, 'down-landed.bin')

    const r = await copy({
      sessionId: sid,
      direction: 'down',
      localPath: local,
      remotePath: remote.path
    })
    if (r.exitCode !== 0) throw new Error('SCP STDERR >>> ' + r.stderr)
    expect(readFileSync(local).equals(remote.data)).toBe(true)

    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)

  it('SSHCTL-U-20: exec 之后再传文件 —— 认证次数一次都不涨', async () => {
    const sid = 'scp-reuse'
    // 先跑一条命令，顺手成为 master
    expect((await run({ sessionId: sid, alias: 'testbox' })).exitCode).toBe(0)
    const authAfterExec = authCount
    expect(sshConnectedAliases(sid, ['testbox'])).toEqual(['testbox'])

    const src = fixture('reuse.bin')
    const up = await copy({
      sessionId: sid,
      direction: 'up',
      localPath: src.path,
      remotePath: join(XFER, 'reuse-up.bin')
    })
    expect(up.exitCode).toBe(0)
    const down = await copy({
      sessionId: sid,
      direction: 'down',
      localPath: join(XFER, 'reuse-down.bin'),
      remotePath: src.path
    })
    expect(down.exitCode).toBe(0)

    // 这一行就是整件事的判据：两次传输都搭在那一次认证上。
    // 涨了，说明 control socket 没被用上，而「传文件不会再认证一次」只是一句话
    expect(authCount).toBe(authAfterExec)
    expect(readFileSync(join(XFER, 'reuse-down.bin')).equals(src.data)).toBe(true)

    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)

  it('SSHCTL-U-21: 单独一次传输会认证，但**不留** master —— scp 自己把复用按掉了', async () => {
    const sid = 'scp-solo'
    expect(sshConnectedAliases(sid, ['testbox'])).toEqual([])
    const before = authCount

    const src = fixture('solo.bin')
    const r = await copy({
      sessionId: sid,
      direction: 'up',
      localPath: src.path,
      remotePath: join(XFER, 'solo-landed.bin')
    })
    expect(r.exitCode).toBe(0)
    expect(authCount).toBe(before + 1)

    // argv 里明明写着 `ControlMaster=auto`，socket 却没建起来：scp 会在更靠前的位置
    // 塞一个 `-oControlMaster=no`，而 OpenSSH 是**先到先得**。于是传输**复用**已有的
    // master，却从不**新建** —— sshServer 的状态条正是因此要先查一次 socket 才点亮
    expect(sshConnectedAliases(sid, ['testbox'])).toEqual([])
    expect(await sshDisconnect(sid, 'testbox', CONFIG)).toBe(false)
  }, 60000)

  it('SSHCTL-U-22: 远端路径原样抵达 SFTP 的 OPEN —— 空格、前导横线、冒号、引号、$(…)', async () => {
    const sid = 'scp-literal'
    const src = fixture('literal.bin', 64)
    // 这些字符在**旧 SCP 协议**下会由远端 shell 求值（`;` 就是远端命令执行）；
    // `-s` 把协议钉在 SFTP 上之后，路径只是协议里的一个字段
    const names = ['a b.bin', '-dash.bin', 'co:lon.bin', 'qu"ote.bin', '$(id).bin']

    for (const name of names) {
      const remote = join(XFER, name)
      const r = await copy({
        sessionId: sid,
        direction: 'up',
        localPath: src.path,
        remotePath: remote
      })
      if (r.exitCode !== 0) throw new Error(`SCP STDERR (${name}) >>> ${r.stderr}`)
      expect(readFileSync(remote).equals(src.data)).toBe(true)
    }

    // 服务端看到的就是原文，一个字符没变（没被 shell 拆开、也没被展开）
    expect(sftpOpens).toEqual(names.map((n) => join(XFER, n)))

    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)

  it('SSHCTL-U-23: 以 `-` 开头的**本地**路径照样传得走 —— 且 `--` 正是它传得走的原因', async () => {
    const sid = 'scp-dash'
    const src = fixture('-dashy.bin', 64)

    // 绝对路径先过一遍（这是 sshServer 唯一会下发的形态：本地路径在那一层已解析成绝对）
    const abs = await copy({
      sessionId: sid,
      direction: 'up',
      localPath: src.path,
      remotePath: join(XFER, 'dashy-landed.bin')
    })
    if (abs.exitCode !== 0) throw new Error('SCP STDERR >>> ' + abs.stderr)
    expect(readFileSync(join(XFER, 'dashy-landed.bin')).equals(src.data)).toBe(true)

    // 但绝对路径第一个字符是 `/`，getopt 根本不会看它一眼 —— 所以上面那一段**证不了**
    // `--` 有用。要证，得让一个真的长得像选项的参数进 argv：裸相对路径。
    // `runProcess` 不传 cwd，于是子进程继承本进程的 —— 临时换过去
    const cwd = process.cwd()
    process.chdir(XFER)
    try {
      const rel = await copy({
        sessionId: sid,
        direction: 'up',
        localPath: '-dashy.bin',
        remotePath: join(XFER, 'dashy-rel-landed.bin')
      })
      if (rel.exitCode !== 0) throw new Error('SCP STDERR >>> ' + rel.stderr)
      expect(readFileSync(join(XFER, 'dashy-rel-landed.bin')).equals(src.data)).toBe(true)

      // 对照：同一条 argv 抽掉 `--`，scp 当场栽在 getopt 上，连都没连。
      // 这就是那两个字符买到的东西
      const without = spawns.calls
        .at(-1)!
        .slice(1)
        .filter((a) => a !== '--')
      const bare = await new Promise<{ code: number | null; stderr: string }>((res) => {
        const child = spawn('scp', without, { cwd: XFER, stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        child.on('close', (code) => res({ code, stderr }))
      })
      expect(bare.code).not.toBe(0)
      expect(bare.stderr).toContain('illegal option')
    } finally {
      process.chdir(cwd)
    }

    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)

  it('SSHCTL-U-24: scp 自己的非零退出与 stderr 原样成为 SshExecResult', async () => {
    const sid = 'scp-fail'
    denyOpen = true
    const src = fixture('denied.bin', 64)

    const r = await copy({
      sessionId: sid,
      direction: 'up',
      localPath: src.path,
      remotePath: join(XFER, 'denied-landed.bin')
    })

    // 不是 255（那是 ssh 自己连不上），也不是抛异常 —— 这次连上了，是 scp 失败了。
    // 于是 sshServer 那一层不会去翻译它，而是原样报 `failed (exit 1): <stderr>`
    expect(r.exitCode).toBe(1)
    expect(r.timedOut).toBe(false)
    // scp 自己按状态码渲染文案（传给 sftp.status 的 message 字符串会被**丢掉**），
    // 而且行尾是 `\r\n` 而非 `\n` —— 所以只断言子串，别去比整行
    expect(r.stderr).toContain('scp: dest open "')
    expect(r.stderr).toContain('Permission denied')
    expect(existsSync(join(XFER, 'denied-landed.bin'))).toBe(false)

    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)

  it('SSHCTL-U-25: 传输挂住 → 超时记 124；中止则真的把 scp 杀掉（**限于没有 master 时**）', async () => {
    hangRead = true
    const src = fixture('hang.bin')

    // **前提必须写明，而且要断言出来**：这两条会话都没有 master（单独一次传输不新建，
    // 见 SSHCTL-U-21）。实测这不是细节 —— master 活着时对挂住的 scp 发 SIGTERM，
    // scp 自己会退（exit 1），但那个 `[mux]` master 还攥着它继承来的 stderr fd，
    // 于是 `'close'` 永不触发，而 runProcess 恰恰是在 `'close'` 上落定的：
    // 超时与中止两条路在**复用了连接的会话里**都回不来。
    // 这条用例钉的是没有 master 的那一支；另一支是实现的缺口，不在这里假装绿。
    expect(sshConnectedAliases('scp-timeout', ['testbox'])).toEqual([])
    expect(sshConnectedAliases('scp-abort', ['testbox'])).toEqual([])

    // 超时：READ 永不作答，于是 scp 一直等
    const t = await copy({
      sessionId: 'scp-timeout',
      direction: 'down',
      localPath: join(XFER, 'hang-landed.bin'),
      remotePath: src.path,
      timeoutSec: 1
    })
    expect(t).toMatchObject({ timedOut: true, exitCode: 124 })

    // 中止：光 reject 不算 —— 留着的 scp 会一直挂在那条 SFTP 请求上
    spawns.children.length = 0
    const ac = new AbortController()
    const pending = copy({
      sessionId: 'scp-abort',
      direction: 'down',
      localPath: join(XFER, 'hang-landed2.bin'),
      remotePath: src.path,
      signal: ac.signal
    })
    await until(() => spawns.children.length > 0)
    ac.abort()
    await expect(pending).rejects.toThrow('Aborted')
    const child = spawns.children[0]
    expect(child.killed).toBe(true)
    await until(() => child.exitCode !== null || child.signalCode !== null)
  }, 60000)

  it('SSHCTL-U-26: 上传到一个已存在的远端**目录** → 落在 `<dir>/<basename>`', async () => {
    const sid = 'scp-dir'
    const src = fixture('into-dir.bin', 64)
    const destDir = join(XFER, 'destdir')
    mkdirSync(destDir, { recursive: true })

    const r = await copy({
      sessionId: sid,
      direction: 'up',
      localPath: src.path,
      remotePath: destDir
    })
    expect(r.exitCode).toBe(0)

    // 这是 scp 的语义，不是 ShuviX 的选择 —— `upload` 没有 `-r`，所以模型以为自己
    // 在「覆盖那个目录」时，其实是在往里放一个文件。判据是 STAT 回的 mode 里那几位
    // 类型位（见 serveSftp）：丢了它们，这里会把目录本身当文件覆盖掉
    expect(existsSync(join(destDir, basename(src.path)))).toBe(true)
    expect(readFileSync(join(destDir, basename(src.path))).equals(src.data)).toBe(true)
    expect(statSync(destDir).isDirectory()).toBe(true)

    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)
})

// ─── 传输类 argv ─────────────────────────────────────────────────────────
//
// 同 exec 的那一组：这些参数只在 argv 里看得见，而每一条失手一次都很贵。
// scp 多一条 `-s`（协议钉在 SFTP 上，否则远端路径会被远端 shell 求值），
// rsync 多一条 `-e`（整串 ssh 命令拼成一个参数，而 rsync 自己按空白切它）。

describe('sshControl 交给 scp / rsync 的 argv', () => {
  it('SSHCTL-U-30: scp 的 argv —— `-s` 打头、`--` 紧贴两个路径、方向决定顺序', async () => {
    const sid = 'argv-scp'
    await copy({
      sessionId: sid,
      direction: 'up',
      localPath: join(XFER, 'argv.bin'),
      remotePath: '/srv/argv.bin'
    }).catch(() => undefined)

    const argv = argvOf(0)
    expect(argv[0]).toBe('scp')
    // `-s` 必须在最前：OpenSSH 9 之前 scp 默认走**旧 SCP 协议**，那条路会在远端
    // 拼出一条命令行由远端 shell 求值 —— 远端路径里的 `;` 就成了远端命令执行
    expect(argv[1]).toBe('-s')
    expect(argv[argv.indexOf('-F') + 1]).toBe(CONFIG)
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('ConnectTimeout=15')
    expect(argv).toContain('ControlMaster=auto')
    expect(argv).toContain('ControlPersist=10m')
    expect(argv.some((a) => a.startsWith(`ControlPath=${CONTROL_ROOT}/`))).toBe(true)
    // `--` 紧贴两个路径：中间插任何东西，以 `-` 开头的路径就又能被当成选项
    expect(argv.slice(-3)).toEqual(['--', join(XFER, 'argv.bin'), 'testbox:/srv/argv.bin'])

    // 反方向只是把那两个位置换一下
    spawns.calls.length = 0
    await copy({
      sessionId: sid,
      direction: 'down',
      localPath: join(XFER, 'argv2.bin'),
      remotePath: '/srv/argv.bin'
    }).catch(() => undefined)
    expect(argvOf(0).slice(-3)).toEqual(['--', 'testbox:/srv/argv.bin', join(XFER, 'argv2.bin')])

    await sshDisconnect(sid, 'testbox', CONFIG)
  }, 60000)

  it('SSHCTL-U-31: rsync 的 argv —— `-a -e <整串 ssh 命令> -- src dst`', async () => {
    await sshSync({
      sessionId: 'argv-rsync',
      alias: 'testbox',
      direction: 'up',
      localPath: join(XFER, 'tree'),
      remotePath: '/srv/tree',
      timeoutSec: 5,
      configPath: CONFIG
    }).catch(() => undefined)

    const argv = argvOf(0)
    expect(argv[0]).toBe('rsync')
    expect(argv.slice(1, 3)).toEqual(['-a', '-e'])
    const sshCmd = argv[3]
    // 整串 ssh 命令是**一个**参数：复用的三件套都在里面，否则 rsync 起的那个 ssh
    // 会自己建一条新连接（功能一样，只是每次都重新认证）
    expect(sshCmd.startsWith('ssh ')).toBe(true)
    expect(sshCmd).toContain(`-F ${CONFIG}`)
    expect(sshCmd).toContain('BatchMode=yes')
    expect(sshCmd).toContain('ConnectTimeout=15')
    expect(sshCmd).toContain(`ControlPath=${CONTROL_ROOT}/`)
    expect(argv.slice(4)).toEqual(['--', join(XFER, 'tree'), 'testbox:/srv/tree'])
  }, 60000)

  it('SSHCTL-U-32: control 目录名带空格 → rsync 按空白切 `-e`，后半截成了「主机名」', async () => {
    const sync = (sessionId: string): ReturnType<typeof sshSync> =>
      sshSync({
        sessionId,
        alias: 'testbox',
        direction: 'up',
        localPath: join(XFER, 'tree'),
        remotePath: '/srv/tree',
        timeoutSec: 10,
        configPath: CONFIG
      })

    const spaced = mkdtempSync('/tmp/shuvix ctl-')
    process.env.SHUVIX_SSH_CONTROL_ROOT = spaced
    let broken: Awaited<ReturnType<typeof sshSync>>
    let brokenHost: string
    const execsBefore = lastCommands.length
    try {
      broken = await sync('argv-rsync-space')
      const sshCmd = argvOf(0)[3]
      // rsync 自己按空白切 `-e` 的值，于是 `ControlPath=/tmp/shuvix` 与
      // `ctl-xxxx/<hash>` 成了两个参数，后半截落到 ssh 的位置参数上 = 主机名
      const controlPath = sshCmd
        .split(' -o ')
        .find((a) => a.startsWith('ControlPath='))!
        .slice('ControlPath='.length)
      expect(controlPath).toContain(' ')
      brokenHost = controlPath.split(' ')[1]
    } finally {
      process.env.SHUVIX_SSH_CONTROL_ROOT = CONTROL_ROOT
      rmSync(spaced, { recursive: true, force: true })
    }

    expect(broken.exitCode).not.toBe(0)

    // **最硬的判据是这一条**（与 DNS、rsync flavour 全无关）：那半截路径成了主机名，
    // 于是这一跳根本没有连到我们这台 sshd —— 它一条 exec 都没收到
    expect(lastCommands.length).toBe(execsBefore)

    // 对照：不带空格的 control 根跑同一条 sync。它也失败（对面这台 sshd 根本没有
    // rsync，我们的 exec handler 只会回一句 `ran: …`），但**失败在别处**：
    // 服务端确实收到了那条 `rsync --server …` —— 也就是 sshServer 上报给命令门的那一条
    const ok = await sync('argv-rsync-nospace')
    expect(ok.exitCode).not.toBe(0)
    expect(lastCommands.slice(execsBefore)).toHaveLength(1)
    expect(lastCommands.at(-1)).toMatch(/^rsync --server /)

    // 用户看得见的症状（这台机器上是这一句）：ssh 抱怨一个他从没敲过的「主机名」。
    // 这里之所以恒定，是因为切出来的那半截带 `/`（`ctl-xxxx/<hash>`），
    // 而带斜杠的名字过不了 getaddrinfo。若那半截**碰巧**像个域名，
    // 某些劫持型解析器会把它解析掉，于是报的就成了「连接被关闭」—— 所以上面那两条才是判据
    expect(broken.stderr.toLowerCase()).toContain(
      `could not resolve hostname ${brokenHost.toLowerCase()}`
    )
    // 代价还不止「跑不起来」：这句会被 classifySshFailure 认成「域名解析不了」
    expect(classifySshFailure('testbox', broken.stderr)).toContain('could not be resolved')
    // 生产路径（`/tmp/shuvix-ssh-<uid>/<hash>`）不带空格，只有覆写了
    // SHUVIX_SSH_CONTROL_ROOT 到带空格的目录才踩得到 —— 钉住它，好过让人现场猜。
    // （顺带：openrsync 认 `-e` 里的 shell 引号，真要修，加一对引号就够了）
  }, 60000)

  it('SSHCTL-U-33: Windows 上两种传输一并按掉多路复用', async () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.resetModules()
    try {
      const win = await import('../sshControl')
      spawns.calls.length = 0

      await win
        .sshCopy({
          sessionId: 'win-xfer',
          alias: 'testbox',
          direction: 'up',
          localPath: join(XFER, 'w.bin'),
          remotePath: '/srv/w.bin',
          timeoutSec: 5,
          configPath: CONFIG
        })
        .catch(() => undefined)
      await win
        .sshSync({
          sessionId: 'win-xfer',
          alias: 'testbox',
          direction: 'up',
          localPath: join(XFER, 'tree'),
          remotePath: '/srv/tree',
          timeoutSec: 5,
          configPath: CONFIG
        })
        .catch(() => undefined)

      // 用户配置里若全局设了 ControlMaster，`ssh.exe` 会直接 `getsockname failed` ——
      // 省略参数救不了，两条路都得显式按掉
      const scpArgv = argvOf(0)
      expect(scpArgv).toContain('ControlMaster=no')
      expect(scpArgv).toContain('ControlPath=none')
      expect(scpArgv).not.toContain('ControlMaster=auto')
      const sshCmd = argvOf(1)[3]
      expect(sshCmd).toContain('ControlMaster=no')
      expect(sshCmd).toContain('ControlPath=none')
      expect(sshCmd).not.toContain('ControlMaster=auto')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
      vi.resetModules()
    }
  }, 60000)

  it('SSHCTL-U-34: rsyncAvailable 一个进程只探一次', async () => {
    spawns.calls.length = 0
    const first = await rsyncAvailable()

    // 一台机器上装没装 rsync 不会在运行期变，所以这是进程级缓存而不是每次都问
    expect(spawns.calls.map((c) => [c[0], c[1]])).toEqual([['rsync', '--version']])
    spawns.calls.length = 0
    expect(await rsyncAvailable()).toBe(first)
    expect(await rsyncAvailable()).toBe(first)
    expect(spawns.calls).toEqual([])
  }, 60000)

  it('SSHCTL-U-35: 起进程失败时说的是**那个**二进制的名字', async () => {
    // libuv 在 exec 前把 environ 换成 options.env，于是 execvp 用的是子进程的 PATH ——
    // 指到一个空目录就真的造出一次 ENOENT，不必 mock spawn
    const emptyBin = mkdtempSync(join(tmpdir(), 'shuvix-nobin-'))
    envHook.override = { PATH: emptyBin }
    try {
      await expect(
        copy({
          sessionId: 'nobin',
          direction: 'up',
          localPath: join(XFER, 'x.bin'),
          remotePath: '/srv/x.bin'
        })
      ).rejects.toThrow('The `scp` command was not found on this machine.')

      // 同一段代码 ssh / rsync 共用，所以名字必须是形参而不是写死的 `ssh` ——
      // 报错说「装个 ssh 吧」而其实缺的是 rsync，是很贵的一次误导
      await expect(
        sshSync({
          sessionId: 'nobin',
          alias: 'testbox',
          direction: 'up',
          localPath: join(XFER, 'tree'),
          remotePath: '/srv/tree',
          timeoutSec: 5,
          configPath: CONFIG
        })
      ).rejects.toThrow('The `rsync` command was not found on this machine.')

      // 非 ENOENT（这里是 EACCES：文件在，但没有执行位）走另一句
      const badBin = mkdtempSync(join(tmpdir(), 'shuvix-badbin-'))
      writeFileSync(join(badBin, 'scp'), '#!/bin/sh\n', { mode: 0o644 })
      chmodSync(join(badBin, 'scp'), 0o644)
      envHook.override = { PATH: badBin }
      await expect(
        copy({
          sessionId: 'nobin',
          direction: 'up',
          localPath: join(XFER, 'x.bin'),
          remotePath: '/srv/x.bin'
        })
      ).rejects.toThrow(/^Failed to run scp: .*EACCES/)
      rmSync(badBin, { recursive: true, force: true })
    } finally {
      envHook.override = undefined
      rmSync(emptyBin, { recursive: true, force: true })
    }
  }, 60000)
})

// ─── ssh 自身失败的翻译 ──────────────────────────────────────────────────
//
// 这张表的意义在于**可操作**：agent 拿到「认证失败，去看 ssh-add -l」才知道下一步做什么，
// 拿到 `exit 255` 只会去猜。翻错的代价同样具体 —— 把一条返回 255 的远端命令说成
// 「主机密钥没认过」，agent 就会去折腾一台其实好端端的机器。

describe('classifySshFailure', () => {
  const CASES: Array<[string, string, string]> = [
    ['主机密钥没认过', 'Host key verification failed.', 'ShuviX will not add it'],
    [
      '算法对不上也归到同一句',
      'Unable to negotiate with 1.2.3.4 port 22: no matching host key type found',
      'ShuviX will not add it'
    ],
    [
      '密钥变了',
      '@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@',
      'has CHANGED since it was recorded'
    ],
    ['认证被拒', 'tester@127.0.0.1: Permission denied (publickey,password).', 'ssh-add -l'],
    [
      '域名解析不了',
      'ssh: Could not resolve hostname nope: nodename nor servname provided',
      'could not be resolved'
    ],
    [
      '连接超时',
      'ssh: connect to host 10.255.255.1 port 22: Operation timed out',
      'timed out after 15s'
    ],
    [
      '端口拒绝',
      'ssh: connect to host 127.0.0.1 port 1: Connection refused',
      'refused the connection'
    ]
  ]

  it.each(CASES)('SSHCTL-U-12（%s）', (_label, stderr, expected) => {
    const explained = classifySshFailure('prod', stderr)
    expect(explained).toContain(expected)
    // 说明里必须带着别名，否则同时连着几台时用户读不出说的是哪一台
    expect(explained).toContain('"prod"')
  })

  it('SSHCTL-U-13: 大小写不敏感 —— ssh 各版本的措辞并不统一', () => {
    expect(classifySshFailure('prod', 'HOST KEY VERIFICATION FAILED.')).toContain(
      'ShuviX will not add it'
    )
  })

  it('SSHCTL-U-14: 认不出来就回 undefined —— 宁可原样带回，也不硬编一个解释', () => {
    expect(
      classifySshFailure('prod', 'kex_exchange_identification: read: Connection reset by peer')
    ).toBeUndefined()
  })

  it('SSHCTL-U-15: 远端一旦有输出，255 就是命令的意思，不是 ssh 的', () => {
    // 有 stdout 说明这次确实连上了 —— 再说「主机密钥没认过」就是把 agent 支去错的方向
    expect(
      classifySshFailure('prod', 'Host key verification failed.', 'partial output')
    ).toBeUndefined()
  })

  it('SSHCTL-U-16: 没有括号的 `Permission denied` 是远端 shell 说的，不翻译', () => {
    // ssh 自己的拒绝恒带认证方式清单：`Permission denied (publickey,password).`
    expect(classifySshFailure('prod', 'bash: /root/secret: Permission denied')).toBeUndefined()
  })

  it('SSHCTL-U-17: 没有 `ssh: ` 前缀的连不上，是远端命令在说话', () => {
    // 远端跑的 curl / ssh 也会打出同样的字眼，那不是**我们这一跳**的失败
    expect(
      classifySshFailure('prod', 'connect to host 10.0.0.1 port 22: Connection refused')
    ).toBeUndefined()
    expect(
      classifySshFailure('prod', 'connect to host 10.0.0.1 port 22: Operation timed out')
    ).toBeUndefined()
    expect(classifySshFailure('prod', 'Could not resolve hostname nope')).toBeUndefined()
  })
})
