/**
 * 两个命令工具（`bash` / `powershell`）是同一条执行路径（shellCommand.ts）—— 这里钉「同一条」：
 * 同样的询问入参、同样的 spawn 入参、同样的结果与 details 形状，只差 shell 名；以及 PowerShell
 * 独有的两处：命令行长度上限（在询问**之前**回话）与按版本变的描述。
 *
 *  - D1 前台：enforceCommand / runCommand 的入参，四种结局（成功 / 非零 / 超时 / 中止）的文本与 details；
 *  - D2 后台：background 两头都带到；转后台 = 后台形态 details；预热内退出 = 前台形态；并发上限；
 *  - D3 用户选「其它」：不执行，反馈原样回给模型；
 *  - D4 PowerShell 长度上限：按转义后的长度判、在询问之前拒；bash 没有这道；
 *  - D5 PowerShell 描述按版本说语法差异（pwsh 7 / 5.1 / 不在 Windows 上时两种都说）；
 *  - D6 停止命令的提示按 shell 给，不按当前平台 —— 设置页在任何平台上展示两个工具各自真实的描述。
 *
 * 替身：toolContext（安全门是 spy、项目配置固定）、bgTaskService 的三个执行入口（回执与停止命令
 * 的文案用真的）、i18n。getPowerShellConfig 可按用例换成固定版本（D5）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../services/toolContext'
import type { BashToolDetails } from '@shuvix/chat-protocol/types/chatMessage'

const mocks = vi.hoisted(() => ({
  enforceCommand: vi.fn(),
  runCommand: vi.fn(),
  runningCount: vi.fn(),
  listBgTasks: vi.fn(),
  /** 非 null 时顶替 getPowerShellConfig（D5）；null = 用真的 */
  psConfig: null as null | { exe: string; edition: 'pwsh' | 'windows-powershell' }
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-shellcmd-test', isPackaged: false }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: () => ({ enforceCommand: mocks.enforceCommand }),
  resolveProjectConfig: () => ({ workingDirectory: '/w', envVars: {} }),
  TOOL_ABORTED: 'Aborted'
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
vi.mock('../../utils/toolUtils/shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/toolUtils/shell')>()
  return {
    ...actual,
    getPowerShellConfig: () => mocks.psConfig ?? actual.getPowerShellConfig()
  }
})
vi.mock('../../i18n', () => ({ t: (key: string) => key }))

import { BashTool } from '../bash'
import { PowerShellTool } from '../powershell'
import {
  MAX_RUNNING_PER_SESSION,
  stopCommandHint,
  type BgTaskInfo
} from '../../services/bgTaskService'
import {
  MAX_POWERSHELL_COMMAND_CHARS,
  powerShellCommandLineLength
} from '../../utils/toolUtils/shell'
import { getBuiltinToolEntries } from '../../services/toolRegistry'
import { isBackgroundCall } from '@shuvix/chat-protocol/types/chatMessage'

type ShellName = 'bash' | 'powershell'

const SID = 'sess-shell-tool'
const CTX = { sessionId: SID } as ToolContext

const REAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM_DESC, value: platform })
}

function makeTool(shell: ShellName): BashTool | PowerShellTool {
  return shell === 'bash' ? new BashTool(CTX) : new PowerShellTool(CTX)
}

/** 一份 BgTaskInfo（只填回执 / 停止命令会读到的字段有意义） */
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

const settled = (
  exitCode: number | null,
  output: string,
  reason: 'finished' | 'timeout' | 'abort' = 'finished'
): unknown => ({ kind: 'settled', info: taskInfo({ exitCode }), output, reason })

interface Run {
  text: string
  details: BashToolDetails
}

async function run(
  tool: BashTool | PowerShellTool,
  params: Record<string, unknown>,
  toolCallId = 'tc-1'
): Promise<Run> {
  const result = await tool.execute(toolCallId, params as never)
  const first = result.content[0] as { type: string; text: string }
  return { text: first.text, details: result.details as BashToolDetails }
}

const params = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  command: 'list-things',
  description: 'List things',
  ...over
})

beforeEach(() => {
  mocks.enforceCommand.mockReset()
  mocks.enforceCommand.mockResolvedValue({ status: 'allowed' })
  mocks.runCommand.mockReset()
  mocks.runCommand.mockResolvedValue(settled(0, 'out'))
  mocks.runningCount.mockReset()
  mocks.runningCount.mockReturnValue(0)
  mocks.listBgTasks.mockReset()
  mocks.listBgTasks.mockReturnValue([])
  mocks.psConfig = null
})

afterEach(() => {
  Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC)
})

describe.each(['bash', 'powershell'] as const)('%s —— 与另一个命令工具同一条路径', (shell) => {
  it(`D1 — ${shell} 前台：询问入参（channel / toolName 就是工具名）与 spawn 入参（shell 同名、timeout 换成毫秒）`, async () => {
    const tool = makeTool(shell)
    expect(tool.name).toBe(shell)
    await run(tool, params({ timeout: 5 }))

    expect(mocks.enforceCommand).toHaveBeenCalledTimes(1)
    const [object, opts] = mocks.enforceCommand.mock.calls[0]
    expect(object).toEqual({ channel: shell, command: 'list-things', cwd: '/w' })
    expect(opts).toMatchObject({
      toolCallId: 'tc-1',
      toolName: shell,
      description: 'List things',
      background: false,
      abortError: 'Aborted',
      onOther: 'return',
      missingChannel: 'deny'
    })

    expect(mocks.runCommand).toHaveBeenCalledTimes(1)
    expect(mocks.runCommand.mock.calls[0][0]).toMatchObject({
      sessionId: SID,
      toolCallId: 'tc-1',
      shell,
      command: 'list-things',
      description: 'List things',
      cwd: '/w',
      background: false,
      timeoutMs: 5000,
      extraEnv: { SHUVIX_SESSION_ID: SID }
    })
  })

  it(`D1 — ${shell} 前台：timeout 0 = 不限时（timeoutMs 0）`, async () => {
    await run(makeTool(shell), params({ timeout: 0 }))
    expect(mocks.runCommand.mock.calls[0][0].timeoutMs).toBe(0)
  })

  it(`D1 — ${shell} 前台的四种结局：成功只回输出；非零标退出码；超时标 124；中止抛 Aborted`, async () => {
    const tool = makeTool(shell)

    const ok = await run(tool, params())
    expect(ok.text).toBe('out')
    expect(ok.details).toEqual({ type: shell, exitCode: 0, truncated: false, cwd: '/w' })

    mocks.runCommand.mockResolvedValueOnce(settled(3, 'bad'))
    const failed = await run(tool, params())
    expect(failed.text.endsWith('[Exit code: 3]')).toBe(true)
    expect(failed.details).toEqual({ type: shell, exitCode: 3, truncated: false, cwd: '/w' })

    mocks.runCommand.mockResolvedValueOnce(settled(null, 'slow', 'timeout'))
    const timedOut = await run(tool, params({ timeout: 5 }))
    expect(timedOut.text.endsWith('[Command timed out (5s)]')).toBe(true)
    expect(timedOut.details.exitCode).toBe(124)
    expect(timedOut.details.type).toBe(shell)

    mocks.runCommand.mockResolvedValueOnce(settled(null, '', 'abort'))
    await expect(run(tool, params())).rejects.toThrow('Aborted')
  })

  it(`D2 — ${shell} 后台：background 两头都带到；转后台 → 后台形态 details（isBackgroundCall 为真）`, async () => {
    mocks.runCommand.mockResolvedValueOnce({
      kind: 'background',
      info: taskInfo({ pid: 777, status: 'running', exitCode: null }),
      logBytes: 12
    })
    const r = await run(makeTool(shell), params({ run_in_background: true }))

    expect(mocks.enforceCommand.mock.calls[0][1]).toMatchObject({ background: true })
    expect(mocks.runCommand.mock.calls[0][0]).toMatchObject({ shell, background: true })
    // 后台形态刻意不传超时与中止信号（停止生成不杀后台任务）
    expect(mocks.runCommand.mock.calls[0][0].signal).toBeUndefined()

    expect(r.details).toMatchObject({ type: shell, background: true, exitCode: 0 })
    expect(isBackgroundCall(r.details)).toBe(true)
    expect(r.text).toContain('pid 777')
  })

  it(`D2 — ${shell} 后台但预热窗口内就退出了：按前台形态回话，不带 background`, async () => {
    mocks.runCommand.mockResolvedValueOnce(settled(2, 'no such command'))
    const r = await run(makeTool(shell), params({ run_in_background: true }))

    expect(r.details).toEqual({ type: shell, exitCode: 2, truncated: false, cwd: '/w' })
    expect(isBackgroundCall(r.details)).toBe(false)
    expect(r.text.endsWith('[Exit code: 2]')).toBe(true)
  })

  it(`D2 — ${shell} 后台任务已达上限：说清楚、列出停止命令，不起新进程`, async () => {
    mocks.runningCount.mockReturnValue(MAX_RUNNING_PER_SESSION)
    mocks.listBgTasks.mockReturnValue([
      taskInfo({ pid: 11, status: 'running', description: 'dev server' }),
      taskInfo({ pid: 12, status: 'exited', description: 'done one' })
    ])
    const r = await run(makeTool(shell), params({ run_in_background: true }))

    expect(r.text).toContain('Too many background tasks')
    expect(r.text).toContain('dev server')
    expect(r.text).not.toContain('done one')
    expect(r.details).toMatchObject({ type: shell, exitCode: -1 })
    expect(mocks.runCommand).not.toHaveBeenCalled()
  })

  it(`D3 — ${shell} 用户选「其它」：命令不执行，反馈原样回给模型`, async () => {
    mocks.enforceCommand.mockResolvedValueOnce({ status: 'feedback', text: 'no' })
    const r = await run(makeTool(shell), params())

    expect(r.text).toBe('Command was not executed. User responded with feedback instead:\nno')
    expect(r.details).toMatchObject({ type: shell, exitCode: -1 })
    expect(mocks.runCommand).not.toHaveBeenCalled()
  })
})

describe('PowerShell 的命令行长度上限（询问之前）', () => {
  /** 转义后长度恰为 target 的纯字母命令 */
  const commandOfLength = (target: number): string => {
    const cmd = 'a'.repeat(target - powerShellCommandLineLength(''))
    expect(powerShellCommandLineLength(cmd)).toBe(target)
    return cmd
  }

  it.each([false, true])(
    'D4 — 超出一个字符（run_in_background=%s）：不询问、不 spawn，让模型写成 .ps1',
    async (background) => {
      const cmd = commandOfLength(MAX_POWERSHELL_COMMAND_CHARS + 1)
      const r = await run(
        makeTool('powershell'),
        params({ command: cmd, run_in_background: background })
      )

      expect(mocks.enforceCommand).not.toHaveBeenCalled()
      expect(mocks.runCommand).not.toHaveBeenCalled()
      expect(r.text).toContain('.ps1')
      expect(r.details).toMatchObject({ type: 'powershell', exitCode: -1 })
    }
  )

  it('D4 — 恰好在上限上：照常进入询问', async () => {
    const cmd = commandOfLength(MAX_POWERSHELL_COMMAND_CHARS)
    await run(makeTool('powershell'), params({ command: cmd }))
    expect(mocks.enforceCommand).toHaveBeenCalledTimes(1)
    expect(mocks.runCommand).toHaveBeenCalledTimes(1)
  })

  it('D4 — 原始长度没超、但大半是双引号（转义后翻倍）：按转义后的长度拒', async () => {
    const cmd = '"'.repeat(16_000)
    expect(cmd.length).toBeLessThan(MAX_POWERSHELL_COMMAND_CHARS)
    expect(powerShellCommandLineLength(cmd)).toBeGreaterThan(MAX_POWERSHELL_COMMAND_CHARS)

    const r = await run(makeTool('powershell'), params({ command: cmd }))
    expect(mocks.enforceCommand).not.toHaveBeenCalled()
    expect(r.text).toContain('.ps1')
  })

  it('D4 — bash 没有这道上限：同样长的命令照常进入询问', async () => {
    const cmd = 'a'.repeat(MAX_POWERSHELL_COMMAND_CHARS + 100)
    await run(makeTool('bash'), params({ command: cmd }))
    expect(mocks.enforceCommand).toHaveBeenCalledTimes(1)
    expect(mocks.enforceCommand.mock.calls[0][0].command).toBe(cmd)
  })
})

describe('PowerShell 的描述按版本说', () => {
  /** 三个版本都该有的规则（不论哪一版，都是模型在 Windows 上最常犯的错） */
  const COMMON = ['$env:', 'The escape character is the backtick', 'powershell -Command']

  /** 工具实例的描述与设置页（注册项 describe）读到的是同一份 */
  function descriptions(): string[] {
    const entry = getBuiltinToolEntries().find((e) => e.name === 'powershell')
    expect(entry?.describe).toBeTypeOf('function')
    return [makeTool('powershell').description, entry!.describe!().description]
  }

  it('D5 — Windows + pwsh 7：说 PowerShell 7、&& / || 可用；不说「不存在」', () => {
    setPlatform('win32')
    mocks.psConfig = { exe: 'C:\\pwsh.exe', edition: 'pwsh' }
    for (const text of descriptions()) {
      expect(text).toContain('It runs in PowerShell 7 (pwsh).')
      expect(text).toContain('chain on success / failure')
      expect(text).not.toContain('do not exist')
      for (const rule of COMMON) expect(text).toContain(rule)
    }
  })

  it('D5 — Windows + 5.1：说 && / || 在 5.1 里不存在', () => {
    setPlatform('win32')
    mocks.psConfig = { exe: 'C:\\ps.exe', edition: 'windows-powershell' }
    for (const text of descriptions()) {
      expect(text).toContain('It runs in Windows PowerShell 5.1.')
      expect(text).toContain('do not exist in Windows PowerShell 5.1')
      for (const rule of COMMON) expect(text).toContain(rule)
    }
  })

  it('D5 — 不在 Windows 上（设置页照样展示它）：两种可能都说，不去解析版本', () => {
    setPlatform('darwin')
    mocks.psConfig = null
    for (const text of descriptions()) {
      expect(text).toContain('when installed, otherwise in Windows PowerShell 5.1')
      expect(text).toContain('exist only in PowerShell 7')
      for (const rule of COMMON) expect(text).toContain(rule)
    }
  })
})

describe('停止命令的提示按 shell 给，不按平台', () => {
  it.each(['win32', 'darwin'] as const)('D6 — %s 上：两个 shell 各自的写法', (platform) => {
    setPlatform(platform)
    expect(stopCommandHint('powershell')).toBe('taskkill /T /F /PID <pid>')
    expect(stopCommandHint('bash')).toBe('kill -- -<pid>')
  })

  /** 参数 schema 里 run_in_background 的说明 */
  const backgroundHelp = (shell: ShellName): string =>
    (makeTool(shell).parameters.properties.run_in_background as { description?: string })
      .description ?? ''

  it('D6 — bash 的 run_in_background 说明：kill 进程组，不提 taskkill', () => {
    const text = backgroundHelp('bash')
    expect(text).toContain('kill -- -<pid>')
    expect(text).not.toContain('taskkill')
  })

  it('D6 — powershell 的 run_in_background 说明：taskkill，别自己 Start-Process，回答写进命令（-Confirm:$false）', () => {
    const text = backgroundHelp('powershell')
    expect(text).toContain('taskkill /T /F /PID <pid>')
    expect(text).toContain('Start-Process')
    expect(text).toContain('-Confirm:$false')
    expect(text).not.toContain('kill -- -')
  })
})
