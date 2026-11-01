/**
 * sshRemoteScripts —— 远端任务的脚本与回执。
 *
 * 两层：
 *  - 纯函数（RS-P-*）：脚本怎么拼（命令原样进 heredoc、结束符避开内容、不安全的 id 拒绝）、回执怎么解析；
 *  - **真 shell**（RS-S-*）：远端那一半的逻辑就是 `sh -s` 读到的脚本，ssh 只是搬运工 —— 这里把脚本直接喂给
 *    本机的 `/bin/sh -s`（HOME 指向临时目录），runner、进程组、退出码落盘、字节偏移续读、清理全是真的。
 *    macOS 上 sh 是 bash（没有 setsid，走 `set -m`），Linux 上是 dash（走 setsid）。Windows 没有 sh，跳过。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildKillScript,
  buildLaunchScript,
  buildPollScript,
  buildProbeScript,
  buildReapScript,
  buildStopScript,
  parseProbe,
  parseReport,
  remoteTaskDirName,
  REMOTE_ROOT_DIRNAME,
  type LaunchScriptParams
} from '../sshRemoteScripts'
import { runLocalScript, waitFor } from './support/localRemote'

const I = '11111111-aaaa-4aaa-8aaa-000000000001'
const RUN = 'run-current'
let seq = 0
const random = (): string => (seq++).toString(16).padStart(16, '0')

function launchParams(over: Partial<LaunchScriptParams> = {}): LaunchScriptParams {
  return {
    installId: I,
    runId: RUN,
    dir: 'call_1',
    waitSec: 2,
    capBytes: 1024 * 1024,
    manifest: {
      schema: 'shuvix.ssh-task/1',
      runId: over.runId ?? RUN,
      taskId: over.dir ?? 'call_1'
    },
    origin: { schema: 'shuvix.ssh-origin/1', hostname: 'test' },
    command: 'echo hi',
    random,
    ...over
  }
}

describe('RS-P 拼脚本与解析回执', () => {
  it('RS-P-1: 命令原样进 quoted heredoc —— 引号、$、反斜杠一个都不转义', () => {
    const command = `echo "it's $HOME" \\ 'x' \`date\` $(id)`
    const script = buildLaunchScript(launchParams({ command }))
    expect(script).toContain(`\n${command}\n`)
    // quoted heredoc：开头的结束符带单引号，内容不做任何展开
    expect(script).toMatch(/cat > "\$d\/cmd" <<'SHUVIX_[0-9a-f]{16}'/)
  })

  it('RS-P-2: 结束符避开内容里恰好成行的那一个', () => {
    let n = 0
    const tags = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']
    const script = buildLaunchScript(
      launchParams({ command: 'echo 1\nSHUVIX_aaaaaaaaaaaaaaaa\necho 2', random: () => tags[n++] })
    )
    expect(script).toContain("<<'SHUVIX_bbbbbbbbbbbbbbbb'")
    expect(script).not.toContain("<<'SHUVIX_aaaaaaaaaaaaaaaa'")
  })

  it('RS-P-3: 会拼进单引号与路径的 id 不安全就拒绝', () => {
    expect(() => buildLaunchScript(launchParams({ dir: "x'; rm -rf ~; '" }))).toThrow(/unsafe dir/)
    expect(() =>
      buildPollScript({
        installId: '../x',
        dir: 'a',
        waitSec: 0,
        fromByte: 0,
        capBytes: 1
      })
    ).toThrow(/unsafe installId/)
    expect(() => buildKillScript({ installId: I, dirs: ['ok', 'a b'] })).toThrow(/unsafe dir/)
  })

  it('RS-P-4: 目录名 = 安全的 id 原样（否则取哈希）+ 这次调用的后缀（同一个 id 会在一个会话里重复出现）', () => {
    const hash = (): string => 'f'.repeat(64)
    expect(remoteTaskDirName('toolu_01ABC-x', hash, 'a1b2c3')).toBe('toolu_01ABC-x-a1b2c3')
    expect(remoteTaskDirName('functions.exec:0', hash, 'a1b2c3')).toBe(`t-${'f'.repeat(24)}-a1b2c3`)
    expect(remoteTaskDirName('x'.repeat(65), hash, 'a1b2c3')).toBe(`t-${'f'.repeat(24)}-a1b2c3`)
  })

  it('RS-P-5: 整段包在函数里再调用（半截脚本 = 语法错误 = 什么都不执行）', () => {
    for (const script of [
      buildLaunchScript(launchParams()),
      buildPollScript({ installId: I, dir: 'a', waitSec: 1, fromByte: 0, capBytes: 10 }),
      buildReapScript({ installId: I, dir: 'a', fromByte: 0 }),
      buildStopScript({ installId: I, dir: 'a' }),
      buildKillScript({ installId: I, dirs: ['a'] }),
      buildProbeScript({ installId: I, runId: RUN, staleSec: 1, gcDays: 1 })
    ]) {
      expect(script.trimEnd().endsWith('}\nshuvix_main')).toBe(true)
      // 曾经的坑：String.raw 里写 `\${…}` 会把反斜杠原样留下，shell 拿到的是字面量
      expect(script).not.toContain('\\${')
      // dash 不认 `kill -TERM -- -PGID`
      expect(script).not.toMatch(/kill -TERM --/)
    }
  })

  it('RS-P-6: systemd 形态 —— runner 交给 systemd-run --user，环境经 env 文件带过去', () => {
    const script = buildLaunchScript(launchParams({ systemdUnit: 'shuvix-task-abc' }))
    expect(script).toContain("UNIT='shuvix-task-abc'")
    expect(script).toContain('systemd-run --user --collect --quiet --unit="$UNIT"')
    expect(script).toContain('export -p > "$d/env"')
    expect(buildLaunchScript(launchParams())).not.toContain('systemd-run')
  })

  it('RS-P-7: 回执解析 —— 各状态、字节原样、认不出就是 null', () => {
    const body = Buffer.concat([
      Buffer.from('héllo '),
      Buffer.from([0xe4, 0xb8]),
      Buffer.from([0xad])
    ])
    const r = parseReport(Buffer.concat([Buffer.from('SHUVIX-STATE RUNNING SIZE 99\n'), body]))
    expect(r?.state).toEqual({ kind: 'running' })
    expect(r?.size).toBe(99)
    expect(r?.body.equals(body)).toBe(true)
    expect(parseReport(Buffer.from('SHUVIX-STATE EXIT 143 stopped SIZE 0\n'))?.state).toEqual({
      kind: 'exit',
      code: 143,
      stopped: true,
      orphaned: false
    })
    expect(
      parseReport(Buffer.from('SHUVIX-STATE EXIT 0 stopped orphaned SIZE 3\nabc'))?.state
    ).toMatchObject({ orphaned: true })
    expect(parseReport(Buffer.from('SHUVIX-STATE LOST SIZE 0\n'))?.state).toEqual({ kind: 'lost' })
    expect(parseReport(Buffer.from('SHUVIX-STATE GONE SIZE 0\n'))?.state).toEqual({ kind: 'gone' })
    expect(
      parseReport(Buffer.from('SHUVIX-STATE ERROR runner-did-not-start SIZE 0\nwhy'))?.state
    ).toEqual({ kind: 'error', reason: 'runner-did-not-start' })
    // 半截输出、别的东西：不能当日志收（字节偏移会错位）
    expect(parseReport(Buffer.from('SHUVIX-STATE RUNNING SIZ'))).toBeNull()
    expect(parseReport(Buffer.from("'sh' is not recognized as an internal command\n"))).toBeNull()
  })

  it('RS-P-7b: 哨兵行之前的输出（远端 .bashrc 的 echo）丢掉；行中间的哨兵字样不算', () => {
    const r = parseReport(
      Buffer.from(
        'Welcome to prod! SHUVIX-STATE EXIT 9 SIZE 0\nLast login: today\nSHUVIX-STATE EXIT 0 SIZE 3\nabc'
      )
    )
    expect(r?.state).toEqual({ kind: 'exit', code: 0, stopped: false, orphaned: false })
    expect(r?.body.toString()).toBe('abc')
  })

  it('RS-P-8: 探测回执 —— 没有标记行就是跑不了脚本', () => {
    expect(parseProbe('sh: not found\n')).toBeNull()
    expect(
      parseProbe(
        'SHUVIX-PROBE 1\nos=Linux\ngroup=setsid\nhome=ok\nkup=1\nlinger=yes\nsystemd_run=1\nsweep orphaned=2 gc=3\n'
      )
    ).toEqual({
      os: 'Linux',
      group: 'setsid',
      homeWritable: true,
      killUserProcesses: true,
      linger: true,
      systemdRun: true,
      orphaned: 2,
      collected: 3
    })
    expect(
      parseProbe('SHUVIX-PROBE 1\ngroup=none\nhome=unwritable\nkup=0\nlinger=\n')
    ).toMatchObject({
      group: 'none',
      homeWritable: false,
      linger: false
    })
  })
})

// ─── 真 shell ────────────────────────────────────────

const posix = process.platform !== 'win32'

describe.skipIf(!posix)('RS-S 远端那一半，用本机 sh 跑', () => {
  let home: string
  const root = (): string => join(home, REMOTE_ROOT_DIRNAME, I)
  const sh = (script: string, env?: Record<string, string>): ReturnType<typeof runLocalScript> =>
    runLocalScript(home, script, { env })
  const report = async (
    script: string,
    env?: Record<string, string>
  ): Promise<NonNullable<ReturnType<typeof parseReport>>> => {
    const res = await sh(script, env)
    const r = res.stdoutBytes ? parseReport(res.stdoutBytes) : null
    if (!r) throw new Error(`no report: ${res.stdout} ${res.stderr}`)
    return r
  }
  const poll = (dir: string, waitSec: number, fromByte: number, capBytes = 1024 * 1024): string =>
    buildPollScript({ installId: I, dir, waitSec, fromByte, capBytes })
  const reap = async (dir: string, fromByte: number): Promise<string> =>
    (await sh(buildReapScript({ installId: I, dir, fromByte }))).stdout.trim()
  const running = (pattern: string): number => {
    try {
      return execFileSync('pgrep', ['-f', pattern]).toString().trim().split('\n').filter(Boolean)
        .length
    } catch {
      return 0
    }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'shuvix-remote-'))
  })
  afterEach(async () => {
    execFileSync('/bin/sh', ['-c', 'pkill -f "sleep 30[0-5][0-9]" || true'])
    // runner 们收到子进程退出后还要写 exit：等它们全走了再删，否则删目录时它正往里写
    await waitFor(() => running(home) === 0, 15_000).catch(() => {
      const left = execFileSync('/bin/sh', ['-c', `pgrep -fl "${home}" || true`]).toString()
      throw new Error(`processes still running under ${home}:\n${left}`)
    })
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('RS-S-1: 窗口内结束 —— 一个来回带回退出码与输出；目录留到本机收全后的 reap', async () => {
    const r = await report(
      buildLaunchScript(launchParams({ command: 'echo "out $((1+1))"; echo err >&2; exit 3' }))
    )
    expect(r.state).toEqual({ kind: 'exit', code: 3, stopped: false, orphaned: false })
    expect(r.body.toString()).toBe('out 2\nerr\n')
    const d = join(root(), 'call_1')
    expect(existsSync(d)).toBe(true)
    // 还有字节没收（from 比日志短）→ 不删
    expect(await reap('call_1', 3)).toBe('KEPT')
    expect(existsSync(d)).toBe(true)
    expect(await reap('call_1', r.body.length)).toBe('REAPED')
    expect(existsSync(d)).toBe(false)
    // 可重放
    expect(await reap('call_1', r.body.length)).toBe('REAPED')
    expect(readdirSync(root())).toEqual(['origin.json'])
    expect(readFileSync(join(home, REMOTE_ROOT_DIRNAME, 'README'), 'utf-8')).toContain('ShuviX')
  }, 30_000)

  it('RS-S-1b: 回执丢了、启动重放 —— 命令不会再跑一遍，交回的还是那一次的结果', async () => {
    const script = buildLaunchScript(
      launchParams({ command: 'echo once >> "$HOME/count"; echo done; exit 4' })
    )
    const first = await report(script)
    const again = await report(script)
    expect(again.state).toEqual(first.state)
    expect(again.body.toString()).toBe('done\n')
    expect(readFileSync(join(home, 'count'), 'utf-8')).toBe('once\n')
  }, 30_000)

  it('RS-S-2: 没结束 —— RUNNING，之后从字节偏移接着取，轮询从不删目录', async () => {
    const first = await report(
      buildLaunchScript(
        launchParams({
          waitSec: 1,
          command: 'for i in 1 2 3; do echo "tick $i"; sleep 1; done; exit 0'
        })
      )
    )
    expect(first.state.kind).toBe('running')
    const task = JSON.parse(readFileSync(join(root(), 'call_1', 'task.json'), 'utf-8'))
    expect(task.runId).toBe(RUN)
    let mirror = first.body
    // 上限 4 字节：结束之后还得分几轮取完
    let r = await report(poll('call_1', 10, mirror.length, 4))
    mirror = Buffer.concat([mirror, r.body])
    while (r.state.kind === 'exit' && mirror.length < r.size) {
      r = await report(poll('call_1', 0, mirror.length, 4))
      mirror = Buffer.concat([mirror, r.body])
    }
    expect(r.state).toMatchObject({ kind: 'exit', code: 0 })
    expect(mirror.toString()).toBe('tick 1\ntick 2\ntick 3\n')
    expect(existsSync(join(root(), 'call_1'))).toBe(true)
    expect(await reap('call_1', mirror.length)).toBe('REAPED')
  }, 30_000)

  it('RS-S-3: 启动可重放 —— 第二次启动只 poll，不起第二个进程', async () => {
    await report(buildLaunchScript(launchParams({ waitSec: 0, command: 'sleep 3011' })))
    await report(buildLaunchScript(launchParams({ waitSec: 0, command: 'sleep 3011' })))
    expect(running('sleep 3011')).toBe(1)
    // 还在跑的不删
    expect(await reap('call_1', 0)).toBe('KEPT')
  }, 30_000)

  it('RS-S-4: 停 —— 整个进程组（含孙进程）都停掉，记 143 stopped', async () => {
    await report(
      buildLaunchScript(
        launchParams({
          waitSec: 0,
          command: 'sleep 3021 & sleep 3022 & (sleep 3023; echo never); wait'
        })
      )
    )
    await waitFor(() => running('sleep 302[123]') === 3)
    const res = await sh(buildStopScript({ installId: I, dir: 'call_1' }))
    expect(res.stdout).toContain('STOPPED')
    const r = await report(poll('call_1', 0, 0))
    expect(r.state).toEqual({ kind: 'exit', code: 143, stopped: true, orphaned: false })
    expect(running('sleep 302[123]')).toBe(0)
  }, 30_000)

  it('RS-S-5: runner 被 kill -9 —— LOST，之后再问还是 LOST；reap 之后是 GONE', async () => {
    await report(buildLaunchScript(launchParams({ waitSec: 0, command: 'sleep 3031' })))
    const d = join(root(), 'call_1')
    const runner = Number(readFileSync(join(d, 'runner'), 'utf-8'))
    const pgid = Number(readFileSync(join(d, 'pgid'), 'utf-8'))
    process.kill(runner, 'SIGKILL')
    process.kill(-pgid, 'SIGKILL')
    await waitFor(() => running('sleep 3031') === 0)
    expect((await report(poll('call_1', 1, 0))).state).toEqual({ kind: 'lost' })
    expect((await report(poll('call_1', 0, 0))).state).toEqual({ kind: 'lost' })
    expect(await reap('call_1', 0)).toBe('REAPED')
    expect((await report(poll('call_1', 0, 0))).state).toEqual({ kind: 'gone' })
  }, 30_000)

  it('RS-S-5b: 没有能用的 ps（精简容器、busybox 不认 -p）—— 跑着的 runner 不被当成死了', async () => {
    const bin = join(home, 'shim')
    execFileSync('mkdir', ['-p', bin])
    await report(buildLaunchScript(launchParams({ waitSec: 0, command: 'sleep 3035' })))
    // ps 一调就失败：只能信 kill -0
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const env = { PATH: `${bin}:${process.env.PATH ?? ''}` }
    expect((await report(poll('call_1', 0, 0), env)).state).toEqual({ kind: 'running' })
    // ps 能用、但那个 pid 已经是别的进程了（pid 复用）→ 不是我们的 runner
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\necho "/usr/sbin/cron -f"\n', { mode: 0o755 })
    if (!existsSync('/proc/self/cmdline')) {
      expect((await report(poll('call_1', 0, 0), env)).state).toEqual({ kind: 'lost' })
    }
  }, 30_000)

  it('RS-S-6: 删会话 / 退出 —— 停掉并删目录，活儿在远端后台做完', async () => {
    await report(
      buildLaunchScript(launchParams({ dir: 'call_a', waitSec: 0, command: 'sleep 3041' }))
    )
    await report(
      buildLaunchScript(
        launchParams({ dir: 'call_b', waitSec: 0, command: 'sleep 3042 & sleep 3043; wait' })
      )
    )
    const res = await sh(buildKillScript({ installId: I, dirs: ['call_a', 'call_b'] }))
    expect(res.stdout).toContain('KILL-SENT')
    await waitFor(() => running('sleep 304[123]') === 0 && readdirSync(root()).length === 1)
    expect(readdirSync(root())).toEqual(['origin.json'])
  }, 30_000)

  it('RS-S-7: 半截脚本什么都不执行', async () => {
    const script = buildLaunchScript(launchParams({ command: 'touch "$HOME/ran"' }))
    // 断在命令文件写到一半的地方
    const cut = script.slice(0, script.indexOf('touch "$HOME/ran"') + 5)
    await sh(cut)
    expect(existsSync(join(home, 'ran'))).toBe(false)
    expect(existsSync(join(root(), 'call_1'))).toBe(false)
  }, 30_000)

  it('RS-S-8: 探测与清理 —— 只停本安装上一轮运行、没人照看的；别的安装与还有人 poll 的不动', async () => {
    const other = '22222222-bbbb-4bbb-8bbb-000000000002'
    // 上一轮运行留下的、没人照看（seen 很旧）
    await report(
      buildLaunchScript(
        launchParams({ dir: 'call_old', runId: 'run-old', waitSec: 0, command: 'sleep 3051' })
      )
    )
    // 同一个安装、另一轮运行，但还有人在 poll（复制了数据目录的另一台机器）
    await report(
      buildLaunchScript(
        launchParams({ dir: 'call_clone', runId: 'run-clone', waitSec: 0, command: 'sleep 3052' })
      )
    )
    // 本轮自己的
    await report(
      buildLaunchScript(launchParams({ dir: 'call_mine', waitSec: 0, command: 'sleep 3053' }))
    )
    // 另一个安装（远端自己装的 ShuviX）
    await report(
      buildLaunchScript(
        launchParams({
          installId: other,
          dir: 'call_vm',
          runId: 'run-old',
          waitSec: 0,
          command: 'sleep 3054'
        })
      )
    )
    // 8 天前结束的
    const done = join(root(), 'call_done')
    execFileSync('mkdir', ['-p', done])
    writeFileSync(join(done, 'task.json'), '{"runId": "run-old"}')
    writeFileSync(join(done, 'exit'), `0 ${Math.floor(Date.now() / 1000) - 8 * 86400}\n`)
    // seen：老的改旧，clone 的刚 poll 过
    execFileSync('touch', ['-t', '202001010000', join(root(), 'call_old', 'seen')])
    execFileSync('touch', [join(root(), 'call_clone', 'seen')])

    const res = await sh(buildProbeScript({ installId: I, runId: RUN, staleSec: 60, gcDays: 7 }))
    const probe = parseProbe(res.stdout)
    expect(probe).toMatchObject({ homeWritable: true, orphaned: 1, collected: 1 })
    expect(probe?.group === 'setsid' || probe?.group === 'jobctl').toBe(true)
    expect(probe?.killUserProcesses).toBe(false)

    expect((await report(poll('call_old', 0, 0))).state).toEqual({
      kind: 'exit',
      code: 143,
      stopped: true,
      orphaned: true
    })
    expect(running('sleep 3051')).toBe(0)
    expect(running('sleep 3052')).toBe(1)
    expect(running('sleep 3053')).toBe(1)
    expect(running('sleep 3054')).toBe(1)
    expect(existsSync(done)).toBe(false)
  }, 30_000)
})
