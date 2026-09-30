/**
 * 命令沙箱 —— 管理器 + bgTaskService 端到端，真 Seatbelt（[darwin]）：RS-10（含 FU-7：智能体经宿主
 * 停掉自己那条受限的后台任务 —— 沙箱里的命令自己发不出跨实例的信号）；RS-11：工具卡上「实际执行的
 * 命令」那份记录贴进终端能复现同一条受限命令（同样的 TMPDIR、同样被拦下、同样能写工作区）。
 *
 * 与 seatbelt.darwin.test.ts 分开放，因为这里要换掉 `os` 与 `electron`：管理器从 `os.homedir()` /
 * `app.getPath('userData')` 现取宿主路径，而家目录必须是假的。fakeHome 建在 realpath(os.tmpdir())
 * 下（不在任何可写根里）；探测的工作区是 realpath(os.tmpdir())，家目录落在它里面探测会被拒，
 * 所以这张模块图里的 `os.tmpdir()` 也换成本文件独占的 /private/tmp/shuvix-sbxtest-* 目录。
 *
 * 管理器的临时目录父目录是真的 /private/tmp/shuvix-<uid>（取自 process.getuid()，无法改）：
 * 本文件只经产品（planFor / cleanupSession）建、删自己那个 <sha8(唯一会话 id)> 子目录，不动父目录。
 * 命令的 HOME 经 extraEnv 指向 fakeHome（buildSpawnEnv 会把测试进程的环境整份带进去）。
 *
 * 跳过条件：不是 macOS，或管理器的真探测不过（例如本套件跑在别的沙箱里）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'crypto'
import { spawnSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync
} from 'fs'
import { join } from 'path'

const state = vi.hoisted(() => ({ home: '', tmp: '', userData: '' }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const mocked = {
    ...actual,
    homedir: () => state.home || actual.homedir(),
    tmpdir: () => state.tmp || actual.tmpdir()
  }
  return { ...mocked, default: mocked }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData' || !state.userData) throw new Error(`unexpected app.getPath(${name})`)
      return state.userData
    },
    getAppPath: () => '',
    isPackaged: false
  }
}))

// electron-log 在 Electron 之外会往真家目录的 Logs 里写
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import {
  cleanupSession,
  pinSession,
  planFor,
  sandboxStatus,
  setSandboxSettingReader,
  type SandboxPlan
} from '../index'
import { sessionTmpName } from '../spec'
/* eslint-disable boundaries/dependencies -- 端到端用例有意把计划的产出方（本模块）与消费方（扁平的 bgTaskService）放进同一个进程；产品代码里是 bgTaskService 引用本模块，不是反过来 */
import {
  getBgTask,
  killAllBgTasks,
  readBgTaskLog,
  runCommand,
  setBgTaskNotifier,
  stopBgTask,
  stopBgTaskByAgent
} from '../../bgTaskService'
import { readInvocation } from '../../commandInvocation'
/* eslint-enable boundaries/dependencies */

const RAND = randomBytes(4).toString('hex')
const SID = `sbxtest-mgr-${RAND}`
const UID = process.getuid?.() ?? 0
const SESSION_TMP = `/private/tmp/shuvix-${UID}/${sessionTmpName(SID)}`

let fakeHome = ''
let ws = ''
let available = false
let plan: SandboxPlan | null = null
let callSeq = 0
const nextId = (): string => `sbxtest-call-${RAND}-${++callSeq}`

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

describe.skipIf(process.platform !== 'darwin')('sandbox manager + bgTaskService [darwin]', () => {
  beforeAll(async () => {
    const actualOs = await vi.importActual<typeof import('os')>('os')
    fakeHome = mkdtempSync(join(realpathSync(actualOs.tmpdir()), 'sbxm-'))
    state.home = fakeHome
    state.userData = join(fakeHome, 'Library', 'Application Support', 'ShuviX')
    state.tmp = mkdtempSync('/private/tmp/shuvix-sbxtest-')
    ws = join(fakeHome, 'proj')
    mkdirSync(ws, { recursive: true })
    mkdirSync(state.userData, { recursive: true })
    mkdirSync(join(fakeHome, '.shuvix'), { recursive: true })

    setSandboxSettingReader(() => undefined)
    available = sandboxStatus().available
  })

  afterAll(() => {
    killAllBgTasks()
    // 安全网：正常情况下最后一条用例已经清掉了；这里只动自己那个子目录
    cleanupSession(SID)
    for (const dir of [fakeHome, state.tmp]) if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('RS-10 pinSession → planFor gives a plan with the session TMPDIR', (ctx) => {
    if (!available) ctx.skip()
    expect(existsSync(SESSION_TMP)).toBe(false)
    expect(pinSession(SID)).toBe(true)
    plan = planFor({
      sessionId: SID,
      workingDirectory: ws,
      grantedWrite: [],
      grantedRead: [],
      offerEscalation: true
    })
    expect(plan).not.toBeNull()
    expect(plan!.env.TMPDIR).toBe(SESSION_TMP + '/')
    expect(plan!.spec.workingDirectory).toBe(ws)
    expect(existsSync(SESSION_TMP)).toBe(true)
  })

  it('RS-10 a refused write exits 1 and the log ends with a [sandbox] note', async (ctx) => {
    if (!available || !plan) ctx.skip()
    const outcome = await runCommand({
      sessionId: SID,
      toolCallId: nextId(),
      shell: 'bash',
      command: 'echo TMP=$TMPDIR; touch "$HOME/.shuvix/x"',
      description: 'sandbox denial',
      cwd: ws,
      extraEnv: { HOME: fakeHome, SHUVIX_SESSION_ID: SID },
      background: false,
      timeoutMs: 20_000,
      sandbox: plan!
    })
    expect(outcome.kind).toBe('settled')
    if (outcome.kind !== 'settled') return
    expect(outcome.info.exitCode, outcome.output).toBe(1)
    expect(outcome.output).toContain(`TMP=${plan!.env.TMPDIR}\n`)
    const blocked = join(fakeHome, '.shuvix', 'x')
    expect(outcome.output).toContain(`touch: ${blocked}: Operation not permitted`)
    // 说明是日志的最后一段，在命令自己的输出之后
    const at = outcome.output.lastIndexOf('\n[sandbox]')
    expect(at).toBeGreaterThan(outcome.output.indexOf('Operation not permitted'))
    const note = outcome.output.slice(at + 1)
    expect(note).toContain(`cannot write: ${blocked}`)
    expect(note).toContain('dangerouslyDisableSandbox')
    expect(existsSync(blocked)).toBe(false)
  })

  it('RS-10 an allowed write in the working directory exits 0 with no note', async (ctx) => {
    if (!available || !plan) ctx.skip()
    const outcome = await runCommand({
      sessionId: SID,
      toolCallId: nextId(),
      shell: 'bash',
      command: 'touch ok',
      description: 'sandbox allowed',
      cwd: ws,
      extraEnv: { HOME: fakeHome, SHUVIX_SESSION_ID: SID },
      background: false,
      timeoutMs: 20_000,
      sandbox: plan!
    })
    expect(outcome.kind).toBe('settled')
    if (outcome.kind !== 'settled') return
    expect(outcome.info.exitCode, outcome.output).toBe(0)
    expect(outcome.output).not.toContain('[sandbox]')
    expect(existsSync(join(ws, 'ok'))).toBe(true)
  })

  it('RS-10 a background confined task stopped through the task hub dies as a group', async (ctx) => {
    if (!available || !plan) ctx.skip()
    const toolCallId = nextId()
    // bash（spawn 拿到的 pid）再起一个子进程：sh 记下自己的 pid 后 exec 成 sleep
    const outcome = await runCommand({
      sessionId: SID,
      toolCallId,
      shell: 'bash',
      command: `sh -c 'echo $$ > "$TMPDIR/inner.pid"; exec sleep 30'; echo after`,
      description: 'sandbox background',
      cwd: ws,
      extraEnv: { HOME: fakeHome, SHUVIX_SESSION_ID: SID },
      background: true,
      sandbox: plan!
    })
    expect(outcome.kind).toBe('background')
    const pid = outcome.info.pid
    const pidFile = join(SESSION_TMP, 'inner.pid')
    expect(await until(() => existsSync(pidFile), 5000)).toBe(true)
    const inner = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      expect(isAlive(pid)).toBe(true)
      expect(isAlive(inner)).toBe(true)

      expect(stopBgTask(toolCallId)).toBe(true)
      expect(await until(() => getBgTask(toolCallId)?.status !== 'running', 10_000)).toBe(true)
      expect(getBgTask(toolCallId)?.status).toBe('killed')
      expect(await until(() => !isAlive(pid) && !isAlive(inner), 5000)).toBe(true)
      expect(readBgTaskLog({ toolCallId }).text).not.toContain('[sandbox]')
    } finally {
      for (const p of [pid, inner]) {
        try {
          process.kill(p, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      }
    }
  }, 30_000)

  it('RS-10 FU-7 the agent stops its own confined background task through the host (no notice back)', async (ctx) => {
    if (!available || !plan) ctx.skip()
    // 上一条用例是「用户停的」，会通知（250ms 合并窗口）—— 等它投递完再换上本用例的 spy
    await new Promise((r) => setTimeout(r, 500))
    const notify = vi.fn<(sessionId: string, text: string) => void>()
    setBgTaskNotifier(notify)

    const toolCallId = nextId()
    const outcome = await runCommand({
      sessionId: SID,
      toolCallId,
      shell: 'bash',
      command: `sh -c 'echo $$ > "$TMPDIR/inner-fu7.pid"; exec sleep 30'; echo after`,
      description: 'sandbox background stopped by the agent',
      cwd: ws,
      extraEnv: { HOME: fakeHome, SHUVIX_SESSION_ID: SID },
      background: true,
      sandbox: plan!
    })
    expect(outcome.kind).toBe('background')
    const pid = outcome.info.pid
    const pidFile = join(SESSION_TMP, 'inner-fu7.pid')
    expect(await until(() => existsSync(pidFile), 5000)).toBe(true)
    const inner = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      expect(isAlive(pid)).toBe(true)
      expect(isAlive(inner)).toBe(true)

      // 别的会话问同一个 pid：找不到，谁都不动
      expect(stopBgTaskByAgent(`other-${SID}`, pid)).toBe('not-found')
      expect(isAlive(pid)).toBe(true)
      expect(isAlive(inner)).toBe(true)

      expect(stopBgTaskByAgent(SID, pid)).toBe('stopped')
      expect(await until(() => getBgTask(toolCallId)?.status !== 'running', 10_000)).toBe(true)
      expect(getBgTask(toolCallId)?.status).toBe('killed')
      // 整个进程组都停了（sh exec 成的 sleep 也在组里）
      expect(await until(() => !isAlive(pid) && !isAlive(inner), 5000)).toBe(true)
      expect(readBgTaskLog({ toolCallId }).text).not.toContain('[sandbox]')

      // 智能体自己停的不回头通知它
      await new Promise((r) => setTimeout(r, 500))
      expect(notify).not.toHaveBeenCalled()
      expect(stopBgTaskByAgent(SID, pid)).toBe('not-running')
    } finally {
      setBgTaskNotifier(() => {})
      for (const p of [pid, inner]) {
        try {
          process.kill(p, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      }
    }
  }, 30_000)

  it('RS-11 the recorded invocation, pasted into bash, reruns the same confined command', async (ctx) => {
    if (!available || !plan) ctx.skip()
    const toolCallId = nextId()
    const outcome = await runCommand({
      sessionId: SID,
      toolCallId,
      shell: 'bash',
      command: 'echo "TMP=$TMPDIR"; touch pasted-ok; touch "$HOME/.shuvix/pasted"; echo rc=$?',
      description: 'sandbox invocation record',
      cwd: ws,
      extraEnv: { HOME: fakeHome, SHUVIX_SESSION_ID: SID },
      background: false,
      timeoutMs: 20_000,
      sandbox: plan!
    })
    expect(outcome.kind).toBe('settled')
    if (outcome.kind !== 'settled') return
    expect(outcome.output).toContain('rc=1')

    const text = readInvocation(SID, toolCallId)
    expect(text).not.toBeNull()
    expect(text).toContain('/usr/bin/sandbox-exec')
    // HOME 来自调用方的 extraEnv（项目变量那一类）：只列名字，不写成赋值
    expect(text!.split('\n')[0]).toBe(": 'Also set (values not shown): HOME'")
    expect(text).not.toMatch(/(^|\s)HOME=/m)
    expect(text).toContain(`TMPDIR=${plan!.env.TMPDIR} `)

    const okFile = join(ws, 'pasted-ok')
    const blocked = join(fakeHome, '.shuvix', 'pasted')
    expect(existsSync(okFile)).toBe(true)
    unlinkSync(okFile)

    // 用户贴进自己的终端：环境是他自己的（这里 HOME 换成假的家目录，其余照测试进程）
    const pasted = spawnSync('/bin/bash', ['--norc', '-c', text!], {
      env: { ...process.env, HOME: fakeHome },
      encoding: 'utf8',
      timeout: 20_000
    })
    expect(pasted.stdout).toContain(`TMP=${plan!.env.TMPDIR}\n`)
    expect(pasted.stdout).toContain('rc=1')
    expect(pasted.stderr).toContain(`touch: ${blocked}: Operation not permitted`)
    expect(existsSync(okFile)).toBe(true)
    expect(existsSync(blocked)).toBe(false)
  })

  it('RS-10 cleanupSession removes the session tmp dir', (ctx) => {
    if (!available || !plan) ctx.skip()
    expect(existsSync(SESSION_TMP)).toBe(true)
    cleanupSession(SID)
    expect(existsSync(SESSION_TMP)).toBe(false)
    expect(existsSync(`/private/tmp/shuvix-${UID}`)).toBe(true)
  })
})
