/**
 * bgTaskService 执行沙箱计划的那一半 —— 真 spawn、假计划（SandboxPlan 是纯接口，这里不碰
 * Seatbelt；真沙箱另有 darwin 专属用例）：
 *
 *  - BT-1 包装 + 环境：shell 调用交给 plan.wrap 包一层；plan.env 注入子进程并盖过 extraEnv 的同名项；
 *         没有计划时调用原样、环境原样；
 *  - BT-2 退出时的说明：explain 拿到日志尾部与退出码；有说明就追加在命令输出之后（前台结果里看得到），
 *         退出码不变；没说明日志一字不动；成功的命令也照样问一句（由分类器决定说不说）；
 *  - BT-3 后台任务的退出通知读的是同一份日志尾部，所以也带着说明；
 *  - BT-4 被停掉的（超时 / 用户从面板停）不追究；explain 自己抛错时任务照常落定、日志不动、记一条警告；
 *  - BT-INV 「实际执行的命令」那份记录（commandInvocation.ts）：spawn 之前写好（命令自己就读得到）；
 *         有计划时记的是包装后的调用、计划的变量在前；项目变量只列名字、值不落盘；与计划同名的项目变量
 *         按实际生效的那份写一次、不再列为隐藏；没有 extraEnv 就既无会话 id 也无说明行；后台任务当场
 *         就有记录；日志被收走记录还在；spawn 失败也有记录；记录写不下去不挡命令。
 *
 * [posix]：假计划用 /usr/bin/env 包 bash，Windows 上整组跳过。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SandboxPlan } from '../sandbox'
import type { SandboxSpec } from '../sandbox/types'
import type { ShellInvocation } from '../../utils/toolUtils/shell'

const STAMP = Date.now()
const USER_DATA_DIR = join(tmpdir(), `shuvix-bgsandbox-userdata-${STAMP}`)

const logs = vi.hoisted(() => ({
  entries: [] as Array<{ tag: string; level: string; text: string }>
}))

// bgTaskService → utils/paths 需要 app.getPath（日志目录）与 app.isPackaged（CLI 路径）
vi.mock('electron', () => ({ app: { getPath: () => USER_DATA_DIR, isPackaged: false } }))
// 记下各模块的日志（BT-4 要看到 explain 抛错时的那条警告）
vi.mock('../../logger', () => {
  const make = (tag: string): Record<string, (...args: unknown[]) => void> => {
    const at =
      (level: string) =>
      (...args: unknown[]): void => {
        logs.entries.push({ tag, level, text: args.map(String).join(' ') })
      }
    return {
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      debug: at('debug'),
      verbose: at('verbose'),
      silly: at('silly'),
      log: at('log')
    }
  }
  return { createLogger: make, default: make('default') }
})

import {
  runCommand,
  getBgTask,
  killAllBgTasks,
  readBgTaskLog,
  setBgTaskNotifier,
  stopBgTask
} from '../bgTaskService'
import { shellInvocation } from '../../utils/toolUtils/shell'
import { formatInvocation, readInvocation } from '../commandInvocation'

const SESSION_ID = `bgsandbox-${STAMP}`
/** 假计划注入的 TMPDIR —— 只作为字符串回显，不需要真的存在 */
const PLAN_TMPDIR = '/private/tmp/shuvix-sbx-test/sess/'
const NOTE = '[sandbox] X'

let callSeq = 0
const nextId = (): string => `bgsandbox-${STAMP}-${++callSeq}`

type ExplainFn = (outputTail: string, exitCode: number | null) => string | null

/** 假计划：wrap 用 /usr/bin/env 在前面垫一个标记变量，explain 由用例决定 */
function fakePlan(explain: ExplainFn = () => null): {
  plan: SandboxPlan
  wrap: Mock<(base: ShellInvocation) => ShellInvocation>
  explain: Mock<ExplainFn>
} {
  const wrap = vi.fn<(base: ShellInvocation) => ShellInvocation>((base) => ({
    file: '/usr/bin/env',
    args: ['SBX_WRAPPED=1', base.file, ...base.args]
  }))
  const explainSpy = vi.fn<ExplainFn>(explain)
  const plan: SandboxPlan = {
    spec: {} as SandboxSpec,
    env: { TMPDIR: PLAN_TMPDIR },
    wrap,
    explain: explainSpy
  }
  return { plan, wrap, explain: explainSpy }
}

/** 轮询等任务落定（上限 15s） */
async function waitSettled(toolCallId: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (getBgTask(toolCallId)?.status !== 'running') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`任务 ${toolCallId} 15s 内未落定`)
}

/** 轮询等一个条件成立（上限 5s） */
async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`等不到：${what}`)
}

/** 前台跑一条命令，返回 settled 结局 */
async function runSync(
  command: string,
  opts: {
    plan?: SandboxPlan
    extraEnv?: Record<string, string>
    timeoutMs?: number
    toolCallId?: string
    cwd?: string
  } = {}
): Promise<Extract<Awaited<ReturnType<typeof runCommand>>, { kind: 'settled' }>> {
  const outcome = await runCommand({
    sessionId: SESSION_ID,
    toolCallId: opts.toolCallId ?? nextId(),
    shell: 'bash',
    command,
    description: 'sandbox wiring',
    cwd: opts.cwd ?? tmpdir(),
    extraEnv: opts.extraEnv,
    sandbox: opts.plan,
    background: false,
    timeoutMs: opts.timeoutMs
  })
  if (outcome.kind !== 'settled') throw new Error('前台命令不该转后台')
  return outcome
}

const bgWarnings = (): string[] =>
  logs.entries.filter((e) => e.tag === 'BgTask' && e.level === 'warn').map((e) => e.text)

const invocationWarnings = (): string[] =>
  logs.entries.filter((e) => e.tag === 'CommandInvocation' && e.level === 'warn').map((e) => e.text)

/** 本会话一次调用的记录文件 / 日志文件（toolCallId 由本文件造，只含安全字符） */
const recordPath = (toolCallId: string): string =>
  join(USER_DATA_DIR, 'tool_results', SESSION_ID, `${toolCallId}.invocation.txt`)
const logPathOf = (toolCallId: string): string =>
  join(USER_DATA_DIR, 'tool_results', SESSION_ID, `${toolCallId}.log`)

beforeEach(() => {
  logs.entries.length = 0
})

afterEach(() => {
  killAllBgTasks()
  setBgTaskNotifier(() => {})
})

afterAll(() => {
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('bgTaskService × 沙箱计划 [posix]', () => {
  describe('BT-1 包装 + 环境', () => {
    const COMMAND = 'echo "[$SBX_WRAPPED|$TMPDIR|$SHUVIX_SESSION_ID]"'
    const EXTRA_ENV = { TMPDIR: '/from/extra-env/', SHUVIX_SESSION_ID: SESSION_ID }

    it('BT-1 有计划：调用经 wrap 包一层；plan.env 的 TMPDIR 盖过 extraEnv，extraEnv 的其余项照旧', async () => {
      const { plan, wrap } = fakePlan()
      const outcome = await runSync(COMMAND, { plan, extraEnv: EXTRA_ENV })

      expect(wrap).toHaveBeenCalledTimes(1)
      expect(wrap.mock.calls[0][0]).toEqual(shellInvocation('bash', COMMAND))
      expect(outcome.info.exitCode).toBe(0)
      expect(outcome.output.trim()).toBe(`[1|${PLAN_TMPDIR}|${SESSION_ID}]`)
    })

    it('BT-1 没有计划：调用原样（没有标记变量），TMPDIR 就是 extraEnv 给的', async () => {
      const outcome = await runSync(COMMAND, { extraEnv: EXTRA_ENV })

      expect(outcome.info.exitCode).toBe(0)
      expect(outcome.output.trim()).toBe(`[|/from/extra-env/|${SESSION_ID}]`)
    })
  })

  describe('BT-2 退出时追加说明', () => {
    it('BT-2 失败 + 有说明：explain 拿到（含输出的尾部, 退出码）；说明追加在输出之后；退出码不变', async () => {
      const { plan, explain } = fakePlan(() => NOTE)
      const outcome = await runSync('echo boom; exit 3', { plan })

      expect(explain).toHaveBeenCalledTimes(1)
      expect(explain).toHaveBeenCalledWith(expect.stringContaining('boom'), 3)
      expect(outcome.output).toBe(`boom\n\n${NOTE}\n`)
      expect(outcome.output.endsWith(`\n${NOTE}\n`)).toBe(true)
      expect(outcome.reason).toBe('finished')
      expect(outcome.info.exitCode).toBe(3)
    })

    it('BT-2 失败 + explain 返回 null：日志一字不动', async () => {
      const { plan, explain } = fakePlan(() => null)
      const outcome = await runSync('echo boom; exit 3', { plan })

      expect(explain).toHaveBeenCalledTimes(1)
      expect(outcome.output).toBe('boom\n')
      expect(outcome.info.exitCode).toBe(3)
    })

    it('BT-2 成功的命令也问一句（退出码 0），分类器不说就什么都不加', async () => {
      const { plan, explain } = fakePlan(() => null)
      const outcome = await runSync('echo ok', { plan })

      expect(explain).toHaveBeenCalledTimes(1)
      expect(explain).toHaveBeenCalledWith(expect.stringContaining('ok'), 0)
      expect(outcome.output).toBe('ok\n')
      expect(outcome.info.exitCode).toBe(0)
    })
  })

  describe('BT-3 后台任务', () => {
    it('BT-3 过了预热窗口再 exit 1：落定后日志与退出通知里都有说明', async () => {
      const notices: Array<{ sessionId: string; text: string }> = []
      setBgTaskNotifier((sessionId, text) => notices.push({ sessionId, text }))

      const { plan, explain } = fakePlan(() => NOTE)
      const toolCallId = nextId()
      const started = await runCommand({
        sessionId: SESSION_ID,
        toolCallId,
        shell: 'bash',
        // sleep 3 秒保过 2s 预热窗口，强制走 background 形态
        command: 'echo started; sleep 3; echo failing; exit 1',
        description: 'sandboxed background task',
        cwd: tmpdir(),
        sandbox: plan,
        background: true
      })
      expect(started.kind).toBe('background')
      expect(explain).not.toHaveBeenCalled()

      await waitSettled(toolCallId)
      const info = getBgTask(toolCallId)
      expect(info?.status).toBe('exited')
      expect(info?.exitCode).toBe(1)

      expect(explain).toHaveBeenCalledTimes(1)
      expect(explain).toHaveBeenCalledWith(expect.stringContaining('failing'), 1)

      const text = readBgTaskLog({ toolCallId }).text
      expect(text).toContain('failing')
      expect(text.endsWith(`\n${NOTE}\n`)).toBe(true)
      expect(text.indexOf(NOTE)).toBeGreaterThan(text.indexOf('failing'))

      // 没人等的后台任务落定后发退出通知（枢纽按会话聚拢后投递）
      await until(() => notices.length > 0, '退出通知')
      expect(notices[0].sessionId).toBe(SESSION_ID)
      expect(notices[0].text).toContain('exited with code 1')
      expect(notices[0].text).toContain(NOTE)
    }, 20_000)
  })

  describe('BT-4 不追究 / 注释器自己出错', () => {
    it('BT-4 前台超时被杀：不问 explain，不加说明', async () => {
      const { plan, explain } = fakePlan(() => NOTE)
      const outcome = await runSync('echo waiting; sleep 5', { plan, timeoutMs: 200 })

      expect(outcome.reason).toBe('timeout')
      expect(explain).not.toHaveBeenCalled()
      expect(outcome.output).not.toContain(NOTE)
    }, 15_000)

    it('BT-4 后台任务被用户从面板停掉：不问 explain，日志里没有说明', async () => {
      const { plan, explain } = fakePlan(() => NOTE)
      const toolCallId = nextId()
      const started = await runCommand({
        sessionId: SESSION_ID,
        toolCallId,
        shell: 'bash',
        command: 'echo up; sleep 30',
        description: 'long sandboxed task',
        cwd: tmpdir(),
        sandbox: plan,
        background: true
      })
      expect(started.kind).toBe('background')

      expect(stopBgTask(toolCallId)).toBe(true)
      await waitSettled(toolCallId)

      expect(getBgTask(toolCallId)?.status).toBe('killed')
      expect(explain).not.toHaveBeenCalled()
      const text = readBgTaskLog({ toolCallId }).text
      expect(text).toContain('up')
      expect(text).not.toContain(NOTE)
    }, 20_000)

    it('BT-4 explain 抛错：任务照常落定（真实退出码），日志不动，记一条警告', async () => {
      const { plan, explain } = fakePlan(() => {
        throw new Error('classifier exploded')
      })
      const outcome = await runSync('echo boom; exit 3', { plan })

      expect(explain).toHaveBeenCalledTimes(1)
      expect(outcome.reason).toBe('finished')
      expect(outcome.info.status).toBe('exited')
      expect(outcome.info.exitCode).toBe(3)
      expect(outcome.output).toBe('boom\n')

      const warnings = bgWarnings()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('sandbox denial annotation failed')
      expect(warnings[0]).toContain('classifier exploded')
    })
  })

  describe('BT-INV 实际执行命令的记录', () => {
    it('BT-INV-1 spawn 之前就写好：命令自己 cat 得到它；读回的就是按原样调用格式化的文本', async () => {
      const toolCallId = nextId()
      const command = `cat '${recordPath(toolCallId)}'`
      const outcome = await runSync(command, {
        toolCallId,
        extraEnv: { SHUVIX_SESSION_ID: SESSION_ID }
      })

      expect(outcome.info.exitCode, outcome.output).toBe(0)
      expect(outcome.output).toContain('/bin/bash --norc -c')
      const expected = formatInvocation({
        shell: 'bash',
        invocation: shellInvocation('bash', command),
        cwd: tmpdir(),
        env: { SHUVIX_SESSION_ID: SESSION_ID },
        hiddenEnv: []
      })
      expect(readInvocation(SESSION_ID, toolCallId)).toBe(expected)
      // 命令读到的就是那一份
      expect(outcome.output).toBe(expected)
    })

    it('BT-INV-2 有计划：记的是 wrap 之后的调用；变量先计划的（TMPDIR）再会话 id', async () => {
      const { plan } = fakePlan()
      const toolCallId = nextId()
      const command = 'echo wrapped'
      const outcome = await runSync(command, {
        plan,
        toolCallId,
        extraEnv: { SHUVIX_SESSION_ID: SESSION_ID }
      })
      expect(outcome.info.exitCode).toBe(0)

      const base = shellInvocation('bash', command)
      const text = readInvocation(SESSION_ID, toolCallId)
      expect(text).toBe(
        formatInvocation({
          shell: 'bash',
          invocation: { file: '/usr/bin/env', args: ['SBX_WRAPPED=1', base.file, ...base.args] },
          cwd: tmpdir(),
          env: { TMPDIR: PLAN_TMPDIR, SHUVIX_SESSION_ID: SESSION_ID },
          hiddenEnv: []
        })
      )
      expect(text).toContain(`TMPDIR=${PLAN_TMPDIR} SHUVIX_SESSION_ID=${SESSION_ID} \\\n`)
      expect(text).toContain('/usr/bin/env SBX_WRAPPED=1 /bin/bash --norc -c')
    })

    it('BT-INV-3 项目变量只列名字：第一行是说明，值不落盘；会话 id 照样写成赋值', async () => {
      const toolCallId = nextId()
      const outcome = await runSync('echo "got=$API_TOKEN"', {
        toolCallId,
        extraEnv: { API_TOKEN: 'sekret-123', SHUVIX_SESSION_ID: SESSION_ID }
      })
      // 命令本身照样拿到了值
      expect(outcome.output.trim()).toBe('got=sekret-123')

      const text = readInvocation(SESSION_ID, toolCallId)!
      const lines = text.split('\n')
      expect(lines[0]).toBe(": 'Also set (values not shown): API_TOKEN'")
      expect(text).not.toContain('sekret-123')
      expect(text).not.toContain('API_TOKEN=')
      expect(lines[2]).toBe(`SHUVIX_SESSION_ID=${SESSION_ID} \\`)
    })

    it('BT-INV-3b 与计划同名的项目变量（TMPDIR）：按计划的值写一次赋值，不再列为隐藏', async () => {
      const { plan } = fakePlan()
      const toolCallId = nextId()
      const command = 'echo "tmp=$TMPDIR"'
      const outcome = await runSync(command, {
        plan,
        toolCallId,
        extraEnv: { TMPDIR: 'x', API_TOKEN: 'y', SHUVIX_SESSION_ID: SESSION_ID }
      })
      // 进程真正拿到的是计划的值 —— 记录写的也是它
      expect(outcome.output.trim()).toBe(`tmp=${PLAN_TMPDIR}`)

      const text = readInvocation(SESSION_ID, toolCallId)!
      expect(text).toBe(
        formatInvocation({
          shell: 'bash',
          invocation: plan.wrap(shellInvocation('bash', command)),
          cwd: tmpdir(),
          env: { TMPDIR: PLAN_TMPDIR, SHUVIX_SESSION_ID: SESSION_ID },
          hiddenEnv: ['API_TOKEN']
        })
      )
      expect(text.split('\n')[0]).toBe(": 'Also set (values not shown): API_TOKEN'")
      expect(text).not.toContain('TMPDIR=x')
      expect(text.match(/TMPDIR=/g)).toHaveLength(1)
    })

    it('BT-INV-4 没有 extraEnv：没有会话 id 赋值，也没有说明行', async () => {
      const toolCallId = nextId()
      await runSync('echo bare', { toolCallId })

      const text = readInvocation(SESSION_ID, toolCallId)!
      expect(text).toBe(
        formatInvocation({
          shell: 'bash',
          invocation: shellInvocation('bash', 'echo bare'),
          cwd: tmpdir(),
          env: {},
          hiddenEnv: []
        })
      )
      expect(text).not.toContain('SHUVIX_SESSION_ID=')
      expect(text).not.toContain('Also set')
    })

    it('BT-INV-5 后台任务当场就有记录（runCommand 还没返回）', async () => {
      const toolCallId = nextId()
      const pending = runCommand({
        sessionId: SESSION_ID,
        toolCallId,
        shell: 'bash',
        command: 'echo up; sleep 30',
        description: 'background with a record',
        cwd: tmpdir(),
        extraEnv: { SHUVIX_SESSION_ID: SESSION_ID },
        background: true
      })
      // 同步写在 spawn 之前 —— 不必等预热窗口
      expect(readInvocation(SESSION_ID, toolCallId)).toBe(
        formatInvocation({
          shell: 'bash',
          invocation: shellInvocation('bash', 'echo up; sleep 30'),
          cwd: tmpdir(),
          env: { SHUVIX_SESSION_ID: SESSION_ID },
          hiddenEnv: []
        })
      )
      const started = await pending
      expect(started.kind).toBe('background')
      expect(stopBgTask(toolCallId)).toBe(true)
      await waitSettled(toolCallId)
      expect(readInvocation(SESSION_ID, toolCallId)).not.toBeNull()
    }, 20_000)

    it('BT-INV-5 很快结束的前台命令：日志随之收走，记录留着（工具卡还在）', async () => {
      const toolCallId = nextId()
      const outcome = await runSync('echo quick', { toolCallId })
      expect(outcome.output).toBe('quick\n')

      expect(existsSync(logPathOf(toolCallId))).toBe(false)
      expect(readInvocation(SESSION_ID, toolCallId)).toContain("/bin/bash --norc -c 'echo quick'")
    })

    it('BT-INV-6 spawn 失败（cwd 不存在）：落定为 -1 + [spawn failed]；记录照样在，cd 那行点名这个 cwd', async () => {
      const toolCallId = nextId()
      const missing = join(USER_DATA_DIR, 'no such dir', 'nested')
      const outcome = await runSync('echo never', { toolCallId, cwd: missing })

      expect(outcome.info.exitCode).toBe(-1)
      expect(outcome.output).toContain('[spawn failed]')
      const text = readInvocation(SESSION_ID, toolCallId)!
      expect(text.split('\n')[0]).toBe(`cd '${missing}' && \\`)
    })

    it('BT-INV-7 记录写不下去（那个位置被目录占着）：命令照跑、输出与退出码不受影响，只记一条警告', async () => {
      const toolCallId = nextId()
      mkdirSync(recordPath(toolCallId), { recursive: true })
      const outcome = await runSync('echo still-runs', { toolCallId })

      expect(outcome.info.exitCode).toBe(0)
      expect(outcome.output).toBe('still-runs\n')
      const warnings = invocationWarnings()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(toolCallId)
    })
  })
})
