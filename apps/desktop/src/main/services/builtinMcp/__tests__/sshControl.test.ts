/**
 * sshControl —— 拿**真的 `ssh` 二进制**去连一个**进程内真 sshd**（ssh2.Server）。
 *
 * 这条路比 mock 掉 spawn 值钱得多：握手、认证、exec 通道、ControlMaster 多路复用全是真的，
 * 而 ControlMaster 恰恰是客户端侧的特性 —— 对面是不是 OpenSSH 无所谓。零外部依赖，CI 照跑，
 * 不需要 Docker。
 *
 * 复用是否成立的判据不是「跑通了」，而是**服务端数到几次认证**：两条命令一次认证才叫复用。
 *
 * 分组（SSHCTL-U-*）：
 *   1…2    control socket 那个目录 —— 权限收紧与属主复核（路径完全可预测，里面是活的凭据）；
 *   3…6    会话隔离 —— 两条会话两份连接、释放只收自己的、从没连过的不起进程、残留清理；
 *   7…8    中止与超时 —— 子进程真被杀掉（不只是 promise reject），124 是本地编的；
 *   9…11   argv —— `-F` / `--` / `-O exit`，以及 Windows 上按掉多路复用后的三处退化；
 *   12…17  ssh 自身失败的翻译表，含「远端有输出就不是 ssh 的错」这两道守卫。
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  mkdirSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Server, utils } from 'ssh2'

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

// ssh 按 $HOME 找 ~/.ssh/config —— 把 HOME 指到临时目录，走的就是真实那条解析路径
vi.mock('../../../utils/paths', () => ({
  buildSpawnEnv: () => ({ ...process.env })
}))
const { sshExec, sshDisconnect, sshConnectedAliases, sshCloseSession, classifySshFailure } =
  await import('../sshControl')
const hostKey = utils.generateKeyPairSync('ed25519')
const clientKey = utils.generateKeyPairSync('ed25519')
const clientPub = utils.parseKey(clientKey.public)

let authCount = 0
let execCount = 0
/** 让下一条 exec 以非零码退出（验证远端退出码不被混成 ssh 自身的失败） */
let failNext = false
const lastCommands: string[] = []

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
  // 上一条用例可能把它留在 true 上，于是下一条命令莫名以 3 退出
  failNext = false
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
