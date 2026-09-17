/**
 * sshControl —— 拿**真的 `ssh` 二进制**去连一个**进程内真 sshd**（ssh2.Server）。
 *
 * 这条路比 mock 掉 spawn 值钱得多：握手、认证、exec 通道、ControlMaster 多路复用全是真的，
 * 而 ControlMaster 恰恰是客户端侧的特性 —— 对面是不是 OpenSSH 无所谓。零外部依赖，CI 照跑，
 * 不需要 Docker。
 *
 * 复用是否成立的判据不是「跑通了」，而是**服务端数到几次认证**：两条命令一次认证才叫复用。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Server, utils } from 'ssh2'

const dir = mkdtempSync(join(tmpdir(), 'shuvix-sshd-'))
const CONFIG = join(dir, '.ssh', 'config')
// ssh 按 $HOME 找 ~/.ssh/config —— 把 HOME 指到临时目录，走的就是真实那条解析路径
vi.mock('../../../utils/paths', () => ({
  buildSpawnEnv: () => ({ ...process.env })
}))
const { sshExec, sshDisconnect, sshConnectedAliases, classifySshFailure } =
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
})

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
