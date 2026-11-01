/**
 * sshRemoteTasks —— 远端任务的编排：启动、长轮询、断线重连、本机镜像、停止、接后台任务枢纽。
 *
 * 「远端」是本机的 `/bin/sh -s`（support/localRemote）：sshScript 换成「把脚本喂给本机 sh」，其余全是真的 ——
 * 真脚本、真进程、真的后台任务枢纽（agent-runtime createTaskRegistry）。断线由 fake 注入：让指定的几次
 * sshScript 像连接断了一样以 255 收场。Windows 没有 sh，跳过。
 *
 * 分组（RT-*）：
 *   1…4   前台：窗口内结束不留痕迹、断线照样拿到结果、超时与中止真的停掉远端
 *   5…6   后台：脱离、结束时的通知、远端够不着时的停止
 *   7     删会话 / 退出：脱离的 ssh 停掉并删目录，枢纽的级联不再重复
 *   8     起不来：连不上当场交回，不留面板行
 *   9     探测：缓存、回退、连不上不缓存、systemd 形态
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskRegistry, type TaskRegistry } from '@shuvix/agent-runtime'

const fake = vi.hoisted(() => ({
  home: '',
  /** 接下来这么多次（满足 failWhen 的）sshScript 像断线一样以 255 收场 */
  failNext: 0,
  failWhen: undefined as ((script: string) => boolean) | undefined,
  /** 一直够不着 */
  unreachable: false,
  /** 连不上（指纹 / 认证…）：ssh 自己的 stderr */
  connectError: '',
  /** 探测脚本的回执覆写 */
  probeReply: undefined as { stdout: string; exitCode: number } | undefined,
  /** 接下来这么多次（满足 dropWhen 的）脚本**照常跑完**，回执却丢在路上（255） */
  dropAfterRun: 0,
  dropWhen: undefined as ((script: string) => boolean) | undefined,
  /** 远端登录 shell 的启动文件往 stdout 打的字（.bashrc 里的 echo） */
  banner: '',
  scripts: [] as string[],
  detached: [] as Array<{ alias: string; script: string }>
}))

vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

vi.mock('../sshControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sshControl')>()
  const { runLocalScript } = await import('./support/localRemote')
  const dropped = (stderr: string): Record<string, unknown> => ({
    stdout: '',
    stdoutBytes: Buffer.alloc(0),
    stderr,
    exitCode: 255,
    timedOut: false
  })
  return {
    ...actual,
    sshScript: async (opts: { script: string }) => {
      fake.scripts.push(opts.script)
      if (fake.connectError) return dropped(fake.connectError)
      if (fake.probeReply && opts.script.includes('SHUVIX-PROBE')) {
        return {
          ...fake.probeReply,
          stdoutBytes: Buffer.from(fake.probeReply.stdout),
          stderr: '',
          timedOut: false
        }
      }
      if (fake.unreachable) return dropped('ssh: connect to host box port 22: Operation timed out')
      if (fake.failNext > 0 && (!fake.failWhen || fake.failWhen(opts.script))) {
        fake.failNext--
        return dropped('Connection to box closed by remote host.')
      }
      const res = await runLocalScript(fake.home, opts.script)
      if (fake.dropAfterRun > 0 && (!fake.dropWhen || fake.dropWhen(opts.script))) {
        fake.dropAfterRun--
        return dropped('client_loop: send disconnect: Broken pipe')
      }
      if (!fake.banner) return res
      const stdoutBytes = Buffer.concat([
        Buffer.from(fake.banner),
        res.stdoutBytes ?? Buffer.alloc(0)
      ])
      return { ...res, stdout: stdoutBytes.toString('utf-8'), stdoutBytes }
    },
    sshScriptDetached: (opts: { alias: string; script: string }) => {
      fake.detached.push(opts)
      void runLocalScript(fake.home, opts.script)
    }
  }
})

import {
  hostMode,
  killRemoteTasksBySession,
  runRemoteCommand,
  setRemoteTaskHost,
  __resetRemoteTasksForTests,
  type HostMode,
  type RemoteRunParams
} from '../sshRemoteTasks'
import { REMOTE_ROOT_DIRNAME } from '../sshRemoteScripts'
import { waitFor } from './support/localRemote'

const posix = process.platform !== 'win32'
const isPoll = (script: string): boolean =>
  script.includes('poll_task "$ROOT/$I/$T" "$WAIT" "$FROM"')
const isStop = (script: string): boolean =>
  script.includes('stop_task "$ROOT/$I/$T"\n  echo "STOPPED"')
const isLaunch = (script: string): boolean => script.includes('cat > "$d/cmd"')

const RUNNER: Extract<HostMode, { kind: 'runner' }> = {
  kind: 'runner',
  systemd: false,
  probe: {
    os: 'Darwin',
    group: 'jobctl',
    homeWritable: true,
    killUserProcesses: false,
    linger: false,
    systemdRun: false,
    orphaned: 0,
    collected: 0
  }
}

function running(pattern: string): number {
  try {
    return execFileSync('pgrep', ['-f', pattern]).toString().trim().split('\n').filter(Boolean)
      .length
  } catch {
    return 0
  }
}

describe.skipIf(!posix)('sshRemoteTasks', () => {
  let toolResults: string
  let registry: TaskRegistry
  let notices: Array<{ sessionId: string; text: string }>
  let settings: Map<string, string>

  const run = (over: Partial<RemoteRunParams> = {}): ReturnType<typeof runRemoteCommand> =>
    runRemoteCommand({
      sessionId: 'S1',
      toolCallId: 'call_fg',
      alias: 'box',
      command: 'echo hi',
      description: 'say hi',
      background: false,
      timeoutSec: 30,
      mode: RUNNER,
      ...over
    })
  /** 这条任务在远端的目录（名字带每次调用的随机后缀）；没有 = null */
  const remoteDir = (taskId: string): string | null => {
    const root = remoteRoot()
    if (!existsSync(root)) return null
    const name = readdirSync(root).find((n) => n.startsWith(`${taskId}-`))
    return name ? join(root, name) : null
  }
  const remoteRoot = (): string =>
    join(fake.home, REMOTE_ROOT_DIRNAME, settings.get('ssh.remoteInstallId') ?? '')

  beforeEach(() => {
    fake.home = mkdtempSync(join(tmpdir(), 'shuvix-rt-home-'))
    toolResults = mkdtempSync(join(tmpdir(), 'shuvix-rt-tr-'))
    fake.failNext = 0
    fake.failWhen = undefined
    fake.unreachable = false
    fake.connectError = ''
    fake.probeReply = undefined
    fake.dropAfterRun = 0
    fake.dropWhen = undefined
    fake.banner = ''
    fake.scripts = []
    fake.detached = []
    notices = []
    settings = new Map()
    registry = createTaskRegistry({
      broadcast: () => {},
      deliver: (sessionId, text) => notices.push({ sessionId, text }),
      coalesceMs: 10
    })
    __resetRemoteTasksForTests({
      launchWaitSec: 1,
      pollWaitSec: 2,
      stopConfirmMs: 800,
      backoffMs: [50, 100, 200]
    })
    setRemoteTaskHost({
      registry,
      settings: { get: (k) => settings.get(k), set: (k, v) => void settings.set(k, v) },
      toolResultsDir: () => toolResults
    })
  })

  afterEach(async () => {
    killRemoteTasksBySession('S1')
    killRemoteTasksBySession('S2')
    await new Promise((r) => setTimeout(r, 300))
    execFileSync('/bin/sh', ['-c', 'pkill -f "sleep 30[6-9][0-9]" || true'])
    setRemoteTaskHost(null)
    rmSync(fake.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(toolResults, { recursive: true, force: true })
  })

  it('RT-1: 窗口内结束 —— 结果当场交回，不进面板、不发通知、本机镜像与远端目录都不留', async () => {
    const out = await run({ command: 'echo out; exit 3' })
    expect(out).toMatchObject({ kind: 'settled', exitCode: 3, reason: 'finished', status: 'error' })
    if (out.kind === 'settled') expect(out.output).toBe('out\n')
    expect(registry.list('S1')).toEqual([])
    expect(readdirSync(toolResults)).toEqual([])
    // 远端目录在本机收全之后另发 reap 删（不在交回结果的那一次里删）
    await waitFor(() => readdirSync(remoteRoot()).length === 1)
    expect(readdirSync(remoteRoot())).toEqual(['origin.json'])
    // 本安装的 id 只生成一次，存进设置
    expect(settings.get('ssh.remoteInstallId')).toMatch(/^[0-9a-f-]{36}$/)
    await new Promise((r) => setTimeout(r, 50))
    expect(notices).toEqual([])
  }, 30_000)

  it('RT-2: 跑到一半连接断了两次 —— 重连后照样拿到完整输出，进过面板的镜像留着', async () => {
    fake.failNext = 2
    fake.failWhen = isPoll
    const out = await run({ command: 'for i in 1 2 3; do echo "t$i"; sleep 1; done' })
    expect(out).toMatchObject({ kind: 'settled', exitCode: 0, reason: 'finished', status: 'done' })
    if (out.kind === 'settled') expect(out.output).toBe('t1\nt2\nt3\n')
    expect(fake.failNext).toBe(0)
    // 跑够阈值进过面板：那一行还要能展开看输出
    const [task] = registry.list('S1')
    expect(task?.subject).toMatchObject({ kind: 'bash', host: 'box', cwd: 'box:~', exitCode: 0 })
    expect(readFileSync(join(toolResults, 'call_fg.log'), 'utf-8')).toBe('t1\nt2\nt3\n')
    await waitFor(() => remoteDir('call_fg') === null)
  }, 30_000)

  it('RT-3: 超时 —— 停掉远端进程组，结果是被杀的那一个', async () => {
    const out = await run({ command: 'echo started; sleep 3061', timeoutSec: 2 })
    expect(out).toMatchObject({
      kind: 'settled',
      reason: 'timeout',
      status: 'killed',
      exitCode: 143
    })
    if (out.kind === 'settled') expect(out.output).toContain('started')
    expect(running('sleep 3061')).toBe(0)
  }, 30_000)

  it('RT-4: 中止 —— 同样停掉远端', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 1500)
    const out = await run({ command: 'sleep 3062', signal: ac.signal })
    expect(out).toMatchObject({ kind: 'settled', reason: 'abort', status: 'killed' })
    expect(running('sleep 3062')).toBe(0)
  }, 30_000)

  it('RT-5: 后台 —— 窗口后脱离，结束时发一条带 host 的通知，镜像与远端逐字节一致', async () => {
    const out = await run({
      toolCallId: 'call_bg',
      background: true,
      command: 'echo "héllo"; sleep 2; echo done; exit 4'
    })
    expect(out).toMatchObject({ kind: 'background', taskId: 'call_bg' })
    expect(registry.list('S1').map((t) => t.taskId)).toEqual(['call_bg'])
    await waitFor(() => notices.length > 0, 15_000)
    const text = notices[0].text
    expect(text).toMatch(
      /^<background-task host="box" task="call_bg" status="exited with code 4" duration="\d+s">/
    )
    expect(text).toContain('Last output:\nhéllo\ndone')
    expect(text).toContain(`Full log: ${join(toolResults, 'call_bg.log')}`)
    expect(readFileSync(join(toolResults, 'call_bg.log'), 'utf-8')).toBe('héllo\ndone\n')
    await waitFor(() => remoteDir('call_bg') === null)
  }, 30_000)

  it('RT-6: 停的时候远端够不着 —— 先按「已停」落定并说明，连上之后停止照样送到', async () => {
    const out = await run({ toolCallId: 'call_bg', background: true, command: 'sleep 3071' })
    expect(out.kind).toBe('background')
    fake.unreachable = true
    expect(registry.stop('call_bg', { by: 'user' })).toBe(true)
    await waitFor(() => notices.length > 0, 10_000)
    expect(notices[0].text).toContain('status="stopped"')
    expect(notices[0].text).toContain('Could not reach "box" to confirm the stop')
    expect(running('sleep 3071')).toBe(1)
    fake.unreachable = false
    await waitFor(() => running('sleep 3071') === 0, 10_000)
    await waitFor(() => remoteDir('call_bg') === null, 10_000)
  }, 30_000)

  it('RT-7: 删会话 —— 经脱离的 ssh 停掉并删目录，只动这条会话的；之后枢纽的级联不再发停止', async () => {
    await run({ toolCallId: 'call_a', background: true, command: 'sleep 3081' })
    await run({ toolCallId: 'call_b', background: true, command: 'sleep 3082' })
    await run({ sessionId: 'S2', toolCallId: 'call_c', background: true, command: 'sleep 3083' })
    expect(killRemoteTasksBySession('S1')).toBe(2)
    expect(fake.detached).toHaveLength(1)
    expect(fake.detached[0].alias).toBe('box')
    expect(fake.detached[0].script).toMatch(/DIRS='call_a-[0-9a-f]{6} call_b-[0-9a-f]{6}'/)
    const stopsBefore = fake.scripts.filter(isStop).length
    registry.killBySession('S1')
    await waitFor(() => running('sleep 308[12]') === 0, 10_000)
    // 停完再删目录（同一个远端后台子 shell 里先后做）
    await waitFor(() => remoteDir('call_a') === null && remoteDir('call_b') === null)
    expect(running('sleep 3083')).toBe(1)
    expect(remoteDir('call_c')).not.toBeNull()
    expect(fake.scripts.filter(isStop).length).toBe(stopsBefore)
  }, 30_000)

  it('RT-7b: 同一个 tool call id 在会话里又来一次（有的供应商每轮从头编号）—— 两条都起，本机各记各的', async () => {
    const a = await run({
      toolCallId: 'functions.exec:0',
      background: true,
      command: 'echo A; sleep 3091'
    })
    const b = await run({
      toolCallId: 'functions.exec:0',
      background: true,
      command: 'echo B; sleep 3092'
    })
    await waitFor(() => running('sleep 309[12]') === 2)
    expect(a).toMatchObject({ kind: 'background', taskId: 'functions.exec:0' })
    expect(b.kind).toBe('background')
    if (a.kind !== 'background' || b.kind !== 'background') return
    expect(b.taskId).toMatch(/^functions\.exec:0~[0-9a-f]{6}$/)
    expect(b.logPath).not.toBe(a.logPath)
    expect(
      registry
        .list('S1')
        .map((t) => t.taskId)
        .sort()
    ).toEqual([a.taskId, b.taskId].sort())
    await waitFor(
      () => readFileSync(a.logPath, 'utf-8') === 'A\n' && readFileSync(b.logPath, 'utf-8') === 'B\n'
    )
  }, 30_000)

  it('RT-10: 窗口内结束、回执却丢了 —— 重放启动拿回同一个结果，命令不再跑一遍', async () => {
    fake.dropAfterRun = 1
    fake.dropWhen = isLaunch
    const out = await run({ command: 'echo once >> "$HOME/count"; echo done; exit 2' })
    expect(out).toMatchObject({ kind: 'settled', exitCode: 2, reason: 'finished' })
    if (out.kind === 'settled') expect(out.output).toBe('done\n')
    expect(readFileSync(join(fake.home, 'count'), 'utf-8')).toBe('once\n')
  }, 30_000)

  it('RT-11: 远端 .bashrc 往 stdout 打字 —— 照样认得出回执', async () => {
    fake.banner = 'Welcome to box!\n'
    const out = await run({ command: 'echo hi; exit 1' })
    expect(out).toMatchObject({ kind: 'settled', exitCode: 1 })
    if (out.kind === 'settled') expect(out.output).toBe('hi\n')
  }, 30_000)

  it('RT-12: 启动途中会话被删 —— 不登记、不挂着，远端那条也停掉', async () => {
    const pending = run({ toolCallId: 'call_x', command: 'sleep 3093' })
    await new Promise((r) => setTimeout(r, 300))
    killRemoteTasksBySession('S1')
    const out = await pending
    expect(out).toMatchObject({ kind: 'failed' })
    expect(registry.list('S1')).toEqual([])
    await waitFor(() => running('sleep 3093') === 0, 10_000)
  }, 30_000)

  it('RT-13: 启动后一直连不回来 —— 到点交回失败，并发一次停止（命令可能已经起来了）', async () => {
    fake.dropAfterRun = 1000
    fake.dropWhen = isLaunch
    const out = await run({ toolCallId: 'call_y', command: 'sleep 3094', timeoutSec: 2 })
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') expect(out.message).toContain('asked "box" to stop it')
    expect(fake.detached.some((d) => d.script.includes('call_y-'))).toBe(true)
    await waitFor(() => running('sleep 3094') === 0, 10_000)
  }, 30_000)

  it('RT-8: 连不上 —— 当场交回翻译过的原因，不留面板行和镜像', async () => {
    fake.connectError = 'agent@box: Permission denied (publickey,password).'
    const out = await run()
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') expect(out.message).toContain('Authentication to "box" was refused')
    expect(registry.list('S1')).toEqual([])
    expect(readdirSync(toolResults)).toEqual([])
  }, 30_000)

  describe('RT-9 探测', () => {
    it('RT-9a: 能跑脚本 → runner，一次运行只探一次', async () => {
      const a = await hostMode({ sessionId: 'S1', alias: 'box' })
      const b = await hostMode({ sessionId: 'S2', alias: 'box' })
      expect(a).toMatchObject({ kind: 'runner', systemd: false })
      expect(b).toBe(a)
      expect(fake.scripts.filter((s) => s.includes('SHUVIX-PROBE'))).toHaveLength(1)
    })

    it('RT-9b: 没有 POSIX sh（Windows、受限 shell）→ 直连', async () => {
      fake.probeReply = {
        stdout: "'sh' is not recognized as an internal or external command\n",
        exitCode: 1
      }
      expect(await hostMode({ sessionId: 'S1', alias: 'win' })).toMatchObject({ kind: 'direct' })
    })

    it('RT-9c: 连不上 → 原样交回，不缓存（下次再探）', async () => {
      fake.connectError = 'ssh: Could not resolve hostname box: nodename nor servname provided'
      expect((await hostMode({ sessionId: 'S1', alias: 'box' })).kind).toBe('unreachable')
      fake.connectError = ''
      expect((await hostMode({ sessionId: 'S1', alias: 'box' })).kind).toBe('runner')
    })

    it('RT-9d: 登出会杀进程 —— 开了 linger 走 systemd-run，没开就带一句说明', async () => {
      const reply = (linger: string): { stdout: string; exitCode: number } => ({
        stdout: `SHUVIX-PROBE 1\nos=Linux\ngroup=setsid\nhome=ok\nkup=1\nlinger=${linger}\nsystemd_run=1\nsweep orphaned=0 gc=0\n`,
        exitCode: 0
      })
      fake.probeReply = reply('yes')
      expect(await hostMode({ sessionId: 'S1', alias: 'lingered' })).toMatchObject({
        kind: 'runner',
        systemd: true
      })
      fake.probeReply = reply('no')
      const m = await hostMode({ sessionId: 'S1', alias: 'strict' })
      expect(m).toMatchObject({ kind: 'runner', systemd: false })
      if (m.kind === 'runner') expect(m.note).toContain('loginctl enable-linger')
    })

    it('RT-9e: home 不可写、建不了进程组 → 直连', async () => {
      fake.probeReply = {
        stdout: 'SHUVIX-PROBE 1\nos=Linux\ngroup=setsid\nhome=unwritable\nkup=0\n',
        exitCode: 0
      }
      expect(await hostMode({ sessionId: 'S1', alias: 'ro' })).toMatchObject({ kind: 'direct' })
      fake.probeReply = {
        stdout: 'SHUVIX-PROBE 1\nos=Linux\ngroup=none\nhome=ok\nkup=0\n',
        exitCode: 0
      }
      expect(await hostMode({ sessionId: 'S1', alias: 'bare' })).toMatchObject({ kind: 'direct' })
    })
  })
})
