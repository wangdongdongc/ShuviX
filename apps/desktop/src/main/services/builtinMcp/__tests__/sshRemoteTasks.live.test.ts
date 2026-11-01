/**
 * 远端任务对一台**真的**远端（真 ssh、真 sshd、远端自己的 sh —— Linux 上是 dash）。
 *
 * 缺省跳过；指一台 ~/.ssh/config 里的别名才跑（能免密登录、可以随便起进程的测试机）：
 *   SHUVIX_SSH_LIVE_HOST=testvm npx vitest run src/main/services/builtinMcp/__tests__/sshRemoteTasks.live.test.ts
 *
 * 本机 sh 那一组（sshRemoteTasks.test）证明不了的三件事在这里：ssh 真的把脚本经 stdin 送到、
 * ControlMaster 真断之后能重连接着取、退出 / 删会话时脱离的 ssh 真把远端进程停掉。
 * 远端只碰 `~/.shuvix-ssh/<本次随机的 installId>/` 与以 `sleep 46` 开头的进程，结束时删干净。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { createTaskRegistry } from '@shuvix/agent-runtime'

const HOST = process.env.SHUVIX_SSH_LIVE_HOST ?? ''

vi.mock('../../../utils/paths', () => ({ buildSpawnEnv: () => ({ ...process.env }) }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

describe.skipIf(!HOST || process.platform === 'win32')(`远端任务 · 真主机 ${HOST}`, () => {
  const installId = randomUUID()
  const SID = `live-${Date.now()}`
  let tr = ''
  const notices: string[] = []
  let mod: typeof import('../sshRemoteTasks')
  let ctl: typeof import('../sshControl')

  const remote = async (command: string): Promise<string> =>
    (await ctl.sshExec({ sessionId: SID, alias: HOST, command, timeoutSec: 30 })).stdout.trim()
  const runner = async (): Promise<
    Extract<import('../sshRemoteTasks').HostMode, { kind: 'runner' }>
  > => {
    const m = await mod.hostMode({ sessionId: SID, alias: HOST })
    if (m.kind !== 'runner') throw new Error(`${HOST} is not a runner host: ${JSON.stringify(m)}`)
    return m
  }

  beforeAll(async () => {
    process.env.SHUVIX_SSH_CONTROL_ROOT = mkdtempSync('/tmp/shuvix-live-')
    tr = mkdtempSync(join(tmpdir(), 'shuvix-live-tr-'))
    ctl = await import('../sshControl')
    mod = await import('../sshRemoteTasks')
    const settings = new Map<string, string>([['ssh.remoteInstallId', installId]])
    mod.setRemoteTaskHost({
      registry: createTaskRegistry({
        broadcast: () => {},
        deliver: (_s, t) => notices.push(t),
        coalesceMs: 10
      }),
      settings: { get: (k) => settings.get(k), set: (k, v) => void settings.set(k, v) },
      toolResultsDir: () => tr
    })
  })

  afterAll(async () => {
    await remote(`pkill -f '^sleep 46' ; rm -rf ~/.shuvix-ssh/${installId}`)
    await ctl.sshDisconnect(SID, HOST)
    rmSync(tr, { recursive: true, force: true })
  })

  it('L-1: 探测 —— 能跑脚本', async () => {
    const m = await runner()
    expect(m.probe.homeWritable).toBe(true)
    expect(m.probe.group).not.toBe('none')
  }, 60_000)

  it('L-2: 前台窗口内结束 —— 一个来回，远端不留目录', async () => {
    const out = await mod.runRemoteCommand({
      sessionId: SID,
      toolCallId: 'live_fg',
      alias: HOST,
      command: `echo "on $(uname -s) as $(id -un)"; exit 3`,
      description: 'live fg',
      background: false,
      timeoutSec: 60,
      mode: await runner()
    })
    expect(out).toMatchObject({ kind: 'settled', exitCode: 3, reason: 'finished' })
    if (out.kind === 'settled') expect(out.output).toMatch(/^on \w+ as \w+\n$/)
    // 远端目录在本机收全后另发 reap 删
    const until = Date.now() + 20_000
    let left = ''
    while (Date.now() < until) {
      left = await remote(`ls ~/.shuvix-ssh/${installId}`)
      if (left === 'origin.json') break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(left).toBe('origin.json')
  }, 60_000)

  it('L-3: 前台命令跑到一半 master 被关 —— 重连后拿到完整输出', async () => {
    const pending = mod.runRemoteCommand({
      sessionId: SID,
      toolCallId: 'live_drop',
      alias: HOST,
      command: 'for i in 1 2 3 4 5 6; do echo "tick $i"; sleep 1; done',
      description: 'live drop',
      background: false,
      timeoutSec: 120,
      mode: await runner()
    })
    await new Promise((r) => setTimeout(r, 3500))
    // 正在复用这条连接的轮询随之以 255 断掉
    expect(await ctl.sshDisconnect(SID, HOST)).toBe(true)
    const out = await pending
    expect(out).toMatchObject({ kind: 'settled', exitCode: 0, reason: 'finished' })
    if (out.kind === 'settled') {
      expect(out.output).toBe('tick 1\ntick 2\ntick 3\ntick 4\ntick 5\ntick 6\n')
    }
  }, 120_000)

  it('L-4: 超时 —— 远端整个进程组停掉', async () => {
    const out = await mod.runRemoteCommand({
      sessionId: SID,
      toolCallId: 'live_timeout',
      alias: HOST,
      command: 'sleep 4601 & sleep 4602; wait',
      description: 'live timeout',
      background: false,
      timeoutSec: 4,
      mode: await runner()
    })
    expect(out).toMatchObject({
      kind: 'settled',
      reason: 'timeout',
      status: 'killed',
      exitCode: 143
    })
    expect(await remote("pgrep -c -f '^sleep 460' || true")).toBe('0')
  }, 60_000)

  it('L-5: 后台 —— 结束时的通知带 host，镜像是完整输出', async () => {
    const out = await mod.runRemoteCommand({
      sessionId: SID,
      toolCallId: 'live_bg',
      alias: HOST,
      command: 'echo start; sleep 3; echo end; exit 5',
      description: 'live bg',
      background: true,
      timeoutSec: 60,
      mode: await runner()
    })
    expect(out.kind).toBe('background')
    const until = Date.now() + 30_000
    while (notices.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
    expect(notices[0]).toContain(
      `<background-task host="${HOST}" task="live_bg" status="exited with code 5"`
    )
    expect(readFileSync(join(tr, 'live_bg.log'), 'utf-8')).toBe('start\nend\n')
  }, 60_000)

  it('L-6: 删会话 —— 脱离的 ssh 停掉远端进程并删目录', async () => {
    const out = await mod.runRemoteCommand({
      sessionId: SID,
      toolCallId: 'live_kill',
      alias: HOST,
      command: 'sleep 4611 & sleep 4612; wait',
      description: 'live kill',
      background: true,
      timeoutSec: 60,
      mode: await runner()
    })
    expect(out.kind).toBe('background')
    expect(await remote("pgrep -c -f '^sleep 461' || true")).toBe('2')
    expect(mod.killRemoteTasksBySession(SID)).toBe(1)
    const until = Date.now() + 30_000
    let left = '2'
    while (Date.now() < until) {
      left = await remote(`pgrep -c -f '^sleep 461' || true; ls ~/.shuvix-ssh/${installId}`)
      if (left === '0\norigin.json') break
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(left).toBe('0\norigin.json')
  }, 60_000)
})
