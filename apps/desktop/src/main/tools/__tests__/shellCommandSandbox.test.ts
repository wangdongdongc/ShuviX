/**
 * bash 工具与命令沙箱的接线 —— 沙箱本身（规格、profile、探测、拒绝说明）另有单测，这里只钉
 * 「工具怎么用它」：
 *
 *  - SC-1 schema 与描述跟着**构造时**的 pin 走：pin 为真 → 多一个可选的 `dangerouslyDisableSandbox`、
 *         描述 = 基础描述 + 受限范围一段；为假 → 两样都没有。构造之后全局开关再变，已造好的实例
 *         不变（照旧要计划）。PowerShell 工具永远没有这个参数；
 *  - SC-2 圈住执行：planFor 的入参（工作区 + 会话授权 + offerEscalation），命令客体带 `sandboxed`、
 *         询问选项不带 `unsandboxed`，计划前台 / 后台都交给 runCommand；计划为 null → 如实上报
 *         「未圈住」（照常询问，卡片不标完全访问），runCommand 不带沙箱；
 *  - SC-3 申请越界（`dangerouslyDisableSandbox: true`）：不要计划、客体不带 `sandboxed`、询问选项标
 *         `unsandboxed`（后台时与 `background` 并存）；用户选「其它」则不执行；
 *  - SC-4 本实例没套沙箱（pin 为假 / PowerShell）时，参数里就算带了 `dangerouslyDisableSandbox` 也
 *         无视：不要计划、不标任何沙箱字段，命令照旧执行；
 *  - SC-5 设置页的 describe() 读全局开关（sandboxGloballyActive），从不 pin 会话。
 *
 * 命令客体恒带 `unconfinedReason`（没进沙箱的原因，圈住了为 ''）：圈住 ''、计划为 null 'unavailable'、
 * 申请越界 'escalated'、pin 为假的 bash 按此刻的沙箱状态（替身里设置关着 → 'disabled'）、
 * PowerShell 'unsupported'。SC-UR 专门钉这一格的来源：
 *  - SC-UR1 pin 为假的 bash 原样上报 whyUnconfined 的答案（三种都试），而且问的是**本会话自己的 id**；
 *           PowerShell 恒 'unsupported'，根本不问 whyUnconfined；
 *  - SC-UR2 pin 为真的实例（计划为 null → 'unavailable'，申请越界 → 'escalated'）不问 whyUnconfined ——
 *           它答的是「这条会话为什么没固定成套」，而这条会话固定成了套。
 *
 * 替身：sandbox 管理器（pinSession / planFor / sandboxGloballyActive 都是 spy）、toolContext
 * （安全门是 spy，含 getSessionPathGrants）、bgTaskService 的三个执行入口、i18n。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../services/toolContext'
import type { SandboxPlan } from '../../services/sandbox'

const mocks = vi.hoisted(() => ({
  enforceCommand: vi.fn(),
  runCommand: vi.fn(),
  runningCount: vi.fn(),
  listBgTasks: vi.fn(),
  getSessionPathGrants: vi.fn(),
  pinSession: vi.fn(),
  planFor: vi.fn(),
  sandboxGloballyActive: vi.fn(),
  whyUnconfined: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-shellcmd-sandbox-test', isPackaged: false }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: () => ({ enforceCommand: mocks.enforceCommand }),
  getSessionPathGrants: mocks.getSessionPathGrants,
  resolveProjectConfig: () => ({ workingDirectory: '/w', envVars: {} }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/sandbox', () => ({
  pinSession: mocks.pinSession,
  planFor: mocks.planFor,
  sandboxGloballyActive: mocks.sandboxGloballyActive,
  whyUnconfined: mocks.whyUnconfined
}))
vi.mock('../../services/bgTaskService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/bgTaskService')>()
  return {
    ...actual,
    runCommand: mocks.runCommand,
    runningCount: mocks.runningCount,
    listBgTasks: mocks.listBgTasks
  }
})
vi.mock('../../i18n', () => ({ t: (key: string) => key }))

import { BashTool } from '../bash'
import { PowerShellTool } from '../powershell'
import { getBuiltinToolEntries, type BuiltinToolMeta } from '../../services/toolRegistry'
import type { BgTaskInfo } from '../../services/bgTaskService'

const SID = 'sess-shell-sandbox'
const CTX = { sessionId: SID } as ToolContext

const GRANTS = { grantedWrite: ['/granted/write'], grantedRead: ['/granted/read'] }

/** 一份假计划：工具层只负责把它原样交给 runCommand，不调用它的任何方法 */
const PLAN = {
  spec: {},
  env: { TMPDIR: '/private/tmp/shuvix-501/sbx/' },
  wrap: vi.fn(),
  explain: vi.fn()
} as unknown as SandboxPlan

/** 一份 BgTaskInfo（只填回执会读到的字段有意义） */
function taskInfo(over: Partial<BgTaskInfo> = {}): BgTaskInfo {
  return {
    toolCallId: 'tc',
    sessionId: SID,
    command: 'cmd',
    description: 'desc',
    cwd: '/w',
    pid: 4242,
    logPath: '/tool-results/tc.log',
    status: 'exited',
    exitCode: 0,
    signal: null,
    startedAt: 0,
    endedAt: 1,
    logCapped: false,
    ...over
  }
}

const settled = (exitCode: number | null, output: string): unknown => ({
  kind: 'settled',
  info: taskInfo({ exitCode }),
  output,
  reason: 'finished'
})

const detached = (): unknown => ({
  kind: 'background',
  info: taskInfo({ pid: 777, status: 'running', exitCode: null }),
  logBytes: 0
})

const params = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  command: 'make build',
  description: 'Build',
  ...over
})

async function run(
  tool: BashTool | PowerShellTool,
  p: Record<string, unknown>,
  toolCallId = 'tc-1'
): Promise<string> {
  const result = await tool.execute(toolCallId, p as never)
  return (result.content[0] as { text: string }).text
}

/** 按 pin 的答案造一个 bash 工具 */
function bashWithPin(pinned: boolean): BashTool {
  mocks.pinSession.mockReturnValueOnce(pinned)
  return new BashTool(CTX)
}

/** enforceCommand 第一次调用的 [命令客体, 询问选项] */
function enforceArgs(): [Record<string, unknown>, Record<string, unknown>] {
  expect(mocks.enforceCommand).toHaveBeenCalledTimes(1)
  const [object, opts] = mocks.enforceCommand.mock.calls[0]
  return [object, opts]
}

/** runCommand 第一次调用的参数 */
function runArgs(): Record<string, unknown> {
  expect(mocks.runCommand).toHaveBeenCalledTimes(1)
  return mocks.runCommand.mock.calls[0][0]
}

type Schema = { properties: Record<string, { type?: string; description?: string }> } & {
  required?: string[]
}
const schemaOf = (tool: { parameters: unknown }): Schema => tool.parameters as Schema

/** 沙箱那段说明里一定有的两样：说它受限，说出越界参数的名字 */
function expectConfinementParagraph(text: string): void {
  expect(text).toContain('confined in a sandbox')
  expect(text).toContain('dangerouslyDisableSandbox')
}

function bashEntry(): BuiltinToolMeta {
  const entry = getBuiltinToolEntries().find((e) => e.name === 'bash')
  expect(entry?.describe).toBeTypeOf('function')
  return entry!
}

beforeEach(() => {
  // 此刻的沙箱状态：有后端、设置关着 —— pin 为假的 bash 据此报 'disabled'
  mocks.whyUnconfined.mockReset()
  mocks.whyUnconfined.mockReturnValue('disabled')
  mocks.enforceCommand.mockReset()
  mocks.enforceCommand.mockResolvedValue({ status: 'allowed' })
  mocks.runCommand.mockReset()
  mocks.runCommand.mockResolvedValue(settled(0, 'out'))
  mocks.runningCount.mockReset()
  mocks.runningCount.mockReturnValue(0)
  mocks.listBgTasks.mockReset()
  mocks.listBgTasks.mockReturnValue([])
  mocks.getSessionPathGrants.mockReset()
  mocks.getSessionPathGrants.mockReturnValue(GRANTS)
  mocks.pinSession.mockReset()
  mocks.pinSession.mockReturnValue(false)
  mocks.planFor.mockReset()
  mocks.planFor.mockReturnValue(PLAN)
  mocks.sandboxGloballyActive.mockReset()
  mocks.sandboxGloballyActive.mockReturnValue(false)
})

describe('SC-1 schema 与描述跟着构造时的 pin 走', () => {
  it('SC-1 pin 为真：多一个可选布尔参数 dangerouslyDisableSandbox（说明提到完全权限），描述 = 基础描述 + 受限一段', () => {
    const plain = bashWithPin(false)
    const confined = bashWithPin(true)

    const prop = schemaOf(confined).properties.dangerouslyDisableSandbox
    expect(prop).toBeDefined()
    expect(prop.type).toBe('boolean')
    expect(prop.description).toMatch(/full privileges/)
    // 可选：模型不写它就是「照常圈住」
    expect(schemaOf(confined).required ?? []).not.toContain('dangerouslyDisableSandbox')

    // 基础描述原样在前，后面只多一段受限范围说明
    expect(confined.description.startsWith(plain.description)).toBe(true)
    const extra = confined.description.slice(plain.description.length)
    expect(extra.length).toBeGreaterThan(0)
    expectConfinementParagraph(extra)

    // FU-6：受限实例停后台任务也走宿主（沙箱里的命令发不出跨实例的信号），不教 kill 进程组
    const background = schemaOf(confined).properties.run_in_background.description ?? ''
    expect(background).toContain('shuvix task stop <pid>')
    expect(background).not.toContain('kill -- -')
  })

  it('SC-1 pin 为假：没有这个参数，描述就是基础描述（不提沙箱）', () => {
    const tool = bashWithPin(false)
    const schema = schemaOf(tool)

    expect(Object.keys(schema.properties).sort()).toEqual(
      ['command', 'description', 'run_in_background', 'timeout'].sort()
    )
    expect('dangerouslyDisableSandbox' in schema.properties).toBe(false)
    expect(tool.description.startsWith('Execute a bash command')).toBe(true)
    expect(tool.description).not.toMatch(/sandbox/i)
  })

  it('SC-1 每次构造恰好 pin 一次，按 ctx.sessionId；执行时不再 pin', async () => {
    const tool = new BashTool(CTX)
    new BashTool({ sessionId: 'sess-other' } as ToolContext)
    expect(mocks.pinSession.mock.calls).toEqual([[SID], ['sess-other']])

    mocks.pinSession.mockClear()
    await run(tool, params())
    expect(mocks.pinSession).not.toHaveBeenCalled()
  })

  it('SC-1 以 pin=真 造好的实例：之后 pin / 全局开关都翻成假，schema、描述照旧，执行照旧要计划', async () => {
    const tool = bashWithPin(true)
    const before = { description: tool.description, parameters: tool.parameters }

    mocks.pinSession.mockReturnValue(false)
    mocks.sandboxGloballyActive.mockReturnValue(false)

    expect(tool.description).toBe(before.description)
    expect(tool.parameters).toBe(before.parameters)
    expect(schemaOf(tool).properties.dangerouslyDisableSandbox).toBeDefined()
    expectConfinementParagraph(tool.description)

    await run(tool, params())
    expect(mocks.planFor).toHaveBeenCalledTimes(1)
    expect(enforceArgs()[0]).toMatchObject({ sandboxed: true })
    expect(runArgs().sandbox).toBe(PLAN)
  })

  it('SC-1 PowerShell 工具永远没有这个参数（全局开关、pin 都为真也一样）', () => {
    mocks.pinSession.mockReturnValue(true)
    mocks.sandboxGloballyActive.mockReturnValue(true)
    const tool = new PowerShellTool(CTX)

    expect('dangerouslyDisableSandbox' in schemaOf(tool).properties).toBe(false)
    expect(tool.description).not.toContain('dangerouslyDisableSandbox')
  })
})

describe('SC-2 圈住执行', () => {
  it('SC-2 前台：planFor 拿到工作区 + 会话授权 + offerEscalation；客体带 sandboxed，不标 unsandboxed；计划交给 runCommand', async () => {
    const tool = bashWithPin(true)
    await run(tool, params())

    expect(mocks.getSessionPathGrants).toHaveBeenCalledWith(SID)
    expect(mocks.planFor).toHaveBeenCalledTimes(1)
    expect(mocks.planFor.mock.calls[0][0]).toEqual({
      sessionId: SID,
      workingDirectory: '/w',
      grantedWrite: ['/granted/write'],
      grantedRead: ['/granted/read'],
      offerEscalation: true
    })

    const [object, opts] = enforceArgs()
    expect(object).toEqual({
      channel: 'bash',
      command: 'make build',
      cwd: '/w',
      sandboxed: true,
      unconfinedReason: ''
    })
    expect(opts).not.toHaveProperty('unsandboxed')
    expect(opts).toMatchObject({ toolName: 'bash', background: false })

    expect(runArgs()).toMatchObject({ background: false, cwd: '/w', command: 'make build' })
    expect(runArgs().sandbox).toBe(PLAN)
  })

  it('SC-2 后台（run_in_background）：同一份计划交给后台形态的 runCommand', async () => {
    mocks.runCommand.mockResolvedValueOnce(detached())
    const tool = bashWithPin(true)
    await run(tool, params({ run_in_background: true }))

    expect(mocks.planFor).toHaveBeenCalledTimes(1)
    const [object, opts] = enforceArgs()
    expect(object).toMatchObject({ sandboxed: true })
    expect(opts).toMatchObject({ background: true })
    expect(opts).not.toHaveProperty('unsandboxed')

    expect(runArgs()).toMatchObject({ background: true })
    expect(runArgs().sandbox).toBe(PLAN)
  })

  it('SC-2 dangerouslyDisableSandbox: false 等于没写：照常要计划、照常圈住', async () => {
    const tool = bashWithPin(true)
    await run(tool, params({ dangerouslyDisableSandbox: false }))

    expect(mocks.planFor).toHaveBeenCalledTimes(1)
    const [object, opts] = enforceArgs()
    expect(object).toMatchObject({ sandboxed: true })
    expect(opts).not.toHaveProperty('unsandboxed')
    expect(runArgs().sandbox).toBe(PLAN)
  })

  it.each([false, true])(
    'SC-2 计划为 null（run_in_background=%s）：客体不带 sandboxed（照常询问）、选项不带 unsandboxed（卡片不标完全访问）、runCommand 不带沙箱',
    async (background) => {
      mocks.planFor.mockReturnValue(null)
      if (background) mocks.runCommand.mockResolvedValueOnce(detached())
      const tool = bashWithPin(true)
      await run(tool, params({ run_in_background: background }))

      expect(mocks.planFor).toHaveBeenCalledTimes(1)
      const [object, opts] = enforceArgs()
      // 按会话固定成沙箱模式、这一次却做不出计划：原因是 unavailable
      expect(object).toEqual({
        channel: 'bash',
        command: 'make build',
        cwd: '/w',
        unconfinedReason: 'unavailable'
      })
      expect(opts).not.toHaveProperty('unsandboxed')
      expect(opts).toMatchObject({ background })

      expect(runArgs()).toMatchObject({ background })
      expect(runArgs().sandbox).toBeUndefined()
    }
  )
})

describe('SC-3 申请越界', () => {
  it('SC-3 前台：不要计划；客体不带 sandboxed；选项标 unsandboxed；runCommand 不带沙箱', async () => {
    const tool = bashWithPin(true)
    await run(tool, params({ dangerouslyDisableSandbox: true }))

    expect(mocks.planFor).not.toHaveBeenCalled()
    const [object, opts] = enforceArgs()
    expect(object).toEqual({
      channel: 'bash',
      command: 'make build',
      cwd: '/w',
      unconfinedReason: 'escalated'
    })
    expect(opts).toMatchObject({ unsandboxed: true, background: false })

    expect(runArgs().sandbox).toBeUndefined()
  })

  it('SC-3 后台：unsandboxed 与 background 同时标在询问卡片上', async () => {
    mocks.runCommand.mockResolvedValueOnce(detached())
    const tool = bashWithPin(true)
    await run(tool, params({ dangerouslyDisableSandbox: true, run_in_background: true }))

    expect(mocks.planFor).not.toHaveBeenCalled()
    const [object, opts] = enforceArgs()
    expect(object).not.toHaveProperty('sandboxed')
    expect(opts).toMatchObject({ unsandboxed: true, background: true })

    expect(runArgs()).toMatchObject({ background: true })
    expect(runArgs().sandbox).toBeUndefined()
  })

  it('SC-3 用户选「其它」：命令不执行，反馈回给模型', async () => {
    mocks.enforceCommand.mockResolvedValueOnce({ status: 'feedback', text: 'do not escalate' })
    const tool = bashWithPin(true)
    const text = await run(tool, params({ dangerouslyDisableSandbox: true }))

    expect(enforceArgs()[1]).toMatchObject({ unsandboxed: true })
    expect(mocks.runCommand).not.toHaveBeenCalled()
    expect(text).toBe(
      'Command was not executed. User responded with feedback instead:\ndo not escalate'
    )
  })
})

describe('SC-4 没套沙箱的实例无视越界参数', () => {
  it.each([
    ['bash（pin 为假）', (): BashTool | PowerShellTool => bashWithPin(false)],
    [
      'powershell（pin 为真也一样）',
      (): BashTool | PowerShellTool => {
        mocks.pinSession.mockReturnValue(true)
        return new PowerShellTool(CTX)
      }
    ]
  ])('SC-4 %s：不要计划，不标 sandboxed / unsandboxed，命令照常执行', async (_name, make) => {
    const tool = make()
    const text = await run(tool, params({ dangerouslyDisableSandbox: true }))

    expect(mocks.planFor).not.toHaveBeenCalled()
    const [object, opts] = enforceArgs()
    // 越界参数被无视，原因如实报这个实例为什么没套：bash 是设置关着，PowerShell 没有后端
    expect(object).toEqual({
      channel: tool.name,
      command: 'make build',
      cwd: '/w',
      unconfinedReason: tool.name === 'bash' ? 'disabled' : 'unsupported'
    })
    expect(opts).not.toHaveProperty('unsandboxed')

    expect(runArgs()).toMatchObject({ shell: tool.name, command: 'make build' })
    expect(runArgs().sandbox).toBeUndefined()
    expect(text).toBe('out')
  })
})

describe('SC-UR 没进沙箱的原因（命令客体的 unconfinedReason）', () => {
  it.each(['unsupported', 'disabled', 'unavailable'] as const)(
    'SC-UR1 pin 为假的 bash：whyUnconfined 答 %s 就原样上报；问的是本会话自己的 id，不要计划',
    async (reason) => {
      mocks.whyUnconfined.mockReturnValue(reason)
      mocks.pinSession.mockReturnValueOnce(false)
      // 与文件其余用例不同的会话 id：「按本会话问」要能和「按某个固定 id 问」区分开
      const tool = new BashTool({ sessionId: 'sess-ur-own' } as ToolContext)
      await run(tool, params())

      expect(mocks.whyUnconfined.mock.calls).toEqual([['sess-ur-own']])
      expect(mocks.planFor).not.toHaveBeenCalled()
      const [object, opts] = enforceArgs()
      expect(object).toEqual({
        channel: 'bash',
        command: 'make build',
        cwd: '/w',
        unconfinedReason: reason
      })
      expect(opts).not.toHaveProperty('unsandboxed')
    }
  )

  it('SC-UR1 PowerShell：恒 unsupported，不问 whyUnconfined（哪怕它此刻会答 disabled）', async () => {
    mocks.whyUnconfined.mockReturnValue('disabled')
    const tool = new PowerShellTool(CTX)
    await run(tool, params())

    expect(mocks.whyUnconfined).not.toHaveBeenCalled()
    expect(mocks.planFor).not.toHaveBeenCalled()
    expect(enforceArgs()[0]).toEqual({
      channel: 'powershell',
      command: 'make build',
      cwd: '/w',
      unconfinedReason: 'unsupported'
    })
  })

  it.each([
    ['计划为 null', {}, 'unavailable', 1],
    ['申请越界', { dangerouslyDisableSandbox: true }, 'escalated', 0]
  ] as const)(
    'SC-UR2 pin 为真、%s：报 %s，不问 whyUnconfined（它此刻答 disabled 也不采信）',
    async (_label, extra, reason, planCalls) => {
      mocks.planFor.mockReturnValue(null)
      mocks.whyUnconfined.mockReturnValue('disabled')
      const tool = bashWithPin(true)
      await run(tool, params(extra))

      expect(mocks.planFor).toHaveBeenCalledTimes(planCalls)
      expect(mocks.whyUnconfined).not.toHaveBeenCalled()
      const [object] = enforceArgs()
      expect(object).not.toHaveProperty('sandboxed')
      expect(object).toMatchObject({ unconfinedReason: reason })
    }
  )
})

describe('SC-5 设置页的 describe() 读全局开关', () => {
  it('SC-5 全局启用：参数与受限一段都在，且与 pin=真 的实例一字不差；不 pin 会话', () => {
    const entry = bashEntry()
    mocks.sandboxGloballyActive.mockReturnValue(true)
    mocks.pinSession.mockClear()

    const described = entry.describe!()
    expect(mocks.sandboxGloballyActive).toHaveBeenCalled()
    expect(mocks.pinSession).not.toHaveBeenCalled()

    expect(schemaOf(described).properties.dangerouslyDisableSandbox).toBeDefined()
    expectConfinementParagraph(described.description)
    expect(described.description).toBe(bashWithPin(true).description)
  })

  it('SC-5 全局关闭：两样都没有，与 pin=假 的实例一字不差；不 pin 会话', () => {
    const entry = bashEntry()
    mocks.sandboxGloballyActive.mockReturnValue(false)
    // 即便 pin 会答「真」，describe 也不该去问它
    mocks.pinSession.mockReset()
    mocks.pinSession.mockReturnValue(true)

    const described = entry.describe!()
    expect(mocks.pinSession).not.toHaveBeenCalled()

    expect('dangerouslyDisableSandbox' in schemaOf(described).properties).toBe(false)
    expect(described.description).not.toMatch(/sandbox/i)
    expect(described.description).toBe(bashWithPin(false).description)
  })
})
